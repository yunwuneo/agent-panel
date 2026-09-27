import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Approval,
  type Envelope,
  makeEnvelope,
  parseEnvelope,
  type SessionEvent,
} from "@agentpanel/protocol";
import { ClaudeAdapter, claudeAuthentication } from "../src/adapters/claude";
import { CodexAdapter, codexProfileProblem } from "../src/adapters/codex";
import { RpcProcess } from "../src/adapters/rpc";
import { ApprovalBroker } from "../src/approvals";
import { configSchema, validateRelayUrl } from "../src/config";
import { allowedDirectory, listDirectories } from "../src/directories";
import {
  type IndexedSession,
  LocalSessionIndexer,
  parseRecord,
  type ScanState,
} from "../src/indexer";
import { SessionManager } from "../src/manager";
import { servicePlan } from "../src/services";
import { Store } from "../src/store";
import { RelayConnection } from "../src/transport";
import { installUpdate, stageUpdate, verifyManifest, windowsUpdateScript } from "../src/updater";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const memory = () => {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
};
const config = (input: Record<string, unknown> = {}) => configSchema.parse({ ...input });
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("目录与持久化安全", () => {
  test("拒绝白名单外目录、前缀碰撞和越界符号链接；'*' 是显式全盘授权", async () => {
    const root = await mkdtemp(join(tmpdir(), "ap-directory-"));
    const safe = join(root, "safe"),
      outside = join(root, "safe-elsewhere");
    await mkdir(safe);
    await mkdir(outside);
    await mkdir(join(safe, "project"));
    await symlink(outside, join(safe, "escape"));
    expect(await allowedDirectory(join(safe, "project"), [safe])).toEndWith("/safe/project");
    await expect(allowedDirectory(outside, [safe])).rejects.toThrow("白名单");
    await expect(allowedDirectory(join(safe, "escape"), [safe])).rejects.toThrow("白名单");
    expect((await listDirectories(safe, [safe])).entries.map((e) => e.name)).toEqual(["project"]);
    expect(await allowedDirectory(outside, ["*"])).toEndWith("/safe-elsewhere");
    expect(() => validateRelayUrl("http://example.com")).toThrow("HTTPS");
    expect(() => validateRelayUrl("http://8.8.8.8:8787")).toThrow("HTTPS");
    expect(() => validateRelayUrl("http://172.32.0.1:8787")).toThrow("HTTPS");
    for (const local of [
      "http://192.168.31.42:8787",
      "http://10.0.0.5:8787",
      "http://172.16.0.1:8787",
      "http://169.254.1.2:8787",
      "http://my-mac.local:8787",
      "http://[fd00::1]:8787",
      "http://[fe80::1]:8787",
    ]) {
      expect(validateRelayUrl(local).hostname).toBeTruthy();
    }
    expect(() => validateRelayUrl("https://secret@example.com")).toThrow();
  });
  test("离线事件与命令去重跨 SQLite 重启保留", async () => {
    const root = await mkdtemp(join(tmpdir(), "ap-store-"));
    const path = join(root, "state.sqlite");
    const store = new Store(path);
    const message = makeEnvelope("session.send", { prompt: "hello" }, { sessionId: "s" });
    expect(store.claimCommand(message)).toBe(true);
    expect(store.claimCommand(message)).toBe(false);
    store.enqueue(message);
    store.enqueue(message);
    store.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.pending()).toHaveLength(1);
    expect(reopened.unfinishedCommands()).toHaveLength(1);
    reopened.acknowledge(message.id);
    expect(reopened.pending()).toHaveLength(0);
  });
});

