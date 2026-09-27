import { expect, test } from "bun:test";
import {
  addUsage,
  emptyUsage,
  isQuotaProbe,
  makeEnvelope,
  type Session,
  type Usage,
} from "@agentpanel/protocol";
import { effectivePrices, priceId, priceUsage } from "../src/pricing";
import { MemoryStore } from "../src/store";
import { queryStats, recordUsage } from "../src/usage";
import { setup } from "./helpers";

const amount = (model: string, inputTokens = 1_000_000): Usage => ({
  ...emptyUsage(),
  model,
  inputTokens,
});
const sample = (usage: Usage): Session => ({
  id: "s",
  deviceId: "d",
  nativeId: "native",
  agent: "codex",
  cwd: "/work",
  title: "work",
  source: "local",
  status: "completed",
  readOnly: false,
  createdAt: 1000,
  updatedAt: 2000,
  usage,
  usageByDay: [{ date: "1970-01-01", usage }],
});

test("prices cache categories once, leaves unknown names blank and honors source costs", async () => {
  const { prices } = await effectivePrices(new MemoryStore(), "owner");
  const usage = {
    ...amount("gpt-6-sol"),
    outputTokens: 200_000,
    cacheReadTokens: 400_000,
    cacheWriteTokens: 100_000,
  };
  expect(priceUsage(usage, prices).usage.costUsd).toBeCloseTo(3.33);
  expect(priceUsage(amount("gpt-5.6-luna"), prices).usage.costUsd).toBeUndefined();
  expect(priceUsage(amount("gpt-6-sol-custom"), prices).missingModels).toEqual([
    "gpt-6-sol-custom",
  ]);
  expect(priceUsage({ ...usage, costUsd: 123 }, prices).usage.costUsd).toBe(123);
  expect(priceUsage(emptyUsage(), prices).usage.costUsd).toBe(0);
});

test("mixed models retain partial cost and unknown attribution cannot masquerade as last model", async () => {
  const { prices } = await effectivePrices(new MemoryStore(), "owner");
  const known = amount("gpt-6-sol"),
    unknown = amount("custom");
  const mixed = { ...addUsage(known, unknown), byModel: [known, unknown] };
  expect(priceUsage(mixed, prices)).toMatchObject({
    usage: { costUsd: 2 },
    missingModels: ["custom"],
  });
  expect(priceUsage({ ...mixed, byModel: [known], model: "gpt-6-sol" }, prices)).toMatchObject({
    missingModels: ["未记录模型"],
  });
});

test("pricing API persists owner-scoped overrides; lower and zero rates reprice history and reset restores defaults", async () => {
  const store = new MemoryStore();
  const relay = await setup(store);
  const owner = relay.principal.owner;
  await recordUsage(store, owner, sample(amount("gpt-6-sol")));
  const stats = () => queryStats(store, owner, {});
  expect((await stats()).totals.costUsd).toBe(2);
  const price = { model: "gpt-6-sol", input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 };
  expect((await relay.request("/api/pricing", price, "PUT")).status).toBe(200);
  expect((await stats()).totals.costUsd).toBe(0.5);
  expect((await effectivePrices(store, "someone-else")).prices.get(price.model)?.input).toBe(2);
  const catalog = (await (await relay.request("/api/pricing")).json()) as any;
  expect(catalog.models.find((item: any) => item.model === price.model)).toMatchObject({
    source: "custom",
    observed: true,
  });
  await relay.request("/api/pricing", { ...price, input: 0 }, "PUT");
  expect((await stats()).totals).toMatchObject({ costUsd: 0, costComplete: true });
  expect((await relay.request("/api/pricing?model=gpt-6-sol", undefined, "DELETE")).status).toBe(
    200,
  );
  expect((await stats()).totals.costUsd).toBe(2);
  expect((await store.list<any>("usage", owner))[0].usage.costUsd).toBeUndefined();
  expect((await relay.request("/api/pricing", { ...price, input: "" }, "PUT")).status).toBe(400);
  expect((await relay.request("/api/pricing", { ...price, input: -1 }, "PUT")).status).toBe(400);
  expect((await relay.request("/api/pricing", "broken json", "PUT", "invalid")).status).toBe(401);
  const device = await relay.pair();
  expect((await relay.request("/api/pricing", price, "PUT", device.deviceToken)).status).toBe(403);
});

test("unknown models appear in settings and partial stats stay incomplete until their price is supplied", async () => {
  const store = new MemoryStore();
  const known = amount("gpt-6-sol"),
    unknown = amount("custom");
  const usage = { ...addUsage(known, unknown), byModel: [known, unknown] };
  const session = sample(usage);
  await recordUsage(store, "owner", session);
  await recordUsage(store, "owner", session); // Repeated cumulative snapshots must not double costs.
  let stats = await queryStats(store, "owner", {});
  expect(stats.totals).toMatchObject({
    costUsd: 2,
    costComplete: false,
    unpricedSessions: 1,
    inputTokens: 2_000_000,
  });
  expect(stats.missingModels).toEqual(["custom"]);
  await store.put("model_prices", {
    id: priceId("owner", "custom"),
    owner: "owner",
    createdAt: 1,
    price: { model: "custom", input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  stats = await queryStats(store, "owner", {});
  expect(stats.totals).toMatchObject({ costUsd: 5, costComplete: true });
  expect(stats.usage.costUsd).toBe(5);
});

test("ClaudeProbe exclusion uses provenance, including legacy records; ordinary similarly named projects remain", async () => {
  const store = new MemoryStore();
  const relay = await setup(store);
  const device = await relay.pair();
  const probe = {
    ...sample(amount("claude-opus-5")),
    deviceId: device.deviceId,
    agent: "claude" as const,
    cwd: "/Users/test/Library/Application Support/CodexBar/ClaudeProbe",
  };
  expect(isQuotaProbe(probe)).toBe(true);
  expect(isQuotaProbe({ ...probe, source: "managed" })).toBe(false);
  expect(isQuotaProbe({ ...probe, cwd: "/tmp/ClaudeProbe" })).toBe(false);
  expect(isQuotaProbe({ ...probe, agent: "codex" })).toBe(false);
  await relay.hub.ingest(
    device.principal,
    makeEnvelope("session.snapshot", { sessions: [probe] }, { deviceId: device.deviceId }),
  );
  expect(await relay.hub.sessions(relay.principal.owner)).toHaveLength(0);
  expect((await relay.hub.stats(relay.principal.owner, {})).sessions).toBe(0);
  expect(await store.list("sessions", relay.principal.owner)).toHaveLength(1);
  // Old usage entries have no source or marker, and may outlive their original log.
  await store.put("usage", {
    id: "legacy-probe",
    owner: relay.principal.owner,
    createdAt: 1,
    updatedAt: 2,
    sessionId: "legacy-probe",
    deviceId: device.deviceId,
    agent: "claude",
    project: probe.cwd,
    usage: amount("claude-opus-5"),
  });
  expect((await relay.hub.stats(relay.principal.owner, {})).sessions).toBe(0);
  await relay.hub.ingest(
    device.principal,
    makeEnvelope(
      "session.snapshot",
      { sessions: [{ ...probe, id: "real", nativeId: "real", cwd: "/tmp/ClaudeProbe" }] },
      { deviceId: device.deviceId },
    ),
  );
  expect(await relay.hub.sessions(relay.principal.owner)).toHaveLength(1);
  expect((await relay.hub.stats(relay.principal.owner, {})).totals.costUsd).toBe(5);
});
