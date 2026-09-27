import { hostname, platform } from "node:os";
import {
  type AgentCapability,
  COMMAND_TYPES,
  type Envelope,
  makeEnvelope,
  parseEnvelope,
} from "@agentpanel/protocol";
import { type Config, validateRelayUrl, version } from "./config";
import { commandResult, type SessionManager } from "./manager";
import type { Store } from "./store";

export class RelayConnection {
  private socket?: WebSocket;
  private stopped = false;
  private retry = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private sent = new Set<string>();
  private lastReceived = Date.now();
  constructor(
    private config: Config,
    private store: Store,
    private manager: SessionManager,
    private agents: AgentCapability[],
    private refreshCapabilities?: () => void,
  ) {}
  publish(message: Envelope) {
    this.store.enqueue(message);
    this.flush();
  }
  start() {
    if (!this.config.deviceId || !this.config.deviceToken)
      throw new Error("设备尚未配对，请先运行 agentpaneld pair");
    for (const pending of this.store.unfinishedCommands<Envelope>()) {
      if (pending.state === "received") void this.execute(pending.message);
      else {
        const result = commandResult(pending.message, {
          error: "设备在执行期间重启，无法确认操作是否已经生效；请查看会话后再决定是否重试",
        });
        this.store.db.transaction(() => {
          this.store.completeCommand(pending.message.id, result);
          this.store.enqueue(result);
        })();
      }
    }
    this.connect();
  }
  private connect() {
    if (this.stopped) return;
    const url = new URL("/ws", validateRelayUrl(this.config.relayUrl));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const BunWebSocket = WebSocket as unknown as new (
      url: string | URL,
      options: Bun.WebSocketOptions,
    ) => WebSocket;
    this.socket = new BunWebSocket(url, {
      headers: { Authorization: `Bearer ${this.config.deviceToken}` },
    });
    this.socket.addEventListener("open", () => {
      this.retry = 0;
      this.sent.clear();
      this.lastReceived = Date.now();
      this.publishHello();
      this.manager.snapshotAll();
      this.flush();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastReceived > 75_000) {
          this.socket?.close(4000, "Heartbeat timeout");
          return;
        }
        this.send(makeEnvelope("ping", {}, { deviceId: this.config.deviceId }));
        this.flush();
      }, 25_000);
      console.error("设备已连接 Relay");
    });
    this.socket.addEventListener("message", (event) => {
      this.lastReceived = Date.now();
      try {
        this.receive(parseEnvelope(JSON.parse(String(event.data))));
      } catch (error) {
        console.error("Relay 消息无法处理:", String(error));
      }
    });
    this.socket.addEventListener("close", (event) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if ([4001, 4003, 4401, 4403].includes(event.code)) {
        this.stopped = true;
        console.error("设备认证已失效或已被吊销，停止远程会话");
        void this.manager.close();
        return;
      }
      if (!this.stopped)
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          Math.min(30_000, 500 * 2 ** Math.min(6, this.retry++)) * (0.75 + Math.random() * 0.5),
        );
    });
    this.socket.addEventListener("error", () => {
      this.socket?.close();
    });
  }
  updateAgents(agents: AgentCapability[]) {
    this.agents = agents;
    if (!this.stopped && this.socket?.readyState === WebSocket.OPEN) this.publishHello();
  }
  private publishHello() {
    this.publish(
      makeEnvelope(
        "device.hello",
        {
          name: this.config.name,
          platform: platform(),
          hostname: hostname(),
          version,
          agents: this.agents,
        },
        { deviceId: this.config.deviceId },
      ),
    );
  }
  private send(message: Envelope) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  private flush() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (const message of this.store.pending<Envelope>(500)) {
      if (this.socket.bufferedAmount > 2 * 1024 * 1024) break;
      if (!this.sent.has(message.id)) {
        this.send(message);
        this.sent.add(message.id);
      }
    }
  }
  private receive(message: Envelope) {
    if (message.deviceId && message.deviceId !== this.config.deviceId)
      throw new Error("设备 ID 不匹配");
    if (message.type === "ack") {
      this.store.acknowledge(message.payload.ackId);
      this.sent.delete(message.payload.ackId);
      this.flush();
      return;
    }
    if (message.type === "ping") {
      this.send(makeEnvelope("pong", {}, { deviceId: this.config.deviceId }));
      return;
    }
    if (message.type === "pong") return;
    if (!(COMMAND_TYPES as readonly string[]).includes(message.type)) return;
    const fresh = this.store.claimCommand(message);
    // ACK means durably accepted, not successfully executed. The correlated result records the outcome.
    this.send(makeEnvelope("ack", { ackId: message.id }, { deviceId: this.config.deviceId }));
    if (fresh) void this.execute(message);
    else {
      const existing = this.store.command(message.id);
      if (existing?.result) this.publish(JSON.parse(existing.result));
    }
  }
  private async execute(command: Envelope) {
    this.store.startCommand(command.id);
    let result: Envelope;
    try {
      if (command.type === "device.refresh") {
        if (!this.refreshCapabilities) throw new Error("当前设备不支持额度刷新，请更新 daemon");
        this.refreshCapabilities();
        result = commandResult(command, { data: { accepted: true } });
      } else result = commandResult(command, { data: await this.manager.command(command) });
    } catch (error) {
      result = commandResult(command, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.store.db.transaction(() => {
      this.store.completeCommand(command.id, result);
      this.store.enqueue(result);
    })();
    this.flush();
  }
  async close() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close(1000, "Daemon shutdown");
  }
}