describe("本地日志兼容与统计", () => {
  test("Claude 重复 assistant 块只计一次用量", () => {
    const state: ScanState = { messages: {}, turnIds: [], malformed: 0 };
    const ctx = { deviceId: "device", path: "/tmp/history.jsonl" };
    const base = { sessionId: "native", cwd: "/tmp/project", timestamp: "2026-01-01T00:00:00Z" };
    parseRecord(
      { ...base, type: "user", uuid: "u", message: { content: "修复错误" } },
      "claude",
      state,
      ctx,
    );
    const assistant = {
      ...base,
      type: "assistant",
      message: {
        id: "msg",
        model: "claude",
        content: [{ type: "text", text: "完成" }],
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 },
      },
    };
    parseRecord(assistant, "claude", state, ctx);
    parseRecord(assistant, "claude", state, ctx);
    expect(state.session?.usage).toMatchObject({
      inputTokens: 150,
      outputTokens: 10,
      cacheReadTokens: 50,
      turns: 1,
    });
    expect(state.session?.title).toBe("修复错误");
  });
  test("Codex 累计 token_count 不进行重复累加，历史只读取结构化正文", () => {
    const state: ScanState = { messages: {}, turnIds: [], malformed: 0 };
    const ctx = { deviceId: "device", path: "/tmp/rollout.jsonl" };
    parseRecord(
      { type: "session_meta", payload: { id: "native", cwd: "/tmp/project" } },
      "codex",
      state,
      ctx,
    );
    const count = {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50 },
        },
      },
    };
    parseRecord(count, "codex", state, ctx);
    parseRecord(count, "codex", state, ctx);
    expect(state.session?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 50,
    });
    expect(
      parseRecord(
        {
          type: "response_item",
          payload: {
            type: "message",
            id: "m",
            role: "assistant",
            content: [{ type: "output_text", text: "完成" }],
          },
        },
        "codex",
        state,
        ctx,
      ),
    ).toEqual([{ kind: "message.done", role: "assistant", messageId: "m", text: "完成" }]);
    const nativeUsage = {
      type: "token_usage_record",
      payload: {
        turn_id: "new-turn",
        thread_token_usage: { input_tokens: 150, output_tokens: 25, cached_input_tokens: 60 },
      },
    };
    parseRecord(nativeUsage, "codex", state, ctx);
    parseRecord(nativeUsage, "codex", state, ctx);
    expect(state.session?.usage).toMatchObject({
      inputTokens: 150,
      outputTokens: 25,
      cacheReadTokens: 60,
      turns: 1,
    });
  });
  test("增量偏移保留跨块中文与未完成 JSON，重启后追加不重复统计", async () => {
    const root = await mkdtemp(join(tmpdir(), "ap-index-"));
    const projects = join(root, "claude", "projects");
    await mkdir(projects, { recursive: true });
    const path = join(projects, "session.jsonl");
    const prefix = JSON.stringify({
      type: "user",
      sessionId: "s",
      cwd: root,
      uuid: "u",
      message: { content: "中文测试" },
    });
    const bytes = Buffer.from(`${prefix}\n`);
    const split = bytes.indexOf(Buffer.from("中文")) + 1;
    await writeFile(path, bytes.subarray(0, split));
    const store = memory();
    const batches: IndexedSession[][] = [];
    const indexer = new LocalSessionIndexer(
      config({ claudeHome: join(root, "claude"), codexHome: join(root, "absent") }),
      store,
      (sessions) => {
        if (sessions.length) batches.push(sessions);
      },
    );
    expect(await indexer.scan()).toHaveLength(0);
    await appendFile(path, bytes.subarray(split));
    expect(await indexer.scan()).toHaveLength(1);
    expect(batches[0]?.[0]?.title).toBe("中文测试");
    expect(await indexer.scan()).toHaveLength(0);
    await appendFile(path, "{broken}\n");
    await indexer.scan();
    const history = await indexer.history(batches[0]![0]!);
    expect(history.events).toHaveLength(1);
    expect(history.events[0]?.text).toBe("中文测试");
    // Replacement with a new inode resets the byte offset and old accumulator.
    const replacement = join(projects, "replacement");
    await writeFile(
      replacement,
      `${JSON.stringify({
        type: "user",
        sessionId: "new",
        cwd: root,
        uuid: "u2",
        message: { content: "新文件" },
      })}\n`,
    );
    await rename(replacement, path);
    expect((await indexer.scan())[0]?.nativeId).toBe("new");
  });
  test("Claude 跨午夜分块去重、继续旧会话和活跃时长按真实日期计入", () => {
    const state: ScanState = { messages: {}, turnIds: [], malformed: 0 };
    const context = { deviceId: "d", path: "/tmp/claude.jsonl" };
    const row = (timestamp: string, value: Record<string, unknown>) =>
      parseRecord(
        { sessionId: "old-session", cwd: "/tmp", timestamp, ...value },
        "claude",
        state,
        context,
      );
    row("2026-01-01T10:00:00Z", { type: "user", uuid: "u1", message: { content: "first" } });
    const first = {
      type: "assistant",
      message: {
        id: "a1",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
          output_tokens: 5,
        },
      },
    };
    row("2026-09-25T23:59:59Z", first);
    row("2026-09-26T00:00:00Z", first);
    row("2026-09-26T00:00:00Z", {
      ...first,
      message: { ...first.message, usage: { ...first.message.usage, output_tokens: 7 } },
    });
    row("2026-09-26T00:00:00Z", { type: "user", uuid: "u2", message: { content: "resume" } });
    row("2026-09-26T00:00:01Z", {
      type: "assistant",
      message: { id: "a2", usage: { input_tokens: 50, output_tokens: 3 } },
    });
    const duration = {
      type: "system",
      subtype: "turn_duration",
      uuid: "duration",
      durationMs: 1000,
    };
    row("2026-09-26T00:00:00.500Z", duration);
    row("2026-09-26T00:00:00.500Z", duration);
    expect(state.session?.usage).toMatchObject({
      inputTokens: 180,
      outputTokens: 10,
      turns: 2,
      activeMs: 1000,
    });
    expect(
      state.session?.usageByDay?.find((day) => day.date === "2026-09-25")?.usage,
    ).toMatchObject({ inputTokens: 130, outputTokens: 5, activeMs: 500 });
    expect(
      state.session?.usageByDay?.find((day) => day.date === "2026-09-26")?.usage,
    ).toMatchObject({ inputTokens: 50, outputTokens: 5, turns: 1, activeMs: 500 });
    expect(
      state.session?.usageByDay?.find((day) => day.date === "2026-01-01")?.usage,
    ).toMatchObject({ inputTokens: 0, turns: 1 });
  });
  test("Codex 跨天累计快照按差值归档，索引重启/重复记录/计数器重置均无负数或重复", () => {
    let state: ScanState = { messages: {}, turnIds: [], malformed: 0 };
    const context = { deviceId: "d", path: "/tmp/codex.jsonl" };
    const row = (timestamp: string, value: Record<string, unknown>) =>
      parseRecord({ timestamp, ...value }, "codex", state, context);
    row("2026-01-01T00:00:00Z", { type: "session_meta", payload: { id: "old", cwd: "/tmp" } });
    row("2026-09-25T23:59:59Z", { type: "turn_context", payload: { turn_id: "t1" } });
    const count = (input: number, output: number) => ({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: input, output_tokens: output } },
      },
    });
    row("2026-09-25T23:59:59Z", count(100, 10));
    state = JSON.parse(JSON.stringify(state));
    row("2026-09-26T00:00:00Z", {
      type: "token_usage_record",
      payload: { turn_id: "t1", thread_token_usage: { input_tokens: 100, output_tokens: 10 } },
    });
    row("2026-09-26T00:00:01Z", {
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "t1", duration_ms: 2000 },
    });
    row("2026-09-26T00:00:02Z", { type: "turn_context", payload: { turn_id: "t2" } });
    row("2026-09-26T00:00:02Z", count(150, 15));
    row("2026-09-26T00:00:02Z", count(150, 15));
    row("2026-09-26T00:00:03Z", count(20, 2));
    row("2026-09-26T00:00:04Z", count(30, 3));
    expect(state.session?.usage).toMatchObject({
      inputTokens: 180,
      outputTokens: 18,
      turns: 2,
      activeMs: 2000,
    });
    expect(
      state.session?.usageByDay?.find((day) => day.date === "2026-09-25")?.usage,
    ).toMatchObject({ inputTokens: 100, outputTokens: 10, turns: 1, activeMs: 1000 });
    expect(
      state.session?.usageByDay?.find((day) => day.date === "2026-09-26")?.usage,
    ).toMatchObject({ inputTokens: 80, outputTokens: 8, turns: 1, activeMs: 1000 });
    expect(
      state.session?.usageByDay?.reduce((total, day) => total + day.usage.inputTokens, 0),
    ).toBe(state.session?.usage?.inputTokens);
  });
  test("Codex fork 的继承历史不重复计算父会话用量", () => {
    const state: ScanState = { messages: {}, turnIds: [], malformed: 0 };
    const context = { deviceId: "d", path: "/tmp/fork.jsonl" };
    const row = (id: string, tokens: number, timestamp: string) => {
      parseRecord(
        { type: "session_meta", timestamp, payload: { id, cwd: "/tmp" } },
        "codex",
        state,
        context,
      );
      parseRecord(
        {
          type: "token_usage_record",
          timestamp,
          payload: {
            turn_id: `turn-${id}`,
            thread_token_usage: { input_tokens: tokens, output_tokens: 1 },
          },
        },
        "codex",
        state,
        context,
      );
    };
    row("parent", 100, "2026-09-25T00:00:00Z");
    row("child", 30, "2026-09-26T00:00:00Z");
    expect(state.session?.nativeId).toBe("child");
    expect(state.session?.usage?.inputTokens).toBe(30);
    expect(state.session?.usageByDay).toHaveLength(1);
    expect(state.session?.usageByDay?.[0]?.date).toBe("2026-09-26");
  });
  test("超大历史以有界帧分页，原始内容保留并明确标记截断", async () => {
    const root = await mkdtemp(join(tmpdir(), "ap-large-history-"));
    const projects = join(root, "projects");
    await mkdir(projects);
    const path = join(projects, "large.jsonl");
    const rows = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        type: "assistant",
        sessionId: "large",
        cwd: root,
        timestamp: "2026-09-26T00:00:00Z",
        message: { id: `m${i}`, content: [{ type: "text", text: "界".repeat(40000) }] },
      }),
    );
    await writeFile(path, `${rows.join("\n")}\n`);
    const indexer = new LocalSessionIndexer(
      config({ claudeHome: root, codexHome: join(root, "absent") }),
      memory(),
      () => {},
    );
    const sessions = await indexer.scan();
    const seen = new Set<string>();
    let before: number | undefined;
    let pages = 0;
    while (true) {
      const page = await indexer.history(sessions[0]!, 1000, before);
      pages++;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1024 * 1024);
      for (const event of page.events) {
        expect(event.text).toContain("完整内容保留");
        seen.add(event.messageId!);
      }
      if (!page.hasMore) break;
      before = page.before;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBe(20);
    expect(Bun.file(path).size).toBeGreaterThan(2_000_000);
  });
});

