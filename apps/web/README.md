# AgentPanel Web

React 19、Vite、TanStack Query 客户端，使用共享的 `@agentpanel/protocol` 协议。

在仓库根目录安装依赖、配置并启动 Relay 后运行：

```sh
bun run --cwd apps/web dev
```

默认只监听 `127.0.0.1:5173`，将 `/api`、`/ws` 转发到本机 `8787`。其他 Relay 端口使用 `RELAY_URL`。访问来源必须列入 Relay 的 `ALLOWED_ORIGINS`，Passkey 的 RP ID 必须与域名匹配；本地使用 `localhost`。

首次登录以 Relay 配置的账号邮箱与 `BOOTSTRAP_TOKEN` 注册 Passkey，随后显示一次性恢复码。前端仅在内存中保存 access token，refresh token 使用 Relay 设置的 HttpOnly Cookie；重载页面会刷新登录并补拉会话事件。

```sh
bun run --cwd apps/web build
bun run --cwd apps/web test
bun run --cwd apps/web test:e2e
```

`build` 同时执行 TypeScript 检查，产物在 `dist/`；Relay 使用 `WEB_DIST` 指向此目录即可同源提供静态客户端。Web Push 的 service worker 为 `/sw.js`，需配置 Relay VAPID；iOS 浏览器需先将页面添加到主屏幕。通知正文默认隐藏。

浏览器测试需要本机 Chrome、Bun 和有效的本地 `TEST_DATABASE_URL` 或根目录 `.env` 中的 `DATABASE_URL`。测试自动建立独立 PostgreSQL schema、localhost Relay 和隔离的设备目录，并通过 Chrome 虚拟 CTAP2 认证器完成真实 WebAuthn 验证。它使用真实 Relay、Daemon Manager、审批、SQLite journal 与 WebSocket，只将外部模型提供商替换成确定性的测试 adapter。测试不使用正式账号、不读取真实会话，也不调用付费模型。结束后删除测试 schema 与临时目录。

验收覆盖注册、恢复码确认、配对、重命名、目录选择、新建会话、流式内容、允许/拒绝、中断、持久化补拉、统计、通知偏好、深浅色及移动布局、退出与再次 Passkey 登录。截图输出到仓库 `.local/web-screenshots/`，失败跟踪位于 `.local/web-e2e-results/`。真实浏览器推送送达需要另行验证。

视觉采用分层半透明材质；跟随系统深浅色、减少动态效果及减少透明度偏好，设置页也可显式减少透明度。Markdown 不执行 HTML；工具 diff 只作为会话工具结果展示。
