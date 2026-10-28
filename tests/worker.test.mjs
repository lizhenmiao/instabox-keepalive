import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import worker from "../worker.js";

const env = {
  ADMIN_PASSWORD: "test-password",
  INSTABOX_API_KEY: "ibk_first",
  INSTABOX_ACCOUNTS: JSON.stringify([{ id: "second", name: "账号二", apiKey: "ibk_second" }]),
  UPSTASH_REDIS_REST_URL: "https://redis.test",
  UPSTASH_REDIS_REST_TOKEN: "redis-test-token",
};
const future = () => new Date(Date.now() + 3600000).toISOString();
const reply = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });

function setup(t, handler, initial = {}) {
  const configs = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const locks = new Map(), logs = [], calls = [];
  let redisHook;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).startsWith("https://redis.test/")) {
      const commands = JSON.parse(options.body);
      if (redisHook) await redisHook(commands);
      return reply(commands.map(([command, key, ...args]) => {
        let result;
        switch (command) {
          case "HGETALL": result = Object.fromEntries(configs); break;
          case "HSET": configs.set(args[0], args[1]); result = 1; break;
          case "HDEL": result = args.reduce((n, field) => n + Number(configs.delete(field)), 0); break;
          case "LPUSH": logs.unshift(args[0]); result = logs.length; break;
          case "LTRIM": logs.splice(Number(args[1]) + 1); result = "OK"; break;
          case "LRANGE": result = logs.slice(Number(args[0]), Number(args[1]) + 1); break;
          case "DEL": logs.length = 0; result = 1; break;
          case "SET":
            result = locks.has(key) ? null : "OK";
            if (result) locks.set(key, args[0]);
            break;
          case "EVAL": {
            const [, lockKey, token] = args;
            result = locks.get(lockKey) === token ? Number(locks.delete(lockKey)) : 0;
            break;
          }
          default: throw new Error("Unexpected Redis command " + command);
        }
        return { result };
      }));
    }
    const request = { url: new URL(url), method: options.method, key: options.headers["X-API-Key"],
      body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers };
    calls.push(request);
    return handler(request);
  });
  return { configs, locks, logs, calls, setRedisHook: (hook) => { redisHook = hook; } };
}

