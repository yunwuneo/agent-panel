import { expect, test } from "bun:test";
import { makeEnvelope, type Session, type Usage } from "@agentpanel/protocol";
import { MemoryStore } from "../src/store";
import { setup } from "./helpers";

const usage = (inputTokens: number, turns = 0): Usage => ({
  inputTokens,
  outputTokens: inputTokens / 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turns,
  activeMs: inputTokens * 10,
});
const stamp = (date: string) => Date.parse(`${date}T12:00:00Z`);

test("resumed old session assigns only new cumulative delta to its real UTC usage day", async () => {
  const relay = await setup(new MemoryStore());
  const device = await relay.pair();
  const session: Session = {
    id: "day-session",
    nativeId: "day-native",
    deviceId: device.deviceId,
    agent: "codex",
    cwd: "/tmp/days",
    title: "cross midnight",
    status: "idle",
    source: "local",
    readOnly: false,
    createdAt: stamp("2026-09-20"),
    updatedAt: stamp("2026-09-20"),
    usage: usage(100, 1),
    usageByDay: [{ date: "2026-09-20", usage: usage(100, 1) }],
  };
  const snapshot = (value: Session) =>
    relay.hub.ingest(
      device.principal,
      makeEnvelope("session.snapshot", { sessions: [value] }, { deviceId: device.deviceId }),
    );
  await snapshot(session);
  const live = makeEnvelope(
    "session.event",
    { kind: "usage", usage: usage(130, 2) },
    { deviceId: device.deviceId, sessionId: session.id, ts: stamp("2026-09-27") },
  );
  await relay.hub.ingest(device.principal, live);
  await relay.hub.ingest(device.principal, live);
  const current = await relay.hub.stats(relay.principal.owner, {
    from: Date.parse("2026-09-27T00:00:00Z"),
    to: Date.parse("2026-09-27T23:59:59Z"),
    groupBy: "day",
  });
  expect(current.usage.inputTokens).toBe(30);
  expect(current.usage.turns).toBe(1);
  expect(current.sessions).toBe(1);
  expect(current.buckets.map((b) => b.key)).toEqual(["2026-09-27"]);
  expect(current.timeBasis).toBe("usage-day");
  await snapshot({
    ...session,
    updatedAt: stamp("2026-09-27"),
    usage: usage(130, 2),
    usageByDay: [
      { date: "2026-09-20", usage: usage(100, 1) },
      { date: "2026-09-27", usage: usage(30, 1) },
    ],
  });
  const all = await relay.hub.stats(relay.principal.owner, {});
  expect(all.usage.inputTokens).toBe(130);
  expect(all.usage.turns).toBe(2);
  expect(all.sessions).toBe(1);
  expect(all.buckets).toHaveLength(2);
  // A stale indexed snapshot must not erase a live suffix or count its history again.
  await snapshot(session);
  expect((await relay.hub.stats(relay.principal.owner, {})).usage.inputTokens).toBe(130);
});

test("indexed daily data replaces legacy cohort allocation without double counting subsequent live usage", async () => {
  const relay = await setup(new MemoryStore());
  const device = await relay.pair();
  const session: Session = {
    id: "legacy-day-session",
    nativeId: "legacy-native",
    deviceId: device.deviceId,
    agent: "claude",
    cwd: "/tmp/days",
    title: "legacy",
    status: "idle",
    source: "local",
    readOnly: false,
    createdAt: stamp("2026-09-20"),
    updatedAt: stamp("2026-09-21"),
    usage: usage(100, 2),
  };
  const snapshot = (value: Session) =>
    relay.hub.ingest(
      device.principal,
      makeEnvelope("session.snapshot", { sessions: [value] }, { deviceId: device.deviceId }),
    );
  await snapshot(session);
  expect((await relay.hub.stats(relay.principal.owner, {})).timeBasis).toBe("session-created-at");
  await relay.hub.ingest(
    device.principal,
    makeEnvelope(
      "session.event",
      { kind: "usage", usage: usage(120, 3) },
      { deviceId: device.deviceId, sessionId: session.id, ts: stamp("2026-09-27") },
    ),
  );
  await snapshot({
    ...session,
    usageByDay: [
      { date: "2026-09-20", usage: usage(60, 1) },
      { date: "2026-09-21", usage: usage(40, 1) },
    ],
  });
  const result = await relay.hub.stats(relay.principal.owner, {});
  expect(result.usage.inputTokens).toBe(120);
  expect(result.sessions).toBe(1);
  expect(result.timeBasis).toBe("usage-day");
  expect(result.buckets.map((b) => [b.key, b.usage.inputTokens])).toEqual([
    ["2026-09-20", 60],
    ["2026-09-21", 40],
    ["2026-09-27", 20],
  ]);
});

