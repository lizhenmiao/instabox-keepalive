# InstaBox 保活面板

给多个 InstaBox 账号的云机器做活动租约保活的可视化管理面板。单文件 Cloudflare Worker，前端页面、API 代理、定时保活全部内嵌在 `worker.js` 里，配置与日志存放在 Upstash Redis。

## 为什么需要它

InstaBox 免费机器默认空闲 30 分钟后自动暂停；是否可以调整或关闭空闲暂停取决于账号权限和套餐。

本面板通过 **activity lease（活动租约）** 保活：租约有效期内机器不会进入空闲暂停，定时续期可避免空闲暂停。**租约不能解除平台的运行时长上限、冷却期或其他限制，不保证永不暂停。**租约单次最长 3600 秒，配合 15 分钟一次的定时任务，可为短暂续租失败留出缓冲。

## 功能

- 多账号机器列表与实时状态（运行中 / 已暂停 / 已停止 / 操作过渡态），自动读取全部分页
- 每台机器显示所属账号；一个账号请求失败不影响其他账号
- 冷却截止时间与自动重试状态，冷却中不调用启动、唤醒或续租
- 启动、唤醒、暂停、停止、删除
- 每台机器独立开关自动保活，显示检查时间、冷却状态与租约剩余时间
- 保活日志，保留最近 200 条
- 面板密码保护，所有接口需鉴权
- 操作按钮防重复点击，操作期间整张卡片锁定

## 界面预览

登录后进入控制台，顶部可在「机器」与「日志」之间切换。

**登录**

![登录页](images/panel-login.png)

**机器列表**：每张卡片显示状态、规格、操作按钮，以及自动保活的上次/下次保活时间与租约剩余。

![机器列表](images/panel-machines.png)

**保活日志**：记录每次续期与手动操作，存于 Upstash Redis，可一键清空。

![保活日志](images/panel-logs.png)

## 保活效果

![连续运行时长](images/komari-uptime.png)

**近 24 小时资源曲线**：CPU、内存、磁盘、网络、负载与延迟均有完整采样，没有因暂停出现的断档。

![近 24 小时历史曲线](images/komari-24h-history.png)

## 前置条件

