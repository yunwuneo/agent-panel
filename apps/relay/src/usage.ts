import { addUsage, emptyUsage, type Session, type Usage } from "@agentpanel/protocol";
import { ApiError, digest } from "./auth";
import type { RecordData, Store } from "./store";

type UsageObservation = { ts: number; usage: Usage };
type UsageRow = RecordData & {
  observations?: UsageObservation[];
  indexedAt?: number;
  deviceId: string;
  sessionId: string;
  nativeId?: string;
  agent: string;
  project: string;
  usage: Usage;
  updatedAt: number;
};
type DayRow = UsageRow & {
  date: string;
  sessionKey: string;
  legacyUsage?: Usage;
  liveContribution?: Usage;
};
const counters = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "turns",
  "activeMs",
  "costUsd",
] as const;
const dateOf = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);
const dayTime = (date: string) => {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time) || dateOf(time) !== date)
    throw new ApiError(400, "INVALID_USAGE_DATE", "用量日期无效");
  return time;
};
export function mergeUsage(a: Usage | undefined, b: Usage): Usage {
  const merged = { ...a, ...b } as Usage;
  for (const key of counters) {
    if (key === "costUsd" && a?.[key] === undefined && b[key] === undefined) continue;
    merged[key] = Math.max(a?.[key] ?? 0, b[key] ?? 0);
  }
  return merged;
}
function difference(a: Usage, b: Usage): Usage {
  const result = { ...a };
  for (const key of counters) {
    if (key === "costUsd" && a[key] === undefined) continue;
    result[key] = Math.max(0, (a[key] ?? 0) - (b[key] ?? 0));
  }
  return result;
}
const nonzero = (usage?: Usage) => !!usage && counters.some((key) => (usage[key] ?? 0) > 0);
const addDayUsage = (a: Usage, b: Usage): Usage => ({
  ...addUsage(a, b),
  model: b.model ?? a.model,
  pricingVersion: b.pricingVersion ?? a.pricingVersion,
});
const sum = (rows: { usage: Usage }[]) =>
  rows.reduce((total, row) => addUsage(total, row.usage), emptyUsage());

