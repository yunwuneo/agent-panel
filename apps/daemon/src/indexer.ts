import { createHash } from "node:crypto";
import { type Dirent, type FSWatcher, watch } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentKind,
  addUsage,
  type Session,
  type SessionEvent,
  type Usage,
} from "@agentpanel/protocol";
import type { Config } from "./config";
import { boundedEvent } from "./event-limits";
import type { Store } from "./store";

type RecordValue = Record<string, any>;
export type IndexedSession = Session & { logPath: string };
export type ScanState = {
  session?: IndexedSession;
  messages: Record<string, Usage>;
  turnIds: string[];
  firstPrompt?: string;
  inode?: string;
  malformed: number;
  parserVersion?: number;
  codexLastUsage?: Usage;
  durations?: Record<string, number>;
};
const parserVersion = 3;
const number = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turns: 0,
  activeMs: 0,
});
const timestamp = (value: unknown) =>
  typeof value === "number"
    ? value
    : typeof value === "string"
      ? Date.parse(value) || Date.now()
      : Date.now();
const textContent = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part: RecordValue) => part.text ?? "")
          .filter(Boolean)
          .join("\n")
      : "";
export const localSessionId = (agent: AgentKind, nativeId: string, deviceId = "local") =>
  `local_${createHash("sha256").update(deviceId).digest("hex").slice(0, 12)}_${agent}_${nativeId}`;

export function claudeUsage(usage: RecordValue): Usage {
  return {
    inputTokens:
      number(usage.input_tokens) +
      number(usage.cache_read_input_tokens) +
      number(usage.cache_creation_input_tokens),
    outputTokens: number(usage.output_tokens),
    cacheReadTokens: number(usage.cache_read_input_tokens),
    cacheWriteTokens: number(usage.cache_creation_input_tokens),
  };
}
export function codexUsage(usage: RecordValue): Usage {
  return {
    inputTokens: number(usage.input_tokens ?? usage.inputTokens),
    outputTokens: number(usage.output_tokens ?? usage.outputTokens),
    cacheReadTokens: number(usage.cached_input_tokens ?? usage.cachedInputTokens),
    cacheWriteTokens: number(usage.cache_write_input_tokens ?? usage.cacheWriteInputTokens),
  };
}
export function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    ...a,
    ...b,
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
    turns: Math.max(a.turns ?? 0, b.turns ?? 0),
    activeMs: Math.max(a.activeMs ?? 0, b.activeMs ?? 0),
  };
}

function positiveDelta(after: Usage, before: Usage): Usage {
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    cacheReadTokens: Math.max(0, after.cacheReadTokens - before.cacheReadTokens),
    cacheWriteTokens: Math.max(0, after.cacheWriteTokens - before.cacheWriteTokens),
    turns: Math.max(0, (after.turns ?? 0) - (before.turns ?? 0)),
    activeMs: Math.max(0, (after.activeMs ?? 0) - (before.activeMs ?? 0)),
    ...(after.costUsd !== undefined
      ? { costUsd: Math.max(0, after.costUsd - (before.costUsd ?? 0)) }
      : {}),
    model: after.model,
    pricingVersion: after.pricingVersion,
  };
}
function addDay(session: IndexedSession, date: string, increment: Usage) {
  if (
    !increment.inputTokens &&
    !increment.outputTokens &&
    !increment.cacheReadTokens &&
    !increment.cacheWriteTokens &&
    !increment.turns &&
    !increment.activeMs &&
    !increment.costUsd
  )
    return;
  session.usageByDay ??= [];
  let day = session.usageByDay.find((day) => day.date === date);
  if (!day) {
    day = { date, usage: emptyUsage() };
    session.usageByDay.push(day);
    session.usageByDay.sort((a, b) => a.date.localeCompare(b.date));
  }
  day.usage = {
    ...addUsage(day.usage, increment),
    model: increment.model ?? day.usage.model,
    pricingVersion: increment.pricingVersion ?? day.usage.pricingVersion,
  };
}
function accumulateCodex(state: ScanState, raw: RecordValue) {
  const current = codexUsage(raw),
    previous = state.codexLastUsage ?? emptyUsage();
  // A lower native counter starts a new accounting epoch; never subtract already recorded work.
  const delta = (next: number, before: number) => (next >= before ? next - before : next);
  const increment: Usage = {
    inputTokens: delta(current.inputTokens, previous.inputTokens),
    outputTokens: delta(current.outputTokens, previous.outputTokens),
    cacheReadTokens: delta(current.cacheReadTokens, previous.cacheReadTokens),
    cacheWriteTokens: delta(current.cacheWriteTokens, previous.cacheWriteTokens),
  };
  state.codexLastUsage = current;
  const session = state.session!;
  session.usage = { ...session.usage, ...addUsage(session.usage ?? emptyUsage(), increment) };
}
function recordDuration(state: ScanState, id: string, duration: number, end: number) {
  state.durations ??= {};
  const durations = state.durations;
  const previous = durations[id] ?? 0;
  const next = Math.max(previous, duration);
  durations[id] = next;
  const session = state.session!;
  session.usage = {
    ...(session.usage ?? emptyUsage()),
    activeMs: (session.usage?.activeMs ?? 0) + next - previous,
  };
  return {
    start: Math.max(0, end - next),
    end: Math.max(0, end - previous),
    increment: next - previous,
  };
}

