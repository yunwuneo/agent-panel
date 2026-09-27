# AgentPanel Relay

Hono + Bun WebSocket；持久化使用 Drizzle/PostgreSQL。生产入口始终要求数据库，`MemoryStore` 仅供测试使用。

## 启动与配置

在仓库根目录执行，先按根 README 准备 `.env`：

```sh
bun apps/relay/src/migrate.ts
bun apps/relay/src/index.ts
```

必填 `DATABASE_URL`、`OWNER_EMAIL`、`BOOTSTRAP_TOKEN`、`JWT_SECRET`。两项 secret 至少 32 字符，使用密码学随机值，文件权限设为 `0600`，不要提交、输出到日志或放入客户端构建。数据库不应暴露到公网。应用不会自动运行迁移，以便部署者先备份和审查。

`PUBLIC_ORIGIN` 必须是客户端实际访问的 origin，本地默认 `http://localhost:5173`；`WEBAUTHN_RP_ID` 默认使用其主机名；`ALLOWED_ORIGINS` 可用逗号列出可信 WebAuthn/CORS origins。非 localhost 必须 HTTPS。`PORT` 默认 8787，`HOST` 默认 `127.0.0.1`；容器内通过 `HOST=0.0.0.0` 显式监听容器网络。配置 `WEB_DIST` 为 Web 构建目录后，Relay 同时提供 SPA、assets、service worker 和 manifest。若从 Relay 端口打开界面，应同步修改 `PUBLIC_ORIGIN` 与 `ALLOWED_ORIGINS`。

`GET /health` 仅检查进程；`GET /ready` 实际执行数据库 `SELECT 1`。

## 首次注册、恢复与认证

只允许配置的唯一邮箱注册，不发送邮件、不开放公开注册。首次打开 Web，输入配置邮箱和本机 `.env` 中的 bootstrap token，使用系统 Passkey 注册。注册后仅允许 Passkey 登录。妥善离线保存注册结果显示的八个一次性恢复码；恢复时使用其中一个注册新的 Passkey，会撤销旧 Passkey、所有客户端会话和旧恢复码。

若同时丢失 Passkey 与恢复码，拥有服务器文件和数据库权限的管理员可以在本机执行：

```sh
bun apps/relay/src/admin.ts status
bun apps/relay/src/admin.ts reset-passkeys --confirm-reset-passkeys
```

第二条命令会删除该账号旧认证器、待用挑战、恢复码、WebSocket ticket 与配对码，撤销客户端登录，并记录审计；之后使用配置的 bootstrap token 重新注册。它保留设备及会话数据。该管理功能没有 HTTP 入口。

WebAuthn 强制验证 RP、origin、challenge、签名和 user verification。access token 有效期 10 分钟。refresh token 轮换且仅存 hash，重复使用旧 token 会立即吊销整个登录会话；服务端每次鉴权验证会话状态。Web refresh 使用 HttpOnly / SameSite=Strict cookie；native 客户端显式存储 refresh token 到 Keychain。cookie 刷新需要精确匹配的 Origin。设备 token 仅存 hash，可随时吊销。

## HTTP API

所有 `/api/*` 接口默认要求 `Authorization: Bearer <accessToken>`。只有下列 auth 接口和配对兑换公开。错误统一为 `{error:{code,message}}`，状态码 400/401/403/404/409/413/429；先鉴权再解析请求正文。

