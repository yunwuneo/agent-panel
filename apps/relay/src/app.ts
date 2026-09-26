import { resolve } from "node:path";
import { AgentCapabilitySchema, parseEnvelope } from "@agentpanel/protocol";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import {
  ApiError,
  AuthService,
  digest,
  missing,
  type Principal,
  type Tokens,
  token,
  unauthorized,
  type WebAuthnProvider,
} from "./auth";
import type { RelayConfig } from "./config";
import { Hub } from "./hub";
import { PushService } from "./push";
import type { Store } from "./store";

type Env = { Variables: { principal: Principal }; Bindings: { remoteAddress?: string } };
const emailSchema = z.string().email().max(320);
const passkeyResponse = z.record(z.string(), z.unknown());
const publicRoutes = new Set([
  "/api/auth/status",
  "/api/auth/register/options",
  "/api/auth/register/verify",
  "/api/auth/login/options",
  "/api/auth/login/verify",
  "/api/auth/recovery/options",
  "/api/auth/refresh",
  "/api/pairing/redeem",
]);

export function createRelay(store: Store, config: RelayConfig, webauthn?: WebAuthnProvider) {
  const app = new Hono<Env>();
  const auth = new AuthService(store, config, webauthn);
  const push = new PushService(store, config);
  const hub = new Hub(store, auth, config, (owner, kind, event) => push.notify(owner, kind, event));
  const limiter = new RateLimiter();
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: config.allowedOrigins,
      credentials: true,
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
  app.onError((error, c) => {
    if (error instanceof ApiError)
      return c.json({ error: { code: error.code, message: error.message } }, error.status as never);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: { code: "INVALID_REQUEST", message: "请求格式无效" } }, 400);
    console.error("Relay request failed", error.name); // never log payloads, tokens, or authentication responses
    return c.json({ error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } }, 500);
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const origin = c.req.header("origin");
    if (origin && !config.allowedOrigins.includes(origin))
      throw new ApiError(403, "ORIGIN_FORBIDDEN", "来源不受信任");
    const remote = c.env?.remoteAddress ?? "local";
    if (!limiter.take(`ip:${remote}`, 300, 60_000))
      throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试");
    if (publicRoutes.has(c.req.path)) {
      if (c.req.method !== "GET" && !limiter.take(`auth:${remote}`, 30, 60_000))
        throw new ApiError(429, "RATE_LIMITED", "认证请求过于频繁，请稍后重试");
    } else {
      // Authenticate before body parsing and route validation, including nonexistent routes.
      const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
      if (!bearer) throw unauthorized();
      const principal = await auth.authenticate(bearer);
      if (principal.role !== "client")
        throw new ApiError(403, "CLIENT_REQUIRED", "此接口仅对客户端开放");
      c.set("principal", principal);
      if (!limiter.take(`user:${principal.owner}`, 600, 60_000))
        throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试");
    }
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > 1024 * 1024) throw new ApiError(413, "BODY_TOO_LARGE", "请求过大");
    await next();
  });
  const body = async <T>(
    c: { req: { text(): Promise<string> } },
    schema: z.ZodType<T>,
  ): Promise<T> => {
    const text = await c.req.text();
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new ApiError(413, "BODY_TOO_LARGE", "请求过大");
    return schema.parse(text ? JSON.parse(text) : {});
  };
  const tokensResponse = (c: Parameters<typeof getCookie>[0], tokens: Tokens, native = false) => {
    if (!native) {
      setCookie(c, "ap_refresh", tokens.refreshToken, {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: "Strict",
        path: "/api/auth",
        maxAge: Math.floor(config.refreshTtlMs / 1000),
      });
    }
    const { refreshToken, ...rest } = tokens;
    return c.json(native ? { ...rest, refreshToken } : rest);
  };
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/.well-known/apple-app-site-association", (c) =>
    c.json({ webcredentials: { apps: config.appleAppIds ?? [] } }),
  );
  app.get("/ready", async (c) => {
    await store.ping();
    return c.json({ status: "ready" });
  });
  app.get("/api/auth/status", async (c) => c.json(await auth.status()));
  app.post("/api/auth/register/options", async (c) => {
    const input = await body(
      c,
      z.object({ email: emailSchema, bootstrapToken: z.string().min(1).max(1000) }),
    );
    return c.json(await auth.registrationOptions(input.email, input.bootstrapToken));
  });
  app.post("/api/auth/register/verify", async (c) => {
    const input = await body(
      c,
      z.object({
        challengeId: z.string().max(256),
        response: passkeyResponse,
        native: z.boolean().optional(),
      }),
    );
    return tokensResponse(
      c,
      await auth.registrationVerify(input.challengeId, input.response as never),
      input.native,
    );
  });
  app.post("/api/auth/login/options", async (c) => {
    const input = await body(c, z.object({ email: emailSchema }));
    return c.json(await auth.loginOptions(input.email));
  });
  app.post("/api/auth/login/verify", async (c) => {
    const input = await body(
      c,
      z.object({
        challengeId: z.string().max(256),
        response: passkeyResponse,
        native: z.boolean().optional(),
      }),
    );
    return tokensResponse(
      c,
      await auth.loginVerify(input.challengeId, input.response as never),
      input.native,
    );
  });
  app.post("/api/auth/recovery/options", async (c) => {
    const input = await body(
      c,
      z.object({ email: emailSchema, recoveryCode: z.string().min(1).max(256) }),
    );
    return c.json(await auth.recoveryOptions(input.email, input.recoveryCode));
  });
  app.post("/api/auth/refresh", async (c) => {
    const input = await body(
      c,
      z.object({ refreshToken: z.string().max(256).optional(), native: z.boolean().optional() }),
    );
    // Browser cookie refresh requires an exact Origin. Native clients explicitly send their token.
    if (!input.refreshToken && !config.allowedOrigins.includes(c.req.header("origin") ?? ""))
      throw new ApiError(403, "ORIGIN_REQUIRED", "刷新登录需要受信任来源");
    const refresh = input.refreshToken ?? getCookie(c, "ap_refresh");
    if (!refresh) throw unauthorized();
    return tokensResponse(c, await auth.refresh(refresh), input.native);
  });
  app.get("/api/auth/me", async (c) => {
    const p = c.get("principal");
    const user = await store.get("users", p.owner, p.owner);
    return c.json({ user: { id: p.owner, email: user?.email } });
  });
  app.post("/api/auth/logout", async (c) => {
    await auth.logout(c.get("principal"));
    deleteCookie(c, "ap_refresh", { path: "/api/auth" });
    return c.json({ ok: true });
  });
  app.post("/api/ws-ticket", async (c) => c.json(await auth.ticket(c.get("principal"))));
  app.get("/api/devices", async (c) =>
    c.json({ devices: await hub.devices(c.get("principal").owner) }),
  );
  app.post("/api/pairing", async (c) => {
    const code = token(12).replace(/[-_]/g, "A").toUpperCase();
    const expiresAt = Date.now() + 300_000;
    await store.put("pairing_codes", {
      id: digest(code),
      owner: c.get("principal").owner,
      createdAt: Date.now(),
      expiresAt,
    });
    return c.json({ code, expiresAt });
  });
  app.post("/api/pairing/redeem", async (c) => {
    const input = await body(
      c,
      z.object({
        code: z.string().min(1).max(128),
        name: z.string().min(1).max(128),
        platform: z.string().min(1).max(64),
        hostname: z.string().max(256).optional(),
        agents: z.array(AgentCapabilitySchema).optional(),
      }),
    );
    const hash = digest(input.code.replace(/[\s-]/g, "").toUpperCase());
    const result = await store.atomic(`pair:${hash}`, async (tx) => {
      const pairing = await tx.get("pairing_codes", hash);
      if (!pairing?.expiresAt || pairing.expiresAt < Date.now())
        throw new ApiError(400, "PAIRING_INVALID", "配对码无效或已过期");
      const deviceId = `dev_${token(16)}`,
        deviceToken = `apd_${token()}`;
      await tx.put("devices", {
        id: deviceId,
        owner: pairing.owner,
        createdAt: Date.now(),
        name: input.name,
        platform: input.platform,
        hostname: input.hostname,
        agents: input.agents ?? [],
        tokenHash: digest(deviceToken),
        online: false,
        lastSeen: Date.now(),
      });
      await tx.remove("pairing_codes", hash);
      await auth.audit(tx, "device.pair", { deviceId }, pairing.owner);
      return { deviceId, deviceToken };
    });
    return c.json(result);
  });
  app.patch("/api/devices/:id", async (c) => {
    const input = await body(c, z.object({ name: z.string().min(1).max(128) }));
    const owner = c.get("principal").owner;
    const device = await store.atomic(`tenant:${owner}`, async (tx) => {
      const row = await tx.get("devices", c.req.param("id"), owner);
      if (!row || row.revokedAt) throw missing();
      const updated = { ...row, name: input.name };
      await tx.put("devices", updated);
      return updated;
    });
    return c.json({ device: hub.publicDevice(device as never) });
  });
  app.delete("/api/devices/:id", async (c) => {
    const owner = c.get("principal").owner;
    await store.atomic(`tenant:${owner}`, async (tx) => {
      const row = await tx.get("devices", c.req.param("id"), owner);
      if (!row) throw missing();
      await tx.put("devices", { ...row, revokedAt: Date.now(), online: false });
      for (const approval of await tx.list("approvals", owner))
        if (approval.deviceId === row.id && approval.status === "pending")
          await tx.put("approvals", {
            ...approval,
            status: "denied",
            reason: "设备已解绑",
            decisionAt: Date.now(),
          });
      await auth.audit(tx, "device.revoke", { deviceId: row.id }, owner);
    });
    hub.disconnectDevice(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/sessions", async (c) =>
    c.json({ sessions: await hub.sessions(c.get("principal").owner, c.req.query()) }),
  );
  app.get("/api/sessions/:id/events", async (c) => {
    const query = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
      })
      .parse(c.req.query());
    return c.json(
      await hub.events(c.get("principal").owner, c.req.param("id"), query.after, query.limit),
    );
  });
  app.post("/api/commands", async (c) =>
    c.json(await hub.command(c.get("principal").owner, parseEnvelope(await body(c, z.unknown())))),
  );
  app.get("/api/approvals", async (c) => {
    const rows = (await store.list("approvals", c.get("principal").owner)).map((r) =>
      hub.publicApproval(r),
    );
    return c.json({
      approvals: rows.filter((r) => !c.req.query("status") || r.status === c.req.query("status")),
    });
  });
  app.post("/api/approvals/:id/decision", async (c) => {
    const input = await body(
      c,
      z.object({ decision: z.enum(["allow", "deny"]), reason: z.string().max(2000).optional() }),
    );
    return c.json({
      approval: await hub.decide(
        c.get("principal").owner,
        c.req.param("id"),
        input.decision,
        input.reason,
      ),
    });
  });
  app.get("/api/stats", async (c) => {
    const input = z
      .object({
        deviceId: z.string().optional(),
        agent: z.enum(["claude", "codex"]).optional(),
        project: z.string().optional(),
        from: z.coerce.number().nonnegative().optional(),
        to: z.coerce.number().nonnegative().optional(),
        groupBy: z.enum(["day", "device", "agent", "project"]).optional(),
      })
      .parse(c.req.query());
    return c.json(await hub.stats(c.get("principal").owner, input));
  });
  app.get("/api/audit", async (c) => {
    const rows = await store.list("audit", c.get("principal").owner);
    return c.json({
      entries: rows
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 500)
        .map(({ owner: _owner, ...r }) => r),
    });
  });
  app.get("/api/push/config", (c) => c.json(push.status()));
  app.post("/api/push/web", async (c) => {
    const input = await body(
      c,
      z.object({
        endpoint: z.string().url().max(4096),
        keys: z.object({ p256dh: z.string().min(1).max(1024), auth: z.string().min(1).max(1024) }),
      }),
    );
    return c.json(await push.registerWeb(c.get("principal").owner, input));
  });
  app.post("/api/push/apns", async (c) => {
    const input = await body(
      c,
      z.object({
        token: z.string().regex(/^[0-9a-fA-F]{64,256}$/),
        platform: z.enum(["ios", "macos"]),
      }),
    );
    return c.json(await push.registerAPNs(c.get("principal").owner, input.token, input.platform));
  });
  app.delete("/api/push/:id", async (c) => {
    const row = await store.get("push_subscriptions", c.req.param("id"), c.get("principal").owner);
    if (!row) throw missing();
    await store.remove("push_subscriptions", row.id);
    return c.json({ ok: true });
  });
  app.get("/api/push/settings", async (c) =>
    c.json({ settings: await push.settings(c.get("principal").owner) }),
  );
  app.put("/api/push/settings", async (c) => {
    const input = await body(
      c,
      z.object({
        deviceId: z.string().optional(),
        sessionId: z.string().optional(),
        enabled: z.boolean().optional(),
        approval: z.boolean().optional(),
        completed: z.boolean().optional(),
        error: z.boolean().optional(),
        waiting: z.boolean().optional(),
        preview: z.boolean().optional(),
      }),
    );
    const owner = c.get("principal").owner;
    if (
      (input.deviceId && !(await store.get("devices", input.deviceId, owner))) ||
      (input.sessionId && !(await store.get("sessions", input.sessionId, owner)))
    )
      throw missing();
    return c.json({ setting: await push.updateSetting(owner, input) });
  });
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "接口不存在" } }, 404));
  if (process.env.WEB_DIST) {
    const root = resolve(process.env.WEB_DIST);
    app.get("/assets/*", serveStatic({ root, rewriteRequestPath: (path) => path }));
    app.get("/sw.js", serveStatic({ root, path: "sw.js" }));
    app.get("/icon.svg", serveStatic({ root, path: "icon.svg" }));
    app.get("/manifest.webmanifest", serveStatic({ root, path: "manifest.webmanifest" }));
    app.get("*", async (c, next) => {
      if (c.req.path.startsWith("/api/") || c.req.path === "/ws") return next();
      return serveStatic({ root, path: "index.html" })(c, next);
    });
  }
  return { app, auth, hub, push, initialize: () => auth.initialize() };
}

export class RateLimiter {
  private entries = new Map<string, { count: number; resetAt: number }>();
  take(key: string, limit: number, period: number, now = Date.now()): boolean {
    if (this.entries.size > 10_000)
      for (const [id, row] of this.entries) if (row.resetAt <= now) this.entries.delete(id);
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + period });
      return true;
    }
    current.count++;
    return current.count <= limit;
  }
}
