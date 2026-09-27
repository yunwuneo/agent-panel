# agentpaneld

设备端守护进程通过主动 WebSocket 连接 Relay，管理 Claude Agent SDK 和 Codex app-server。Relay 断线不终止正在运行的轮次；事件先写入本地 SQLite，收到 Relay 的持久化 ACK 后移出待发送队列。

## 本地启动

在仓库根目录运行 `bun install`。未全局安装 Bun 时，可把下面的 `bun` 换成 `.tools/node_modules/.bin/bun`。

```sh
bun apps/daemon/src/cli.ts init --relay http://localhost:8787
bun apps/daemon/src/cli.ts doctor
bun apps/daemon/src/cli.ts pair --code 客户端生成的一次性配对码
bun apps/daemon/src/cli.ts run
```

`pair` 只绑定设备并保存凭据，完成后会退出，不会自动启动 daemon。需要继续运行 `run` 并保持终端开启；看到“设备已连接 Relay”后，客户端中的设备才会上线。关闭终端或按 Ctrl+C 会让设备离线。如果配对时指定了 `--config`，启动时须使用同一配置文件。需要后台常驻时，可使用下文的系统服务安装命令。

安装单文件构建后，使用 `agentpaneld` 代替 `bun apps/daemon/src/cli.ts`。配置默认保存在 `~/.agentpanel/config.json`，可用 `--config /absolute/path/config.json` 或 `AGENTPANEL_CONFIG` 指定。配置文件包含设备 token，以 `0600` 权限保存；服务配置只记录文件路径。设备 token 只通过 HTTP Authorization 头发送。除本机回环地址外，Relay 必须使用 HTTPS/WSS，且不接受 URL 内的凭据。

账号先在 Web/Apple 客户端完成 Passkey 登记，然后生成配对码。Daemon 不创建账号，不绕过 Passkey 的本人在场验证。

## Claude 与 Codex 认证

