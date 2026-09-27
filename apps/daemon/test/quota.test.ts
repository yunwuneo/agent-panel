import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentQuota } from "@agentpanel/protocol";
import { CapabilityMonitor } from "../src/capabilities";
import { configSchema } from "../src/config";
import { parseCredentials, parseQuota, type QuotaDependencies, queryQuota } from "../src/quota";

const config = configSchema.parse({
  claudeHome: join(homedir(), ".claude"),
  codexHome: "/fixture/codex",
});
const signal = () => new AbortController().signal;
const auth = (kind: "claude" | "codex") =>
  JSON.stringify(
    kind === "codex"
      ? {
          OPENAI_API_KEY: "never-send-api-key",
          tokens: { access_token: "fixture-secret", account_id: "fixture-account" },
        }
      : { claudeAiOauth: { accessToken: "fixture-secret", scopes: ["user:profile"] } },
  );
const deps = (overrides: Partial<QuotaDependencies> = {}): QuotaDependencies => ({
  platform: "linux",
  read: async () => auth("codex"),
  keychain: async () => undefined,
  fetch: async () =>
    Response.json({
      rate_limit: {
        primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1791050259 },
      },
    }),
  ...overrides,
});

test("quota periods follow provider duration and missing windows remain unknown", () => {
  const result = parseQuota(
    {
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 604800 },
        secondary_window: null,
      },
      access_token: "never-forward",
    },
    "codex",
    1000,
  );
  expect(result.windows).toEqual([
    { id: "primary_window", label: "每周", usedPercent: 0, windowMinutes: 10080 },
  ]);
  expect(result.staleAt).toBe(601000);
  expect(parseQuota({ rate_limit: null }, "codex").status).toBe("unavailable");
  expect(JSON.stringify(result)).not.toContain("never-forward");
  expect(() =>
    parseQuota({ rate_limit: { primary_window: { used_percent: 101 } } }, "codex"),
  ).toThrow();
});

test("Claude current nullable scopes do not break or duplicate session and weekly windows", () => {
  const result = parseQuota(
    {
      five_hour: { utilization: 13, resets_at: "2026-09-27T04:20:00.190963+00:00" },
      seven_day: { utilization: 53 },
      seven_day_sonnet: null,
      limits: [
        { kind: "session", group: "session", percent: 13, scope: null, is_active: false },
        { kind: "weekly_all", group: "weekly", percent: 53, scope: null, is_active: true },
      ],
    },
    "claude",
  );
  expect(result.windows).toHaveLength(2);
  expect(result.windows[0]?.resetsAt).toBe(Date.parse("2026-09-27T04:20:00.190963+00:00"));
  expect(
    parseQuota(
      {
        limits: [
          { kind: "weekly_all", percent: 1 },
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 4,
            scope: { model: { display_name: "Sonnet" } },
          },
        ],
      },
      "claude",
    ).windows,
  ).toHaveLength(2);
  expect(() => parseQuota({ five_hour: { utilization: 5, resets_at: "bad" } }, "claude")).toThrow();
});

test("Codex reads only scoped OAuth tokens and uses a fixed official GET with redirects rejected", async () => {
  let calls = 0;
  const result = await queryQuota(
    config,
    "codex",
    signal(),
    deps({
      read: async (path) => {
        expect(path).toBe("/fixture/codex/auth.json");
        return auth("codex");
      },
      fetch: async (url, init) => {
        calls++;
        expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-secret");
        expect(new Headers(init.headers).get("ChatGPT-Account-Id")).toBe("fixture-account");
        expect(init.body).toBeUndefined();
        return Response.json({ rate_limit: { primary_window: { used_percent: 8 } } });
      },
    }),
  );
  expect(result.status).toBe("available");
  expect(calls).toBe(1);
  expect(JSON.stringify(result)).not.toContain("fixture-");
  expect(parseCredentials({ OPENAI_API_KEY: "api-only" }, "codex")).toBeUndefined();
});

