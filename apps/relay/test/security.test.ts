import { describe, expect, test } from "bun:test";
import { makeEnvelope, type Session } from "@agentpanel/protocol";
import { createRelay, RateLimiter } from "../src/app";
import { apnsTopicFor, validatePushEndpoint } from "../src/push";
import { MemoryStore } from "../src/store";
import { Authenticator, config, setup } from "./helpers";

describe("real WebAuthn and token security", () => {
  test("owner bootstrap verifies RP, origin, signature and one-use challenge", async () => {
    const relay = createRelay(new MemoryStore(), config);
    await relay.initialize();
    expect((await relay.auth.status()).registered).toBe(false);
    await expect(
      relay.auth.registrationOptions("other@example.invalid", config.bootstrapToken),
    ).rejects.toThrow();
    await expect(relay.auth.registrationOptions(config.ownerEmail, "bad")).rejects.toThrow();
    const challenge = await relay.auth.registrationOptions(
      config.ownerEmail,
      config.bootstrapToken,
    );
    const device = new Authenticator();
    await expect(
      relay.auth.registrationVerify(
        challenge.challengeId,
        device.register(challenge.options.challenge, "https://evil.invalid") as never,
      ),
    ).rejects.toThrow("Passkey");
    await expect(
      relay.auth.registrationVerify(
        challenge.challengeId,
        device.register(challenge.options.challenge, config.origin, "evil.invalid") as never,
      ),
    ).rejects.toThrow("Passkey");
    const credentials = await relay.auth.registrationVerify(
      challenge.challengeId,
      device.register(challenge.options.challenge) as never,
    );
    expect(credentials.recoveryCodes?.length).toBe(8);
    await expect(
      relay.auth.registrationVerify(
        challenge.challengeId,
        device.register(challenge.options.challenge) as never,
      ),
    ).rejects.toThrow();
    expect((await relay.auth.status()).registered).toBe(true);
    const login = await relay.auth.loginOptions(config.ownerEmail);
    const signed = device.login(login.options.challenge);
    const malformed = structuredClone(signed);
    malformed.response.signature = Buffer.alloc(70).toString("base64url");
    await expect(relay.auth.loginVerify(login.challengeId, malformed as never)).rejects.toThrow(
      "Passkey",
    );
    const valid = await relay.auth.loginVerify(login.challengeId, signed as never);
    expect((await relay.auth.authenticate(valid.accessToken)).role).toBe("client");
    await expect(relay.auth.loginVerify(login.challengeId, signed as never)).rejects.toThrow();
  });
  test("refresh rotation detects reuse and invalidates current access immediately", async () => {
    const relay = await setup(new MemoryStore());
    const refreshed = await relay.auth.refresh(relay.credentials.refreshToken);
    expect((await relay.auth.authenticate(refreshed.accessToken)).owner).toBe(
      relay.principal.owner,
    );
    await expect(relay.auth.refresh(relay.credentials.refreshToken)).rejects.toThrow();
    await expect(relay.auth.authenticate(refreshed.accessToken)).rejects.toThrow();
    await expect(relay.auth.refresh(refreshed.refreshToken)).rejects.toThrow();
  });
  test("recovery replaces credentials, invalidates sessions and consumes all old recovery codes", async () => {
    const relay = await setup(new MemoryStore());
    const oldCode = relay.credentials.recoveryCodes![0]!;
    const challenge = await relay.auth.recoveryOptions(config.ownerEmail, oldCode);
    const replacement = new Authenticator();
    const recovered = await relay.auth.registrationVerify(
      challenge.challengeId,
      replacement.register(challenge.options.challenge) as never,
    );
    await expect(relay.auth.authenticate(relay.credentials.accessToken)).rejects.toThrow();
    await expect(relay.auth.recoveryOptions(config.ownerEmail, oldCode)).rejects.toThrow();
    expect(recovered.recoveryCodes?.length).toBe(8);
    const login = await relay.auth.loginOptions(config.ownerEmail);
    await expect(
      relay.auth.loginVerify(
        login.challengeId,
        relay.authenticator.login(login.options.challenge) as never,
      ),
    ).rejects.toThrow();
    expect(
      (
        await relay.auth.loginVerify(
          login.challengeId,
          replacement.login(login.options.challenge) as never,
        )
      ).accessToken,
    ).toBeTruthy();
  });
  test("authentication precedes request parsing; browser refresh requires exact origin", async () => {
    const relay = await setup(new MemoryStore());
    expect((await relay.app.request("/api/commands", { method: "POST", body: "{" })).status).toBe(
      401,
    );
    expect(
      (
        await relay.app.request("/api/commands", {
          method: "POST",
          headers: { authorization: `Bearer ${relay.credentials.accessToken}` },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await relay.app.request("/api/auth/refresh", {
          method: "POST",
          headers: { cookie: `ap_refresh=${relay.credentials.refreshToken}` },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await relay.request("/api/auth/refresh", {
          refreshToken: relay.credentials.refreshToken,
          native: true,
        })
      ).status,
    ).toBe(200);
  });
  test("single-use websocket tickets, one-use pairing and immediate device revocation", async () => {
    const relay = await setup(new MemoryStore());
    const ticket = await relay.auth.ticket(relay.principal);
    expect((await relay.auth.redeemTicket(ticket.ticket)).owner).toBe(relay.principal.owner);
    await expect(relay.auth.redeemTicket(ticket.ticket)).rejects.toThrow();
    const device = await relay.pair();
    expect(
      (
        await relay.request("/api/pairing/redeem", {
          code: device.code,
          name: "Again",
          platform: "darwin",
        })
      ).status,
    ).toBe(400);
    expect((await relay.request("/api/devices", undefined, "GET", device.deviceToken)).status).toBe(
      403,
    );
    expect(
      (await relay.request(`/api/devices/${device.deviceId}`, undefined, "DELETE")).status,
    ).toBe(200);
    await expect(relay.auth.authenticate(device.deviceToken)).rejects.toThrow();
  });
});

describe("tenant isolation, delivery and approval integrity", () => {
  test("a valid second tenant cannot access owner data or route commands through HTTP", async () => {
    const store = new MemoryStore();
    const relay = await setup(store);
    const device = await relay.pair();
    const other = createRelay(store, { ...config, ownerEmail: "second@example.invalid" });
    await other.initialize();
    const authenticator = new Authenticator();
    const challenge = await other.auth.registrationOptions(
      "second@example.invalid",
      config.bootstrapToken,
    );
    const credentials = await other.auth.registrationVerify(
      challenge.challengeId,
      authenticator.register(challenge.options.challenge) as never,
    );
    const request = (path: string, body?: unknown) =>
      relay.request(path, body, body ? "POST" : "GET", credentials.accessToken);
    expect(await (await request("/api/devices")).json()).toEqual({ devices: [] });
    expect(await (await request("/api/sessions")).json()).toEqual({ sessions: [] });
    const command = makeEnvelope(
      "session.create",
      { agent: "codex", cwd: "/tmp", prompt: "forged" },
      { deviceId: device.deviceId },
    );
    expect((await request("/api/commands", command)).status).toBe(404);
    expect(
      (
        await relay.request(
          `/api/devices/${device.deviceId}`,
          { name: "forged" },
          "PATCH",
          credentials.accessToken,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await relay.request(
          `/api/devices/${device.deviceId}`,
          undefined,
          "DELETE",
          credentials.accessToken,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await relay.request(
          "/api/push/settings",
          { deviceId: device.deviceId },
          "PUT",
          credentials.accessToken,
        )
      ).status,
    ).toBe(404);
  });
  test("forged device scope, tenant session reads and subscription are rejected", async () => {
    const relay = await setup(new MemoryStore());
    const device = await relay.pair();
    const other = await relay.pair();
    const messages: string[] = [];
    const peerId = await relay.hub.connect(device.principal, {
      send: (s) => messages.push(s),
      close: () => {},
    });
    await expect(
      relay.hub.receive(
        peerId,
        JSON.stringify(
          makeEnvelope(
            "device.hello",
            { name: "x", platform: "linux", agents: [] },
            { deviceId: other.deviceId },
          ),
        ),
      ),
    ).rejects.toThrow();
    const client = await relay.hub.connect(relay.principal, { send: () => {}, close: () => {} });
    await expect(
      relay.hub.receive(
        client,
        JSON.stringify(makeEnvelope("subscribe", { sessionIds: ["other-tenant-session"] })),
      ),
    ).rejects.toThrow();
    expect((await relay.request("/api/sessions/other-tenant-session/events")).status).toBe(404);
    relay.hub.close();
  });
  test("commands survive reconnect and are acked once; event IDs replay with stable seq", async () => {
    const relay = await setup(new MemoryStore());
    const device = await relay.pair();
    const command = makeEnvelope(
      "session.create",
      { agent: "codex", cwd: "/tmp/agentpanel-test", prompt: "hello" },
      { deviceId: device.deviceId },
    );
    const queued = await relay.hub.command(relay.principal.owner, command);
    expect(queued.status).toBe("queued");
    const repeated = await relay.hub.command(relay.principal.owner, command);
    expect(repeated.sessionId).toBe(queued.sessionId);
    await expect(
      relay.hub.command(relay.principal.owner, {
        ...command,
        payload: { ...command.payload, prompt: "different" },
      }),
    ).rejects.toThrow("命令编号");
    const messages: string[] = [];
    const peer = await relay.hub.connect(device.principal, {
      send: (s) => messages.push(s),
      close: () => {},
    });
    expect(messages.map((s) => JSON.parse(s)).some((m) => m.id === command.id)).toBe(true);
    await relay.hub.receive(peer, JSON.stringify(makeEnvelope("ack", { ackId: command.id })));
    relay.hub.disconnect(peer);
    const reconnected: string[] = [];
    const next = await relay.hub.connect(device.principal, {
      send: (s) => reconnected.push(s),
      close: () => {},
    });
    expect(reconnected.map((s) => JSON.parse(s)).some((m) => m.id === command.id)).toBe(false);
    const event = makeEnvelope(
      "session.event",
      { kind: "message.delta", text: "hello" },
      { deviceId: device.deviceId, sessionId: queued.sessionId },
    );
    await relay.hub.receive(next, JSON.stringify(event));
    await relay.hub.receive(next, JSON.stringify(event));
    const history = await relay.hub.events(relay.principal.owner, queued.sessionId!, 0, 500);
    expect(history.events).toHaveLength(1);
    expect(history.nextSeq).toBe(1);
    const acks = reconnected
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === "ack" && m.payload.ackId === event.id);
    expect(acks).toHaveLength(2);
    expect(acks[0].payload.seq).toBe(acks[1].payload.seq);
    relay.hub.close();
  });
  test("command idempotency includes session scope while preserving generated create IDs", async () => {
    const relay = await setup(new MemoryStore());
    const device = await relay.pair();
    const create = makeEnvelope(
      "session.create",
      { agent: "codex", cwd: "/tmp", prompt: "same" },
      { deviceId: device.deviceId },
    );
    const first = await relay.hub.command(relay.principal.owner, create);
    expect((await relay.hub.command(relay.principal.owner, create)).sessionId).toBe(
      first.sessionId,
    );
    expect(
      (await relay.hub.command(relay.principal.owner, { ...create, sessionId: first.sessionId }))
        .sessionId,
    ).toBe(first.sessionId);
    await expect(
      relay.hub.command(relay.principal.owner, {
        ...create,
        sessionId: "different-explicit-session",
      }),
    ).rejects.toThrow("命令编号");
    const second = await relay.hub.command(relay.principal.owner, {
      ...create,
      id: crypto.randomUUID(),
    });
    const send = makeEnvelope(
      "session.send",
      { prompt: "same prompt" },
      { deviceId: device.deviceId, sessionId: first.sessionId },
    );
    expect((await relay.request("/api/commands", send)).status).toBe(200);
    expect(
      (await relay.request("/api/commands", { ...send, sessionId: second.sessionId })).status,
    ).toBe(409);
    expect((await relay.request("/api/commands", send)).status).toBe(200);
  });
  test("approval decisions are owner-scoped, idempotent and reject opposite/expired decisions", async () => {
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
    const approval = {
      id: "approval-test",
      deviceId: device.deviceId,
      sessionId: command.sessionId!,
      toolName: "Bash",
      input: { command: "pwd" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: "pending" as const,
    };
    await relay.hub.ingest(
      device.principal,
      makeEnvelope("approval.request", approval, {
        deviceId: device.deviceId,
        sessionId: command.sessionId,
      }),
    );
    await expect(relay.hub.decide("another-owner", approval.id, "allow")).rejects.toThrow();
    expect((await relay.hub.decide(relay.principal.owner, approval.id, "allow")).status).toBe(
      "allowed",
    );
    expect((await relay.hub.decide(relay.principal.owner, approval.id, "allow")).status).toBe(
      "allowed",
    );
    await expect(relay.hub.decide(relay.principal.owner, approval.id, "deny")).rejects.toThrow(
      "审批已有决定",
    );
    const audit = (await store.list("audit", relay.principal.owner)).filter(
      (r) => r.action === "approval.decide",
    );
    expect(audit).toHaveLength(1);
    const expired = { ...approval, id: "expired", expiresAt: Date.now() - 1 };
    await relay.hub.ingest(
      device.principal,
      makeEnvelope("approval.request", expired, {
        deviceId: device.deviceId,
        sessionId: command.sessionId,
      }),
    );
    await expect(relay.hub.decide(relay.principal.owner, "expired", "allow")).rejects.toThrow();
  });
  test("daemon approval lifecycle cannot self-allow and settles without reviving pending state", async () => {
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
    const approval = {
      id: "approval-lifecycle",
      deviceId: device.deviceId,
      sessionId: command.sessionId!,
      toolName: "Bash",
      input: { command: "pwd" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: "pending" as const,
    };
    const report = (status: "pending" | "allowed" | "denied" | "expired") =>
      relay.hub.ingest(
        device.principal,
        makeEnvelope(
          "approval.request",
          { ...approval, status },
          { deviceId: device.deviceId, sessionId: command.sessionId },
        ),
      );
    await report("pending");
    await expect(report("allowed")).rejects.toThrow("自行批准");
    await relay.hub.decide(relay.principal.owner, approval.id, "allow");
    await report("allowed");
    const replay = await report("pending");
    expect(replay.event.type === "approval.request" && replay.event.payload.status).toBe("allowed");
    expect((await store.get("approvals", approval.id))?.status).toBe("allowed");
  });
  test("historical snapshots and cumulative live usage deduplicate by native session", async () => {
    const relay = await setup(new MemoryStore());
    const device = await relay.pair();
    const session: Session = {
      id: "managed-1",
      nativeId: "native-1",
      deviceId: device.deviceId,
      agent: "codex",
      cwd: "/tmp",
      title: "test",
      source: "managed",
      status: "idle",
      readOnly: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await relay.hub.ingest(
      device.principal,
      makeEnvelope("session.snapshot", { sessions: [session] }, { deviceId: device.deviceId }),
    );
    const usage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      turns: 1,
    };
    await relay.hub.ingest(
      device.principal,
      makeEnvelope(
        "session.event",
        { kind: "usage", usage },
        { deviceId: device.deviceId, sessionId: session.id },
      ),
    );
    await relay.hub.ingest(
      device.principal,
      makeEnvelope(
        "session.snapshot",
        { sessions: [{ ...session, id: "local-1", source: "local", usage }] },
        { deviceId: device.deviceId },
      ),
    );
    const stats = await relay.hub.stats(relay.principal.owner, {});
    expect(stats.sessions).toBe(1);
    expect(stats.usage.inputTokens).toBe(100);
    expect(stats.usage.turns).toBe(1);
    expect(stats.groups[0]?.agent).toBe("codex");
    expect(stats.groups[0]?.project).toBe("/tmp");
    expect(stats.groups[0]?.totals.inputTokens).toBe(100);
    expect(stats.totals.costUsd).toBeUndefined();
    expect(stats.unpricedSessions).toBe(1);

    expect((await relay.hub.stats("another-owner", {})).sessions).toBe(0);
  });
  test("malicious snapshot cannot overwrite another owner or device's session", async () => {
    const store = new MemoryStore();
    const relay = await setup(store);
    const device = await relay.pair();
    const session: Session = {
      id: "other-owned",
      deviceId: "other-device",
      agent: "codex",
      cwd: "/tmp",
      title: "private",
      source: "local",
      status: "idle",
      readOnly: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.put("sessions", { ...session, owner: "another-owner" });
    await expect(
      relay.hub.ingest(
        device.principal,
        makeEnvelope(
          "session.snapshot",
          { sessions: [{ ...session, deviceId: device.deviceId }] },
          { deviceId: device.deviceId },
        ),
      ),
    ).rejects.toThrow();
    expect((await store.get("sessions", session.id))?.owner).toBe("another-owner");
  });
});

test("push endpoints prevent SSRF and rate limiter resets", () => {
  for (const endpoint of [
    "http://localhost/a",
    "https://127.0.0.1/push",
    "https://fcm.googleapis.com.evil.invalid/a",
    "https://user:pass@fcm.googleapis.com/a",
    "https://fcm.googleapis.com:1234/a",
  ])
    expect(() => validatePushEndpoint(endpoint)).toThrow();
  expect(() => validatePushEndpoint("https://fcm.googleapis.com/fcm/send/test")).not.toThrow();
  const limiter = new RateLimiter();
  expect(limiter.take("x", 1, 1000, 1)).toBe(true);
  expect(limiter.take("x", 1, 1000, 2)).toBe(false);
  expect(limiter.take("x", 1, 1000, 1002)).toBe(true);
});

test("APNs selects each platform topic and only falls back to an explicit shared topic", () => {
  const settings = {
    ...config,
    apnsIosTopic: "dev.test.ios",
    apnsMacosTopic: "dev.test.mac",
    apnsTopic: "dev.shared",
  };
  expect(apnsTopicFor(settings, "ios")).toBe("dev.test.ios");
  expect(apnsTopicFor(settings, "macos")).toBe("dev.test.mac");
  expect(apnsTopicFor({ ...config, apnsTopic: "dev.shared" }, "macos")).toBe("dev.shared");
  expect(apnsTopicFor({ ...config, apnsIosTopic: "dev.test.ios" }, "macos")).toBeUndefined();
  expect(apnsTopicFor(settings, "web")).toBeUndefined();
});