| 请求 | 正文或查询 | 返回 |
| --- | --- | --- |
| GET `/api/auth/status` | — | `{configured,registered,rpId}` |
| POST `/api/auth/register/options` | `{email,bootstrapToken}` | `{challengeId,options}` |
| POST `/api/auth/login/options` | `{email}` | `{challengeId,options}` |
| POST `/api/auth/recovery/options` | `{email,recoveryCode}` | `{challengeId,options}`，后续走 register/verify |
| POST `/api/auth/register/verify`、`login/verify` | `{challengeId,response,native?}`，response 为标准 WebAuthn JSON | `{accessToken,expiresIn,user,recoveryCodes?}`；native=true 另含 refreshToken |
| POST `/api/auth/refresh` | Web `{}`；native `{refreshToken,native:true}` | 新的 token 响应 |
| GET `/api/auth/me`；POST `/api/auth/logout` | — | `{user}`；`{ok:true}` |
| POST `/api/pairing` | `{}` | `{code,expiresAt}`，5 分钟一次性代码 |
| POST `/api/pairing/redeem` | `{code,name,platform,hostname?,agents?}` | `{deviceId,deviceToken}`，仅此时返回设备明文凭据 |
| GET `/api/devices` | — | `{devices:Device[]}`，不含 token hash |
| PATCH `/api/devices/:id`；DELETE 同路径 | `{name}`；— | `{device}`；`{ok:true}`，DELETE 立即断开设备连接 |
| GET `/api/sessions` | `deviceId?`、`agent?`、`project?` | `{sessions:Session[]}`，同一 nativeId 去重 |
| GET `/api/sessions/:id/events` | `after=0&limit=500`，limit ≤ 1000 | `{events:Envelope[],nextSeq,hasMore,oldestSeq,truncated}` |
| POST `/api/commands` | 协议 Envelope | `{commandId,status,sessionId?}` |
| GET `/api/approvals` | `status=pending` 可选 | `{approvals:Approval[]}` |
| POST `/api/approvals/:id/decision` | `{decision:"allow"|"deny",reason?}` | `{approval}`，支持离线 HTTP 审批 |
| GET `/api/stats` | `deviceId?`、`agent?`、`project?`、`from?`、`to?`、`groupBy=day|device|agent|project` | `{sessions,usage,buckets,totals,groups,priceVersion,timeBasis}` |
| GET `/api/audit` | — | 最新 500 条账号审计 |
| POST `/api/ws-ticket` | `{}` | `{ticket,expiresAt}`，30 秒一次性 |

`response` 中二进制 WebAuthn 字段必须使用 base64url。所有设备/会话/审批写入均检查 owner 与设备归属。数据库中各实体包含 owner；协议输出不会依赖 adapter raw 字段。

## WebSocket、重连与幂等

浏览器先兑换 `/api/ws-ticket`，再连接 `/ws?ticket=...`；daemon/native 可以连接 `/ws` 并使用 Authorization header。禁止在 URL 中传 access/设备 token。单 Relay 实例维护在线连接；多个实例运行需要共享路由层，本实现不声称支持多实例水平扩展。

客户端发送协议 `subscribe`，payload 为 `{deviceIds?,sessionIds?}`，一次最多 512 个，替换当前订阅。设备状态对该账号连接广播。会话事件带 Relay 分配的、每会话递增的 seq。客户端应先订阅、再 HTTP 补拉，按事件 id/seq 去重。补拉使用数据库 session/seq 索引与分页；`truncated=true` 表示起始游标早于保留窗口，不能把已清理的内容计为完整历史。后台连接可能断开，推送动作通过 HTTP 提交。服务器每 30 秒发送 ping，客户端应回 pong；120 秒无消息关闭连接。

设备消息先提交数据库，再 ACK `{ackId,seq?}`。重复 event id 返回相同 ACK，不新增 seq。客户端命令持久化后交付设备；设备 ACK 后才停止重发。断线和重启会重发未 ACK 命令，因此 daemon 需要持久化命令 id，并对执行结果不确定的崩溃恢复保持保守，不能无条件重新执行。普通命令 5 分钟过期，审批命令使用审批截止时间；过期允许不会迟到执行。

`session.create` 未提供 sessionId 时由 Relay 分配，返回于 HTTP 响应。`result` payload 为 `{requestId,ok,data?,error?}`，对应原命令 id；目录浏览、native 历史等结果通过订阅设备的 WebSocket 返回。相同 command id 不允许对应不同请求。审批相同决定重复提交成功，相反决定或过期决定返回 409，并且只记录一次决策审计。

## 用量与保留期

Daemon 上报**每个 native 会话的累计用量**，并在已索引的会话快照中提供 `usageByDay:[{date:"YYYY-MM-DD",usage}]`（UTC 日）。Relay 保留累计基线，实时事件只取相对基线的非负增量，按事件时间写入日表；旧会话今天继续产生的用量会出现在今天。历史每日快照与 live 增量按设备 + agent + nativeId + 日期协调：使用索引的源 `updatedAt` 水位重建每日基线，只重放水位之后的 live 累计观测；跨午夜归属可由日志纠正，过时快照不会覆盖较新基线。重复快照和事件不会叠加。nativeId 出现后会迁移临时键。会话数按选定日期中贡献数据的 native 会话去重，不跨日重复计数。

`from` / `to` 按 UTC 日与查询范围的交集筛选，日粒度不等同于逐小时账单。`timeBasis=usage-day` 表示真实日期聚合；旧版没有 `usageByDay` 的累计快照暂按创建日期保留并明确返回 `session-created-at`，混合数据返回 `mixed`，同时给出 `legacySessionCount`。收到完整新索引后会重新分配旧的日期归属，保留尚未被索引覆盖的 live 后缀。

