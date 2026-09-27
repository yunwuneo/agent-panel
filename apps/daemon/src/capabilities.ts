import type { AgentCapability, AgentKind, AgentQuota } from "@agentpanel/protocol";
import type { Config } from "./config";
import { queryQuota } from "./quota";

type Query = (config: Config, kind: AgentKind, signal: AbortSignal) => Promise<AgentQuota>;

/** Query independently of execution permission, without holding the Relay handshake open. */
export class CapabilityMonitor {
  private abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Map<AgentKind, Promise<void>>();
  private next = new Map<AgentKind, number>();
  private manualAfter = new Map<AgentKind, number>();
  readonly agents: AgentCapability[];
  constructor(
    private config: Config,
    agents: AgentCapability[],
    private changed: (agents: AgentCapability[]) => void,
    private query: Query = queryQuota,
    private now = Date.now,
  ) {
    this.agents = agents.map((agent) => ({
      ...agent,
      executionAvailable: agent.executionAvailable ?? agent.authenticated,
      quota: { status: "loading", checkedAt: now(), windows: [], message: "正在查询订阅额度" },
    }));
  }
  start() {
    void this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), 60_000);
  }
  refresh(manual = false): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    for (const agent of this.agents) {
      if (
        this.pending.has(agent.kind) ||
        this.now() <
          (manual ? (this.manualAfter.get(agent.kind) ?? 0) : (this.next.get(agent.kind) ?? 0))
      )
        continue;
      const task = this.query(this.config, agent.kind, this.abort.signal)
        .then((quota) => {
          if (this.abort.signal.aborted) return;
          agent.quota = quota;
          this.next.set(
            agent.kind,
            Math.max(this.now() + this.config.quotaRefreshIntervalMs, quota.retryAt ?? 0),
          );
          this.manualAfter.set(agent.kind, Math.max(this.now() + 60_000, quota.retryAt ?? 0));
          this.changed(this.agents);
        })
        .catch(() => {
          if (this.abort.signal.aborted) return;
          agent.quota = {
            status: "error",
            checkedAt: this.now(),
            windows: [],
            message: "额度查询失败，稍后自动重试",
          };
          this.next.set(agent.kind, this.now() + this.config.quotaRefreshIntervalMs);
          this.manualAfter.set(agent.kind, this.now() + 60_000);
          this.changed(this.agents);
        })
        .finally(() => {
          this.pending.delete(agent.kind);
        });
      this.pending.set(agent.kind, task);
    }
    return Promise.all(this.pending.values()).then(() => {});
  }
  async close() {
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    await Promise.all(this.pending.values());
  }
}