/** Parse only understood fields; unknown log versions/records remain harmless. No raw payload leaves this module. */
export function parseRecord(
  record: RecordValue,
  agent: AgentKind,
  state: ScanState,
  context: { deviceId: string; path: string },
): SessionEvent[] {
  const payload = record.payload ?? {};
  const nativeId =
    agent === "claude"
      ? (record.sessionId ?? record.session_id)
      : record.type === "session_meta"
        ? payload.id
        : state.session?.nativeId;
  const cwd = agent === "claude" ? record.cwd : payload.cwd;
  const ts = timestamp(record.timestamp);
  if (
    agent === "codex" &&
    record.type === "session_meta" &&
    typeof nativeId === "string" &&
    state.session &&
    nativeId !== state.session.nativeId
  ) {
    // Forked rollouts can include the parent's prefix before the child's metadata.
    // Keep that prefix readable as context, but account only the new native session's work.
    state.session = undefined;
    state.messages = {};
    state.turnIds = [];
    state.durations = {};
    state.codexLastUsage = undefined;
    state.firstPrompt = undefined;
  }
  if (!state.session && typeof nativeId === "string" && typeof cwd === "string") {
    state.session = {
      id: localSessionId(agent, nativeId, context.deviceId),
      deviceId: context.deviceId,
      agent,
      nativeId,
      cwd,
      title: "本地会话",
      status: "readonly",
      source: "local",
      createdAt: ts,
      updatedAt: ts,
      readOnly: true,
      usage: emptyUsage(),
      usageByDay: [],
      logPath: context.path,
    };
  }
  const session = state.session;
  if (!session) return [];
  const previousUsage = { ...(session.usage ?? emptyUsage()) };
  let activeSpan: { start: number; end: number; increment: number } | undefined;
  session.updatedAt = Math.max(session.updatedAt, ts);
  if (cwd && (record.type === "turn_context" || !session.cwd)) session.cwd = cwd;
  const events: SessionEvent[] = [];
  if (agent === "claude") {
    const message = record.message;
    if (record.type === "ai-title" && typeof record.title === "string")
      session.title = record.title;
    if (record.type === "summary" && typeof record.summary === "string")
      session.title = record.summary;
    if (message && ["user", "assistant"].includes(record.type)) {
      const content = textContent(message.content);
      if (record.type === "user" && content && !record.isMeta && !record.isSidechain) {
        if (!state.firstPrompt) {
          state.firstPrompt = content.slice(0, 120);
          session.title = state.firstPrompt;
        }
        if (record.uuid && !state.turnIds.includes(record.uuid)) state.turnIds.push(record.uuid);
        session.usage = { ...(session.usage ?? emptyUsage()), turns: state.turnIds.length };
      }
      if (content)
        events.push({
          kind: "message.done",
          role: record.type,
          messageId: message.id ?? record.uuid,
          text: content,
        });
      if (Array.isArray(message.content))
        for (const part of message.content) {
          if (part.type === "tool_use")
            events.push({
              kind: "tool.call",
              toolCallId: part.id,
              toolName: part.name,
              input: part.input ?? {},
            });
          if (part.type === "tool_result")
            events.push({
              kind: "tool.result",
              toolCallId: part.tool_use_id,
              output: part.content ?? "",
            });
        }
      if (message.usage && message.id) {
        const next = claudeUsage(message.usage);
        state.messages[message.id] = mergeUsage(state.messages[message.id] ?? emptyUsage(), next);
        const total = emptyUsage();
        for (const usage of Object.values(state.messages)) {
          total.inputTokens += usage.inputTokens;
          total.outputTokens += usage.outputTokens;
          total.cacheReadTokens += usage.cacheReadTokens;
          total.cacheWriteTokens += usage.cacheWriteTokens;
        }
        total.model = message.model;
        total.turns = state.turnIds.length;
        total.activeMs = session.usage?.activeMs ?? 0;
        session.usage = mergeUsage(session.usage ?? emptyUsage(), total);
      }
    }
    if (record.type === "system" && record.subtype === "turn_duration") {
      activeSpan = recordDuration(
        state,
        record.uuid ?? `duration_${ts}`,
        number(record.durationMs),
        ts,
      );
    }
  } else {
    if (
      record.type === "turn_context" ||
      (record.type === "event_msg" && payload.type === "task_started")
    ) {
      if (payload.turn_id && !state.turnIds.includes(payload.turn_id))
        state.turnIds.push(payload.turn_id);
      session.usage = {
        ...(session.usage ?? emptyUsage()),
        model: payload.model ?? session.usage?.model,
        turns: state.turnIds.length,
      };
    }
    if (
      record.type === "event_msg" &&
      payload.type === "token_count" &&
      payload.info?.total_token_usage
    ) {
      accumulateCodex(state, payload.info.total_token_usage);
    }
    if (record.type === "token_usage_record" && payload.thread_token_usage) {
      if (payload.turn_id && !state.turnIds.includes(payload.turn_id))
        state.turnIds.push(payload.turn_id);
      accumulateCodex(state, payload.thread_token_usage);
      session.usage = { ...(session.usage ?? emptyUsage()), turns: state.turnIds.length };
    }
    if (record.type === "event_msg" && payload.type === "task_complete") {
      activeSpan = recordDuration(
        state,
        payload.turn_id ?? `duration_${ts}`,
        number(payload.duration_ms),
        ts,
      );
    }
    if (record.type === "response_item") {
      if (payload.type === "message" && ["user", "assistant"].includes(payload.role)) {
        const content = textContent(payload.content);
        if (
          payload.role === "user" &&
          !state.firstPrompt &&
          content &&
          !content.startsWith("<") &&
          !content.startsWith("# AGENTS.md")
        ) {
          state.firstPrompt = content.slice(0, 120);
          session.title = state.firstPrompt;
        }
        if (content)
          events.push({
            kind: "message.done",
            role: payload.role,
            text: content,
            messageId: payload.id ?? `log_${record.ordinal ?? ts}`,
          });
      }
      if (["function_call", "custom_tool_call"].includes(payload.type)) {
        let input = payload.arguments ?? payload.input ?? {};
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            /* Custom tools have textual input. */
          }
        }
        events.push({
          kind: "tool.call",
          toolCallId: payload.call_id,
          toolName: payload.name,
          input,
        });
      }
      if (["function_call_output", "custom_tool_call_output"].includes(payload.type))
        events.push({
          kind: "tool.result",
          toolCallId: payload.call_id,
          output: payload.output ?? "",
        });
    }
  }
  const increment = positiveDelta(session.usage ?? emptyUsage(), previousUsage);
  if (activeSpan) {
    increment.activeMs = 0;
    let cursor = activeSpan.start;
    while (cursor < activeSpan.end) {
      const nextMidnight = Math.floor(cursor / 86_400_000) * 86_400_000 + 86_400_000;
      const until = Math.min(activeSpan.end, nextMidnight);
      addDay(session, new Date(cursor).toISOString().slice(0, 10), {
        ...emptyUsage(),
        activeMs: until - cursor,
      });
      cursor = until;
    }
  }
  addDay(session, new Date(ts).toISOString().slice(0, 10), increment);
  return events;
}

