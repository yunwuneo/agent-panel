import { expect, test } from "bun:test";
import { type Envelope, makeEnvelope } from "@agentpanel/protocol";
import { startServer } from "../src/server";
import { MemoryStore } from "../src/store";
import { config, setup } from "./helpers";

function socket(url: string, headers?: Record<string, string>) {
  const Socket = WebSocket as unknown as new (
    url: string,
    options?: Bun.WebSocketOptions,
  ) => WebSocket;
  const ws = new Socket(url, headers ? { headers } : undefined);
  const messages: Envelope[] = [];
  const waiters = new Set<() => void>();
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
    for (const wake of waiters) wake();
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
  });
  const until = (predicate: (event: Envelope) => boolean) =>
    new Promise<Envelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(check);
        reject(new Error("Expected transport event was not delivered"));
      }, 5000);
      const check = () => {
        const match = messages.find(predicate);
        if (match) {
          clearTimeout(timeout);
          waiters.delete(check);
          resolve(match);
        }
      };
      waiters.add(check);
      check();
    });
  return { ws, opened, until, messages };
}

test("actual HTTP/WebSocket transport routes subscribed events and closes revoked devices", async () => {
  const relay = await setup(new MemoryStore());
  const server = startServer(relay, { ...config, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  let daemon: ReturnType<typeof socket> | undefined;
  let browser: ReturnType<typeof socket> | undefined;
  try {
    const request = (path: string, body?: unknown, method = body ? "POST" : "GET") =>
      fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${relay.credentials.accessToken}`,
          Origin: config.origin,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect((await fetch(`${base}/api/commands`, { method: "POST", body: "{" })).status).toBe(401);
    expect((await fetch(`${base}/ws?token=forbidden-query-token`)).status).toBe(401);
    const pair = (await (await request("/api/pairing", {})).json()) as { code: string };
    const device = (await (
      await request("/api/pairing/redeem", {
        code: pair.code,
        name: "Transport",
        platform: "linux",
      })
    ).json()) as { deviceId: string; deviceToken: string };
    const ticket = (await (await request("/api/ws-ticket", {})).json()) as { ticket: string };
    browser = socket(`${wsBase}/ws?ticket=${ticket.ticket}`, { Origin: config.origin });
    await browser.opened;
    const subscribe = makeEnvelope("subscribe", { deviceIds: [device.deviceId] });
    browser.ws.send(JSON.stringify(subscribe));
    await browser.until((e) => e.type === "ack" && e.payload.ackId === subscribe.id);
    expect((await fetch(`${base}/ws?ticket=${ticket.ticket}`)).status).toBe(401);
    daemon = socket(`${wsBase}/ws`, { Authorization: `Bearer ${device.deviceToken}` });
    await daemon.opened;
    const create = makeEnvelope(
      "session.create",
      { agent: "codex", cwd: "/tmp", prompt: "transport" },
      { deviceId: device.deviceId },
    );
    const queued = (await (await request("/api/commands", create)).json()) as { sessionId: string };
    const received = await daemon.until((e) => e.id === create.id);
    expect(received.sessionId).toBe(queued.sessionId);
    daemon.ws.send(JSON.stringify(makeEnvelope("ack", { ackId: create.id })));
    const event = makeEnvelope(
      "session.event",
      { kind: "message.delta", text: "real socket" },
      { deviceId: device.deviceId, sessionId: queued.sessionId },
    );
    daemon.ws.send(JSON.stringify(event));
    expect((await daemon.until((e) => e.type === "ack" && e.payload.ackId === event.id)).type).toBe(
      "ack",
    );
    expect((await browser.until((e) => e.id === event.id)).seq).toBe(1);
    const replay = (await (
      await request(`/api/sessions/${queued.sessionId}/events?after=0`)
    ).json()) as { events: Envelope[] };
    expect(replay.events.map((e) => e.id)).toEqual([event.id]);
    const closed = new Promise<number>((resolve) =>
      daemon!.ws.addEventListener("close", (e) => resolve(e.code), { once: true }),
    );
    expect((await request(`/api/devices/${device.deviceId}`, undefined, "DELETE")).status).toBe(
      200,
    );
    expect(await closed).toBe(4003);
  } finally {
    daemon?.ws.close();
    browser?.ws.close();
    relay.hub.close();
    await server.stop(true);
  }
}, 20_000);
