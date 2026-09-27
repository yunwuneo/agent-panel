import { dirname } from "node:path";
import {
  type AgentKind,
  type Envelope,
  isQuotaProbe,
  makeEnvelope,
  type Session,
  type SessionEvent,
  SessionSchema,
} from "@agentpanel/protocol";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { type AgentAdapter, jsonValue } from "./adapters/types";
import { ApprovalBroker } from "./approvals";
import type { Config } from "./config";
import { allowedDirectory, listDirectories } from "./directories";
import { boundedEvent } from "./event-limits";
import {
  emptyUsage,
  type IndexedSession,
  LocalSessionIndexer,
  mergeUsage,
  type ScanState,
} from "./indexer";
import { createOccupancyProbe, localSessionStatus, type OccupancyProbe } from "./occupancy";
import type { Store } from "./store";

export class SessionManager {
  readonly sessions = new Map<string, Session | IndexedSession>();
  readonly adapters = new Map<string, AgentAdapter>();
  readonly approvals: ApprovalBroker;
  readonly indexer: LocalSessionIndexer;
  private recent: string[];
  private queues = new Map<string, Promise<unknown>>();
  private turns = new Set<Promise<void>>();
  constructor(
    readonly config: Config,
    readonly store: Store,
    private publish: (message: Envelope) => void,
    private adapterFactory?: (agent: AgentKind) => AgentAdapter,
    private occupancyFactory: () => OccupancyProbe = createOccupancyProbe,
  ) {
    for (const session of store.sessions<Session | IndexedSession>()) {
      session.excludedReason = isQuotaProbe(session) ? "quota-probe" : undefined;
      session.status = "readonly";
      session.readOnly = true;
      session.busyReason = "请重新连接后继续本地会话";
      this.sessions.set(session.id, session);
    }
    this.recent = JSON.parse(store.getMeta("recentDirectories") ?? "[]");
    this.approvals = new ApprovalBroker((approval) => {
      const session = this.sessions.get(approval.sessionId);
      if (session) {
        session.status =
          approval.status === "pending"
            ? "waiting"
            : this.adapters.get(session.id)?.running
              ? "running"
              : "idle";
        this.snapshot([session]);
      }
      this.publish(
        makeEnvelope("approval.request", approval, {
          deviceId: config.deviceId,
          sessionId: approval.sessionId,
        }),
      );
    }, config.approvalTimeoutMs);
    this.indexer = new LocalSessionIndexer(config, store, (indexed, changed) =>
      this.reconcileIndexed(indexed, changed),
    );
  }
  private async reconcileIndexed(indexed: IndexedSession[], changed: Set<string>) {
    const probe = this.occupancyFactory();
    // Forked/copied logs can share a native identity; only the newest source wins.
    const latest = new Map<string, IndexedSession>();
    for (const local of indexed) {
      const previous = latest.get(local.id);
      if (!previous || local.updatedAt >= previous.updatedAt) latest.set(local.id, local);
    }
    const seen = new Set<string>();
    for (const local of latest.values()) {
      const managed = [...this.sessions.values()].find(
        (s) =>
          s.agent === local.agent &&
          s.nativeId === local.nativeId &&
          (s.source === "managed" || this.adapters.has(s.id)),
      );
      const previous = this.sessions.get(managed?.id ?? local.id);
      const before =
        previous &&
        [previous.status, previous.readOnly, previous.busyReason, previous.excludedReason].join(
          "|",
        );
      const session: IndexedSession = managed
        ? Object.assign(managed, { logPath: local.logPath, localActivity: local.localActivity })
        : local;
      seen.add(session.id);
      const logChanged = changed.has(local.logPath);
      if (session.excludedReason) {
        session.status = "idle";
        session.readOnly = true;
        session.busyReason = "内部额度探测记录";
      } else if (!this.adapters.has(session.id)) {
        const occupancy = await probe(local);
        // A resume can attach an adapter while the process probe is in flight.
        if (this.adapters.has(session.id)) continue;
        session.readOnly = occupancy.busy;
        session.status = localSessionStatus(local, occupancy);
        session.busyReason = occupancy.reason;
      }
      if (managed && logChanged) {
        session.usage = mergeUsage(managed.usage ?? emptyUsage(), local.usage ?? emptyUsage());
        session.usageByDay = undefined;
      }
      this.sessions.set(session.id, session);
      if (managed && session.id !== local.id) {
        this.sessions.delete(local.id);
        this.store.db.query("DELETE FROM sessions WHERE id=?").run(local.id);
      }
      const stateChanged =
        before !==
        [session.status, session.readOnly, session.busyReason, session.excludedReason].join("|");
      if (logChanged || stateChanged) {
        this.store.putSession(session);
        // Source-dated totals keep their original timestamp; status-only refreshes do not
        // fabricate a new accounting watermark or move sessions to the top of recents.
        this.snapshot([
          managed && logChanged
            ? {
                ...session,
                usage: local.usage,
                usageByDay: local.usageByDay,
                updatedAt: local.updatedAt,
              }
            : session,
        ]);
      }
    }
    for (const session of this.sessions.values()) {
      if (!("logPath" in session) || seen.has(session.id) || this.adapters.has(session.id))
        continue;
      const reason = "无法找到本地会话日志，保持只读";
      if (session.status === "idle" && session.readOnly && session.busyReason === reason) continue;
      session.status = "idle";
      session.readOnly = true;
      session.busyReason = reason;
      this.store.putSession(session);
      this.snapshot([session]);
    }
  }