describe("审批与 adapter", () => {
  test("审批必须属于同一会话，超时/取消一律拒绝，重复决定无效", async () => {
    const events: Approval[] = [];
    const broker = new ApprovalBroker((a) => events.push(a), 20);
    const promise = broker.request("d", "s", {
      toolName: "Bash",
      input: { command: "touch test" },
    });
    const id = events[0]!.id;
    expect(() => broker.decide(id, "another", { decision: "allow" })).toThrow("不属于");
    expect((await promise).decision).toBe("deny");
    expect(events.at(-1)?.status).toBe("expired");
    expect(() => broker.decide(id, "s", { decision: "allow" })).toThrow("不存在");
    const abort = new AbortController();
    const cancelled = broker.request("d", "s", { toolName: "Bash", input: {} }, abort.signal);
    abort.abort();
    expect((await cancelled).decision).toBe("deny");
    const oversized = await broker.request("d", "s", {
      toolName: "Edit",
      input: "x".repeat(512 * 1024 + 1),
    });
    expect(oversized.decision).toBe("deny");
    expect(broker.pending.size).toBe(0);
  });
  test("Claude 不使用订阅 OAuth，费用默认阻断", () => {
    expect(claudeAuthentication(config(), { CLAUDE_CODE_OAUTH_TOKEN: "fake" }).available).toBe(
      false,
    );
    expect(claudeAuthentication(config(), { ANTHROPIC_API_KEY: "fake" }).available).toBe(false);
    expect(
      claudeAuthentication(config({ allowPaidApi: true }), { ANTHROPIC_API_KEY: "fake" }).available,
    ).toBe(true);
  });
  test("Claude SDK 流式、canUseTool、resume 和累计统计遵守统一模型", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-only-not-a-key";
    const events: SessionEvent[] = [];
    let opts: any;
    const adapter = new ClaudeAdapter(config({ allowPaidApi: true }), (args) => {
      opts = args.options;
      return {
        interrupt: async () => {},
        close: () => {},
        async *[Symbol.asyncIterator]() {
          yield { type: "system", session_id: "native" };
          yield {
            type: "stream_event",
            session_id: "native",
            event: { type: "message_start", message: { id: "msg" } },
          };
          yield {
            type: "stream_event",
            session_id: "native",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          };
          const result = await opts.canUseTool(
            "Bash",
            { command: "echo test" },
            { signal: new AbortController().signal, toolUseID: "call" },
          );
          expect(result.behavior).toBe("deny");
          yield {
            type: "assistant",
            session_id: "native",
            message: {
              id: "msg",
              content: [{ type: "text", text: "Hello" }],
              usage: { input_tokens: 10, output_tokens: 2 },
            },
          };
          yield {
            type: "result",
            session_id: "native",
            subtype: "success",
            total_cost_usd: 0,
            is_error: false,
          };
        },
      };
    });
    try {
      await adapter.start({
        cwd: "/tmp",
        nativeId: "previous",
        permissionMode: "default",
        emit: (event) => events.push(event),
        approve: async () => ({ decision: "deny" }),
      });
      await adapter.send("hello");
      while (adapter.running) await tick();
      expect(opts.resume).toBe("previous");
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(events.some((event) => event.kind === "message.delta" && event.text === "Hello")).toBe(
        true,
      );
      expect(events.find((event) => event.kind === "usage")?.usage?.inputTokens).toBe(10);
      for (const event of events)
        expect(() => parseEnvelope(makeEnvelope("session.event", event))).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
      await adapter.close();
    }
  });
  test("Codex app-server 统一审批、流式输出、token 总量和中断映射", async () => {
    class FakeRpc extends RpcProcess {
      calls: { method: string; params: Record<string, unknown> }[] = [];
      responses: unknown[] = [];
      override async start() {}
      override async close() {}
      override notify() {}
      override request(method: string, params: Record<string, unknown>) {
        this.calls.push({ method, params });
        return Promise.resolve(
          method === "account/read"
            ? { account: { type: "chatgpt" } }
            : method === "thread/start"
              ? { thread: { id: "native" }, modelProvider: "openai" }
              : method === "turn/start"
                ? { turn: { id: "turn" } }
                : {},
        );
      }
      override respond(id: number | string, result: unknown) {
        this.responses.push({ id, result });
      }
    }
    const rpc = new FakeRpc();
    const events: SessionEvent[] = [];
    const adapter = new CodexAdapter(config(), rpc);
    await adapter.start({
      cwd: "/tmp",
      permissionMode: "default",
      emit: (e) => events.push(e),
      approve: async () => ({ decision: "deny" }),
    });
    await adapter.send("hello");
    rpc.onMessage({ method: "turn/started", params: { threadId: "native", turn: { id: "turn" } } });
    rpc.onMessage({
      id: 100,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "native", itemId: "tool", command: "touch file" },
    });
    await tick();
    expect(rpc.responses).toEqual([{ id: 100, result: { decision: "decline" } }]);
    rpc.onMessage({
      method: "item/agentMessage/delta",
      params: { threadId: "native", itemId: "msg", delta: "Hello" },
    });
    rpc.onMessage({
      method: "thread/tokenUsage/updated",
      params: { threadId: "native", tokenUsage: { total: { inputTokens: 100, outputTokens: 10 } } },
    });
    await adapter.interrupt();
    expect(rpc.calls.at(-1)?.method).toBe("turn/interrupt");
    rpc.onMessage({
      method: "turn/completed",
      params: { threadId: "native", turn: { id: "turn", status: "interrupted" } },
    });
    expect(adapter.running).toBe(false);
    expect(events.filter((e) => e.kind === "usage").at(-1)?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      turns: 1,
    });
    for (const event of events)
      expect(() => parseEnvelope(makeEnvelope("session.event", event))).not.toThrow();
    await adapter.close();
  });
  test("切换提供方时不会把原自定义模型目录当成官方可用模型", async () => {
    const root = await mkdtemp(join(tmpdir(), "ap-codex-profile-"));
    await writeFile(
      join(root, "config.toml"),
      'model_provider="custom"\nmodel_catalog_json="/tmp/catalog.json"\n',
    );
    expect(
      await codexProfileProblem(config({ codexHome: root, codexModelProvider: "openai" })),
    ).toContain("独立 codexHome");
    expect(await codexProfileProblem(config({ codexHome: root }))).toBeUndefined();
  });
});

