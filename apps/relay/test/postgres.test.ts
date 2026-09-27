import { expect, test } from "bun:test";
import { makeEnvelope } from "@agentpanel/protocol";
import postgres from "postgres";
import { createRelay } from "../src/app";
import { migrate } from "../src/migrate";
import { PostgresStore } from "../src/store";
import { config, setup } from "./helpers";

const databaseUrl = process.env.TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "PostgreSQL restart, concurrent pairing/approval, rollback, replay and retention",
  async () => {
    const admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const schema = `agentpanel_test_${crypto.randomUUID().replaceAll("-", "")}`;
    let store: PostgresStore | undefined;
    try {
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      const url = new URL(databaseUrl!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      await migrate(url.toString());
      store = PostgresStore.connect(url.toString());
      const relay = await setup(store);
      const pairing = (await (await relay.request("/api/pairing", {})).json()) as { code: string };
      const claims = await Promise.all(
        Array.from({ length: 4 }, () =>
          relay.request("/api/pairing/redeem", {
            code: pairing.code,
            name: "Concurrent",
            platform: "linux",
          }),
        ),
      );
      expect(claims.filter((r) => r.status === 200)).toHaveLength(1);
      expect(claims.filter((r) => r.status === 400)).toHaveLength(3);
      const device = (await claims.find((r) => r.status === 200)!.json()) as {
        deviceId: string;
        deviceToken: string;
      };
      const principal = await relay.auth.authenticate(device.deviceToken);
      const command = makeEnvelope(
        "session.create",
        { agent: "claude", cwd: "/tmp/test", prompt: "integration" },
        { deviceId: device.deviceId },
      );
      const queued = await relay.hub.command(relay.principal.owner, command);
      const another = await relay.hub.command(relay.principal.owner, {
        ...command,
        id: crypto.randomUUID(),
      });
      const scoped = makeEnvelope(
        "session.send",
        { prompt: "same scoped prompt" },
        { deviceId: device.deviceId, sessionId: queued.sessionId },
      );
      await relay.hub.command(relay.principal.owner, scoped);
      await expect(
        relay.hub.command(relay.principal.owner, { ...scoped, sessionId: another.sessionId }),
      ).rejects.toThrow("命令编号");
      await expect(
        relay.hub.command(relay.principal.owner, { ...command, sessionId: another.sessionId }),
      ).rejects.toThrow("命令编号");

      const event = makeEnvelope(
        "session.event",
        { kind: "message.done", text: "durable" },
        { deviceId: device.deviceId, sessionId: queued.sessionId },
      );
      await Promise.all(Array.from({ length: 6 }, () => relay.hub.ingest(principal, event)));
      expect(
        (await relay.hub.events(relay.principal.owner, queued.sessionId!, 0, 500)).events,
      ).toHaveLength(1);
      const approval = {
        id: "approval-concurrent",
        deviceId: device.deviceId,
        sessionId: queued.sessionId!,
        toolName: "Bash",
        input: { command: "pwd" },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        status: "pending" as const,
      };
      await relay.hub.ingest(
        principal,
        makeEnvelope("approval.request", approval, {
          deviceId: device.deviceId,
          sessionId: queued.sessionId,
        }),
      );
      const decisions = await Promise.allSettled([
        relay.hub.decide(relay.principal.owner, approval.id, "allow"),
        relay.hub.decide(relay.principal.owner, approval.id, "deny"),
      ]);
      expect(decisions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (await store.list("audit", relay.principal.owner)).filter(
          (r) => r.action === "approval.decide",
        ),
      ).toHaveLength(1);
      await expect(
        store.atomic("rollback", async (tx) => {
          await tx.put("audit", {
            id: "rollback",
            owner: relay.principal.owner,
            createdAt: Date.now(),
          });
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect(await store.get("audit", "rollback")).toBeUndefined();
      const oldUsage = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        turns: 1,
      };
      await relay.hub.ingest(
        principal,
        makeEnvelope(
          "session.snapshot",
          {
            sessions: [
              {
                id: queued.sessionId!,
                deviceId: device.deviceId,
                nativeId: "postgres-day-native",
                agent: "claude",
                cwd: "/tmp/test",
                title: "daily restart",
                status: "idle",
                source: "managed",
                readOnly: false,
                createdAt: Date.parse("2026-09-20T12:00:00Z"),
                updatedAt: Date.parse("2026-09-20T12:00:00Z"),
                usage: oldUsage,
                usageByDay: [{ date: "2026-09-20", usage: oldUsage }],
              },
            ],
          },
          { deviceId: device.deviceId },
        ),
      );
      await relay.hub.ingest(
        principal,
        makeEnvelope(
          "session.event",
          { kind: "usage", usage: { ...oldUsage, inputTokens: 130, outputTokens: 65, turns: 2 } },
          {
            deviceId: device.deviceId,
            sessionId: queued.sessionId,
            ts: Date.parse("2026-09-27T12:00:00Z"),
          },
        ),
      );
      expect(
        (
          await relay.request(
            "/api/pricing",
            { model: "custom-model", input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 },
            "PUT",
          )
        ).status,
      ).toBe(200);
      await store.close();
      store = PostgresStore.connect(url.toString());
      const restarted = createRelay(store, config);
      await restarted.initialize();
      const pricingResponse = await restarted.app.request("/api/pricing", {
        headers: { authorization: `Bearer ${relay.credentials.accessToken}` },
      });
      const pricing = (await pricingResponse.json()) as {
        models: { model: string; source: string; price: { input: number } }[];
      };
      expect(pricing.models.find((row) => row.model === "custom-model")).toMatchObject({
        source: "custom",
        price: { input: 1 },
      });
      expect((await restarted.auth.authenticate(relay.credentials.accessToken)).owner).toBe(
        relay.principal.owner,
      );
      expect((await restarted.auth.authenticate(device.deviceToken)).deviceId).toBe(
        device.deviceId,
      );
      const history = await restarted.hub.events(relay.principal.owner, queued.sessionId!, 0, 500);
      expect(history.events).toHaveLength(3);
      expect(history.events.map((e) => e.seq)).toEqual([1, 2, 3]);
      const today = await restarted.hub.stats(relay.principal.owner, {
        from: Date.parse("2026-09-27T00:00:00Z"),
        to: Date.parse("2026-09-27T23:59:59Z"),
      });
      expect(today.usage.inputTokens).toBe(30);
      expect(today.usage.turns).toBe(1);
      expect(today.timeBasis).toBe("usage-day");
      const messages: string[] = [];
      const peer = await restarted.hub.connect(principal, {
        send: (s) => messages.push(s),
        close: () => {},
      });
      expect(messages.map((s) => JSON.parse(s)).some((m) => m.id === command.id)).toBe(true);
      await restarted.hub.receive(peer, JSON.stringify(makeEnvelope("ack", { ackId: command.id })));
      restarted.hub.disconnect(peer);
      await store.put("events", {
        id: "expired-event",
        owner: relay.principal.owner,
        createdAt: 1,
        expiresAt: 2,
      });
      await store.put("audit", {
        id: "retained-audit",
        owner: relay.principal.owner,
        createdAt: 1,
        expiresAt: Date.now() + 180 * 86400_000,
      });
      await store.prune(Date.now());
      expect(await store.get("events", "expired-event")).toBeUndefined();
      expect(await store.get("audit", "retained-audit")).toBeDefined();
    } finally {
      await store?.close();
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
  30_000,
);
