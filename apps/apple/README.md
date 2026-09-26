# Apple 客户端

同一 SwiftUI 工程包含 iOS 和 macOS target。支持登录/恢复、设备与会话、目录选择、新建/继续/中断、统一事件、审批、统计、通知设置和 macOS 菜单栏。

## 本地编译与界面验证

根目录 `bun run generate` 生成 `AgentPanel/Generated/Protocol.generated.swift`。`project.yml` 是工程生成输入；修改后运行 `xcodegen generate`。源码使用 Xcode 26+ 的 Liquid Glass API 并通过 availability 回退到 iOS 18/macOS 15 的 Material。

无签名构建可运行模拟器和本地 macOS 应用。默认连接 `http://localhost:8787`；只允许本机 HTTP，其他地址要求 HTTPS。Relay 地址存在用户偏好中，refresh token 存在 Keychain，access token 只保存在内存。

DEBUG 的 UI 测试可通过 `AGENTPANEL_QA_ORIGIN` 与 `AGENTPANEL_QA_ACCESS_TOKEN` 使用独立测试 Relay 的真实有效令牌；不会绕过服务端鉴权或持久化测试凭据。Release 不包含该入口。

## 原生 Passkey

1. 为两个 target 设置自己的 bundle ID 和签名 Team。
2. 添加 Associated Domains entitlement：`webcredentials:你的域名`。
3. Relay 设置对应 `WEBAUTHN_RP_ID`、HTTPS `PUBLIC_ORIGIN` 和 `APPLE_APP_IDS=TEAMID.bundleid,TEAMID.bundleid.mac`。验证其 `/.well-known/apple-app-site-association` 可被 Apple 访问。
4. 本人在 App 内通过系统通行密钥界面完成创建或登录。

本地 `localhost` 的 WebAuthn 浏览器测试与原生签名/关联域验证是两个不同的验收项目。未设置这些资源时不宣称原生通行密钥已端到端通过。

## APNs

为 App 配置 Push Notifications entitlement 和有效 provisioning profile；Relay 配置 `APNS_KEY_PATH`、`APNS_KEY_ID`、`APNS_TEAM_ID` 和环境开关。分别设置 `APNS_IOS_TOPIC=dev.agentpanel.client` 与 `APNS_MACOS_TOPIC=dev.agentpanel.client.mac`，服务器按设备平台选用 topic；两者都可回退到共享 `APNS_TOPIC`。实际值须匹配你签名的 bundle ID。

用户允许通知后，App 上报 APNs token。`AGENTPANEL_APPROVAL` 通知提供允许/拒绝 action，要求设备解锁；后台通过 Keychain 恢复凭据并调用 HTTP 审批接口，不依赖前台 WebSocket。提交失败时发出本地重试提示。任务通知点击会定位会话。

当前交付不自动签名、推送到 App Store Connect 或发布 TestFlight。Windows 真机和 Apple 生产推送资源不包含在本机验收环境中。
