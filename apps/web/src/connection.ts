import {
  type CommandType,
  type Envelope,
  EnvelopeSchema,
  makeEnvelope,
} from "@agentpanel/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, post } from "./api";
import { mergeEvents } from "./events";

type Result = { requestId: string; ok: boolean; data?: unknown; error?: { message: string } };
const pending = new Map<
  string,
  {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

export async function command<T = unknown>(
  type: CommandType,
  payload: Envelope<CommandType>["payload"],
  scope: { deviceId: string; sessionId?: string },
): Promise<T> {
  const envelope = makeEnvelope(type, payload, scope);
  const result = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(envelope.id);
      reject(new Error("设备尚未确认操作。请检查设备连接及会话状态，避免重复提交。"));
    }, 30_000);
    pending.set(envelope.id, { resolve: (data) => resolve(data as T), reject, timer });
  });
  // Attach a rejection handler before awaiting HTTP so a delayed request cannot cause an unhandled rejection.
  void result.catch(() => undefined);
  try {
    await post("/commands", envelope);
  } catch (error) {
    const item = pending.get(envelope.id);
    if (item) {
      clearTimeout(item.timer);
      pending.delete(envelope.id);
      item.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return result;
}

export async function loadEvents(sessionId: string, after = 0): Promise<Envelope[]> {
  let events: Envelope[] = [];
  let cursor = after;
  for (;;) {
    const page = await api<{ events: Envelope[]; nextSeq: number; hasMore: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/events?after=${cursor}&limit=500`,
    );
    events = mergeEvents(events, page.events);
    if (!page.hasMore || page.nextSeq <= cursor) return events;
    cursor = page.nextSeq;
  }
}

export function useConnection(enabled: boolean, deviceIds: string[], sessionId?: string) {
  const query = useQueryClient();
  const [state, setState] = useState<ConnectionState>("connecting");
  const [issue, setIssue] = useState("");
  const socket = useRef<WebSocket | null>(null);
  const scopes = useRef({ deviceIds, sessionId });
  scopes.current = { deviceIds, sessionId };

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    let ping: ReturnType<typeof setInterval>;
    async function replay() {
      const selected = scopes.current.sessionId;
      if (!selected) return;
      const previous = query.getQueryData<Envelope[]>(["events", selected]) ?? [];
      const after = previous.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
      const events = await loadEvents(selected, after);
      if (!stopped)
        query.setQueryData<Envelope[]>(["events", selected], (current = []) =>
          mergeEvents(current, events),
        );
    }
    async function connect() {
      if (stopped) return;
      setState(retry ? "reconnecting" : "connecting");
      try {
        const { ticket } = await post<{ ticket: string }>("/ws-ticket");
        if (stopped) return;
        const url = new URL("/ws", location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", ticket);
        const ws = new WebSocket(url);
        socket.current = ws;
        ws.onopen = () => {
          if (stopped) {
            ws.close();
            return;
          }
          retry = 0;
          setState("connected");
          setIssue("");
          ws.send(
            JSON.stringify(
              makeEnvelope("subscribe", {
                deviceIds: scopes.current.deviceIds,
                sessionIds: scopes.current.sessionId ? [scopes.current.sessionId] : [],
              }),
            ),
          );
          void replay().catch((error) => setIssue(error.message));
          void query.invalidateQueries({ queryKey: ["devices"] });
          void query.invalidateQueries({ queryKey: ["sessions"] });
          void query.invalidateQueries({ queryKey: ["approvals"] });
          ping = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(makeEnvelope("ping", {})));
          }, 25_000);
        };
        ws.onmessage = (message) => {
          let parsed: ReturnType<typeof EnvelopeSchema.safeParse>;
          try {
            parsed = EnvelopeSchema.safeParse(JSON.parse(message.data));
          } catch {
            return;
          }
          if (!parsed.success) return;
          const event = parsed.data as Envelope;
          if (event.type === "ping") ws.send(JSON.stringify(makeEnvelope("pong", {})));
          if (event.type === "result") {
            const result = event.payload as Result;
            const awaiting = pending.get(result.requestId);
            if (awaiting) {
              clearTimeout(awaiting.timer);
              pending.delete(result.requestId);
              if (result.ok) awaiting.resolve(result.data);
              else awaiting.reject(new Error(result.error?.message || "设备操作失败"));
            }
          }
          if (event.type === "session.event" && event.sessionId) {
            query.setQueryData<Envelope[]>(["events", event.sessionId], (previous = []) =>
              mergeEvents(previous, [event]),
            );
            if (
              ["turn.end", "turn.start", "error"].includes((event.payload as { kind: string }).kind)
            ) {
              void query.invalidateQueries({ queryKey: ["sessions"] });
              void query.invalidateQueries({ queryKey: ["stats"] });
            }
          }
          if (event.type.startsWith("device."))
            void query.invalidateQueries({ queryKey: ["devices"] });
          if (event.type === "session.snapshot")
            void query.invalidateQueries({ queryKey: ["sessions"] });
          if (event.type.startsWith("approval."))
            void query.invalidateQueries({ queryKey: ["approvals"] });
        };
        ws.onclose = () => {
          clearInterval(ping);
          if (!stopped) {
            setState(navigator.onLine ? "reconnecting" : "offline");
            timer = setTimeout(
              connect,
              Math.min(30_000, 1000 * 2 ** retry++) + Math.random() * 600,
            );
          }
        };
        ws.onerror = () => ws.close();
      } catch (error) {
        if (!stopped) {
          setIssue(error instanceof Error ? error.message : "连接失败");
          setState("reconnecting");
          timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
        }
      }
    }
    const reconnect = () => {
      if (!socket.current || socket.current.readyState === WebSocket.CLOSED) {
        clearTimeout(timer);
        void connect();
      }
    };
    window.addEventListener("online", reconnect);
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      socket.current?.close();
      window.removeEventListener("online", reconnect);
    };
  }, [enabled, query]);

  const _ids = deviceIds.join(",");
  useEffect(() => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(
        JSON.stringify(
          makeEnvelope("subscribe", { deviceIds, sessionIds: sessionId ? [sessionId] : [] }),
        ),
      );
  }, [sessionId, deviceIds]);
  return { state, issue };
}
