import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Envelope, makeEnvelope, SessionSchema } from "@agentpanel/protocol";
import { configSchema } from "../src/config";
import { type IndexedSession, parseRecord, type ScanState } from "../src/indexer";
import { SessionManager } from "../src/manager";
import { createOccupancyProbe, localSessionStatus, type Occupancy } from "../src/occupancy";
import { Store } from "../src/store";

function parser(agent: "codex" | "claude") {
  const state: ScanState = { messages: {}, turnIds: [], malformed: 0 };
  const parse = (record: Record<string, unknown>) => {
    parseRecord({ timestamp: new Date().toISOString(), ...record }, agent, state, {
      deviceId: "device",
      path: "/tmp/test.jsonl",
    });
    return state.session?.localActivity;
  };
  if (agent === "codex") parse({ type: "session_meta", payload: { id: "test", cwd: "/tmp" } });
  else
    parse({
      type: "user",
      sessionId: "test",
      cwd: "/tmp",
      uuid: "first",
      message: { content: "start" },
    });
  return { state, parse };
}
const event = (type: string, turn_id = "turn") => ({
  type: "event_msg",
  payload: { type, turn_id },
});

test("Codex start, long tool work, final answer and trailing accounting retain the correct lifecycle", () => {
  const { parse, state } = parser("codex");
  expect(parse(event("task_started"))?.status).toBe("running");
  expect(
    parse({
      type: "response_item",
      payload: { type: "custom_tool_call", name: "long_tool", call_id: "c", input: "" },
    })?.status,
  ).toBe("running");
  expect(
    parse({
      type: "response_item",
      payload: { type: "message", role: "assistant", phase: "commentary", content: [] },
    })?.status,
  ).toBe("running");
  expect(
    parse({
      type: "response_item",
      payload: { type: "message", role: "assistant", phase: "final_answer", content: [] },
    })?.status,
  ).toBe("completed");
  parse(event("task_complete"));
  parse(event("item_completed"));
  parse({
    type: "token_usage_record",
    payload: { turn_id: "turn", thread_token_usage: { input_tokens: 100, output_tokens: 1 } },
  });
  expect(state.session?.localActivity?.status).toBe("completed");
  parse(event("task_started", "next"));
  expect(parse(event("task_complete", "turn"))?.status).toBe("running");
  expect(parse(event("turn_aborted", "next"))?.status).toBe("completed");
  parse(event("task_started", "failed"));
  expect(parse(event("task_failed", "failed"))?.status).toBe("error");
});

test("Codex fork metadata resets inherited activity and legacy turn_context is recognized", () => {
  const { parse, state } = parser("codex");
  parse(event("task_started", "parent"));
  parse({ type: "session_meta", payload: { id: "child", cwd: "/tmp" } });
  expect(state.session?.localActivity).toBeUndefined();
  expect(parse({ type: "turn_context", payload: { turn_id: "child-turn" } })?.status).toBe(
    "running",
  );
  parse(event("task_complete", "child-turn"));
  expect(parse({ type: "turn_context", payload: { turn_id: "child-turn" } })?.status).toBe(
    "completed",
  );
});

test("Claude tool results stay running; final, interrupt, error and duration close the turn", () => {
  const { parse, state } = parser("claude");
  expect(state.session?.localActivity?.status).toBe("running");
  const assistant = (stop_reason: string, extra = {}) => ({
    type: "assistant",
    message: { stop_reason, content: [], ...extra },
  });
  parse(assistant("tool_use"));
  expect(
    parse({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] },
    })?.status,
  ).toBe("running");
  expect(parse(assistant("end_turn"))?.status).toBe("completed");
  parse({ type: "user", isMeta: true, message: { content: "context" } });
  parse({ type: "assistant", isSidechain: true, message: { content: [] } });
  expect(state.session?.localActivity?.status).toBe("completed");
  parse({ type: "user", uuid: "next", message: { content: "next" } });
  expect(state.session?.localActivity?.status).toBe("running");
  expect(
    parse({ type: "user", message: { content: "[Request interrupted by user for tool use]" } })
      ?.status,
  ).toBe("completed");
  parse({ type: "user", uuid: "third", message: { content: "third" } });
  expect(
    parse({ type: "assistant", isApiErrorMessage: true, message: { content: [] } })?.status,
  ).toBe("error");
  expect(parse({ type: "system", subtype: "turn_duration", durationMs: 1 })?.status).toBe("error");
  parse({ type: "user", uuid: "fourth", message: { content: "fourth" } });
  expect(parse({ type: "system", subtype: "turn_duration", durationMs: 1 })?.status).toBe(
    "completed",
  );
});

