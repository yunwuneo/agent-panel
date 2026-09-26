import { describe, expect, test } from "bun:test";
import { EnvelopeSchema, makeEnvelope, parseEnvelope, SessionSchema } from "../src";

describe("wire boundary", () => {
  test("rejects unsupported versions, unknown messages and invalid permission mode", () => {
    const message = makeEnvelope(
      "session.create",
      { agent: "codex", cwd: "/tmp", prompt: "hello" },
      { deviceId: "d1" },
    );
    expect(parseEnvelope(message)).toEqual(message);
    expect(EnvelopeSchema.safeParse({ ...message, v: 2 }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...message, type: "shell.exec" }).success).toBe(false);
    expect(
      EnvelopeSchema.safeParse({
        ...message,
        payload: { ...message.payload, permissionMode: "bypassPermissions" },
      }).success,
    ).toBe(false);
  });
  test("rejects invalid usage and preserves the unified event without raw fields", () => {
    const event = makeEnvelope("session.event", {
      kind: "message.delta",
      text: "你好 🌏",
      role: "assistant",
    });
    expect(parseEnvelope(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(() => parseEnvelope(makeEnvelope("session.event", { kind: "usage" }))).toThrow();
  });
  test("indexed sessions must explicitly communicate ownership and readonly state", () => {
    expect(SessionSchema.safeParse({ id: "s", cwd: "/tmp" }).success).toBe(false);
  });
});
