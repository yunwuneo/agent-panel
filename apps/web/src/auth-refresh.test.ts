import { describe, expect, it } from "bun:test";
import { type RefreshLockScheduler, serializedRefresh } from "./auth-refresh";

describe("cross-tab refresh coordination", () => {
  it("reads the updated cookie when two tabs refresh concurrently", async () => {
    let tail = Promise.resolve();
    const names: string[] = [];
    const locks: RefreshLockScheduler = {
      request<T>(name: string, operation: () => Promise<T>) {
        names.push(name);
        const next = tail.then(operation);
        tail = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    };
    let cookie = 0;
    const consumed = new Set<number>();
    const rotate = async () => {
      const incoming = cookie;
      await Promise.resolve();
      if (consumed.has(incoming)) throw new Error("Refresh reuse revokes the session");
      consumed.add(incoming);
      cookie = incoming + 1;
      return cookie;
    };
    expect(
      await Promise.all([serializedRefresh(rotate, locks), serializedRefresh(rotate, locks)]),
    ).toEqual([1, 2]);
    expect(names).toEqual(["agentpanel.session.refresh", "agentpanel.session.refresh"]);
    expect(cookie).toBe(2);
  });
  it("preserves normal refresh and rejection when Web Locks is unavailable", async () => {
    expect(await serializedRefresh(async () => "refreshed")).toBe("refreshed");
    await expect(
      serializedRefresh(async () => {
        throw new Error("expired");
      }),
    ).rejects.toThrow("expired");
  });
});