test("liveness is distinct from read-only: old incomplete logs and failed probes are not running", () => {
  const { state, parse } = parser("codex");
  parse({ ...event("task_started"), timestamp: Date.now() - 60_000 });
  const session = state.session!;
  expect(localSessionStatus(session, { busy: true, live: true })).toBe("running");
  expect(localSessionStatus(session, { busy: true, reason: "probe failed" })).toBe("idle");
  expect(localSessionStatus(session, { busy: false })).toBe("idle");
  expect(localSessionStatus(session, { busy: true, recentWrite: true })).toBe("idle");
  parse(event("task_complete"));
  expect(localSessionStatus(session, { busy: true, live: true })).toBe("completed");
});

const resources: { manager: SessionManager; store: Store }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.manager.close();
    resource.store.close();
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ap-activity-"));
  const dir = join(root, "codex", "sessions");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "rollout-test.jsonl");
  const write = async (records: Record<string, unknown>[]) =>
    appendFile(
      path,
      records.map((r) => JSON.stringify({ timestamp: new Date().toISOString(), ...r })).join("\n") +
        "\n",
    );
  await write([
    { type: "session_meta", payload: { id: "native", cwd: root } },
    event("task_started"),
  ]);
  const cfg = configSchema.parse({
    claudeHome: join(root, "absent"),
    codexHome: join(root, "codex"),
    importHistory: false,
  });
  const store = new Store(":memory:");
  let occupancy: Occupancy = { busy: true, live: true, reason: "writer" };
  const snapshots: Envelope[] = [];
  const create = () =>
    new SessionManager(
      cfg,
      store,
      (e) => snapshots.push(e),
      undefined,
      () => async () => occupancy,
    );
  const manager = create();
  resources.push({ manager, store });
  const session = () => [...manager.sessions.values()][0] as IndexedSession;
  return {
    root,
    path,
    write,
    cfg,
    store,
    manager,
    session,
    snapshots,
    create,
    setOccupancy: (value: Occupancy) => {
      occupancy = value;
    },
  };
}

test("local running + read-only survives protocol transport; completion and unchanged-log unlock emit snapshots", async () => {
  const f = await fixture();
  await f.manager.indexer.scan();
  expect(SessionSchema.parse(f.session())).toMatchObject({ status: "running", readOnly: true });
  expect(SessionSchema.parse(f.session())).not.toHaveProperty("localActivity");
  await expect(
    f.manager.command(
      makeEnvelope("session.resume", { prompt: "no" }, { sessionId: f.session().id }),
    ),
  ).rejects.toThrow("writer");
  await expect(
    f.manager.command(makeEnvelope("session.interrupt", {}, { sessionId: f.session().id })),
  ).rejects.toThrow("只读");
  await f.write([event("task_complete")]);
  await f.manager.indexer.scan();
  expect(f.session()).toMatchObject({ status: "completed", readOnly: true });
  const before = f.snapshots.length;
  const updatedAt = f.session().updatedAt;
  f.setOccupancy({ busy: false });
  expect(await f.manager.indexer.scan()).toHaveLength(0);
  expect(f.session()).toMatchObject({ status: "completed", readOnly: false, updatedAt });
  expect(f.snapshots.length).toBe(before + 1);
  await f.manager.indexer.scan();
  expect(f.snapshots.length).toBe(before + 1);
});