/** Retain cumulative baseline and day rows separately. Native day snapshots overlap live deltas. */
export async function recordUsage(tx: Store, owner: string, session: Session, liveAt?: number) {
  const key = digest(
    `${owner}:${session.deviceId}:${session.agent}:${session.nativeId ?? session.id}`,
  );
  const matches = (row: UsageRow) =>
    row.deviceId === session.deviceId &&
    row.agent === session.agent &&
    (row.sessionId === session.id || (!!session.nativeId && row.nativeId === session.nativeId));
  let previous = emptyUsage();
  let indexedAt: number | undefined;
  const observations = new Map<string, UsageObservation>();
  for (const row of await tx.list<UsageRow>("usage", owner))
    if (row.id === key || matches(row)) {
      previous = mergeUsage(previous, row.usage);
      if (row.indexedAt !== undefined) indexedAt = Math.max(indexedAt ?? 0, row.indexedAt);
      for (const observation of row.observations ?? [])
        observations.set(
          `${observation.ts}:${counters.map((field) => observation.usage[field] ?? 0).join(":")}`,
          observation,
        );
      if (row.id !== key) await tx.remove("usage", row.id);
    }
  let current = mergeUsage(previous, session.usage ?? emptyUsage());
  const scope = {
    owner,
    deviceId: session.deviceId,
    sessionId: session.id,
    nativeId: session.nativeId,
    agent: session.agent,
    project: session.cwd,
    updatedAt: Date.now(),
  };
  const days = new Map<string, DayRow>();
  for (const row of await tx.list<DayRow>("usage_days", owner))
    if (row.sessionKey === key || matches(row)) {
      const existing = days.get(row.date);
      const id = digest(`${key}:${row.date}`);
      days.set(row.date, {
        ...row,
        ...scope,
        id,
        sessionKey: key,
        usage: mergeUsage(existing?.usage, row.usage),
        legacyUsage: row.legacyUsage
          ? mergeUsage(existing?.legacyUsage, row.legacyUsage)
          : existing?.legacyUsage,
      });
      if (row.id !== id) await tx.remove("usage_days", row.id);
    }
  const getDay = (date: string): DayRow => {
    const existing = days.get(date);
    if (existing) return existing;
    const row: DayRow = {
      ...scope,
      id: digest(`${key}:${date}`),
      sessionKey: key,
      createdAt: dayTime(date),
      date,
      usage: emptyUsage(),
    };
    days.set(date, row);
    return row;
  };
  if (liveAt !== undefined && session.usage && (indexedAt === undefined || liveAt > indexedAt)) {
    observations.set(
      `${liveAt}:${counters.map((field) => session.usage?.[field] ?? 0).join(":")}`,
      { ts: liveAt, usage: session.usage },
    );
  }
  if (session.usageByDay !== undefined && liveAt === undefined) {
    if (indexedAt === undefined || session.updatedAt >= indexedAt) {
      indexedAt = session.updatedAt;
      // The log is authoritative through its timestamp. Replacing the baseline also
      // corrects observations received after midnight for work recorded before it.
      for (const day of days.values()) await tx.remove("usage_days", day.id);
      days.clear();
      for (const bucket of session.usageByDay) {
        const row = getDay(bucket.date);
        row.usage = mergeUsage(row.usage, bucket.usage);
      }
      let baseline = session.usage ?? sum(session.usageByDay);
      current = mergeUsage(current, baseline);
      const suffix = [...observations.values()]
        .filter((observation) => observation.ts > indexedAt!)
        .sort(
          (a, b) =>
            a.ts - b.ts ||
            a.usage.inputTokens + a.usage.outputTokens - b.usage.inputTokens - b.usage.outputTokens,
        );
      observations.clear();
      for (const observation of suffix) {
        observations.set(
          `${observation.ts}:${counters.map((field) => observation.usage[field] ?? 0).join(":")}`,
          observation,
        );
        const delta = difference(observation.usage, baseline);
        baseline = mergeUsage(baseline, observation.usage);
        if (nonzero(delta)) {
          const row = getDay(dateOf(observation.ts));
          row.usage = addDayUsage(row.usage, delta);
        }
      }
      current = mergeUsage(current, baseline);
      const unallocated = difference(current, sum([...days.values()]));
      if (nonzero(unallocated)) {
        // Old databases can lack observations for a cumulative suffix. Keep that
        // portion explicitly marked as legacy rather than inventing an actual day.
        const row = getDay(dateOf(session.createdAt));
        row.usage = addDayUsage(row.usage, unallocated);
        row.legacyUsage = unallocated;
      }
      if (days.size === 0) getDay(dateOf(session.createdAt));
    }
  } else {
    const delta = difference(current, previous);
    if (liveAt !== undefined) {
      if (nonzero(delta) && (indexedAt === undefined || liveAt > indexedAt)) {
        const row = getDay(dateOf(liveAt));
        row.usage = addDayUsage(row.usage, delta);
      }
    } else if (nonzero(delta) || days.size === 0) {
      const amount = days.size === 0 ? current : delta;
      const row = getDay(dateOf(session.createdAt));
      row.usage = addDayUsage(row.usage, amount);
      if (nonzero(amount)) row.legacyUsage = addUsage(row.legacyUsage ?? emptyUsage(), amount);
    }
  }
  for (const day of days.values()) await tx.put("usage_days", day);
  await tx.put("usage", {
    ...scope,
    id: key,
    createdAt: session.createdAt,
    usage: current,
    indexedAt,
    observations: [...observations.values()].filter(
      (observation) => indexedAt === undefined || observation.ts > indexedAt,
    ),
  });
}

