import {
  type Answers,
  COMMAND_TYPES,
  type Device,
  type Envelope,
  isExcludedProject,
  isQuotaProbe,
  makeEnvelope,
  parseEnvelope,
  type Question,
  type Session,
  SessionSchema,
} from "@agentpanel/protocol";
import { ApiError, type AuthService, digest, missing, type Principal, token } from "./auth";
import type { RelayConfig } from "./config";
import type { RecordData, Store } from "./store";
import { mergeUsage, queryStats, recordUsage } from "./usage";

export { mergeUsage } from "./usage";

export interface PeerSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}
interface Peer {
  id: string;
  principal: Principal;
  socket: PeerSocket;
  devices: Set<string>;
  sessions: Set<string>;
  lastSeen: number;
}
type SessionRecord = RecordData & Session & { seq?: number };
type DeviceRecord = RecordData & Device & { tokenHash: string; revokedAt?: number };
type EventRecord = RecordData & {
  envelope: Envelope;
  deviceId: string;
  sessionId?: string;
  seq?: number;
};
type CommandRecord = RecordData & {
  envelope: Envelope;
  deviceId: string;
  deadline: number;
  ackedAt?: number;
  expired?: boolean;
};
export type NotificationKind = "approval" | "completed" | "error" | "waiting";
export type Notify = (owner: string, kind: NotificationKind, event: Envelope) => Promise<void>;

export class Hub {
  private peers = new Map<string, Peer>();
  private devicePeers = new Map<string, string>();
  constructor(
    readonly store: Store,
    readonly auth: AuthService,
    readonly config: RelayConfig,
    private notify: Notify = async () => {},
  ) {}