Daemon 的 Claude **任务执行**不使用订阅 OAuth token；额度查询另见下节。Anthropic 的 [Agent SDK 官方说明](https://platform.claude.com/docs/en/agent-sdk/overview)要求第三方 SDK 产品使用 API Key 或受支持的云服务认证。本机安装 `claude` 后，需要提供 `ANTHROPIC_API_KEY`，或按官方说明配置 Bedrock/Vertex/Foundry，并在配置中明确设置 `allowPaidApi: true`。默认值为 `false`；仅发现凭据不会触发付费调用。`doctor` 只检查能力，不发起模型生成。

Codex 使用官方 [app-server 接口](https://developers.openai.com/codex/app-server)，支持现有 ChatGPT 订阅认证，也支持明确允许后的 API/外部提供方。`account/read` 验证认证类型；在 `allowPaidApi: false` 时，只有 ChatGPT 认证且实际 thread 的 `modelProvider` 为 `openai` 才能开始轮次。不会自动回退到其他付费提供方。

如果现有 Codex 使用自定义提供方或模型目录，推荐给 AgentPanel 使用独立目录：

```sh
mkdir -p "$HOME/.agentpanel/codex"
CODEX_HOME="$HOME/.agentpanel/codex" codex login
bun apps/daemon/src/cli.ts init \
  --codex-home "$HOME/.agentpanel/codex" \
  --codex-provider openai
bun apps/daemon/src/cli.ts doctor
```

这里的 `codexHome` 同时决定该 app-server 的认证、配置和会话日志位置。`codexModelProvider` 只对本次子进程及新建/继续会话生效，不修改原有 `~/.codex/config.toml`。如果仅覆盖提供方、却继续继承另一个提供方的 `model_catalog_json`，Daemon 会拒绝使用并提示配置独立目录，避免把不受支持的模型显示为可用。模型列表从所选 app-server 动态读取。

独立登录目录的 token 由 Codex 自己维护；登录撤销、到期或要求二次验证时，需要本人再次运行上述 `codex login`。开发验收曾使用现有登录的临时副本检查订阅流式、继续会话、审批和中断；该副本不是交付凭据，不会自动拷贝到用户的正式配置。测试时官方目录中的 `gpt-5.5` 可用于 ChatGPT 订阅；可用模型以当前 `doctor` 结果为准。

## 订阅额度查询

AgentPanel 独立查询 ChatGPT/Codex 与 Claude 的订阅额度，不需要安装 CodexBar，也不发起模型生成或改变 `allowPaidApi`。Web 设备页、Apple「设备与订阅额度」显示剩余百分比、重置时间、查询来源与更新时间；离线或过期结果标为上次数据。订阅额度可读与远程任务可运行分别展示，执行受限时显示具体原因。

```sh
bun apps/daemon/src/cli.ts quota --json
```

- Codex：读取所配置 `codexHome/auth.json` 的 OAuth tokens，向固定的 ChatGPT `/backend-api/wham/usage` 接口查询。即使任务执行使用其他 provider，也可读取该目录中的 ChatGPT 额度；API Key 不用来查询订阅额度。当前仅支持文件中的 Codex OAuth 登录，不支持仅存系统密钥库的 Codex 认证。
- Claude：默认 macOS 配置先读取原生 `Claude Code-credentials` 钥匙串项，其他系统或钥匙串不可用时读取所配置 `claudeHome/.credentials.json`，向 Anthropic `/api/oauth/usage` 查询。需要 `user:profile` scope；自定义目录只读取该目录的认证文件，不借用默认钥匙串账户。macOS 可能要求允许钥匙串访问。
- 凭据只在设备进程内读取并发送至对应服务的固定 HTTPS 地址，拒绝重定向；Relay/客户端仅接收归一化的额度数字、时间和状态。不保存或转发 token、账号标识、原始响应及错误正文，不自动更新共享认证文件。认证过期时在本机 CLI 重新登录，再刷新额度。
- 默认每 5 分钟后台刷新，额度读取不阻塞上线。`quotaEnabled: false` 可关闭；`quotaRefreshIntervalMs` 范围 60000–3600000。设备页可手动刷新，每个服务至少间隔 60 秒；429 按 `Retry-After` 延后，最长 24 小时。未返回的窗口不当作零用量或无限额度。订阅接口发生变化时会显示查询失败，需要更新适配器。

更新后重启 Daemon、Relay 并刷新 Web 页面。Relay 需要新协议才能接收 `device.refresh`；无需数据库迁移。现有配对凭据可继续使用。

## 配置字段

```json
{
  "relayUrl": "http://localhost:8787",
  "name": "我的 Mac",
  "roots": ["*"],
  "codexHome": "/absolute/path/to/dedicated-codex-home",
  "codexModelProvider": "openai",
  "codexExecutable": "codex",
  "allowPaidApi": false,
  "quotaEnabled": true,
  "quotaRefreshIntervalMs": 300000,
  "importHistory": true,
  "approvalTimeoutMs": 600000,
  "scanIntervalMs": 30000,
  "autoUpdate": false
}
```

`roots: ["*"]` 明确允许浏览和选择全盘目录，Windows 下列出可访问的盘符。可以改成绝对路径数组；检查解析符号链接后的真实路径，阻止前缀碰撞和跨白名单链接。此白名单只约束工作目录选择；实际 agent 的读写权限还由本地设置、沙箱、权限模式和审批决定。

`claudeHome` 默认 `CLAUDE_CONFIG_DIR` 或 `~/.claude`，`codexHome` 默认 `CODEX_HOME` 或 `~/.codex`。历史索引只读取这两个根目录中的 JSONL，保存字节偏移、未完成 UTF-8/JSON 行、会话索引和累计用量，容忍未知记录。完整原始日志不上传；客户端请求历史时才读取并返回统一消息/工具事件，实际会话正文不脱敏。远程单字段超过 64 KiB 时明确标记为预览截断，历史按字节预算分页；原始文件保持完整。超过 512 KiB、无法完整展示的工具审批输入自动拒绝，请在设备本地审核。

`inputTokens` 统一包含缓存读取/写入 token，缓存字段是其中的子集。Claude 分块消息按 message ID 去重；Codex 支持 `token_count` 和新版 `token_usage_record`，累计快照按正向差值计入，计数器重置另起统计周期。`usageByDay` 按每条原始记录的 UTC 日期累计增量，继续数月前的会话会把新用量记到实际发生日。可用的轮次时长跨午夜时按两天拆分；重复记录不重复计算，Codex fork 的继承前缀不重复计入父会话用量。索引格式版本变化会从原日志重算缓存。

包含 `usageByDay` 的快照是截至原日志 `updatedAt` 的权威统计，各日总和等于该快照的累计用量。实时会话快照可以省略日分组，实时用量通过统一事件发送；Relay 按 nativeId 将日志快照与更新的实时增量对齐，避免历史导入重复计算。

接管本地会话前检查最近 30 秒写入、`lsof` 的文件占用和明确携带该 native ID 的 Claude/Codex 进程。检测失败或发现占用时保持只读，不提供强制绕过。此检测是保守启发式，无法锁住其他工具今后的启动；继续期间仍应避免在本地 TUI 同时打开同一个会话。Windows 原生历史可读，但当前无法可靠确认文件占用时拒绝 resume；新建和本 daemon 管理的会话可继续使用。

“正在进行”使用独立的执行状态：Codex 的轮次开始、完成、中断记录和 Claude 的用户输入、工具调用、最终回复或轮次结束记录决定状态；本地运行的会话可以同时为 `running` 和 `readOnly: true`。未结束的轮次还需近期活动或存活的写入/继续会话进程作为依据，旧日志、只读占用和探测失败不会单独让会话进入“正在进行”。无法确认本地审批时不伪造待审批卡片。文件监听合并刷新，周期扫描默认每 30 秒重判占用（即使日志没有增长），启动时也会重新判定；状态刷新不改变日志的更新时间或用量归属。占用探测按扫描批量执行，子进程最多等待 5 秒。

命令收到后先持久化并 ACK，执行结果通过关联 `requestId` 返回。相同命令 ID 不重复执行。若设备进程在命令执行过程中崩溃，重启后返回“结果不确定”错误并要求查看会话，不会盲目重复可能有副作用的操作。Relay 仅断线时，子进程仍继续运行，审批请求保留到超时；关闭 daemon 或吊销设备认证会拒绝待审批并停止其管理的子进程。

SQLite 状态文件按设备 ID 隔离，重新配对为新设备后不会重放旧设备的命令或事件；旧文件保留供追溯。本地导入会话的统一 ID 同样包含设备命名空间，同一份原始日志出现在多台设备时不会互相覆盖。

## 本地调试

```sh
bun apps/daemon/src/cli.ts debug \
  --agent codex --cwd /absolute/test/project \
  --model 当前可用模型 --prompt '只回复 hello，不调用工具'
bun apps/daemon/src/cli.ts index
```

`debug` 不经 Relay，输出统一 JSONL 信封；出现 agent 错误时退出状态非零。默认拒绝需要审批的工具。加上 `--interactive` 后，在 stdin 输入 `allow 审批ID` 或 `deny 审批ID`；Ctrl+C 会中断并关闭测试会话。使用 `--resume 原生会话ID` 可验证安全继续现有会话。`index --json` 会输出会话信息和标题，分享输出前由使用者自行决定范围。

权限模式为 `default`、`acceptEdits`、`plan`，不会使用 bypassPermissions 或 danger-full-access。Claude SDK 的 `canUseTool` 仅处理本地权限规则未自动允许的请求。Codex 审批不持久化“整个会话允许”或执行策略修订，仅决定当前请求；权限请求也只授予当前轮次要求的权限。无法用布尔审批表达的 MCP 表单/URL 交互会明确拒绝并提示在本地完成。

## 构建、服务与更新

```sh
bun run --cwd apps/daemon build:all
apps/daemon/dist/agentpaneld-darwin-arm64 --help
apps/daemon/dist/agentpaneld-darwin-arm64 install --preview
```

构建输出在 `apps/daemon/dist/`：`agentpaneld-darwin-arm64`、`agentpaneld-darwin-x64`、`agentpaneld-linux-x64`、`agentpaneld-linux-arm64`、`agentpaneld-windows-x64.exe`。macOS arm64 本地二进制和 Linux arm64 容器中的 `doctor` 已运行；其余目标的交叉编译不等于对应硬件实测。Linux 构建依赖 glibc，适用于 Debian/Ubuntu 等发行版，不直接用于 Alpine/musl。使用平台本机安装的 `claude` / `codex`；两个 agent 不嵌入 daemon。编译时源码和第三方 JS 依赖由 Bun 打包。

`install`/`uninstall` 操作当前用户的 launchd、systemd user 或 Windows 登录计划任务；无需为本产品开启系统级高权限。`--preview` 输出即将生成的文件和命令，不安装服务。卸载保留配置、token 和历史；需要彻底解绑时先在客户端吊销设备。

自动更新默认关闭，不配置公共更新来源。开启前设置 `updateManifestUrl`、`updatePublicKey`（PEM 格式 Ed25519 公钥）以及 `autoUpdate: true`。有任务运行或审批待处理时不更新。每六小时检查一次；必须通过 HTTPS、Ed25519 签名、有效期、递增版本、当前平台和精确字节数/SHA-256 检查。失败保留现有程序，成功保留 `.previous` 备份。macOS/Linux 原子替换，用户服务重新启动；Windows 使用等待当前进程退出的辅助脚本替换并重新启动，实际 Windows 服务/更新流程仍需实机验收。

自托管维护者可生成签名清单：

```sh
bun apps/daemon/scripts/sign-update.ts \
  --key /secure/path/update-private.pem --version 0.2.0 \
  --base-url https://your-release-host.example/0.2.0/ \
  --out /absolute/output/manifest.json
```

工具仅生成本地签名清单，不上传或发布。私钥由维护者保管，不能放进仓库或配置到 daemon。升级仅接受正式 `X.Y.Z` 版本。

## 验证

```sh
bun run --cwd apps/daemon typecheck
bun test apps/daemon/test
```

回归覆盖目录越界与符号链接、JSONL 增量和 Unicode、跨午夜/旧会话继续/计数器重置/fork 用量、超大历史分页、审批归属/超时、SDK/RPC 映射、真实本机 WebSocket ACK/重连/命令去重、服务参数转义、签名/防降级/下载哈希/替换备份。`test/fake-codex.ts` 是显式测试夹具，只供完整链路自动化使用，生产代码不会自动选择它。真实模型验证与这些确定性测试分别记录，Claude 真实调用在未授权付费凭据前不声称完成。
