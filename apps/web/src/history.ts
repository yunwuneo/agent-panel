import { makeEnvelope, type Session, type SessionEvent } from "@agentpanel/protocol";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { command } from "./connection";

type HistoryPage = { events: SessionEvent[]; hasMore: boolean; before?: number };
type ReadPage = (before: number | undefined) => Promise<HistoryPage>;

/** Keep device transcripts separate from Relay replay, with a cache for each session. */
export function localHistoryOptions(session: Session, connected: boolean, readPage?: ReadPage) {
  return infiniteQueryOptions({
    queryKey: ["local-history", session.deviceId, session.id],
    enabled: session.source === "local" && connected,
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }) => {
      const result = await (readPage
        ? readPage(pageParam)
        : command<HistoryPage>(
            "session.history",
            { limit: 200, ...(pageParam !== undefined ? { before: pageParam } : {}) },
            { deviceId: session.deviceId, sessionId: session.id },
          ));
      const start = result.before ?? 0;
      return {
        ...result,
        events: result.events.map((event, index) =>
          makeEnvelope("session.event", event, {
            id: `history:${session.id}:${start + index}`,
            deviceId: session.deviceId,
            sessionId: session.id,
            ts: session.createdAt + start + index,
          }),
        ),
      };
    },
    getNextPageParam: (last, _pages, previous) =>
      last.hasMore &&
      last.before !== undefined &&
      last.before > 0 &&
      (previous === undefined || last.before < previous)
        ? last.before
        : undefined,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