统一 `inputTokens` 包含缓存读写输入，缓存计数是其子集，总 token 为 inputTokens + outputTokens。费用优先沿用来源报告的金额；没有金额时，按 `byModel` 分模型用量与账号当前单价估算。`unpricedSessions`、`missingModels` 与 `costComplete` 标识缺价或部分估算，未知价格不会显示成零费用。`groups` 是设备 + agent + 项目明细，`buckets` 按 groupBy 汇总。CodexBar 专用 ClaudeProbe 额度探测目录不进入会话列表及统计，原始数据保留。

`GET /api/pricing` 返回官方参考价、自定义覆盖及历史中未定价的模型；`PUT /api/pricing` 保存 `{ model, input, output, cacheRead, cacheWrite }`，四项单价单位为 USD / 百万 Token；`DELETE /api/pricing?model=...` 移除覆盖、恢复默认。价格按账号持久化，保存后统计查询会重算历史估算值。Web 和 Apple 的「设置 → 模型费用」均可编辑。空白代表未设置，免费须显式填 0。默认价格来源、核验日期及标准短上下文口径随接口返回，未知名称不会匹配相似模型；订阅费用和长上下文等额外倍率不在本估算内。

`EVENT_RETENTION_DAYS` 默认 30；`AUDIT_RETENTION_DAYS` 默认 180。序号保存在会话行，因此事件清理不重置 seq。用量行不设置过期时间。保留期清理只作用于 AgentPanel 数据库，不触碰 daemon 原始会话日志。数据库迁移按文件名顺序执行幂等 SQL；0002 增加永久保存的 UTC 用量日表，各实体有 owner/expiry 索引，事件另有 session/seq 索引。

## 通知与 Apple 前提

`GET /api/push/config` 返回两种提供方配置状态。Web Push 需要 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`，客户端 POST `/api/push/web` `{endpoint,keys:{p256dh,auth}}`。只接受主流浏览器推送服务 HTTPS endpoint，防止订阅接口变成任意网络请求入口。

APNs 需要 `APNS_KEY_PATH`、`APNS_KEY_ID`、`APNS_TEAM_ID`，以及 topic 配置：`APNS_IOS_TOPIC` / `APNS_MACOS_TOPIC` 分别对应两个 app 的 Bundle ID；`APNS_TOPIC` 作为未设置平台值时的显式共同默认值；`APNS_PRODUCTION=true` 切换生产 APNs，默认 sandbox。客户端 POST `/api/push/apns` `{token,platform:"ios"|"macos"}`。通知 category 为 `AGENTPANEL_APPROVAL` 或 `AGENTPANEL_SESSION`，payload 含 approvalId/deviceId/sessionId。删除订阅使用 DELETE `/api/push/:id`。404/410 失效 token 自动移除，其余失败保留错误状态供诊断；未配置提供方不伪报送达。

GET `/api/push/settings` 返回 `{settings}`；PUT 同路径接收 `{deviceId?,sessionId?,enabled?,approval?,completed?,error?,waiting?,preview?}`。全局 → 设备 → 会话逐级覆盖，默认通知开启、正文预览关闭。

原生 Passkey 需要真实可用的 HTTPS RP 域名、Apple Developer 签名与 `webcredentials:<RP域名>` associated domain entitlement。配置 `APPLE_APP_IDS=TEAMID.bundleid,...` 后，Relay 的 `/.well-known/apple-app-site-association` 输出相应 webcredentials apps。仅本地 localhost 构建不能证明 Apple associated-domain 验证或 APNs 真机送达成功；Web localhost Passkey 可独立使用。

## 验证

```sh
bun test apps/relay/test/security.test.ts apps/relay/test/usage-days.test.ts
TEST_DATABASE_URL='本地测试 PostgreSQL 连接串' bun test apps/relay/test/postgres.test.ts apps/relay/test/full-stack.test.ts
bun x tsc --noEmit -p apps/relay/tsconfig.json
```

安全测试通过真实 ES256 软件认证器调用 SimpleWebAuthn 验证链，覆盖 origin/RP/签名/重放/恢复/刷新轮换、账户与设备隔离、幂等、审批和 SSRF。PostgreSQL 集成测试创建随机独立 schema，仅删除自己的测试 schema，验证并发竞争、事务回滚、Relay 重建后的登录与事件持久性、命令重投和保留期；未提供 `TEST_DATABASE_URL` 时明确跳过。