| 依赖 | 获取方式 |
|---|---|
| InstaBox API Key | 登录 [InstaBox 控制台](https://dashboard.instabox.sh/dashboard/machines)，进入 **Profile → API keys** 创建，`ibk_` 开头 |
| Upstash Redis | 在 [Upstash](https://upstash.com) 创建，步骤见下方 |
| Cloudflare 账号 | 免费注册，登录 [Cloudflare Dashboard](https://dash.cloudflare.com) |

## 准备 Upstash Redis

1. 打开 <https://upstash.com>，点 **Sign In**，选择 **Continue with GitHub** 直接登录，不需要单独注册。
2. 进入控制台选择 Redis 进行创建，区域挑离你较近的节点，计划保持 **Free**。
3. 创建完成后进入数据库详情页，在 **REST API** 区域复制两个值，稍后填入 Worker 环境变量：
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

免费额度为每月 **500,000 次命令**、**250 MB 存储**、**10 GB 带宽**。本面板每 15 分钟续期一次，一天约 96 轮，每轮命令数随开启保活的机器数量增长；多账号、互斥锁、手动操作和页面刷新也会消耗额度。请以 Upstash 的实际用量统计为准。

![Upstash 免费额度](images/upstash-free-tier.png)

## 部署

### 方式一：Cloudflare 网页控制台

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Worker**
2. 命名（例如 `instabox-panel`）后点 **Deploy**，先用默认模板部署
3. 点 **Edit code**，删除默认代码，粘贴 `worker.js` 全文，点 **Deploy**
   > 编辑器默认就是 ES Module 格式，代码使用 `export default`，直接粘贴即可，不要切换为 Service Worker 类型。
4. 进入 **Settings → Variables and Secrets**，逐个添加以下四个变量，类型全部选择 **Secret**：

   | 变量名 | 值 |
   |---|---|
   | `INSTABOX_API_KEY` | InstaBox 的 API Key |
   | `ADMIN_PASSWORD` | 面板登录密码，自行设定 |
   | `UPSTASH_REDIS_REST_URL` | Upstash Redis 的 REST 地址 |
   | `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis 的 REST 令牌 |

   添加完成后点 **Deploy** 使其生效。多个账号的配置见下方「接入第二个账号」。
5. 进入 **Settings → Trigger Events → Cron Triggers**，点 **Add**，填入：

   ```
   */15 * * * *
   ```

6. 访问 `https://<worker 名称>.<你的子域>.workers.dev`，输入 `ADMIN_PASSWORD` 登录。

### 方式二：wrangler CLI

```bash
npm install -g wrangler
wrangler login

wrangler deploy

wrangler secret put INSTABOX_API_KEY
wrangler secret put ADMIN_PASSWORD
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

CLI 部署前，将 `wrangler.example.toml` 复制为 `wrangler.toml`，修改 Worker 名称。配置示例：

```toml
name = "instabox-panel"
main = "worker.js"
compatibility_date = "2026-10-01"

[triggers]
crons = ["*/15 * * * *"]

[vars]
KEEPALIVE_INTERVAL_MINUTES = "15"
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `INSTABOX_API_KEY` | 二选一 | 旧单账号配置，对应账号 ID `default`；可与下面的账号数组同时使用 |
| `INSTABOX_ACCOUNTS` | 二选一 | Secret，账号 JSON 数组，格式见下文；至少配置一个账号 |
| `KEEPALIVE_INTERVAL_MINUTES` | 否 | Cron 的分钟步长，默认 `15`，范围 1–30；须与 Cron 同时修改 |
| `ADMIN_PASSWORD` | 是 | 面板登录密码，所有 `/api` 请求通过 `X-Panel-Auth` 头校验 |
| `UPSTASH_REDIS_REST_URL` | 是 | 形如 `https://xxx.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | 是 | Upstash 数据库的 REST Token |

## 接入第二个账号

已有面板不需要重新建 Redis，也不需要修改原来的 Key：

1. 保留 `INSTABOX_API_KEY`，它仍然管理第一个账号。
2. 在第二个 InstaBox 账号创建自己的 API Key。
3. 在 Cloudflare Worker 的 **Variables and Secrets** 增加一个 **Secret**，名称为 `INSTABOX_ACCOUNTS`，内容如下（替换示例 Key）：

   ```json
   [
     { "id": "second", "name": "账号二", "apiKey": "ibk_REPLACE_WITH_SECOND_ACCOUNT_KEY" }
   ]
   ```

4. 部署新版 `worker.js` 和变量，回面板刷新。两个账号的机器会出现在同一页，为新增机器分别打开保活。

CLI 配置可用 `wrangler secret put INSTABOX_ACCOUNTS`，在交互提示中粘贴 JSON。Key 不要提交进仓库或填入普通明文变量。Key 至少需要机器读取权限，以及保活租约所需的 `machines:write` 或 `machines:exec`；生命周期操作还需要相应写权限，删除需要 `machines:delete`。权限不足会显示在对应账号／机器的错误中。

也可以只配置 `INSTABOX_ACCOUNTS`，包含所有账号：

```json
[
  { "id": "default", "name": "账号一", "apiKey": "ibk_REPLACE_WITH_FIRST_ACCOUNT_KEY" },
  { "id": "second", "name": "账号二", "apiKey": "ibk_REPLACE_WITH_SECOND_ACCOUNT_KEY" }
]
```

这种方式需要移除原来的 `INSTABOX_API_KEY`，否则 `default` 会重复。`id` 使用 1–32 位小写字母、数字、`_` 或 `-`，以字母或数字开头；必须唯一，**添加账号后不要随意改 ID**。轮换 Key 只修改 `apiKey`；改 `name` 不影响保活配置。

旧 Redis 机器配置只迁移到 `default`，首次更新后写入带账号前缀的新字段；另一个账号不会继承它。移除账号会停止它的自动保活，但保留原配置；以相同 ID 添加回来后配置恢复生效。每个账号的套餐额度仍由 InstaBox 决定，添加多个 Key 不会增加单个账号额度。

若分别部署多个独立面板，不要让不同账号的单 Key 面板共用同一套 Redis 数据：它们都会把自己的 Key 视为 `default`。本项目推荐一个面板配置多个账号。

## 定时任务：15 分钟还是 9 分钟

推荐保留 **`*/15 * * * *`**，并保持 `KEEPALIVE_INTERVAL_MINUTES=15`。每次成功续租有效 3600 秒，15 分钟已有足够续期间隔；请求更频繁不能解除冷却或运行上限。

冷却结束后，恢复要等下一个 Cron，默认额外等待约 0–15 分钟（再加平台调度和启动耗时）。如果特别在意恢复速度，可改成 `*/5 * * * *`，同时设置变量为 `5`，代价是请求和 Redis 用量增加。

`*/9 * * * *` 会在每小时的 `00、09、18、27、36、45、54` 分触发，54 分到下个整点只有 6 分钟，**并非严格每 9 分钟一次**。若确实采用它，变量也设为 `9`；面板按小时内分钟步长显示预计时间。仅更改变量不会创建或修改 Cloudflare Cron；二者不一致时 Worker 日志会提示，但仍会执行保活。

## 使用

**机器页**：卡片展示机器名称、状态、机器 ID、规格与模板。操作按钮随状态变化：

- 运行中 → 暂停、停止
- 已暂停 → 唤醒
- 已停止 → 启动

暂停和停止都会弹出确认。两者的区别：

| 操作 | 效果 |
|---|---|
| 暂停 | 保留内存和运行中的进程，唤醒后从原地继续 |
| 停止 | 相当于关机，磁盘文件保留，内存和进程结束，下次启动是冷启动 |

**自动保活开关**：打开后立即检查一次，符合状态条件才续租；冷却中等待到期，启动中等待确认。卡片显示上次检查、预计下次检查、冷却结束时间或租约状态。首次失败仍保留开关开启，后续 Cron 继续重试。

通过本面板手动暂停、停止或删除时，会先持久化关闭保活，再下发机器操作。即使请求超时、无法确认是否已受理，也保持保活关闭，避免下一轮意外拉起；请检查机器状态后自行决定是否重新开启。其他控制台或 CLI 的停机不会自动修改这里的开关，需要先在面板关闭保活。

**日志页**：查看最近 50 条保活与操作记录，可一键清空。日志存放在 Redis，与浏览器无关。

## 保活机制

1. Cloudflare Cron 触发 `scheduled()`，读取所有已启用的 `accountId:machineId` 配置，使用对应账号的 Key。
2. 每台机器先查询状态。未来的 `cooldownUntil` 阻止所有保活写请求；有进行中的操作或过渡状态则等待下一轮。
3. `running` 调用 `PUT /v1/machines/{id}/activity-leases/keepalive`，租约时长 3600 秒。返回正确机器 ID 和有效的未来到期时间才算续租成功。
4. `stopped` 调用 start，`suspended` 调用 resume，然后有限次数确认状态；确认为 running 后立即续租，尚未就绪则记录等待，不冒充成功。
5. 409 会重查机器状态，区分冷却／进行中的操作；不能识别的冲突记录失败，不盲目 start。单台失败不阻断其余机器。
6. Cron 和手动操作共享每台机器的 Redis 互斥锁，避免互相覆盖；若锁被占用，本轮跳过或提示稍后重试。锁在完成后释放，异常中断最多 10 分钟后到期。

`fetch()` 处理页面与 API，`scheduled()` 负责定时任务。租约只解决空闲暂停；续期请求成功不代表绕过平台限制。

## 存储结构

| Key | 类型 | 内容 |
|---|---|---|
| `instabox:machines` | Hash | field 为 `账号ID:机器ID`，value 为 JSON：名称、保活开关、租约／冷却到期时间、上次执行结果 |
| `instabox:lock:<账号ID>:<机器ID>` | String | 操作锁的随机 token，最多保留 600 秒 |
| `instabox:logs` | List | 保活与操作日志，`LPUSH` + `LTRIM` 保留最近 200 条 |

## 常见问题

**定时任务没有生效**

确认 **Trigger Events → Cron Triggers** 已添加并保存。可在 Worker 的 **Logs** 中查看 `scheduled` 事件，成功时输出 `{"event":"keepalive_tick_ok",...}`。

**保活开关打开后状态没有更新**

检查 `UPSTASH_REDIS_REST_URL` 与 `UPSTASH_REDIS_REST_TOKEN` 是否正确。面板顶部会显示 Redis 读取失败的提示。

**机器仍然会暂停**

确认该机器的保活开关为开启状态，且日志页有持续的「自动保活」记录。若显示冷却期，等待截止时间后的下一轮检查；若出现 `HTTP 404 not_found`，检查机器是否已删除或 Key 是否仍有访问权限。不要为单台异常清空整个 Redis。

**能否直接把空闲暂停关掉**

取决于套餐和账号权限，免费套餐默认不能关闭。请以 InstaBox 官方规则为准；租约方案也不能解除运行时长或冷却限制。

**面板部署后是否还需要代理**

不需要。Cloudflare 的网络可直接访问 InstaBox API。

## 本地验证

需要 Node.js 22 或更新版本，没有 npm 依赖要安装：

```bash
npm run check
npm test
```

测试使用模拟 InstaBox API 和 Redis，不连接实际账号，也不会启动、暂停或删除真实机器。GitHub Actions 对 PR 运行相同检查。界面仍内嵌在 `worker.js`，网页部署只需该文件，`package.json` 和测试不影响部署方式。

## 相关链接

**InstaBox**

- 官网 <https://instabox.sh>
- 控制台 <https://dashboard.instabox.sh/dashboard/machines> —— API Key 在 **Profile → API keys** 创建
- 文档 <https://instabox.sh/docs>
- API 地址 `https://api.instabox.sh`

**Upstash**

- 官网 <https://upstash.com> —— 支持 GitHub 账号直接登录
- 控制台 <https://console.upstash.com/redis> —— 创建 Redis 后在此复制 REST URL 与 REST Token
- Redis 文档 <https://upstash.com/docs/redis>

**Cloudflare**

- Dashboard <https://dash.cloudflare.com>
- Workers 文档 <https://developers.cloudflare.com/workers/>
- Cron 触发器 <https://developers.cloudflare.com/workers/configuration/cron-triggers/>

## 社区支持

学 AI , 上 L 站：[LinuxDO](https://linux.do)

## Star History

<a href="https://www.star-history.com/?repos=lizhenmiao%2Finstabox-keepalive&type=timeline&logscale=&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=lizhenmiao/instabox-keepalive&type=timeline&theme=dark&logscale&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=lizhenmiao/instabox-keepalive&type=timeline&logscale&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=lizhenmiao/instabox-keepalive&type=timeline&logscale&legend=bottom-right" />
 </picture>
</a>