  private snapshot(sessions: Session[]) {
    if (sessions.length)
      this.publish(
        makeEnvelope(
          "session.snapshot",
          { sessions: sessions.map((s) => SessionSchema.parse(s)) },
          { deviceId: this.config.deviceId },
        ),
      );
  }
  snapshotAll() {
    const sessions = [...this.sessions.values()];
    for (let i = 0; i < sessions.length; i += 100) this.snapshot(sessions.slice(i, i + 100));
    for (const session of sessions) {
      if (!("logPath" in session)) continue;
      const source = this.store.getScan<ScanState>(session.logPath)?.body.session;
      if (source?.usageByDay && source.nativeId === session.nativeId)
        this.snapshot([
          {
            ...session,
            usage: source.usage,
            usageByDay: source.usageByDay,
            updatedAt: source.updatedAt,
          },
        ]);
    }
  }
  async start() {
    if (this.config.importHistory) await this.indexer.start();
  }
  async close() {
    await this.indexer.stop();
    this.approvals.close();
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.close()));
    await Promise.allSettled([...this.turns]);
  }
  private onEvent(session: Session, event: SessionEvent) {
    event = boundedEvent(event);
    session.updatedAt = Date.now();
    const nativeChanged = !!event.nativeId && event.nativeId !== session.nativeId;
    if (event.nativeId) session.nativeId = event.nativeId;
    if (event.kind === "turn.start") session.status = "running";
    if (event.kind === "turn.end")
      session.status =
        event.text === "failed" || session.status === "error" ? "error" : "completed";
    if (event.kind === "error") session.status = "error";
    if (event.usage) {
      session.usage = mergeUsage(session.usage ?? emptyUsage(), event.usage);
      session.usageByDay = undefined;
    }
    this.store.putSession(session);
    this.publish(
      makeEnvelope(
        "session.event",
        { ...event, ...(event.usage ? { usage: session.usage } : {}) },
        { deviceId: this.config.deviceId, sessionId: session.id },
      ),
    );
    if (["turn.start", "turn.end", "error"].includes(event.kind) || nativeChanged)
      this.snapshot([session]);
  }
  async command(message: Envelope): Promise<unknown> {
    // Per-session creation/send are ordered, while approvals and interrupts stay responsive.
    if (
      [
        "approval.decide",
        "session.interrupt",
        "session.list",
        "fs.listDir",
        "session.history",
      ].includes(message.type)
    )
      return this.execute(message);
    const key = message.sessionId ?? message.id;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.execute(message));
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
  private getSession(id?: string): Session | IndexedSession {
    const session = id ? this.sessions.get(id) : undefined;
    if (!session) throw new Error("会话不存在");
    if (session.excludedReason || isQuotaProbe(session))
      throw new Error("内部额度探测记录不支持接管");
    return session;
  }
  private async connect(
    session: Session,
    model?: string,
    permissionMode: "default" | "acceptEdits" | "plan" = "default",
  ) {
    await allowedDirectory(session.cwd, this.config.roots);
    const adapter =
      this.adapterFactory?.(session.agent) ??
      (session.agent === "claude" ? new ClaudeAdapter(this.config) : new CodexAdapter(this.config));
    await adapter.start({
      cwd: session.cwd,
      nativeId: session.nativeId,
      model,
      permissionMode,
      usage: session.usage,
      emit: (event) => this.onEvent(session, event),
      approve: (tool, signal) => this.approvals.request(session.deviceId, session.id, tool, signal),
    });
    this.adapters.set(session.id, adapter);
    session.nativeId = adapter.nativeId ?? session.nativeId;
    session.readOnly = false;
    session.busyReason = undefined;
    session.status = "idle";
    this.store.putSession(session);
    this.snapshot([session]);
    return adapter;
  }
  private beginTurn(session: Session, adapter: AgentAdapter, prompt: string) {
    if (adapter.running) throw new Error("当前轮次仍在运行");
    session.status = "running";
    this.store.putSession(session);
    const task = adapter
      .send(prompt)
      .catch((error) => {
        this.onEvent(session, {
          kind: "error",
          error: {
            code: "AGENT_SEND_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        this.onEvent(session, { kind: "turn.end", text: "failed" });
      })
      .finally(() => this.turns.delete(task));
    this.turns.add(task);
  }
  private async execute(message: Envelope): Promise<unknown> {
    switch (message.type) {
      case "fs.listDir": {
        const listing = await listDirectories(message.payload.path, this.config.roots);
        let parent: string | null = null;
        if (listing.path && dirname(listing.path) !== listing.path) {
          try {
            parent = await allowedDirectory(dirname(listing.path), this.config.roots);
          } catch {
            /* At whitelist boundary. */
          }
        }
        return { ...listing, parent, recent: this.recent };
      }
      case "session.list":
        return {
          sessions: [...this.sessions.values()]
            .filter((s) => !s.excludedReason && !isQuotaProbe(s))
            .map((s) => SessionSchema.parse(s)),
        };
      case "session.create": {
        if (!message.sessionId) throw new Error("新会话缺少会话 ID");
        if (this.sessions.has(message.sessionId)) throw new Error("会话 ID 已存在");
        const p = message.payload;
        const cwd = await allowedDirectory(p.cwd, this.config.roots);
        const session: Session = {
          id: message.sessionId,
          deviceId: this.config.deviceId ?? "local",
          agent: p.agent,
          cwd,
          title: (p.title ?? p.prompt).slice(0, 120),
          status: "idle",
          source: "managed",
          readOnly: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          usage: emptyUsage(),
        };
        this.sessions.set(session.id, session);
        this.store.putSession(session);
        try {
          const adapter = await this.connect(session, p.model, p.permissionMode);
          this.beginTurn(session, adapter, p.prompt);
          this.recent = [cwd, ...this.recent.filter((path) => path !== cwd)].slice(0, 20);
          this.store.setMeta("recentDirectories", JSON.stringify(this.recent));
          return { session: SessionSchema.parse(session) };
        } catch (error) {
          session.status = "error";
          this.store.putSession(session);
          this.snapshot([session]);
          throw error;
        }
      }
      case "session.resume": {
        const session = this.getSession(message.sessionId);
        if (message.payload.nativeId && message.payload.nativeId !== session.nativeId)
          throw new Error("原生会话 ID 与索引不一致");
        let adapter = this.adapters.get(session.id);
        if (!adapter) {
          if (!("logPath" in session)) {
            await this.indexer.scan();
            const indexed = this.getSession(message.sessionId);
            if (!("logPath" in indexed)) throw new Error("尚未找到本地会话日志，无法安全继续");
            Object.assign(session, indexed);
          }
          const occupancy = await this.occupancyFactory()(session as IndexedSession);
          if (occupancy.busy) {
            session.readOnly = true;
            session.busyReason = occupancy.reason;
            this.snapshot([session]);
            throw new Error(occupancy.reason);
          }
          adapter = await this.connect(
            session,
            message.payload.model,
            message.payload.permissionMode,
          );
        }
        if (message.payload.prompt) this.beginTurn(session, adapter, message.payload.prompt);
        return { session: SessionSchema.parse(session) };
      }
      case "session.send": {
        const session = this.getSession(message.sessionId);
        const adapter = this.adapters.get(session.id);
        if (!adapter || session.readOnly) throw new Error("请先安全连接该会话");
        this.beginTurn(session, adapter, message.payload.prompt);
        return { session: SessionSchema.parse(session) };
      }
      case "session.interrupt": {
        const session = this.getSession(message.sessionId);
        const adapter = this.adapters.get(session.id);
        if (!adapter || session.readOnly) throw new Error("本地会话为只读，请在原应用中中断");
        this.approvals.cancelSession(session.id);
        await adapter.interrupt();
        return { interrupted: true };
      }
      case "approval.decide": {
        const session = this.getSession(message.sessionId);
        this.approvals.decide(message.payload.approvalId, session.id, message.payload);
        return { decided: true };
      }
      case "session.history": {
        const session = this.getSession(message.sessionId);
        if (!("logPath" in session)) await this.indexer.scan();
        const indexed = this.getSession(message.sessionId);
        if (!("logPath" in indexed)) return { events: [], hasMore: false, before: 0 };
        return this.indexer.history(indexed, message.payload.limit, message.payload.before);
      }
      default:
        throw new Error(`设备不支持命令 ${message.type}`);
    }
  }
}

export function commandResult(command: Envelope, result: { data?: unknown; error?: string }) {
  return makeEnvelope(
    "result",
    {
      requestId: command.id,
      ok: !result.error,
      ...(result.error
        ? { error: { code: "DAEMON_COMMAND_FAILED", message: result.error } }
        : { data: jsonValue(result.data) }),
    },
    { id: `result_${command.id}`, deviceId: command.deviceId, sessionId: command.sessionId },
  );
}
