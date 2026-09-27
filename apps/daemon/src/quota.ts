import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentKind,
  type AgentQuota,
  AgentQuotaSchema,
  type QuotaWindow,
} from "@agentpanel/protocol";
import { z } from "zod";
import type { Config } from "./config";

const percentage = z.number().min(0).max(100);
const codexWindow = z.object({
  used_percent: percentage,
  limit_window_seconds: z.number().int().positive().optional(),
  reset_at: z.number().int().nonnegative().optional(),
});
const claudeWindow = z.object({
  utilization: percentage.nullish(),
  resets_at: z.string().nullish(),
});
const codexResponse = z.object({
  rate_limit: z
    .object({ primary_window: codexWindow.nullish(), secondary_window: codexWindow.nullish() })
    .nullish(),
});
const claudeResponse = z.object({
  five_hour: claudeWindow.nullish(),
  seven_day: claudeWindow.nullish(),
  seven_day_opus: claudeWindow.nullish(),
  seven_day_sonnet: claudeWindow.nullish(),
  seven_day_oauth_apps: claudeWindow.nullish(),
  limits: z
    .array(
      z.object({
        kind: z.string().optional(),
        group: z.string().optional(),
        percent: percentage.nullish(),
        resets_at: z.string().nullish(),
        is_active: z.boolean().optional(),
        scope: z
          .object({ model: z.object({ display_name: z.string().max(60).optional() }).nullish() })
          .nullish(),
      }),
    )
    .max(100)
    .nullish(),
});

