import { expect, test } from "bun:test";
import { parseRecord, type ScanState } from "../src/indexer";

const context = { deviceId: "d", path: "/tmp/log.jsonl" };
const state = (): ScanState => ({ messages: {}, turnIds: [], malformed: 0 });

test("Claude model switching and repeated streamed blocks preserve per-model and daily usage", () => {
  const s = state();
  const append = (id: string, model: string, day: number, input = 100) =>
    parseRecord(
      {
        type: "assistant",
        sessionId: "s",
        cwd: "/work",
        timestamp: `2026-09-${day}T12:00:00Z`,
        message: { id, model, usage: { input_tokens: input, output_tokens: 10 } },
      },
      "claude",
      s,
      context,
    );
  append("a", "model-a", 20);
  append("a", "model-a", 20);
  append("b", "model-b", 21, 200);
  expect(s.session?.usage?.byModel?.map((p) => [p.model, p.inputTokens])).toEqual([
    ["model-a", 100],
    ["model-b", 200],
  ]);
  expect(s.session?.usageByDay?.map((d) => d.usage.byModel?.map((p) => p.model))).toEqual([
    ["model-a"],
    ["model-b"],
  ]);
});

test("Codex cumulative counters across model switches only attribute the increment", () => {
  const s = state();
  parseRecord(
    { type: "session_meta", timestamp: "2026-09-20T12:00:00Z", payload: { id: "s", cwd: "/work" } },
    "codex",
    s,
    context,
  );
  const append = (model: string, total: number, day: number) => {
    const timestamp = `2026-09-${day}T12:00:00Z`;
    parseRecord({ type: "turn_context", timestamp, payload: { model } }, "codex", s, context);
    parseRecord(
      {
        type: "event_msg",
        timestamp,
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: total } } },
      },
      "codex",
      s,
      context,
    );
  };
  append("model-a", 100, 20);
  append("model-b", 300, 21);
  append("model-b", 300, 21);
  expect(s.session?.usage?.byModel?.map((p) => [p.model, p.inputTokens])).toEqual([
    ["model-a", 100],
    ["model-b", 200],
  ]);
  expect(s.session?.usageByDay?.map((d) => d.usage.byModel?.map((p) => p.inputTokens))).toEqual([
    [100],
    [200],
  ]);
});

test("later Claude fragments without a model retain the message's original model", () => {
  const s = state();
  const append = (model?: string, output_tokens = 10) =>
    parseRecord(
      {
        type: "assistant",
        sessionId: "s",
        cwd: "/work",
        timestamp: "2026-09-20T12:00:00Z",
        message: { id: "a", model, usage: { input_tokens: 100, output_tokens } },
      },
      "claude",
      s,
      context,
    );
  append("claude-opus-5");
  append(undefined, 20);
  expect(s.session?.usage?.byModel).toEqual([
    {
      model: "claude-opus-5",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ]);
  expect(s.session?.usageByDay?.[0]?.usage.byModel?.[0]?.outputTokens).toBe(20);
});

test("parser marks the dedicated CodexBar probe project", () => {
  const s = state();
  parseRecord(
    {
      type: "user",
      sessionId: "probe",
      cwd: "/Users/test/Library/Application Support/CodexBar/ClaudeProbe",
      message: { content: "/usage" },
    },
    "claude",
    s,
    context,
  );
  expect(s.session?.excludedReason).toBe("quota-probe");
});