async function* walk(root: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (
      entry.isFile() &&
      entry.name.endsWith(".jsonl") &&
      !path.includes(
        `${process.platform === "win32" ? "\\" : "/"}subagents${process.platform === "win32" ? "\\" : "/"}`,
      )
    )
      yield path;
  }
}

export class LocalSessionIndexer {
  private watchers: FSWatcher[] = [];
  private interval?: ReturnType<typeof setInterval>;
  private scanning = false;
  constructor(
    private config: Config,
    private store: Store,
    private onSessions: (sessions: IndexedSession[]) => void | Promise<void>,
  ) {}
  async scan(): Promise<IndexedSession[]> {
    if (this.scanning) return [];
    this.scanning = true;
    const changed: IndexedSession[] = [];
    try {
      for (const [agent, root] of [
        ["claude", join(this.config.claudeHome, "projects")],
        ["codex", join(this.config.codexHome, "sessions")],
      ] as const) {
        for await (const path of walk(root)) {
          const info = await stat(path).catch(() => undefined);
          if (!info) continue;
          let scan = this.store.getScan<ScanState>(path);
          if (
            scan &&
            (info.size < scan.offset ||
              scan.body.inode !== String(info.ino) ||
              scan.body.parserVersion !== parserVersion)
          )
            scan = undefined;
          if (scan?.offset === info.size) continue;
          const state: ScanState = scan?.body ?? {
            messages: {},
            turnIds: [],
            malformed: 0,
            inode: String(info.ino),
            parserVersion,
          };
          const file = await open(path, "r");
          let offset = scan?.offset ?? 0;
          let remainder = scan?.remainder ?? "";
          try {
            // Bound memory per read; retain incomplete UTF-8 and JSON at byte boundaries.
            let carry = Buffer.from(remainder, "base64");
            const buffer = Buffer.alloc(256 * 1024);
            while (offset < info.size) {
              const { bytesRead } = await file.read(
                buffer,
                0,
                Math.min(buffer.length, info.size - offset),
                offset,
              );
              if (!bytesRead) break;
              offset += bytesRead;
              carry = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
              let newline = carry.indexOf(10);
              while (newline !== -1) {
                const line = carry.subarray(0, newline).toString("utf8");
                carry = carry.subarray(newline + 1);
                if (line.trim()) {
                  try {
                    parseRecord(JSON.parse(line), agent, state, {
                      deviceId: this.config.deviceId ?? "local",
                      path,
                    });
                  } catch {
                    state.malformed++;
                  }
                }
                newline = carry.indexOf(10);
              }
              if (carry.length > 16 * 1024 * 1024)
                throw new Error("本地日志单行超过 16 MiB，停止读取该文件");
            }
            remainder = carry.toString("base64");
          } finally {
            await file.close();
          }
          this.store.setScan(path, offset, remainder, state);
          if (state.session) {
            this.store.putSession(state.session);
            changed.push(state.session);
          }
        }
      }
      if (changed.length) await this.onSessions(changed);
      return changed;
    } finally {
      this.scanning = false;
    }
  }
  async start() {
    await this.scan();
    this.interval = setInterval(
      () => void this.scan().catch((e) => console.error("历史索引失败:", String(e))),
      this.config.scanIntervalMs,
    );
    // Recursive watch is a latency optimization. Periodic scanning remains authoritative on every OS.
    for (const path of [
      join(this.config.claudeHome, "projects"),
      join(this.config.codexHome, "sessions"),
    ]) {
      try {
        this.watchers.push(
          watch(
            path,
            { recursive: true },
            () => void this.scan().catch((e) => console.error("历史索引失败:", String(e))),
          ),
        );
      } catch {
        /* Polling handles absent trees and unsupported recursive watch. */
      }
    }
  }
  stop() {
    if (this.interval) clearInterval(this.interval);
    for (const watcher of this.watchers) watcher.close();
  }
  async history(session: IndexedSession, limit = 200, before?: number) {
    const events: SessionEvent[] = [];
    const sizes: number[] = [];
    let pageBytes = 0;
    const state: ScanState = { messages: {}, turnIds: [], malformed: 0 };
    const file = Bun.file(session.logPath);
    const decoder = new TextDecoder();
    let remainder = "";
    let count = 0;
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value: bytes } = await reader.read();
        if (done) break;
        remainder += decoder.decode(bytes, { stream: true });
        let newline = remainder.indexOf("\n");
        while (newline >= 0) {
          const line = remainder.slice(0, newline);
          remainder = remainder.slice(newline + 1);
          try {
            const parsed = parseRecord(JSON.parse(line), session.agent, state, {
              deviceId: session.deviceId,
              path: session.logPath,
            });
            for (const event of parsed) {
              if (before === undefined || count < before) {
                const bounded = boundedEvent(event);
                const size = Buffer.byteLength(JSON.stringify(bounded));
                events.push(bounded);
                sizes.push(size);
                pageBytes += size;
              }
              count++;
              while (events.length > limit || pageBytes > 700 * 1024) {
                events.shift();
                pageBytes -= sizes.shift() ?? 0;
              }
            }
          } catch {
            /* Partial/corrupt historical records do not hide the remaining transcript. */
          }
          newline = remainder.indexOf("\n");
        }
        if (remainder.length > 16 * 1024 * 1024) throw new Error("日志记录过大");
      }
    } finally {
      reader.releaseLock();
    }
    const end = Math.min(before ?? count, count);
    return { events, hasMore: end > events.length, before: Math.max(0, end - events.length) };
  }
}

export function snapshotFingerprint(session: Session): string {
  return createHash("sha256").update(JSON.stringify(session)).digest("hex");
}