test("macOS Claude uses native keychain, custom profiles never borrow the default account", async () => {
  let keychain = 0;
  let requests = 0;
  const sources = deps({
    platform: "darwin",
    keychain: async () => {
      keychain++;
      return auth("claude");
    },
    read: async () => undefined,
    fetch: async (url, init) => {
      requests++;
      expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
      expect(new Headers(init.headers).get("anthropic-beta")).toBe("oauth-2025-04-20");
      return Response.json({ seven_day: { utilization: 5 } });
    },
  });
  expect((await queryQuota(config, "claude", signal(), sources)).status).toBe("available");
  expect(
    (await queryQuota({ ...config, claudeHome: "/other-profile" }, "claude", signal(), sources))
      .status,
  ).toBe("unavailable");
  expect(keychain).toBe(1);
  expect(requests).toBe(1);
  expect(() =>
    parseCredentials(
      { claudeAiOauth: { accessToken: "secret", scopes: ["user:inference"] } },
      "claude",
    ),
  ).toThrow("user:profile");
});

test("disabled and missing credentials never make network calls; provider errors never leak bodies", async () => {
  let calls = 0;
  const sources = deps({
    read: async () => undefined,
    fetch: async () => {
      calls++;
      throw new Error("secret");
    },
  });
  expect((await queryQuota(config, "codex", signal(), sources)).status).toBe("unavailable");
  expect(
    (await queryQuota({ ...config, quotaEnabled: false }, "codex", signal(), sources)).status,
  ).toBe("unavailable");
  expect(calls).toBe(0);
  for (const status of [401, 403, 429, 500]) {
    const result = await queryQuota(
      config,
      "codex",
      signal(),
      deps({
        fetch: async () =>
          new Response("fixture-secret", { status, headers: { "retry-after": "600" } }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(result.windows).toEqual([]);
    if (status === 429) expect(result.retryAt!).toBeGreaterThan(Date.now() + 590000);
    else if (status === 401 || status === 403) expect(result.status).toBe("unavailable");
    else expect(result.status).toBe("error");
  }
  const malformed = await queryQuota(
    config,
    "codex",
    signal(),
    deps({ read: async () => "invalid-secret-json" }),
  );
  expect(JSON.stringify(malformed)).not.toContain("invalid-secret-json");
});

test("abort prevents HTTP and excessive response bodies are rejected", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await queryQuota(
    config,
    "codex",
    controller.signal,
    deps({
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    }),
  );
  expect(calls).toBe(0);
  const large = await queryQuota(
    config,
    "codex",
    signal(),
    deps({ fetch: async () => new Response("x".repeat(1024 * 1024 + 1)) }),
  );
  expect(large.status).toBe("error");
  expect(large.message).toContain("过大");
});

test("monitor coalesces refresh, honors backoff, and never enables paid execution", async () => {
  let now = 1000;
  let calls = 0;
  let complete!: (quota: AgentQuota) => void;
  const updates: AgentQuota[] = [];
  const monitor = new CapabilityMonitor(
    config,
    [{ kind: "codex", installed: true, authenticated: false }],
    (agents) => {
      updates.push(agents[0]!.quota!);
    },
    async () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    () => now,
  );
  const first = monitor.refresh();
  const second = monitor.refresh(true);
  expect(calls).toBe(1);
  expect(monitor.agents[0]?.quota?.status).toBe("loading");
  complete({ status: "error", windows: [], checkedAt: now, retryAt: 601000 });
  await Promise.all([first, second]);
  now = 301000;
  await monitor.refresh(true);
  await monitor.refresh();
  expect(calls).toBe(1);
  now = 601000;
  const retry = monitor.refresh();
  complete(parseQuota({ rate_limit: { primary_window: { used_percent: 5 } } }, "codex", now));
  await retry;
  expect(calls).toBe(2);
  expect(updates).toHaveLength(2);
  expect(monitor.agents[0]?.executionAvailable).toBe(false);
  await monitor.close();
  await monitor.refresh(true);
  expect(calls).toBe(2);
});

test("shutdown cancels in-flight work without late capability publication", async () => {
  let published = false;
  const monitor = new CapabilityMonitor(
    config,
    [{ kind: "claude", installed: true }],
    () => {
      published = true;
    },
    async (_c, _k, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () =>
          resolve({ status: "error", checkedAt: 0, windows: [] }),
        );
      }),
  );
  const running = monitor.refresh();
  await monitor.close();
  await running;
  expect(published).toBe(false);
});