export async function queryStats(
  tx: Store,
  owner: string,
  filter: {
    deviceId?: string;
    agent?: string;
    project?: string;
    from?: number;
    to?: number;
    groupBy?: string;
  },
) {
  const daily = await tx.list<DayRow>("usage_days", owner);
  const known = new Set(daily.map((row) => row.sessionKey));
  // Data predating migration 0002 remains readable until its next daemon snapshot.
  for (const row of await tx.list<UsageRow>("usage", owner))
    if (!known.has(row.id))
      daily.push({
        ...row,
        id: `${row.id}:legacy`,
        date: dateOf(row.createdAt),
        createdAt: dayTime(dateOf(row.createdAt)),
        sessionKey: row.id,
        legacyUsage: row.usage,
      });
  const rows = daily.filter(
    (row) =>
      (!filter.deviceId || row.deviceId === filter.deviceId) &&
      (!filter.agent || row.agent === filter.agent) &&
      (!filter.project || row.project === filter.project) &&
      (filter.from === undefined || row.createdAt + 86400_000 > filter.from) &&
      (filter.to === undefined || row.createdAt <= filter.to),
  );
  type Group = { usage: Usage; sessionKeys: Set<string>; unpriced: Set<string> };
  const group = (): Group => ({ usage: emptyUsage(), sessionKeys: new Set(), unpriced: new Set() });
  const total = group();
  const buckets = new Map<string, Group>();
  const dimensions = new Map<
    string,
    Group & { deviceId: string; agent: string; project: string }
  >();
  const legacy = new Set<string>();
  let actualUsage = false;
  for (const row of rows) {
    if (nonzero(row.legacyUsage)) legacy.add(row.sessionKey);
    if (nonzero(difference(row.usage, row.legacyUsage ?? emptyUsage()))) actualUsage = true;
    const key =
      filter.groupBy === "device"
        ? row.deviceId
        : filter.groupBy === "agent"
          ? row.agent
          : filter.groupBy === "project"
            ? row.project
            : row.date;
    const bucket = buckets.get(key) ?? group();
    buckets.set(key, bucket);
    const scopeKey = JSON.stringify([row.deviceId, row.agent, row.project]);
    const dimension = dimensions.get(scopeKey) ?? {
      ...group(),
      deviceId: row.deviceId,
      agent: row.agent,
      project: row.project,
    };
    dimensions.set(scopeKey, dimension);
    for (const target of [total, bucket, dimension]) {
      target.usage = addUsage(target.usage, row.usage);
      target.sessionKeys.add(row.sessionKey);
      if (row.usage.costUsd === undefined && row.usage.inputTokens + row.usage.outputTokens > 0)
        target.unpriced.add(row.sessionKey);
    }
  }
  const totals = (value: Group) => ({
    ...value.usage,
    costUsd: value.usage.costUsd ?? (value.unpriced.size ? undefined : 0),
    sessionCount: value.sessionKeys.size,
    turnCount: value.usage.turns ?? 0,
    activeMs: value.usage.activeMs ?? 0,
    unpricedSessions: value.unpriced.size,
    costComplete: value.unpriced.size === 0,
  });
  const versions = [...new Set(rows.map((row) => row.usage.pricingVersion).filter(Boolean))];
  return {
    sessions: total.sessionKeys.size,
    usage: total.usage,
    buckets: [...buckets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, sessions: value.sessionKeys.size, usage: value.usage })),
    totals: totals(total),
    groups: [...dimensions.values()].map((value) => ({
      deviceId: value.deviceId,
      agent: value.agent,
      project: value.project,
      totals: totals(value),
    })),
    unpricedSessions: total.unpriced.size,
    priceVersion: versions.join(", ") || "source-reported-estimate",
    timeBasis: legacy.size ? (actualUsage ? "mixed" : "session-created-at") : "usage-day",
    legacySessionCount: legacy.size,
  };
}