class QuotaError extends Error {
  constructor(
    message: string,
    readonly status: "error" | "unavailable" = "error",
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

/** Normalize only measurements; never transport credentials, account IDs or provider diagnostics. */
export function parseQuota(
  value: unknown,
  kind: AgentKind,
  now = Date.now(),
  maxAgeMs = 600_000,
): AgentQuota {
  const windows: QuotaWindow[] = [];
  if (kind === "codex") {
    const data = codexResponse.parse(value);
    for (const [id, window] of Object.entries(data.rate_limit ?? {})) {
      if (!window) continue;
      const minutes = window.limit_window_seconds
        ? Math.ceil(window.limit_window_seconds / 60)
        : undefined;
      windows.push({
        id,
        label:
          minutes === 300
            ? "5 小时"
            : minutes === 10080
              ? "每周"
              : id === "primary_window"
                ? "主额度"
                : "次额度",
        usedPercent: window.used_percent,
        ...(minutes ? { windowMinutes: minutes } : {}),
        ...(window.reset_at !== undefined ? { resetsAt: window.reset_at * 1000 } : {}),
      });
    }
  } else {
    const data = claudeResponse.parse(value);
    const append = (
      id: string,
      label: string,
      minutes: number | undefined,
      used: number | null | undefined,
      reset: string | null | undefined,
    ) => {
      if (used == null) return;
      const resetsAt = reset ? Date.parse(reset) : undefined;
      if (resetsAt !== undefined && (!Number.isFinite(resetsAt) || resetsAt < 0))
        throw new QuotaError("额度接口返回了无效的重置时间");
      windows.push({
        id,
        label,
        usedPercent: used,
        ...(minutes ? { windowMinutes: minutes } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      });
    };
    const session = data.limits?.find((limit) => limit.kind === "session");
    const weekly = data.limits?.find((limit) => limit.kind === "weekly_all");
    append(
      "five_hour",
      "5 小时",
      300,
      data.five_hour?.utilization ?? session?.percent,
      data.five_hour?.resets_at ?? session?.resets_at,
    );
    append(
      "seven_day",
      "每周",
      10080,
      data.seven_day?.utilization ?? weekly?.percent,
      data.seven_day?.resets_at ?? weekly?.resets_at,
    );
    const scoped = (data.limits ?? []).filter(
      (limit) =>
        limit.is_active !== false &&
        limit.percent != null &&
        (limit.kind === "weekly_scoped" || limit.scope?.model?.display_name),
    );
    if (scoped.length) {
      for (const [i, limit] of scoped.slice(0, 14).entries()) {
        const weekly = limit.group === "weekly" || limit.kind?.startsWith("weekly");
        append(
          `limit:${i}`,
          `${limit.scope?.model?.display_name ?? "附加额度"}${weekly ? " · 每周" : ""}`,
          weekly ? 10080 : undefined,
          limit.percent,
          limit.resets_at,
        );
      }
    } else {
      for (const [id, label] of [
        ["seven_day_opus", "Opus · 每周"],
        ["seven_day_sonnet", "Sonnet · 每周"],
        ["seven_day_oauth_apps", "OAuth 应用 · 每周"],
      ] as const) {
        append(id, label, 10080, data[id]?.utilization, data[id]?.resets_at);
      }
    }
  }
  return AgentQuotaSchema.parse({
    status: windows.length ? "available" : "unavailable",
    windows,
    source: kind === "codex" ? "ChatGPT OAuth" : "Claude OAuth",
    checkedAt: now,
    updatedAt: now,
    staleAt: now + maxAgeMs,
    ...(!windows.length ? { message: "该账户未返回可用的订阅额度窗口" } : {}),
  });
}

type Credentials = { token: string; accountId?: string };
const text = z.string().trim().min(1).max(32_768);
export function parseCredentials(value: unknown, kind: AgentKind): Credentials | undefined {
  if (kind === "codex") {
    const data = z
      .object({
        tokens: z
          .object({
            access_token: text.optional(),
            accessToken: text.optional(),
            account_id: text.optional(),
            accountId: text.optional(),
          })
          .nullish(),
      })
      .parse(value);
    const token = data.tokens?.access_token ?? data.tokens?.accessToken;
    return token
      ? { token, accountId: data.tokens?.account_id ?? data.tokens?.accountId }
      : undefined;
  }
  const data = z
    .object({
      claudeAiOauth: z
        .object({ accessToken: text.optional(), scopes: z.array(z.string()).optional() })
        .nullish(),
    })
    .parse(value);
  const oauth = data.claudeAiOauth;
  if (oauth?.scopes && !oauth.scopes.includes("user:profile"))
    throw new QuotaError(
      "Claude 登录缺少 user:profile 权限，请在本机重新运行 claude auth login",
      "unavailable",
    );
  return oauth?.accessToken ? { token: oauth.accessToken } : undefined;
}

/** macOS security output stays in memory. No shell, arguments containing secrets, or stderr forwarding. */
export function readClaudeKeychain(signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new QuotaError("额度查询已取消"));
      return;
    }
    const child = spawn(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    let tooLarge = false;
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(stop, 10_000);
    signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > 1024 * 1024) {
        tooLarge = true;
        stop();
      } else output += chunk;
    });
    child.on("error", () => {
      cleanup();
      reject(new QuotaError("无法读取 Claude 登录钥匙串，请检查本机访问权限", "unavailable"));
    });
    child.on("close", (code) => {
      cleanup();
      if (code === 0 && !tooLarge) resolve(output);
      else if (code === 44)
        resolve(undefined); // errSecItemNotFound
      else
        reject(
          new QuotaError(
            "Claude 钥匙串不可用或访问超时，请在本机解锁钥匙串并允许读取",
            "unavailable",
          ),
        );
    });
  });
}

export type QuotaDependencies = {
  read: (path: string) => Promise<string | undefined>;
  keychain: (signal: AbortSignal) => Promise<string | undefined>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  platform: string;
};
const defaults: QuotaDependencies = {
  async read(path) {
    try {
      if ((await stat(path)).size > 1024 * 1024)
        throw new QuotaError("本机认证文件过大，无法查询额度", "unavailable");
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new QuotaError("无法读取本机认证文件，请检查登录与文件权限", "unavailable");
    }
  },
  keychain: readClaudeKeychain,
  fetch: (url, init) => fetch(url, init),
  platform: process.platform,
};

