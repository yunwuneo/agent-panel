import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Envelope, makeEnvelope } from "@agentpanel/protocol";
import postgres from "postgres";
import { configSchema, pair } from "../../daemon/src/config";
import { SessionManager } from "../../daemon/src/manager";
import { Store as DaemonStore } from "../../daemon/src/store";
import { RelayConnection } from "../../daemon/src/transport";
import { createRelay } from "../src/app";
import { migrate } from "../src/migrate";
import { startServer } from "../src/server";
import { PostgresStore } from "../src/store";
import { ControlledAdapter } from "./controlled-adapter";
import { config, setup } from "./helpers";

async function eventually(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeout = 8000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error(message);
}

async function clientSocket(url: string, ticket: string, deviceId: string) {
  const socket = new WebSocket(`${url.replace("http", "ws")}/ws?ticket=${ticket}`);
  const events: Envelope[] = [];
  socket.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as Envelope;
    events.push(event);
    if (event.type === "ping") socket.send(JSON.stringify(makeEnvelope("pong", {})));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Client socket failed")), {
      once: true,
    });
  });
  const subscribe = makeEnvelope("subscribe", { deviceIds: [deviceId] });
  socket.send(JSON.stringify(subscribe));
  await eventually(
    () => events.some((e) => e.type === "ack" && e.payload.ackId === subscribe.id),
    "Client subscription was not acknowledged",
  );
  return { socket, events };
}

