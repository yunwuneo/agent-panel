import { makeEnvelope } from "@agentpanel/protocol";
import { type createRelay, RateLimiter } from "./app";
import { ApiError, type Principal } from "./auth";
import type { RelayConfig } from "./config";

export function startServer(relay: ReturnType<typeof createRelay>, config: RelayConfig) {
  const limits = new RateLimiter();
  type SocketData = { principal: Principal; peerId?: string; pending: Promise<void> };
  return Bun.serve<SocketData>({
    port: config.port,
    hostname: config.host ?? "127.0.0.1",
    maxRequestBodySize: 1024 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname !== "/ws")
        return relay.app.fetch(request, {
          remoteAddress: server.requestIP(request)?.address ?? "unknown",
        });
      try {
        const origin = request.headers.get("origin");
        if (origin && !config.allowedOrigins.includes(origin))
          return new Response("Forbidden origin", { status: 403 });
        const address = server.requestIP(request)?.address ?? "unknown";
        if (!limits.take(`upgrade:${address}`, 30, 60_000))
          return new Response("Too many connections", { status: 429 });
        const ticket = url.searchParams.get("ticket");
        const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
        // Device/native credentials are accepted in headers only; browsers exchange a one-use ticket.
        const principal = ticket
          ? await relay.auth.redeemTicket(ticket)
          : bearer
            ? await relay.auth.authenticate(bearer)
            : undefined;
        if (!principal) return new Response("Unauthorized", { status: 401 });
        if (server.upgrade(request, { data: { principal, pending: Promise.resolve() } }))
          return undefined;
        return new Response("WebSocket upgrade required", { status: 426 });
      } catch {
        return new Response("Unauthorized", { status: 401 });
      }
    },
    websocket: {
      maxPayloadLength: 1024 * 1024,
      idleTimeout: 120,
      backpressureLimit: 4 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        ws.data.pending = relay.hub
          .connect(ws.data.principal, ws)
          .then((id) => {
            ws.data.peerId = id;
          })
          .catch(() => {
            ws.close(4003, "Unauthorized");
          });
      },
      message(ws, message) {
        if (
          !limits.take(
            `message:${ws.data.principal.owner}:${ws.data.principal.deviceId ?? ws.data.principal.sessionId}`,
            3000,
            10_000,
          )
        ) {
          ws.close(4008, "Rate limit");
          return;
        }
        // Serialize each peer's stream so ACKs never overtake persistence or reorder session seq.
        ws.data.pending = ws.data.pending
          .then(async () => {
            if (ws.data.peerId) await relay.hub.receive(ws.data.peerId, message);
          })
          .catch((error) => {
            const api =
              error instanceof ApiError
                ? error
                : new ApiError(400, "INVALID_MESSAGE", "消息格式无效");
            ws.send(
              JSON.stringify(
                makeEnvelope("result", {
                  requestId: "invalid",
                  ok: false,
                  error: { code: api.code, message: api.message },
                }),
              ),
            );
            if ([401, 403].includes(api.status)) ws.close(4003, api.code);
          });
      },
      close(ws) {
        void ws.data.pending.finally(() => {
          if (ws.data.peerId) relay.hub.disconnect(ws.data.peerId);
        });
      },
    },
  });
}
