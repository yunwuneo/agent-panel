# AgentPanel

用 Web、iPhone、iPad 或 Mac 查看和继续多台设备上的 Claude Code / Codex 会话，处理工具审批，并查看用量统计。客户端采用 Liquid Glass 设计。设备主动连接自托管 Relay，无需暴露设备端口。

这是本地可运行的 Bun/TypeScript monorepo。产品需求、架构、计划、ADR 与开发记录以 [Notion 项目页](https://app.notion.com/p/3e422e543e58801a88bdfe96533eacd2) 为准。

## 本地启动

需要 Bun 1.4.2、Docker。Apple 构建需要包含 Liquid Glass API 的 Xcode 26 或更新版本；当前代码兼容 iOS 18 / macOS 15 起。

```sh
bun install --frozen-lockfile
bun scripts/setup.ts owner@example.com
docker compose --env-file .env -f infra/compose.yml up -d postgres
bun apps/relay/src/migrate.ts
bun run dev
```

另开终端运行 `bun run dev:web`，打开 **http://localhost:5173**。Relay 在 **http://localhost:8787**，默认仅监听本机。`setup.ts` 生成权限为 `0600` 的 `.env`、随机注册凭证、JWT 密钥和 Web Push VAPID 密钥，不覆盖已有配置，也不打印凭据。

若当前机器使用项目内安装的 Bun，先运行 `export PATH="$PWD/.tools/node_modules/.bin:$PATH"`。项目私有 `.env` 已配置时跳过 setup。

首次注册：输入 `.env` 中的账号邮箱与 `BOOTSTRAP_TOKEN`，通过浏览器创建自己的通行密钥，随后妥善保存一次性恢复码。用户的实体/平台通行密钥需要本人确认；测试凭据只用于隔离测试数据库，不会替用户创建不可访问的账号。

## 连接设备

在 Web 的设备页生成配对码，然后在被控设备运行：

```sh
bun apps/daemon/src/cli.ts init --relay http://localhost:8787
bun apps/daemon/src/cli.ts pair --relay http://localhost:8787 --code YOUR_CODE
bun apps/daemon/src/cli.ts doctor
bun apps/daemon/src/cli.ts run
```

目录白名单可配置；`*` 明确表示全文件系统访问。本项目当前用户选择全范围开放。会话正在本地使用或无法可靠判断占用时，仍保持只读。审批超时、取消或无效时拒绝执行。详见 [Daemon 使用说明](apps/daemon/README.md)。

**认证要求：**

- Codex 通过官方 `codex app-server` 使用已有 ChatGPT 登录。若原有配置指向第三方 API provider，需显式选择官方 provider 和干净的配置目录；不会自动回退到可能计费的 API。
- Claude 使用官方 Agent SDK 和允许的 API/provider 凭据。Anthropic 不允许第三方应用直接复用 Claude 订阅登录额度；默认禁止新增 API 费用。未配置受支持凭据时，应用显示不可用原因。

## 功能与运行方式

- 设备配对、重命名、吊销；设备、账号和会话归属校验。
- 目录选择、Agent/模型/权限选择、新建会话、流式消息、工具调用及 diff、继续、审批、中断。
- Claude/Codex 原生历史的增量索引、项目分组、只读占用保护、历史查看与恢复；统计按 UTC 自然日归属用量并合并实时与历史来源。输入 Token 已含缓存读写，缓存项是输入的子集。
- Daemon SQLite 持久事件队列；Relay PostgreSQL 事件序号、持久化后 ACK、客户端补拉和幂等审批。
- Web Push 和 APNs provider，按设备/会话设置通知；原生通知允许/拒绝 action 通过 HTTP 工作。
- macOS 菜单栏待审批入口；Web 响应式界面及明暗主题；原生新系统使用 `glassEffect`、旧系统回退 Material。
- macOS/Linux/Windows 二进制构建、系统服务安装/卸载、验证签名的更新流程。未配置受信更新源时不会自动下载。

会话事件默认保留 30 天、审计 180 天，用量汇总长期保存，均可配置。原始本地日志不由 Relay 清理。费用是估算，未知模型价格显示未知。推送默认隐藏会话正文。

## Apple 构建

```sh
bun run generate
# 修改 project.yml 后重新生成；正常构建可直接使用已提交工程
cd apps/apple && xcodegen generate
```

回到仓库根目录运行：

```sh
xcodebuild -project apps/apple/AgentPanel.xcodeproj -scheme AgentPanelMac \
  -derivedDataPath .local/DerivedData CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/apple/AgentPanel.xcodeproj -scheme AgentPanel \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .local/DerivedData CODE_SIGNING_ALLOWED=NO build
```

macOS 应用位于 `.local/DerivedData/Build/Products/Debug/AgentPanelMac.app`；iOS 模拟器包位于对应 `Debug-iphonesimulator` 目录。Swift 模型由 Zod → JSON Schema → Codable 生成，禁止手改 `Generated` 文件。

Apple 真正的 Passkey 登录需要已签名 App、HTTPS 关联域名及 AASA；APNs 需要 Apple Team、签名/推送权限和服务器凭据。详见 [Apple 集成说明](apps/apple/README.md)。本地编译与模拟器 UI 验证不等同 APNs、真机或 TestFlight 验收。

## 验证

```sh
bun run generate
bun run typecheck
bun run lint
bun test packages apps/daemon apps/relay apps/web/src
bun scripts/check-swift.ts
bun run build
```

`TEST_DATABASE_URL` 指向测试 PostgreSQL 时执行数据库集成测试；每次创建独立 schema，最后仅移除该次测试数据。HTTP/WS 测试需要允许绑定回环端口。测试覆盖真实 WebAuthn 密码学、身份隔离、重用与重放、审批、更新签名、历史日志以及 Swift 双向协议。浏览器验收脚本和运行方法见 Web 目录。

GitHub Actions 配置包含 TS/协议/数据库及 Apple 构建检查；本地生成 workflow 文件不代表已经执行远端 CI。

本地验收已经运行真实 PostgreSQL 与 HTTP/WebSocket 全链路测试、Swift 双向协议检查、Web 生产构建、五平台 daemon 构建，以及 macOS/iOS 模拟器构建。macOS 已通过隔离测试的目录选择、新建会话、发送、允许、拒绝、重启补拉和统计页交互；iOS 已验证真实会话首帧。真实 Codex 的流式、继续、工具拒绝和中断也已使用现有 ChatGPT 登录验证。

浏览器 UI 验收因本次浏览器访问被拒绝而停止，不能视为已通过。Claude 真实生成仍需受支持的计费凭据；当前配置禁止新增 API 消费。APNs/Web Push 实际送达、签名原生 Passkey、Windows/WSL 实机及跨设备延迟仍需对应环境验证。主账号尚未注册，首次通行密钥须由本人创建。

## 自托管与贡献

容器整合运行：`docker compose --env-file .env -f infra/compose.yml --profile full up -d --build`。此模式 Web 与 API 同源，请将 `PUBLIC_ORIGIN` 与 `ALLOWED_ORIGINS` 设为实际访问地址；本地容器可使用 `http://localhost:8787`。公网部署需在前置代理配置 HTTPS/WSS，并正确设置 WebAuthn RP ID。

不要将 `.env`、设备 token、登录文件或真实会话内容提交到仓库。添加协议消息时先改 Zod 并重新生成。使用里程碑前缀提交信息，例如 `M2: 修复设备吊销后的 WebSocket 访问`。修改需求或架构前按 `AGENTS.md` 更新 Notion。许可证为 MIT。