const databaseUrl = process.env.TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "real Relay + daemon manager/journals: stream, approvals, interrupt/resume, restart and replay",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agentpanel-stack-"));
    const admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const schema = `agentpanel_stack_${crypto.randomUUID().replaceAll("-", "")}`;
    let relayStore: PostgresStore | undefined;
    let daemonStore: DaemonStore | undefined;
    let transport: RelayConnection | undefined;
    let manager: SessionManager | undefined;
    let server: ReturnType<typeof startServer> | undefined;
    let browser: Awaited<ReturnType<typeof clientSocket>> | undefined;
    let relay: ReturnType<typeof createRelay> | undefined;
    try {
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      const database = new URL(databaseUrl!);
      database.searchParams.set("options", `-c search_path=${schema}`);
      await migrate(database.toString());
      relayStore = PostgresStore.connect(database.toString());
      const initialized = await setup(relayStore);
      relay = initialized;
      server = startServer(relay, { ...config, port: 0 });
      const port = server.port!;
      const base = `http://127.0.0.1:${port}`;
      const request = async (path: string, data?: unknown) => {
        const response = await fetch(base + path, {
          method: data === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${initialized.credentials.accessToken}`,
            Origin: config.origin,
            "Content-Type": "application/json",
          },
          ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
        });
        const result = (await response.json()) as any;
        if (!response.ok) throw new Error(`${response.status}: ${result.error?.code}`);
        return result;
      };
      const pairing = await request("/api/pairing", {});
      const daemonConfig = await pair(
        configSchema.parse({
          relayUrl: base,
          name: "Isolated integration daemon",
          roots: [temporary],
          importHistory: false,
          claudeHome: join(temporary, "claude"),
          codexHome: join(temporary, "codex"),
        }),
        pairing.code,
        join(temporary, "config.json"),
      );
      expect(daemonConfig.deviceId).toBeTruthy();
      daemonStore = new DaemonStore(join(temporary, "daemon.sqlite"));
      const controlled = new ControlledAdapter();
      const published: Envelope[] = [];
      manager = new SessionManager(
        daemonConfig,
        daemonStore,
        (event) => {
          published.push(event);
          if (transport) transport.publish(event);
          else daemonStore!.enqueue(event);
        },
        () => controlled,
      );
      transport = new RelayConnection(daemonConfig, daemonStore, manager, [
        { kind: "codex", installed: true, authenticated: true, version: "controlled-test" },
      ]);
      await manager.start();
      const ticket = await request("/api/ws-ticket", {});
      browser = await clientSocket(base, ticket.ticket, daemonConfig.deviceId!);
      transport.start();
      await eventually(
        async () =>
          (await request("/api/devices")).devices.some(
            (d: any) => d.id === daemonConfig.deviceId && d.online,
          ),
        "Daemon did not connect",
      );

      const create = makeEnvelope(
        "session.create",
        { agent: "codex", cwd: temporary, prompt: "allow" },
        { deviceId: daemonConfig.deviceId },
      );
      const queued = await request("/api/commands", create);
      const sessionId = queued.sessionId as string;
      const resultSeen = (id: string) =>
        browser!.events.some(
          (e) => e.type === "result" && e.payload.requestId === id && e.payload.ok,
        );
      const turnEnded = (number: number) =>
        browser!.events.some(
          (e) =>
            e.type === "session.event" &&
            e.payload.kind === "turn.end" &&
            e.payload.turnId === `turn-${number}`,
        );
      await eventually(
        () =>
          browser!.events.some(
            (e) => e.type === "session.event" && e.payload.kind === "message.delta",
          ),
        "Streaming output was not delivered",
      );
      await eventually(
        () =>
          browser!.events.some(
            (e) => e.type === "approval.request" && e.payload.status === "pending",
          ),
        "Approval was not delivered",
      );
      const firstApproval = browser.events.find(
        (e) => e.type === "approval.request" && e.payload.status === "pending",
      ) as Envelope<"approval.request">;
      await eventually(
        () => resultSeen(create.id),
        "Create acceptance was blocked by pending approval",
      );
      expect(controlled.running).toBe(true);
      expect(
        (
          await request(`/api/approvals/${firstApproval.payload.id}/decision`, {
            decision: "allow",
          })
        ).approval.status,
      ).toBe("allowed");
      await eventually(() => turnEnded(1), "Turn did not complete after allow");
      expect(
        browser.events.some(
          (e) =>
            e.type === "session.event" &&
            e.payload.kind === "tool.result" &&
            (e.payload.output as any)?.decision === "allow",
        ),
      ).toBe(true);
      await request("/api/commands", create);
      expect(controlled.prompts).toEqual(["allow"]);

      const deny = makeEnvelope(
        "session.send",
        { prompt: "deny" },
        { deviceId: daemonConfig.deviceId, sessionId },
      );
      await request("/api/commands", deny);
      await eventually(
        () =>
          browser!.events.some(
            (e) =>
              e.type === "approval.request" &&
              e.payload.status === "pending" &&
              e.payload.id !== firstApproval.payload.id,
          ),
        "Second approval was not delivered",
      );
      const secondApproval = browser.events.find(
        (e) =>
          e.type === "approval.request" &&
          e.payload.status === "pending" &&
          e.payload.id !== firstApproval.payload.id,
      ) as Envelope<"approval.request">;
      expect(
        (
          await request(`/api/approvals/${secondApproval.payload.id}/decision`, {
            decision: "deny",
          })
        ).approval.status,
      ).toBe("denied");
      await eventually(
        () => resultSeen(deny.id) && turnEnded(2),
        "Turn did not complete after deny",
      );
      expect(
        browser.events.some(
          (e) =>
            e.type === "session.event" &&
            e.payload.kind === "tool.result" &&
            (e.payload.output as any)?.decision === "deny",
        ),
      ).toBe(true);

      const hold = makeEnvelope(
        "session.send",
        { prompt: "hold" },
        { deviceId: daemonConfig.deviceId, sessionId },
      );
      await request("/api/commands", hold);
      await eventually(
        () => controlled.running && controlled.prompts.length === 3,
        "Controlled turn did not start",
      );
      const interrupt = makeEnvelope(
        "session.interrupt",
        {},
        { deviceId: daemonConfig.deviceId, sessionId },
      );
      await request("/api/commands", interrupt);
      await eventually(
        () => resultSeen(interrupt.id) && resultSeen(hold.id) && turnEnded(3),
        "Interrupt did not release the active turn",
      );
      expect(controlled.running).toBe(false);
      const resume = makeEnvelope(
        "session.resume",
        { prompt: "resumed" },
        { deviceId: daemonConfig.deviceId, sessionId },
      );
      await request("/api/commands", resume);
      await eventually(() => resultSeen(resume.id) && turnEnded(4), "Resume did not complete");
      expect(controlled.prompts).toEqual(["allow", "deny", "hold", "resumed"]);

      const active = makeEnvelope(
        "session.send",
        { prompt: "hold" },
        { deviceId: daemonConfig.deviceId, sessionId },
      );
      await request("/api/commands", active);
      await eventually(
        () => controlled.running && controlled.prompts.length === 5,
        "Restart test turn did not start",
      );
      const before = await request(`/api/sessions/${sessionId}/events?after=0&limit=1000`);
      const cursor = before.nextSeq as number;
      browser.socket.close();
      relay.hub.close();
      await server.stop(true);
      server = undefined;
      await relayStore.close();
      controlled.emit({
        kind: "message.delta",
        messageId: "offline-message",
        text: "queued while relay stopped",
      });
      expect(controlled.running).toBe(true);
      expect(
        daemonStore
          .pending<Envelope>()
          .some(
            (e) => e.type === "session.event" && e.payload.text === "queued while relay stopped",
          ),
      ).toBe(true);
      relayStore = PostgresStore.connect(database.toString());
      relay = createRelay(relayStore, config);
      await relay.initialize();
      server = startServer(relay, { ...config, port });
      const nextTicket = await request("/api/ws-ticket", {});
      browser = await clientSocket(base, nextTicket.ticket, daemonConfig.deviceId!);
      await eventually(
        async () => (await request("/api/devices")).devices.some((d: any) => d.online),
        "Daemon did not reconnect after Relay restart",
      );
      await eventually(
        async () =>
          (await request(`/api/sessions/${sessionId}/events?after=${cursor}`)).events.some(
            (e: Envelope) =>
              e.type === "session.event" && e.payload.text === "queued while relay stopped",
          ),
        "Durable daemon outbox was not replayed after restart",
      );
      expect(controlled.prompts).toHaveLength(5);
      const after = await request(`/api/sessions/${sessionId}/events?after=${cursor}&limit=1000`);
      const offline = after.events.filter(
        (e: Envelope) =>
          e.type === "session.event" && e.payload.text === "queued while relay stopped",
      );
      expect(offline).toHaveLength(1);
      expect(offline[0].seq).toBeGreaterThan(cursor);
      expect(new Set(after.events.map((e: Envelope) => e.seq)).size).toBe(after.events.length);
      const finalInterrupt = makeEnvelope(
        "session.interrupt",
        {},
        { deviceId: daemonConfig.deviceId, sessionId },
      );
      await request("/api/commands", finalInterrupt);
      await eventually(
        () => resultSeen(finalInterrupt.id),
        "Reconnected daemon did not accept interrupt",
      );
      await eventually(
        () => daemonStore!.pending().length === 0,
        "Daemon outbox retained acknowledged messages",
      );
      const stats = await request("/api/stats");
      expect(stats.sessions).toBe(1);
      expect(stats.usage.inputTokens).toBe(50);
      expect(stats.usage.turns).toBe(5);
      const audit = await request("/api/audit");
      expect(audit.entries.filter((e: any) => e.action === "approval.decide")).toHaveLength(2);
      expect(
        published.filter((e) => e.type === "approval.request" && e.payload.status === "allowed"),
      ).toHaveLength(1);
    } finally {
      await transport?.close();
      await manager?.close();
      browser?.socket.close();
      relay?.hub.close();
      await server?.stop(true);
      // Allow pending disconnect bookkeeping to settle before closing the database.
      await Bun.sleep(50);
      daemonStore?.close();
      await relayStore?.close();
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(temporary, { recursive: true, force: true });
    }
  },
  30_000,
);
