import { describe, expect, it } from "bun:test";
import { makeEnvelope, type SessionEvent } from "@agentpanel/protocol";
import { conversation, mergeEvents } from "./events";

describe("offline replay", () => {
  it("deduplicates overlap while keeping relay sequence order", () => {
    const first = {
      ...makeEnvelope("session.event", { kind: "message.delta", text: "你", messageId: "m1" }),
      id: "a",
      seq: 1,
    };
    const second = {
      ...makeEnvelope("session.event", { kind: "message.delta", text: "好", messageId: "m1" }),
      id: "b",
      seq: 2,
    };
    const merged = mergeEvents([second], [first, second]);
    expect(merged.map((x) => x.id)).toEqual(["a", "b"]);
    expect(conversation(merged)[0].text).toBe("你好");
  });
  it("replaces streamed text with a final message and merges tool results", () => {
    const make = (payload: SessionEvent) => makeEnvelope("session.event", payload);
    const rows = conversation([
      make({ kind: "message.delta", messageId: "m", text: "部分" }),
      make({ kind: "message.done", messageId: "m", text: "完整消息" }),
      make({ kind: "tool.call", toolCallId: "t", toolName: "Read", input: { path: "README.md" } }),
      make({ kind: "tool.result", toolCallId: "t", output: "content", diff: "+ added" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe("完整消息");
    expect(rows[1]).toMatchObject({
      toolName: "Read",
      complete: true,
      output: "content",
      diff: "+ added",
    });
  });
});