  async connect(principal: Principal, socket: PeerSocket): Promise<string> {
    if (!(await this.auth.stillActive(principal)))
      throw new ApiError(401, "UNAUTHORIZED", "登录已失效");
    const id = token(12);
    this.peers.set(id, {
      id,
      principal,
      socket,
      devices: new Set(),
      sessions: new Set(),
      lastSeen: Date.now(),
    });
    if (principal.role === "device") {
      const previous = this.devicePeers.get(principal.deviceId!);
      if (previous) this.disconnect(previous, 4001, "Replaced by new device connection");
      this.devicePeers.set(principal.deviceId!, id);
      await this.presence(principal.deviceId!, principal.owner, true);
      for (const command of await this.store.list<CommandRecord>("commands", principal.owner)) {
        if (command.deviceId === principal.deviceId && !command.ackedAt && !command.expired) {
          if (command.deadline > Date.now()) this.send(this.peers.get(id)!, command.envelope);
          else await this.expireCommand(command);
        }
      }
    }
    return id;
  }
  disconnect(id: string, code = 1000, reason = "Disconnected") {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    try {
      peer.socket.close(code, reason);
    } catch {
      /* socket already closed */
    }
    if (peer.principal.deviceId && this.devicePeers.get(peer.principal.deviceId) === id) {
      this.devicePeers.delete(peer.principal.deviceId);
      void this.presence(peer.principal.deviceId, peer.principal.owner, false).catch(() => {});
    }
  }
  disconnectDevice(id: string) {
    const peer = this.devicePeers.get(id);
    if (peer) this.disconnect(peer, 4003, "Device revoked");
  }
  close() {
    for (const id of [...this.peers.keys()]) this.disconnect(id, 1001, "Relay shutting down");
  }
  private send(peer: Peer, message: Envelope) {
    try {
      peer.socket.send(JSON.stringify(message));
    } catch {
      this.disconnect(peer.id);
    }
  }
  private broadcast(owner: string, message: Envelope) {
    for (const peer of this.peers.values()) {
      if (peer.principal.role !== "client" || peer.principal.owner !== owner) continue;
      if (
        message.type === "device.status" ||
        (message.deviceId && peer.devices.has(message.deviceId)) ||
        (message.sessionId && peer.sessions.has(message.sessionId))
      )
        this.send(peer, message);
    }
  }
  private async presence(id: string, owner: string, online: boolean) {
    await this.store.atomic(`tenant:${owner}`, async (tx) => {
      const device = await tx.get<DeviceRecord>("devices", id, owner);
      if (!device || device.revokedAt) return;
      await tx.put("devices", { ...device, online, lastSeen: Date.now() });
      this.broadcast(
        owner,
        makeEnvelope(
          "device.status",
          this.publicDevice({ ...device, online, lastSeen: Date.now() }),
          { deviceId: id },
        ),
      );
    });
  }
  publicDevice(device: DeviceRecord): Device {
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      hostname: device.hostname,
      agents: device.agents ?? [],
      lastSeen: device.lastSeen,
      online: this.devicePeers.has(device.id) && !device.revokedAt,
      ...(device.excludedProjects?.length ? { excludedProjects: device.excludedProjects } : {}),
    };
  }
  async devices(owner: string): Promise<Device[]> {
    return (await this.store.list<DeviceRecord>("devices", owner))
      .filter((d) => !d.revokedAt)
      .map((d) => this.publicDevice(d));
  }
  async receive(peerId: string, data: string | Buffer | ArrayBuffer): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (!(await this.auth.stillActive(peer.principal))) {
      this.disconnect(peerId, 4003, "Credentials revoked");
      return;
    }
    if ((typeof data === "string" ? Buffer.byteLength(data) : data.byteLength) > 1024 * 1024)
      throw new ApiError(413, "MESSAGE_TOO_LARGE", "消息过大");
    const message = parseEnvelope(
      JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString()),
    );
    peer.lastSeen = Date.now();
    if (message.type === "ping") {
      this.send(peer, makeEnvelope("pong", {}));
      return;
    }
    if (message.type === "pong") return;
    if (peer.principal.role === "client") {
      if (message.type === "subscribe") {
        const deviceIds = message.payload.deviceIds ?? [],
          sessionIds = message.payload.sessionIds ?? [];
        if (deviceIds.length + sessionIds.length > 512)
          throw new ApiError(400, "TOO_MANY_SUBSCRIPTIONS", "订阅过多");
        for (const id of deviceIds) await this.ownedDevice(this.store, peer.principal.owner, id);
        for (const id of sessionIds)
          if (!(await this.store.get("sessions", id, peer.principal.owner))) throw missing();
        peer.devices = new Set(deviceIds);
        peer.sessions = new Set(sessionIds);
        this.send(peer, makeEnvelope("ack", { ackId: message.id }));
        return;
      }
      if (COMMAND_TYPES.includes(message.type as never)) {
        await this.command(peer.principal.owner, message);
        this.send(peer, makeEnvelope("ack", { ackId: message.id }));
        return;
      }
      throw new ApiError(403, "ROLE_FORBIDDEN", "客户端不可发送此消息");
    }
    if (message.deviceId && message.deviceId !== peer.principal.deviceId)
      throw new ApiError(403, "DEVICE_MISMATCH", "设备不匹配");
    message.deviceId = peer.principal.deviceId;
    if (message.type === "ack") {
      await this.store.atomic(`tenant:${peer.principal.owner}`, async (tx) => {
        const command = await tx.get<CommandRecord>(
          "commands",
          this.commandKey(peer.principal.owner, message.payload.ackId),
          peer.principal.owner,
        );
        if (command && command.deviceId === peer.principal.deviceId)
          await tx.put("commands", { ...command, ackedAt: Date.now() });
      });
      return;
    }
    const { event, fresh, waitingSessions } = await this.ingest(peer.principal, message);
    this.send(
      peer,
      makeEnvelope("ack", {
        ackId: message.id,
        ...(event.seq !== undefined ? { seq: event.seq } : {}),
      }),
    );
    if (fresh) {
      this.broadcast(peer.principal.owner, event);
      const kind =
        event.type === "approval.request" && event.payload.status === "pending"
          ? "approval"
          : event.type === "session.event" && event.payload.kind === "error"
            ? "error"
            : event.type === "session.event" &&
                event.payload.kind === "turn.end" &&
                event.payload.text !== "failed"
              ? "completed"
              : undefined;
      if (kind) void this.notify(peer.principal.owner, kind, event).catch(() => {});
      for (const sessionId of waitingSessions) {
        // An approval snapshot precedes its approval.request. Give that event time to
        // arrive so it gets the actionable approval notification rather than two alerts.
        const timer = setTimeout(() => {
          void this.notifyWaiting(peer.principal.owner, sessionId).catch(() => {});
        }, 500);
        timer.unref();
      }
    }
  }
  private async notifyWaiting(owner: string, sessionId: string) {
    const session = await this.store.get<SessionRecord>("sessions", sessionId, owner);
    if (session?.status !== "waiting") return;
    const approval = (await this.store.list("approvals", owner)).some(
      (row) =>
        row.sessionId === sessionId &&
        row.status === "pending" &&
        Number(row.deadline) > Date.now(),
    );
    if (approval) return;
    const { owner: _owner, seq: _seq, ...publicSession } = session;
    await this.notify(
      owner,
      "waiting",
      makeEnvelope(
        "session.snapshot",
        { sessions: [publicSession] },
        { deviceId: session.deviceId, sessionId },
      ),
    );
  }
  private async ownedDevice(tx: Store, owner: string, id: string) {
    const device = await tx.get<DeviceRecord>("devices", id, owner);
    if (!device || device.revokedAt) throw missing();
    return device;
  }
  async ingest(
    principal: Principal,
    message: Envelope,
  ): Promise<{ event: Envelope; fresh: boolean; waitingSessions: string[] }> {
    if (principal.role !== "device" || !principal.deviceId)
      throw new ApiError(403, "ROLE_FORBIDDEN", "仅设备可上报事件");
    if (message.deviceId && message.deviceId !== principal.deviceId)
      throw new ApiError(403, "DEVICE_MISMATCH", "设备不匹配");
    if (
      ![
        "device.hello",
        "device.status",
        "session.snapshot",
        "session.event",
        "approval.request",
        "result",
      ].includes(message.type)
    )
      throw new ApiError(403, "ROLE_FORBIDDEN", "设备不可发送此消息");
    return this.store.atomic(`tenant:${principal.owner}`, async (tx) => {
      const device = await this.ownedDevice(tx, principal.owner, principal.deviceId!);
      const eventId = digest(`${principal.owner}:${device.id}:${message.id}`);
      const duplicate = await tx.get<EventRecord>("events", eventId, principal.owner);
      if (duplicate) return { event: duplicate.envelope, fresh: false, waitingSessions: [] };
      const waitingSessions: string[] = [];
      let event = { ...message, deviceId: device.id } as Envelope;
      delete event.seq;
      if (event.type === "device.hello") {
        // Device renames made by the owner survive subsequent daemon handshakes.
        await tx.put("devices", {
          ...device,
          platform: event.payload.platform,
          hostname: event.payload.hostname,
          agents: event.payload.agents,
          online: true,
          lastSeen: Date.now(),
        });
        this.broadcast(
          principal.owner,
          makeEnvelope(
            "device.status",
            this.publicDevice({
              ...device,
              ...event.payload,
              name: device.name,
              excludedProjects: device.excludedProjects,
              online: true,
              lastSeen: Date.now(),
            }),
            { deviceId: device.id },
          ),
        );
      } else if (event.type === "device.status") {
        if (event.payload.id !== device.id)
          throw new ApiError(403, "DEVICE_MISMATCH", "设备不匹配");
        await tx.put("devices", { ...device, agents: event.payload.agents, lastSeen: Date.now() });
      } else if (event.type === "session.snapshot") {
        if (event.payload.sessions.length > 5000)
          throw new ApiError(413, "SNAPSHOT_TOO_LARGE", "会话快照过大");
        for (const session of event.payload.sessions) {
          if (
            session.status === "waiting" &&
            (await tx.get<SessionRecord>("sessions", session.id, principal.owner))?.status !==
              "waiting"
          )
            waitingSessions.push(session.id);
          await this.upsertSession(tx, principal.owner, device.id, session);
        }
      } else if (event.type === "result") {
        const command = await tx.get<CommandRecord>(
          "commands",
          this.commandKey(principal.owner, event.payload.requestId),
          principal.owner,
        );
        if (!command || command.deviceId !== device.id) throw missing();
        event.sessionId = command.envelope.sessionId;
        const data = event.payload.data as { session?: Session } | undefined;
        if (event.payload.ok && data?.session)
          await this.upsertSession(
            tx,
            principal.owner,
            device.id,
            SessionSchema.parse(data.session),
          );
      }
      if (event.sessionId) {
        let session = await tx.get<SessionRecord>("sessions", event.sessionId, principal.owner);
        if (!session || session.deviceId !== device.id) throw missing();
        const seq = (session.seq ?? 0) + 1;
        event = { ...event, seq } as Envelope;
        session = { ...session, seq, updatedAt: Date.now() };
        if (event.type === "session.event") {
          if (event.payload.nativeId) session.nativeId = event.payload.nativeId;
          if (event.payload.kind === "turn.start") session.status = "running";
          if (event.payload.kind === "turn.end")
            session.status =
              event.payload.text === "failed" || session.status === "error" ? "error" : "completed";
          if (event.payload.kind === "error") session.status = "error";
          if (event.payload.usage) {
            session.usage = mergeUsage(session.usage, event.payload.usage);
            await this.upsertUsage(tx, principal.owner, session, event.ts);
          }
        }
        if (event.type === "approval.request" && event.payload.status === "pending")
          session.status = "waiting";
        await tx.put("sessions", session);
      } else if (["session.event", "approval.request"].includes(event.type))
        throw new ApiError(400, "SESSION_REQUIRED", "缺少会话编号");
      if (event.type === "approval.request") {
        const approval = event.payload;
        if (
          approval.deviceId !== device.id ||
          approval.sessionId !== event.sessionId ||
          approval.expiresAt > Date.now() + 86400_000
        )
          throw new ApiError(400, "INVALID_APPROVAL", "无效审批请求");
        const existing = await tx.get("approvals", approval.id);
        if (
          existing &&
          (existing.owner !== principal.owner ||
            existing.deviceId !== device.id ||
            existing.sessionId !== event.sessionId)
        )
          throw missing();
        if (
          existing &&
          (existing.toolName !== approval.toolName ||
            stableJSON(existing.input) !== stableJSON(approval.input) ||
            existing.deadline !== approval.expiresAt)
        )
          throw new ApiError(409, "APPROVAL_CONFLICT", "审批编号已用于不同请求");
        if (!existing && approval.status !== "pending")
          throw new ApiError(409, "APPROVAL_MISSING", "审批请求尚未登记");
        if (existing && approval.status === "allowed" && existing.status !== "allowed")
          throw new ApiError(403, "APPROVAL_NOT_ALLOWED", "设备不能自行批准权限请求");
        if (!existing) {
          await tx.put("approvals", {
            ...approval,
            owner: principal.owner,
            expiresAt: Date.now() + this.config.auditRetentionDays * 86400_000,
            deadline: approval.expiresAt,
            status: approval.expiresAt <= Date.now() ? "expired" : "pending",
          });
          await this.auth.audit(
            tx,
            "approval.request",
            { approvalId: approval.id, deviceId: device.id, sessionId: event.sessionId },
            principal.owner,
          );
        } else {
          const settled = approval.status === "denied" || approval.status === "expired";
          const status =
            existing.status === "pending" && settled ? approval.status : existing.status;
          await tx.put("approvals", {
            ...existing,
            status,
            agentStatus: approval.status,
            agentReason: approval.reason,
          });
          if (status !== existing.status)
            await this.auth.audit(
              tx,
              "approval.device_settled",
              { approvalId: approval.id, status, reason: approval.reason },
              principal.owner,
            );
          // Never resurrect a settled approval when an old pending update is replayed.
          event.payload.status = status as typeof approval.status;
        }
      }
      await tx.put("events", {
        id: eventId,
        owner: principal.owner,
        createdAt: Date.now(),
        expiresAt: Date.now() + this.config.eventRetentionDays * 86400_000,
        deviceId: device.id,
        sessionId: event.sessionId,
        seq: event.seq,
        envelope: event,
      });
      return { event, fresh: true, waitingSessions };
    });
  }
  private async upsertSession(tx: Store, owner: string, deviceId: string, session: Session) {
    if (session.deviceId !== deviceId) throw new ApiError(403, "DEVICE_MISMATCH", "会话设备不匹配");
    const current = await tx.get<SessionRecord>("sessions", session.id);
    if (current && (current.owner !== owner || current.deviceId !== deviceId)) throw missing();
    const row: SessionRecord = {
      ...session,
      owner,
      seq: current?.seq ?? 0,
      usage: session.usage ? mergeUsage(current?.usage, session.usage) : current?.usage,
    };
    await tx.put("sessions", row);
    await this.upsertUsage(tx, owner, session);
  }
  private async upsertUsage(tx: Store, owner: string, session: Session, liveAt?: number) {
    await recordUsage(tx, owner, session, liveAt);
  }
  private commandKey(owner: string, id: string) {
    return digest(`${owner}:${id}`);
  }
  async command(
    owner: string,
    input: Envelope,
  ): Promise<{ commandId: string; status: string; sessionId?: string }> {
    if (input.type === "approval.decide") {
      await this.decide(
        owner,
        input.payload.approvalId,
        input.payload.decision,
        input.payload.reason,
      );
      return { commandId: input.id, status: "queued", sessionId: input.sessionId };
    }
    if (!COMMAND_TYPES.includes(input.type as never) || !input.deviceId)
      throw new ApiError(400, "INVALID_COMMAND", "无效命令或缺少设备");
    const command = await this.store.atomic(`tenant:${owner}`, async (tx) => {
      await this.ownedDevice(tx, owner, input.deviceId!);
      const key = this.commandKey(owner, input.id);
      const previous = await tx.get<CommandRecord>("commands", key, owner);
      if (previous) {
        if (
          previous.deviceId !== input.deviceId ||
          previous.envelope.type !== input.type ||
          (input.type === "session.create"
            ? input.sessionId !== undefined && input.sessionId !== previous.envelope.sessionId
            : input.sessionId !== previous.envelope.sessionId) ||
          stableJSON(previous.envelope.payload) !== stableJSON(input.payload)
        )
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "命令编号已用于不同请求");
        return previous;
      }
      const envelope = structuredClone(input);
      if (envelope.type === "session.create") {
        envelope.sessionId ??= `ses_${token(16)}`;
        if (await tx.get("sessions", envelope.sessionId))
          throw new ApiError(409, "SESSION_EXISTS", "会话已存在");
        const session: SessionRecord = {
          id: envelope.sessionId,
          owner,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          deviceId: envelope.deviceId!,
          agent: envelope.payload.agent,
          cwd: envelope.payload.cwd,
          title: envelope.payload.title ?? envelope.payload.prompt.slice(0, 80),
          status: "idle",
          source: "managed",
          readOnly: false,
          seq: 0,
        };
        await tx.put("sessions", session);
        await this.upsertUsage(tx, owner, session);
      } else if (
        ["session.resume", "session.send", "session.interrupt", "session.history"].includes(
          envelope.type,
        )
      ) {
        if (!envelope.sessionId) throw new ApiError(400, "SESSION_REQUIRED", "缺少会话编号");
        const session = await tx.get<SessionRecord>("sessions", envelope.sessionId, owner);
        if (!session || session.deviceId !== envelope.deviceId) throw missing();
        if (session.readOnly && envelope.type !== "session.history")
          throw new ApiError(409, "SESSION_READ_ONLY", session.busyReason ?? "该会话当前只读");
      }
      const row: CommandRecord = {
        id: key,
        owner,
        createdAt: Date.now(),
        expiresAt: Date.now() + this.config.eventRetentionDays * 86400_000,
        deadline: Date.now() + 300_000,
        deviceId: envelope.deviceId!,
        envelope,
      };
      await tx.put("commands", row);
      return row;
    });
    const peerId = this.devicePeers.get(command.deviceId);
    const peer = peerId ? this.peers.get(peerId) : undefined;
    if (peer && !command.ackedAt && !command.expired) this.send(peer, command.envelope);
    return {
      commandId: input.id,
      status: command.ackedAt ? "accepted" : peer ? "delivered" : "queued",
      sessionId: command.envelope.sessionId,
    };
  }
  async decide(
    owner: string,
    id: string,
    decision: "allow" | "deny",
    reason?: string,
    answers?: Answers,
  ) {
    const result = await this.store.atomic(`tenant:${owner}`, async (tx) => {
      const approval = await tx.get("approvals", id, owner);
      if (!approval) throw missing();
      await this.ownedDevice(tx, owner, approval.deviceId as string);
      const status = decision === "allow" ? "allowed" : "denied";
      if (approval.status === status) return { approval, repeated: true };
      if (approval.status !== "pending") throw new ApiError(409, "ALREADY_DECIDED", "审批已有决定");
      if (Number(approval.deadline) <= Date.now()) {
        const expired = { ...approval, status: "expired" };
        await tx.put("approvals", expired);
        return { approval: expired, expired: true };
      }
      const questions = approval.questions as Question[] | undefined;
      if (answers && !questions)
        throw new ApiError(400, "ANSWERS_NOT_EXPECTED", "该审批不是提问，不能提交答案");
      if (questions && decision === "allow") {
        const ids = new Set(questions.map((q) => q.id));
        if (!answers || Object.keys(answers).some((key) => !ids.has(key)))
          throw new ApiError(400, "INVALID_ANSWERS", "答案与问题不匹配");
        if (questions.some((q) => !answers[q.id]?.some((value) => value.trim())))
          throw new ApiError(400, "ANSWERS_INCOMPLETE", "请回答全部问题");
      }
      const updated = { ...approval, status, decisionAt: Date.now(), reason };
      await tx.put("approvals", updated);
      const envelope = makeEnvelope(
        "approval.decide",
        {
          approvalId: id,
          decision,
          reason,
          ...(answers && decision === "allow" ? { answers } : {}),
        },
        {
          id: `decision_${id}`,
          deviceId: approval.deviceId as string,
          sessionId: approval.sessionId as string,
        },
      );
      await tx.put("commands", {
        id: this.commandKey(owner, envelope.id),
        owner,
        createdAt: Date.now(),
        expiresAt: Date.now() + this.config.eventRetentionDays * 86400_000,
        deadline: Number(approval.deadline),
        deviceId: envelope.deviceId,
        envelope,
      });
      await this.auth.audit(
        tx,
        "approval.decide",
        {
          approvalId: id,
          deviceId: approval.deviceId,
          sessionId: approval.sessionId,
          decision,
          reason,
          // The audit trail records that questions were answered, not the answer text.
          ...(questions ? { answered: decision === "allow" } : {}),
        },
        owner,
      );
      return { approval: updated, envelope };
    });
    if (result.expired) throw new ApiError(409, "APPROVAL_EXPIRED", "审批已过期");
    if (result.envelope) {
      const peerId = this.devicePeers.get(result.envelope.deviceId!);
      if (peerId) this.send(this.peers.get(peerId)!, result.envelope);
      this.broadcast(owner, result.envelope);
    }
    return this.publicApproval(result.approval);
  }
  publicApproval(row: RecordData) {
    const { owner: _owner, deadline, ...rest } = row;
    return {
      ...rest,
      expiresAt: deadline,
      status: row.status === "pending" && Number(deadline) <= Date.now() ? "expired" : row.status,
    };
  }
  async events(owner: string, sessionId: string, after: number, limit: number) {
    if (!(await this.store.get("sessions", sessionId, owner))) throw missing();
    const { rows, oldestSeq } = await this.store.replay<EventRecord>(
      owner,
      sessionId,
      after,
      limit + 1,
    );
    const events = rows.slice(0, limit).map((r) => r.envelope);
    return {
      events,
      nextSeq: events.at(-1)?.seq ?? after,
      hasMore: rows.length > limit,
      oldestSeq,
      truncated: oldestSeq !== undefined && after < oldestSeq - 1,
    };
  }
  async sessions(
    owner: string,
    filter: { deviceId?: string; agent?: string; project?: string } = {},
  ) {
    const canonical = new Map<string, SessionRecord>();
    for (const session of await this.store.list<SessionRecord>("sessions", owner)) {
      const key = `${session.deviceId}:${session.agent}:${session.nativeId ?? session.id}`;
      const previous = canonical.get(key);
      if (
        !previous ||
        (session.source === "managed" && previous.source === "local") ||
        (session.source === previous.source && session.updatedAt > previous.updatedAt)
      )
        canonical.set(key, session);
    }
    const excluded = await this.excludedProjects(owner);
    return [...canonical.values()]
      .filter(
        (s) =>
          !s.excludedReason &&
          !isQuotaProbe(s) &&
          !isExcludedProject(s.cwd, excluded.get(s.deviceId)) &&
          (!filter.deviceId || s.deviceId === filter.deviceId) &&
          (!filter.agent || s.agent === filter.agent) &&
          (!filter.project || s.cwd === filter.project),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ owner: _owner, seq: _seq, ...s }) => s);
  }
  /** Per-device project folders the owner hid from lists and stats. */
  async excludedProjects(owner: string): Promise<Map<string, string[]>> {
    return new Map(
      (await this.store.list<DeviceRecord>("devices", owner)).map((d) => [
        d.id,
        d.excludedProjects ?? [],
      ]),
    );
  }
  async stats(
    owner: string,
    filter: {
      deviceId?: string;
      agent?: string;
      project?: string;
      from?: number;
      to?: number;
      groupBy?: string;
    },
  ) {
    return queryStats(this.store, owner, filter);
  }
  private async expireCommand(command: CommandRecord) {
    await this.store.put("commands", { ...command, expired: true });
    this.broadcast(
      command.owner,
      makeEnvelope(
        "result",
        {
          requestId: command.envelope.id,
          ok: false,
          error: { code: "COMMAND_EXPIRED", message: "设备离线，命令已过期，请重新操作" },
        },
        { deviceId: command.deviceId, sessionId: command.envelope.sessionId },
      ),
    );
  }
  async maintenance() {
    for (const peer of [...this.peers.values()]) {
      if (!(await this.auth.stillActive(peer.principal)))
        this.disconnect(peer.id, 4003, "Credentials revoked");
      else if (Date.now() - peer.lastSeen > 120_000)
        this.disconnect(peer.id, 4000, "Heartbeat timeout");
      else this.send(peer, makeEnvelope("ping", {}));
    }
    for (const approval of await this.store.list("approvals"))
      if (approval.status === "pending" && Number(approval.deadline) <= Date.now()) {
        await this.store.atomic(`tenant:${approval.owner}`, async (tx) => {
          const latest = await tx.get("approvals", approval.id, approval.owner);
          if (latest?.status === "pending" && Number(latest.deadline) <= Date.now())
            await tx.put("approvals", { ...latest, status: "expired" });
        });
      }
    for (const command of await this.store.list<CommandRecord>("commands"))
      if (!command.ackedAt && !command.expired && command.deadline <= Date.now())
        await this.expireCommand(command);
    await this.store.prune(Date.now());
  }
}

/** PostgreSQL jsonb reorders object keys; idempotency compares structure, never serialization order. */
function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJSON(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
