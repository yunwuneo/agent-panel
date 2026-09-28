import { afterEach, describe, expect, it } from "bun:test";
import { SessionSchema } from "@agentpanel/protocol";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { mergeEvents } from "./events";
import { localHistoryOptions } from "./history";

const session = SessionSchema.parse({
  id: "local-a",
  deviceId: "device-a",
  source: "local",
  agent: "codex",
  cwd: "/workspace",
  title: "Local session",
  status: "idle",
  readOnly: false,
  createdAt: 100,
  updatedAt: 100,
});
const page = (before = 0, hasMore = false) => ({
  before,
  hasMore,
  events: [{ kind: "message.done" as const, text: `message-${before}` }],
});
const clients: QueryClient[] = [];
function client() {
  const value = new QueryClient();
  clients.push(value);
  return value;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("History query did not settle");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
afterEach(() => {
  for (const value of clients.splice(0)) value.clear();
});

describe("automatic device history", () => {
  it("loads on opening and reuses the session cache when reopened", async () => {
    const query = client();
    let reads = 0;
    const options = localHistoryOptions(session, true, async () => {
      reads++;
      return page();
    });
    const first = new InfiniteQueryObserver(query, options);
    const close = first.subscribe(() => {});
    await until(() => first.getCurrentResult().isSuccess);
    expect(reads).toBe(1);
    close();
    const reopened = new InfiniteQueryObserver(query, options);
    const closeAgain = reopened.subscribe(() => {});
    expect(reopened.getCurrentResult().data?.pages[0].events[0].payload.text).toBe("message-0");
    expect(reads).toBe(1);
    closeAgain();
  });

  it("waits for both connections and loads automatically when they recover", async () => {
    let reads = 0;
    const read = async () => {
      reads++;
      return page();
    };
    const observer = new InfiniteQueryObserver(client(), localHistoryOptions(session, false, read));
    const close = observer.subscribe(() => {});
    expect(reads).toBe(0);
    observer.setOptions(localHistoryOptions(session, true, read));
    await until(() => observer.getCurrentResult().isSuccess);
    observer.setOptions(localHistoryOptions(session, false, read));
    expect(observer.getCurrentResult().data?.pages).toHaveLength(1);
    expect(reads).toBe(1);
    close();
  });

  it("keeps a late response in its own session after switching", async () => {
    const query = client();
    let finish!: (value: ReturnType<typeof page>) => void;
    const optionsA = localHistoryOptions(
      session,
      true,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const observer = new InfiniteQueryObserver(query, optionsA);
    const close = observer.subscribe(() => {});
    observer.setOptions(
      localHistoryOptions({ ...session, id: "local-b" }, true, async () => page(9)),
    );
    await until(() => observer.getCurrentResult().isSuccess);
    finish(page(2));
    await until(() => query.getQueryState(optionsA.queryKey)?.status === "success");
    expect(observer.getCurrentResult().data?.pages[0].events[0].sessionId).toBe("local-b");
    expect(observer.getCurrentResult().data?.pages[0].events[0].payload.text).toBe("message-9");
    close();
  });

  it("orders older pages correctly and stops at the beginning", async () => {
    const cursors: (number | undefined)[] = [];
    const observer = new InfiniteQueryObserver(
      client(),
      localHistoryOptions(session, true, async (before) => {
        cursors.push(before);
        return before === undefined ? page(200, true) : page();
      }),
    );
    const close = observer.subscribe(() => {});
    await until(() => observer.getCurrentResult().isSuccess);
    expect(observer.getCurrentResult().hasNextPage).toBe(true);
    await observer.fetchNextPage();
    const events = observer.getCurrentResult().data!.pages.flatMap((item) => item.events);
    expect(cursors).toEqual([undefined, 200]);
    expect(mergeEvents(events, events).map((item) => item.payload.text)).toEqual([
      "message-0",
      "message-200",
    ]);
    expect(observer.getCurrentResult().hasNextPage).toBe(false);
    close();
  });

  it("shows one failure without a retry loop and allows a successful retry", async () => {
    let reads = 0;
    const observer = new InfiniteQueryObserver(
      client(),
      localHistoryOptions(session, true, async () => {
        if (++reads === 1) throw new Error("设备离线");
        return page();
      }),
    );
    const close = observer.subscribe(() => {});
    await until(() => observer.getCurrentResult().isError);
    expect(reads).toBe(1);
    await observer.refetch();
    expect(observer.getCurrentResult().isSuccess).toBe(true);
    expect(reads).toBe(2);
    close();
  });

  it("does not request device history for a remote session", () => {
    let reads = 0;
    const observer = new InfiniteQueryObserver(
      client(),
      localHistoryOptions({ ...session, source: "remote" }, true, async () => {
        reads++;
        return page();
      }),
    );
    const close = observer.subscribe(() => {});
    expect(reads).toBe(0);
    close();
  });
});
