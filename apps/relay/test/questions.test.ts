import { expect, test } from "bun:test";
import { makeEnvelope } from "@agentpanel/protocol";
import { MemoryStore } from "../src/store";
import { setup } from "./helpers";

test("question approvals require complete matching answers and forward them to the device only", async () => {
  const store = new MemoryStore();
  const relay = await setup(store);
  const device = await relay.pair();
  const command = await relay.hub.command(
    relay.principal.owner,
    makeEnvelope(
      "session.create",
      { agent: "claude", cwd: "/tmp", prompt: "test" },
      { deviceId: device.deviceId },
    ),
  );
  const base = {
    deviceId: device.deviceId,
    sessionId: command.sessionId!,
    input: {},
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: "pending" as const,
  };
  const question = {
    ...base,
    id: "question",
    toolName: "AskUserQuestion",
    questions: [
      {
        id: "db",
        question: "用哪个数据库？",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
      },
      { id: "note", question: "备注？", options: [], allowOther: true },
    ],
  };
  const tool = { ...base, id: "tool", toolName: "Bash" };
  for (const approval of [question, tool])
    await relay.hub.ingest(
      device.principal,
      makeEnvelope("approval.request", approval, {
        deviceId: device.deviceId,
        sessionId: command.sessionId,
      }),
    );
  const decide = (id: string, body: unknown) =>
    relay.request(`/api/approvals/${id}/decision`, body);
  expect((await decide("tool", { decision: "allow", answers: { db: ["x"] } })).status).toBe(400);
  expect((await decide("question", { decision: "allow" })).status).toBe(400);
  expect(
    (await decide("question", { decision: "allow", answers: { db: ["SQLite"], other: ["x"] } }))
      .status,
  ).toBe(400);
  expect(
    (await decide("question", { decision: "allow", answers: { db: ["SQLite"], note: [" "] } }))
      .status,
  ).toBe(400);
  const ok = await decide("question", {
    decision: "allow",
    answers: { db: ["SQLite"], note: ["保持兼容"] },
  });
  expect(ok.status).toBe(200);
  const sent = (await store.list("commands", relay.principal.owner)).find(
    (row) => (row.envelope as { type: string }).type === "approval.decide",
  );
  expect((sent!.envelope as { payload: unknown }).payload).toMatchObject({
    decision: "allow",
    answers: { db: ["SQLite"], note: ["保持兼容"] },
  });
  const audit = (await store.list("audit", relay.principal.owner)).find(
    (row) => row.action === "approval.decide",
  );
  expect(JSON.stringify(audit)).not.toContain("保持兼容");
  expect(JSON.stringify(audit)).toContain('"answered":true');
});
