import { expect, test } from "bun:test";
import { isExcludedProject, makeEnvelope, type Session, type Usage } from "@agentpanel/protocol";
import { MemoryStore } from "../src/store";
import { setup } from "./helpers";

const usage = (inputTokens: number): Usage => ({
  inputTokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turns: 1,
  activeMs: 0,
});

test("project exclusion matches whole path segments on either separator", () => {
  expect(isExcludedProject("/work/app", ["/work/app"])).toBe(true);
  expect(isExcludedProject("/work/app/packages/ui", ["/work/app/"])).toBe(true);
  expect(isExcludedProject("/work/app-old", ["/work/app"])).toBe(false);
  expect(isExcludedProject("C:\\work\\app\\src", ["C:/work/app"])).toBe(true);
  expect(isExcludedProject("/work/app", ["/"])).toBe(false);
  expect(isExcludedProject("/work/app", undefined)).toBe(false);
});

test("device exclusions hide sessions and usage only for that device", async () => {
  const relay = await setup(new MemoryStore());
  const device = await relay.pair();
  const session = (id: string, cwd: string, tokens: number): Session => ({
    id,
    deviceId: device.deviceId,
    agent: "codex",
    cwd,
    title: id,
    status: "idle",
    source: "local",
    readOnly: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: usage(tokens),
  });
  await relay.hub.ingest(
    device.principal,
    makeEnvelope(
      "session.snapshot",
      { sessions: [session("kept", "/work/app", 10), session("hidden", "/work/scratch/a", 90)] },
      { deviceId: device.deviceId },
    ),
  );
  const patch = (body: unknown) => relay.request(`/api/devices/${device.deviceId}`, body, "PATCH");
  expect((await patch({})).status).toBe(400);
  const updated = await patch({ excludedProjects: [" /work/scratch ", "/work/scratch"] });
  expect(updated.status).toBe(200);
  expect((await updated.json()).device.excludedProjects).toEqual(["/work/scratch"]);

  const listed = await (await relay.request("/api/sessions", undefined, "GET")).json();
  expect(listed.sessions.map((s: Session) => s.id)).toEqual(["kept"]);
  const devices = await (await relay.request("/api/devices", undefined, "GET")).json();
  expect(devices.devices[0].excludedProjects).toEqual(["/work/scratch"]);
  expect((await relay.hub.stats(relay.principal.owner, {})).usage.inputTokens).toBe(10);

  await patch({ excludedProjects: [] });
  expect((await relay.hub.sessions(relay.principal.owner)).length).toBe(2);
  expect((await relay.hub.stats(relay.principal.owner, {})).usage.inputTokens).toBe(100);
});