describe("分发与远程重连", () => {
  test("三个系统的服务配置参数正确转义且凭据不在命令行", () => {
    const mac = servicePlan(
      "darwin",
      ["/tmp/a & b/agentpaneld"],
      "/tmp/config.json",
      "/tmp/home",
      501,
    );
    expect(mac.content).toContain("a &amp; b");
    expect(mac.install[0]).toEqual(["launchctl", "bootstrap", "gui/501", mac.path]);
    const linux = servicePlan(
      "linux",
      ["/tmp/with space/agentpaneld"],
      "/tmp/%config.json",
      "/tmp/home",
    );
    expect(linux.content).toContain('"/tmp/with space/agentpaneld"');
    expect(linux.content).toContain("%%config");
    const windows = servicePlan(
      "win32",
      ["C:\\Program Files\\AgentPanel\\agentpaneld.exe"],
      "C:\\Users\\Neo\\config.json",
      "/tmp/home",
    );
    expect(windows.content).toContain("LeastPrivilege");
    expect(windows.install[0]?.[0]).toBe("schtasks.exe");
  });
  test("更新必须有 Ed25519 签名且未过期，不允许降级或修改下载哈希", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const key = publicKey.export({ type: "spki", format: "pem" }).toString();
    const payload = Buffer.from(
      JSON.stringify({
        version: "0.2.0",
        expiresAt: Date.now() + 60_000,
        artifacts: [
          {
            platform: "darwin",
            arch: "arm64",
            url: "https://example.com/daemon",
            sha256: "a".repeat(64),
            bytes: 100,
          },
        ],
      }),
    );
    const signed = {
      payload: payload.toString("base64"),
      signature: sign(null, payload, privateKey).toString("base64"),
    };
    expect(verifyManifest(signed, key).version).toBe("0.2.0");
    expect(() => verifyManifest(signed, key, "0.3.0")).toThrow("降级");
    expect(() => verifyManifest(signed, key, "0.1.0", Date.now() + 120_000)).toThrow("过期");
    expect(() =>
      verifyManifest(
        {
          ...signed,
          payload: Buffer.from(payload.toString().replace("0.2.0", "0.4.0")).toString("base64"),
        },
        key,
      ),
    ).toThrow("签名");
  });
  test("更新下载检查真实字节哈希，安装原子替换且保留上一版本", async () => {
    const root = await mkdtemp(join(tmpdir(), "ap-update-"));
    const executable = join(root, "agentpaneld");
    await writeFile(executable, "old-program", { mode: 0o700 });
    const binary = Buffer.from("new-program");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const payload = Buffer.from(
      JSON.stringify({
        version: "0.2.0",
        expiresAt: Date.now() + 60_000,
        artifacts: [
          {
            platform: process.platform,
            arch: process.arch,
            url: "https://example.com/binary",
            bytes: binary.length,
            sha256: createHash("sha256").update(binary).digest("hex"),
          },
        ],
      }),
    );
    const manifest = JSON.stringify({
      payload: payload.toString("base64"),
      signature: sign(null, payload, privateKey).toString("base64"),
    });
    const cfg = config({
      updateManifestUrl: "https://example.com/manifest",
      updatePublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const downloaded = (tamper: boolean) =>
      (async (url: string | URL | Request) =>
        new Response(
          String(url).endsWith("manifest")
            ? manifest
            : tamper
              ? Buffer.from("bad-program")
              : binary,
        )) as typeof fetch;
    await expect(stageUpdate(cfg, executable, "0.1.0", downloaded(true))).rejects.toThrow(
      "校验失败",
    );
    expect(await Bun.file(executable).text()).toBe("old-program");
    const staged = await stageUpdate(cfg, executable, "0.1.0", downloaded(false));
    expect(staged?.version).toBe("0.2.0");
    if (process.platform !== "win32") {
      await installUpdate(staged!.path, executable);
      expect(await Bun.file(executable).text()).toBe("new-program");
      expect(await Bun.file(`${executable}.previous`).text()).toBe("old-program");
    }
    const script = windowsUpdateScript("C:\\next", "C:\\Program Files\\agentpaneld.exe", 123, [
      "run",
      "--config",
      "C:\\User's home\\config.json",
    ]);
    expect(script).toContain("Wait-Process -Id 123");
    expect(script).toContain("User''s home");
  });
  test("真实本地 WS 持久 ACK、重复命令只执行一次、离线事件重连补传", async () => {
    const store = memory();
    const received: Envelope[] = [];
    let ws: any;
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (request.headers.get("authorization") !== "Bearer device-token")
          return new Response("Unauthorized", { status: 401 });
        if (server.upgrade(request)) return;
        return new Response("bad", { status: 400 });
      },
      websocket: {
        open(socket) {
          ws = socket;
        },
        message(socket, data) {
          const msg = parseEnvelope(JSON.parse(String(data)));
          received.push(msg);
          if (msg.type !== "ack" && msg.type !== "pong")
            socket.send(JSON.stringify(makeEnvelope("ack", { ackId: msg.id })));
        },
      },
    });
    const cfg = config({
      relayUrl: `http://127.0.0.1:${server.port}`,
      deviceId: "d",
      deviceToken: "device-token",
      importHistory: false,
    });
    const manager = new SessionManager(cfg, store, () => {});
    manager.command = async () => {
      calls++;
      return { ok: true };
    };
    let refreshes = 0;
    const relay = new RelayConnection(cfg, store, manager, [], () => {
      refreshes++;
    });
    relay.start();
    try {
      for (let i = 0; i < 100 && !ws; i++) await tick();
      const command = makeEnvelope("fs.listDir", { path: "/" }, { deviceId: "d" });
      ws.send(JSON.stringify(command));
      ws.send(JSON.stringify(command));
      for (let i = 0; i < 100 && !received.some((m) => m.type === "result"); i++) await tick();
      expect(calls).toBe(1);
      const refresh = makeEnvelope("device.refresh", {}, { deviceId: "d" });
      ws.send(JSON.stringify(refresh));
      ws.send(JSON.stringify(refresh));
      for (
        let i = 0;
        i < 100 && !received.some((m) => m.type === "result" && m.payload.requestId === refresh.id);
        i++
      )
        await tick();
      expect(refreshes).toBe(1);
      expect(calls).toBe(1);
      relay.updateAgents([
        {
          kind: "codex",
          installed: true,
          executionAvailable: false,
          quota: {
            status: "available",
            checkedAt: Date.now(),
            windows: [{ id: "week", label: "每周", usedPercent: 7 }],
          },
        },
      ]);
      for (
        let i = 0;
        i < 100 &&
        !received.some(
          (m) => m.type === "device.hello" && m.payload.agents[0]?.quota?.status === "available",
        );
        i++
      )
        await tick();
      expect(
        received.some(
          (m) =>
            m.type === "device.hello" && m.payload.agents[0]?.quota?.windows[0]?.usedPercent === 7,
        ),
      ).toBe(true);
      expect(received.some((m) => m.type === "ack" && m.payload.ackId === command.id)).toBe(true);
      ws.close(1012, "restart");
      await tick();
      const offline = makeEnvelope(
        "session.event",
        { kind: "message.done", text: "offline" },
        { deviceId: "d", sessionId: "s" },
      );
      relay.publish(offline);
      for (let i = 0; i < 200 && !received.some((m) => m.id === offline.id); i++) await tick();
      expect(received.some((m) => m.id === offline.id)).toBe(true);
      await tick();
      expect(store.pending()).toHaveLength(0);
    } finally {
      await relay.close();
      await manager.close();
      await server.stop(true);
    }
  });
});