async function credentials(
  config: Config,
  kind: AgentKind,
  signal: AbortSignal,
  deps: QuotaDependencies,
): Promise<Credentials> {
  let raw: string | undefined;
  if (
    kind === "claude" &&
    deps.platform === "darwin" &&
    resolve(config.claudeHome) === join(homedir(), ".claude")
  ) {
    try {
      raw = await deps.keychain(signal);
    } catch (error) {
      raw = await deps.read(join(config.claudeHome, ".credentials.json"));
      if (!raw) throw error;
    }
  }
  raw ??= await deps.read(
    join(
      kind === "codex" ? config.codexHome : config.claudeHome,
      kind === "codex" ? "auth.json" : ".credentials.json",
    ),
  );
  const parsed = raw ? parseCredentials(JSON.parse(raw), kind) : undefined;
  if (!parsed)
    throw new QuotaError(
      kind === "codex"
        ? "未找到该 Codex 目录的 ChatGPT 订阅登录，请在本机运行 codex login"
        : "未找到该 Claude 目录的订阅登录，请在本机运行 claude auth login",
      "unavailable",
    );
  return parsed;
}

export async function queryQuota(
  config: Config,
  kind: AgentKind,
  signal: AbortSignal,
  deps: QuotaDependencies = defaults,
): Promise<AgentQuota> {
  const failure = (
    status: "error" | "unavailable",
    message: string,
    retryAt?: number,
  ): AgentQuota => ({
    status,
    checkedAt: Date.now(),
    message,
    windows: [],
    ...(retryAt ? { retryAt } : {}),
  });
  if (!config.quotaEnabled) return failure("unavailable", "本设备已关闭订阅额度查询");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  try {
    const auth = await credentials(config, kind, bounded, deps);
    bounded.throwIfAborted();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/json",
    };
    if (kind === "codex" && auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
    if (kind === "claude") {
      headers["anthropic-beta"] = "oauth-2025-04-20";
      headers["User-Agent"] = "claude-code/2.1.0";
      headers["Content-Type"] = "application/json";
    }
    const response = await deps.fetch(
      kind === "codex"
        ? "https://chatgpt.com/backend-api/wham/usage"
        : "https://api.anthropic.com/api/oauth/usage",
      { method: "GET", headers, signal: bounded, redirect: "error" },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401)
        throw new QuotaError("订阅登录已失效，请在本机 CLI 重新登录后刷新额度", "unavailable");
      if (response.status === 403)
        throw new QuotaError(
          "订阅额度接口拒绝访问，请检查本机账户权限或网络访问限制",
          "unavailable",
        );
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        const delay =
          retry && /^\d+(\.\d+)?$/.test(retry)
            ? Number(retry) * 1000
            : retry
              ? Date.parse(retry) - Date.now()
              : 300_000;
        const retryAt =
          Date.now() +
          Math.max(60_000, Math.min(Number.isFinite(delay) ? delay : 300_000, 86_400_000));
        throw new QuotaError("额度查询受到限流，稍后自动重试", "error", retryAt);
      }
      throw new QuotaError(`额度接口暂时不可用（HTTP ${response.status}）`);
    }
    // Bound the body as well as the request lifetime. Error bodies are never surfaced.
    const reader = response.body?.getReader();
    if (!reader) throw new QuotaError("额度接口未返回数据");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new QuotaError("额度接口返回的数据过大");
      }
      chunks.push(value);
    }
    return parseQuota(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      kind,
      Date.now(),
      config.quotaRefreshIntervalMs * 2,
    );
  } catch (error) {
    if (bounded.aborted)
      return failure("error", signal.aborted ? "额度查询已取消" : "额度查询超时，请检查设备网络");
    return error instanceof QuotaError
      ? failure(error.status, error.message, error.retryAt)
      : failure("error", "无法读取订阅额度，请检查本机登录、网络或接口格式变化");
  }
}