async function api(path, method = "GET", body, customEnv = env) {
  return worker.fetch(new Request("https://panel.test/api" + path, {
    method, headers: { "X-Panel-Auth": "test-password", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), customEnv);
}
const keepalive = (id = "m_one", account = "second") => "/accounts/" + account + "/machines/" + id + "/keepalive";
const detail = (state = "running", extra = {}) => reply({ id: "m_one", state, ...extra });
const lease = () => reply({ machineId: "m_one", expiresAt: future() });

test("account-specific keys, pagination and namespaced identities", async (t) => {
  const mock = setup(t, ({ key, url }) => {
    if (key === "ibk_first") return reply({ machines: [{ id: "m_one", name: "same", state: "running" }] });
    if (!url.search) return reply({ machines: [{ id: "m_one", name: "same", state: "running" }], nextCursor: "a+b/=" });
    assert.equal(url.searchParams.get("cursor"), "a+b/=");
    return reply({ machines: [{ id: "m_two", state: "stopped" }] });
  });
  const result = await (await api("/machines")).json();
  assert.deepEqual(result.machines.map((m) => m.key), ["default:m_one", "second:m_one", "second:m_two"]);
  assert.equal(result.accountCount, 2);
  assert.equal(result.intervalMinutes, 15);
  assert.equal(mock.calls.length, 3);
  assert.ok(!JSON.stringify(result).includes("ibk_"));
});

test("failed account does not hide other accounts and error messages redact keys", async (t) => {
  setup(t, ({ key }) => key === "ibk_first"
    ? reply({ error: { code: "unauthorized", message: "Bad key ibk_first" } }, 401)
    : reply({ machines: [{ id: "m_two", state: "running" }] }));
  const result = await (await api("/machines")).json();
  assert.equal(result.machines.length, 1);
  assert.equal(result.accountErrors.length, 1);
  assert.ok(!JSON.stringify(result).includes("ibk_first"));
});

test("repeating pagination cursor terminates with partial results and warning", async (t) => {
  const mock = setup(t, () => reply({ machines: [{ id: "m_one" }], nextCursor: "same" }));
  const result = await (await api("/machines", "GET", undefined, { ...env, INSTABOX_ACCOUNTS: "" })).json();
  assert.equal(mock.calls.length, 2);
  assert.equal(result.machines.length, 1);
  assert.match(result.accountErrors[0].error, /游标/);
});

test("legacy configuration migrates only to default account; new record wins", async (t) => {
  const mock = setup(t, () => reply({ machines: [{ id: "m_one" }] }), {
    m_one: { keepalive: "on" }, "default:m_one": { keepalive: "off" },
  });
  const list = await (await api("/machines")).json();
  assert.equal(list.machines[0].keepalive.keepalive, "off");
  assert.equal(list.machines[1].keepalive, null);
  assert.equal((await api("/machines/m_one/keepalive", "POST", { enable: false })).status, 200);
  assert.ok(!mock.configs.has("m_one"));
  assert.ok(mock.configs.has("default:m_one"));
});

test("legacy single-key deployment still renews existing enabled machines", async (t) => {
  const mock = setup(t, ({ method }) => method === "GET" ? detail() : lease(), { m_one: { keepalive: "on" } });
  await worker.scheduled({ cron: "*/15 * * * *" }, { ...env, INSTABOX_ACCOUNTS: "" });
  assert.ok(!mock.configs.has("m_one"));
  assert.equal(JSON.parse(mock.configs.get("default:m_one")).lastStatus, "ok");
  assert.ok(mock.calls.every((c) => c.key === "ibk_first"));
});

test("cooldown prevents writes in keepalive and manual resume", async (t) => {
  const until = future();
  const mock = setup(t, () => detail("suspended", { cooldownUntil: until }));
  assert.equal((await api(keepalive(), "POST", { enable: true })).status, 200);
  const config = JSON.parse(mock.configs.get("second:m_one"));
  assert.equal(config.lastStatus, "cooldown");
  assert.equal(config.cooldownUntil, until);
  const response = await api("/accounts/second/machines/m_one/resume", "POST", {});
  assert.equal(response.status, 409);
  assert.ok(mock.calls.every((c) => c.method === "GET"));
});

test("expired cooldown resumes, confirms running and renews immediately with correct key", async (t) => {
  let reads = 0;
  const mock = setup(t, ({ method }) => {
    if (method === "GET") return reads++ ? detail() : detail("suspended", { cooldownUntil: "2020-01-01T00:00:00Z" });
    if (method === "POST") return reply({ id: "op_one" }, 202);
    return lease();
  });
  await api(keepalive(), "POST", { enable: true });
  assert.deepEqual(mock.calls.map((c) => c.method), ["GET", "POST", "GET", "PUT"]);
  assert.match(mock.calls[1].url.pathname, /\/resume$/);
  assert.ok(mock.calls[1].headers["Idempotency-Key"]);
  assert.deepEqual(mock.calls[3].body, { ttlSeconds: 3600 });
  assert.ok(mock.calls.every((c) => c.key === "ibk_second"));
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).lastStatus, "ok");
});

test("stopped machine uses start, not resume", async (t) => {
  let reads = 0;
  const mock = setup(t, ({ method }) => method === "GET" ? detail(reads++ ? "running" : "stopped") : method === "POST" ? reply({}, 202) : lease());
  await api(keepalive(), "POST", { enable: true });
  assert.match(mock.calls[1].url.pathname, /\/start$/);
});

test("transitional states and pending operations never trigger lifecycle writes", async (t) => {
  let state = "starting";
  const mock = setup(t, () => detail(state, state === "running" ? { operationId: "op_pending" } : {}));
  await api(keepalive(), "POST", { enable: true });
  state = "running";
  await api(keepalive(), "POST", { enable: true });
  assert.ok(mock.calls.every((c) => c.method === "GET"));
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).lastStatus, "waiting");
});