test("restart re-evaluates unchanged logs, and loss of the writer clears an unfinished running turn", async () => {
  const f = await fixture();
  await f.manager.indexer.scan();
  const restarted = f.create();
  try {
    expect([...restarted.sessions.values()][0]?.status).toBe("readonly");
    expect(await restarted.indexer.scan()).toHaveLength(0);
    expect([...restarted.sessions.values()][0]).toMatchObject({
      status: "running",
      readOnly: true,
    });
    f.setOccupancy({ busy: false });
    await restarted.indexer.scan();
    expect([...restarted.sessions.values()][0]).toMatchObject({ status: "idle", readOnly: false });
  } finally {
    await restarted.close();
  }
});

test("deleted logs cannot leave a phantom running session", async () => {
  const f = await fixture();
  await f.manager.indexer.scan();
  await unlink(f.path);
  await f.manager.indexer.scan();
  expect(f.session()).toMatchObject({ status: "idle", readOnly: true });
});

test("old cached parser state is rebuilt once without double-counting usage", async () => {
  const f = await fixture();
  await f.write([
    {
      type: "token_usage_record",
      payload: { turn_id: "turn", thread_token_usage: { input_tokens: 100, output_tokens: 10 } },
    },
  ]);
  await f.manager.indexer.scan();
  const cached = f.store.getScan<ScanState>(f.path)!;
  cached.body.parserVersion = 3;
  delete cached.body.session!.localActivity;
  f.store.setScan(f.path, cached.offset, cached.remainder, cached.body);
  expect(await f.manager.indexer.scan()).toHaveLength(1);
  expect(f.session()).toMatchObject({
    status: "running",
    usage: { inputTokens: 100, outputTokens: 10 },
  });
  expect(await f.manager.indexer.scan()).toHaveLength(0);
});

test("managed adapter status and accounting are not overwritten by imported lifecycle or occupancy", async () => {
  const f = await fixture();
  await f.manager.indexer.scan();
  const s = f.session();
  s.source = "managed";
  s.status = "waiting";
  s.readOnly = false;
  s.usage = { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
  // Reconciliation only consults adapter membership; no agent process or paid call is started.
  f.manager.adapters.set(s.id, { close: async () => {} } as any);
  await f.write([event("task_complete")]);
  await f.manager.indexer.scan();
  expect(f.session()).toMatchObject({
    status: "waiting",
    readOnly: false,
    usage: { inputTokens: 200 },
  });
  expect(f.store.sessions()).toHaveLength(1);
});

test.skipIf(process.platform === "win32" || !Bun.which("lsof"))(
  "occupancy probes are batched, expire fresh writes and distinguish read handles from writers",
  async () => {
    const f = await fixture();
    await f.manager.indexer.scan();
    const s = f.session();
    const old = new Date(Date.now() - 60_000);
    await utimes(f.path, old, old);
    let calls = 0;
    const other = `${f.path}.other`;
    await writeFile(other, "");
    await utimes(other, old, old);
    const probe = createOccupancyProbe(Date.now, async (args) => {
      calls++;
      return args[0] === "ps"
        ? { code: 0, text: "" }
        : {
            code: 0,
            text: `p999999\nf4\naw\nn${f.path}\nf5\nar\nn${other}\n`,
          };
    });
    expect(await probe(s)).toMatchObject({ busy: true, live: true });
    expect(await probe({ ...s, logPath: other })).toMatchObject({ busy: true, live: false });
    expect(calls).toBe(2);
    const fail = createOccupancyProbe(Date.now, async () => ({ code: -1, text: "" }));
    expect(await fail(s)).toMatchObject({ busy: true });
    expect((await fail(s)).live).toBeUndefined();
    const fresh = new Date();
    await utimes(f.path, fresh, fresh);
    expect(await fail(s)).toMatchObject({ busy: true, recentWrite: true });
    // A long tool can emit only accounting records for a while. Fresh mtime must not
    // suppress the process check when the last lifecycle record is older than 30s.
    s.localActivity = { status: "running", at: Date.now() - 60_000 };
    expect(localSessionStatus(s, await probe(s))).toBe("running");
    const released = createOccupancyProbe(
      () => Date.now() + 60_000,
      async () => ({ code: 0, text: "" }),
    );
    expect(await released(s)).toEqual({ busy: false });
  },
);
