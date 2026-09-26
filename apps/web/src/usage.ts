import type { Usage } from "@agentpanel/protocol";

type Counts = Pick<Usage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">;

/** Canonical inputTokens already includes cache reads and writes. */
export function totalTokens(usage: Partial<Counts>): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export function uncachedInput(usage: Counts): number {
  return Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
}