test("409 during renewal refreshes cooldown without issuing start", async (t) => {
  let reads = 0;
  const mock = setup(t, ({ method }) => method === "GET"
    ? detail("running", reads++ ? { cooldownUntil: future() } : {})
    : reply({ error: { code: "runtime_cooldown" } }, 409));
  await api(keepalive(), "POST", { enable: true });
  assert.deepEqual(mock.calls.map((c) => c.method), ["GET", "PUT", "GET"]);
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).lastStatus, "cooldown");
});

test("unclassified 409 is reported as failure, not a reason to start", async (t) => {
  const mock = setup(t, ({ method }) => method === "GET" ? detail() : reply({ error: { code: "operation_conflict" } }, 409));
  const result = await (await api(keepalive(), "POST", { enable: true })).json();
  assert.match(result.warning, /operation_conflict/);
  assert.ok(!mock.calls.some((c) => c.method === "POST"));
});

test("invalid or expired lease is never marked successful", async (t) => {
  setup(t, ({ method }) => method === "GET" ? detail() : reply({ machineId: "m_one", expiresAt: "2020-01-01T00:00:00Z" }));
  const result = await (await api(keepalive(), "POST", { enable: true })).json();
  assert.match(result.warning, /租约信息异常/);
});

test("first renewal failure keeps switch enabled and preserves prior lease deadline", async (t) => {
  const expiresAt = future();
  const mock = setup(t, () => reply({ error: { code: "unavailable" } }, 503), {
    "second:m_one": { keepalive: "off", leaseExpiresAt: expiresAt },
  });
  await api(keepalive(), "POST", { enable: true });
  const saved = JSON.parse(mock.configs.get("second:m_one"));
  assert.equal(saved.keepalive, "on");
  assert.equal(saved.lastStatus, "failed");
  assert.equal(saved.leaseExpiresAt, expiresAt);
});

test("manual stop persists off before issuing request, even on ambiguous timeout", async (t) => {
  const mock = setup(t, () => {
    assert.equal(JSON.parse(mock.configs.get("second:m_one")).keepalive, "off");
    throw new TypeError("fetch failed");
  }, { "second:m_one": { keepalive: "on" } });
  assert.equal((await api("/accounts/second/machines/m_one/stop", "POST", {})).status, 502);
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).keepalive, "off");
  assert.equal(mock.locks.size, 0);
});

test("failed config persistence prevents stop", async (t) => {
  const mock = setup(t, () => assert.fail("unexpected API write"), { "second:m_one": { keepalive: "on" } });
  mock.setRedisHook((commands) => { if (commands.some(([command]) => command === "HSET")) throw new Error("Redis unavailable"); });
  assert.equal((await api("/accounts/second/machines/m_one/stop", "POST", {})).status, 500);
  assert.equal(mock.calls.length, 0);
});

test("per-machine lock rejects conflicting manual operation and is released", async (t) => {
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const mock = setup(t, async ({ method }) => {
    if (method === "GET") { entered(); await waiting; return detail(); }
    return lease();
  });
  const first = api(keepalive(), "POST", { enable: true });
  await started;
  assert.equal((await api(keepalive(), "POST", { enable: false })).status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(mock.locks.size, 0);
  assert.equal((await api(keepalive(), "POST", { enable: false })).status, 200);
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).keepalive, "off");
});

test("scheduled failure on one machine does not block another account", async (t) => {
  const mock = setup(t, ({ key, method }) => key === "ibk_first" ? reply({}, 403) : method === "GET" ? detail() : lease(), {
    "default:m_one": { keepalive: "on" }, "second:m_one": { keepalive: "on" }, "removed:m_one": { keepalive: "on" },
  });
  await worker.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(JSON.parse(mock.configs.get("default:m_one")).lastStatus, "failed");
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).lastStatus, "ok");
  assert.ok(mock.calls.some((c) => c.key === "ibk_second" && c.method === "PUT"));
});

test("scheduled task re-reads switch under lock rather than using stale snapshot", async (t) => {
  const mock = setup(t, () => assert.fail("disabled machine must not be contacted"), { "second:m_one": { keepalive: "on" } });
  mock.setRedisHook((commands) => {
    if (commands.some(([command]) => command === "SET")) mock.configs.set("second:m_one", JSON.stringify({ keepalive: "off" }));
  });
  await worker.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(mock.calls.length, 0);
});

