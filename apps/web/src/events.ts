import type { Envelope, SessionEvent } from "@agentpanel/protocol";

export interface ConversationItem {
  id: string;
  kind: "message" | "thinking" | "tool" | "error" | "turn";
  role?: string;
  text: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  diff?: string;
  complete?: boolean;
  ts: number;
}

/** HTTP replay and live delivery overlap intentionally; an event is only applied once. */
export function mergeEvents(previous: Envelope[], incoming: Envelope[]): Envelope[] {
  const unique = new Map(previous.map((event) => [event.id, event]));
  for (const event of incoming) unique.set(event.id, event);
  return [...unique.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.ts - b.ts);
}

export function conversation(events: Envelope[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const byId = new Map<string, ConversationItem>();
  let currentMessage = "";
  let currentThinking = "";
  for (const envelope of events) {
    if (envelope.type !== "session.event") continue;
    const event = envelope.payload as SessionEvent;
    if (event.kind === "turn.start") {
      currentMessage = "";
      currentThinking = "";
    }
    if (
      event.kind === "message.delta" ||
      event.kind === "message.done" ||
      event.kind === "thinking.delta"
    ) {
      const thinking = event.kind === "thinking.delta";
      let id = event.messageId || (thinking ? currentThinking : currentMessage);
      if (!id) id = `${thinking ? "thinking" : "message"}:${envelope.id}`;
      if (thinking) currentThinking = id;
      else currentMessage = id;
      let item = byId.get(id);
      if (!item) {
        item = {
          id,
          kind: thinking ? "thinking" : "message",
          role: event.role ?? "assistant",
          text: "",
          ts: envelope.ts,
        };
        items.push(item);
        byId.set(id, item);
      }
      if (event.kind === "message.done") {
        if (event.text !== undefined) item.text = event.text;
        item.complete = true;
        currentMessage = "";
      } else item.text += event.text ?? "";
    } else if (event.kind === "tool.call" || event.kind === "tool.result") {
      const id = event.toolCallId || envelope.id;
      let item = byId.get(id);
      if (!item) {
        item = { id, kind: "tool", text: "", ts: envelope.ts };
        items.push(item);
        byId.set(id, item);
      }
      item.toolName = event.toolName || item.toolName || "工具调用";
      if (event.input !== undefined) item.input = event.input;
      if (event.output !== undefined) item.output = event.output;
      if (event.diff !== undefined) item.diff = event.diff;
      item.complete = event.kind === "tool.result";
    } else if (event.kind === "error") {
      items.push({
        id: envelope.id,
        kind: "error",
        text: event.error?.message || event.text || "任务执行失败",
        ts: envelope.ts,
      });
    }
  }
  return items;
}

export function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function timeAgo(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function projectName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