test("native identity reconciliation deduplicates per-day snapshots and group session counts", async () => {
  const relay = await setup(new MemoryStore());
  const device = await relay.pair();
  const session: Session = {
    id: "managed-days",
    deviceId: device.deviceId,
    agent: "codex",
    cwd: "/tmp/days",
    title: "identity",
    status: "idle",
    source: "managed",
    readOnly: false,
    createdAt: stamp("2026-09-20"),
    updatedAt: stamp("2026-09-20"),
    usage: usage(10, 1),
    usageByDay: [{ date: "2026-09-20", usage: usage(10, 1) }],
  };
  const snapshot = (value: Session) =>
    relay.hub.ingest(
      device.principal,
      makeEnvelope("session.snapshot", { sessions: [value] }, { deviceId: device.deviceId }),
    );
  await snapshot(session);
  await snapshot({ ...session, nativeId: "mapped-native" });
  await snapshot({
    ...session,
    nativeId: "mapped-native",
    id: "local-days",
    source: "local",
    usage: usage(30, 2),
    usageByDay: [
      { date: "2026-09-20", usage: usage(10, 1) },
      { date: "2026-09-21", usage: usage(20, 1) },
    ],
  });
  const result = await relay.hub.stats(relay.principal.owner, { groupBy: "agent" });
  expect(result.sessions).toBe(1);
  expect(result.usage.inputTokens).toBe(30);
  expect(result.buckets[0]?.sessions).toBe(1);
  expect(result.groups[0]?.totals.sessionCount).toBe(1);
});

test("indexed source watermark corrects midnight allocation while preserving the newer live suffix", async () => {
  const relay = await setup(new MemoryStore());
  const device = await relay.pair();
  const session: Session = {
    id: "watermark-session",
    nativeId: "watermark-native",
    deviceId: device.deviceId,
    agent: "codex",
    cwd: "/tmp/days",
    title: "midnight",
    status: "idle",
    source: "local",
    readOnly: false,
    createdAt: stamp("2026-09-20"),
    updatedAt: stamp("2026-09-20"),
    usage: usage(100, 1),
    usageByDay: [{ date: "2026-09-20", usage: usage(100, 1) }],
  };
  const snapshot = (value: Session) =>
    relay.hub.ingest(
      device.principal,
      makeEnvelope("session.snapshot", { sessions: [value] }, { deviceId: device.deviceId }),
    );
  const live = (count: number, ts: string) =>
    relay.hub.ingest(
      device.principal,
      makeEnvelope(
        "session.event",
        { kind: "usage", usage: usage(count, 2) },
        { deviceId: device.deviceId, sessionId: session.id, ts: Date.parse(ts) },
      ),
    );
  await snapshot(session);
  await live(120, "2026-09-21T00:00:02Z");
  await snapshot({
    ...session,
    updatedAt: Date.parse("2026-09-21T00:00:03Z"),
    usage: usage(120, 2),
    usageByDay: [{ date: "2026-09-20", usage: usage(120, 2) }],
  });
  let result = await relay.hub.stats(relay.principal.owner, {});
  expect(result.buckets.map((b) => [b.key, b.usage.inputTokens])).toEqual([["2026-09-20", 120]]);
  await live(150, "2026-09-21T00:00:05Z");
  await snapshot({
    ...session,
    updatedAt: Date.parse("2026-09-21T00:00:04Z"),
    usage: usage(125, 2),
    usageByDay: [
      { date: "2026-09-20", usage: usage(120, 2) },
      { date: "2026-09-21", usage: usage(5) },
    ],
  });
  await snapshot(session);
  result = await relay.hub.stats(relay.principal.owner, {});
  expect(result.usage.inputTokens).toBe(150);
  expect(result.buckets.map((b) => [b.key, b.usage.inputTokens])).toEqual([
    ["2026-09-20", 120],
    ["2026-09-21", 30],
  ]);
  expect(result.timeBasis).toBe("usage-day");
});