test("delete uses selected account and only removes its configuration", async (t) => {
  const mock = setup(t, () => reply(null, 204), { "default:m_one": { keepalive: "on" }, "second:m_one": { keepalive: "on" } });
  assert.equal((await api("/accounts/second/machines/m_one", "DELETE")).status, 202);
  assert.equal(mock.calls[0].key, "ibk_second");
  assert.ok(mock.configs.has("default:m_one"));
  assert.ok(!mock.configs.has("second:m_one"));
});

test("unknown accounts, invalid enable types and missing auth never reach upstream", async (t) => {
  const mock = setup(t, () => assert.fail("unexpected upstream request"));
  assert.equal((await api(keepalive("m_one", "missing"), "POST", { enable: true })).status, 404);
  assert.equal((await api(keepalive(), "POST", { enable: "false" })).status, 400);
  assert.equal((await worker.fetch(new Request("https://panel.test/api/machines"), env)).status, 401);
  assert.equal(mock.calls.length, 0);
});

test("malformed account configuration is rejected without leaking raw secrets", async () => {
  for (const value of ['[{"apiKey":"ibk_secret"}]', '[{"id":"second","apiKey":"ibk_first"}]', 'ibk_secret']) {
    const result = await api("/machines", "GET", undefined, { ...env, INSTABOX_ACCOUNTS: value });
    assert.equal(result.status, 500);
    assert.ok(!(await result.text()).includes("ibk_"));
  }
});

test("rendered browser script parses, routes by account and computes hourly cron boundaries", async () => {
  const html = await (await worker.fetch(new Request("https://panel.test/"), env)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const node = { style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, focus() {} };
  const context = vm.createContext({
    localStorage: { getItem() { return ""; } },
    document: { getElementById() { return node; }, addEventListener() {} },
    setTimeout() {}, setInterval() {}, Intl,
    Date: class extends Date { static now() { return Date.parse("2026-10-28T10:54:00Z"); } },
  });
  vm.runInContext(script, context);
  assert.equal(vm.runInContext('CRON_MINUTES = 9; nextTickAt()', context), "2026-10-28T11:00:00.000Z");
  assert.equal(vm.runInContext('CRON_MINUTES = 15; nextTickAt("2026-10-28T11:07:00Z")', context), "2026-10-28T11:15:00.000Z");
  vm.runInContext('DATA.machines = [{key:"second:m_one", accountId:"second", id:"m_one"}]', context);
  assert.equal(vm.runInContext('machinePath("second:m_one")', context), "/accounts/second/machines/m_one");
  assert.equal(vm.runInContext('humanize("冷却至 2026-10-28T10:54:00Z")', context), "冷却至 2026-10-28 18:54:00");
});

test("accepted start is not reported as renewed while machine is still starting", async (t) => {
  let reads = 0;
  const mock = setup(t, ({ method }) => method === "GET" ? detail(reads++ ? "starting" : "stopped") : reply({}, 202));
  await api(keepalive(), "POST", { enable: true });
  const saved = JSON.parse(mock.configs.get("second:m_one"));
  assert.equal(saved.lastStatus, "waiting");
  assert.equal(saved.leaseExpiresAt, null);
  assert.ok(!mock.calls.some((c) => c.method === "PUT"));
});

test("invalid cooldown timestamp fails closed without a lifecycle request", async (t) => {
  const mock = setup(t, () => detail("suspended", { cooldownUntil: "invalid" }));
  const response = await (await api(keepalive(), "POST", { enable: true })).json();
  assert.match(response.warning, /冷却截止时间无效/);
  assert.ok(mock.calls.every((c) => c.method === "GET"));
});

test("JSON-only accounts work, but legacy routes cannot fall back to another account", async (t) => {
  const mock = setup(t, () => reply({ machines: [{ id: "m_one" }] }));
  const customEnv = { ...env, INSTABOX_API_KEY: "" };
  const response = await (await api("/machines", "GET", undefined, customEnv)).json();
  assert.equal(response.machines[0].accountId, "second");
  assert.equal(response.accountCount, 1);
  assert.equal((await api("/machines/m_one/keepalive", "POST", { enable: true }, customEnv)).status, 404);
  assert.equal(mock.calls.length, 1);
});
