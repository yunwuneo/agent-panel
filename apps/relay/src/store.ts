import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const kinds = [
  "users",
  "credentials",
  "challenges",
  "auth_sessions",
  "refresh_tokens",
  "recovery_codes",
  "pairing_codes",
  "devices",
  "sessions",
  "events",
  "approvals",
  "commands",
  "usage",
  "usage_days",
  "model_prices",
  "audit",
  "push_subscriptions",
  "push_settings",
  "ws_tickets",
] as const;
export type Kind = (typeof kinds)[number];
export type RecordData = {
  id: string;
  owner: string;
  createdAt: number;
  expiresAt?: number;
  [key: string]: unknown;
};

const table = (name: Kind) =>
  pgTable(
    name,
    {
      id: text("id").primaryKey(),
      owner: text("owner").notNull(),
      data: jsonb("data").$type<RecordData>().notNull(),
      createdAt: bigint("created_at", { mode: "number" }).notNull(),
      expiresAt: bigint("expires_at", { mode: "number" }),
    },
    (t) => [index(`${name}_owner_idx`).on(t.owner), index(`${name}_expiry_idx`).on(t.expiresAt)],
  );
export const tables = Object.fromEntries(kinds.map((k) => [k, table(k)])) as Record<
  Kind,
  ReturnType<typeof table>
>;

/** All externally reachable reads include a tenant. Atomic groups use a PostgreSQL advisory transaction lock. */
export interface Store {
  get<T extends RecordData = RecordData>(
    kind: Kind,
    id: string,
    owner?: string,
  ): Promise<T | undefined>;
  list<T extends RecordData = RecordData>(kind: Kind, owner?: string): Promise<T[]>;
  replay<T extends RecordData = RecordData>(
    owner: string,
    sessionId: string,
    after: number,
    limit: number,
  ): Promise<{ rows: T[]; oldestSeq?: number }>;
  put(kind: Kind, value: RecordData): Promise<void>;
  insert(kind: Kind, value: RecordData): Promise<boolean>;
  remove(kind: Kind, id: string): Promise<void>;
  atomic<T>(key: string, fn: (tx: Store) => Promise<T>): Promise<T>;
  prune(now: number): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class PostgresStore implements Store {
  private constructor(
    private db: PostgresJsDatabase,
    private client?: ReturnType<typeof postgres>,
    private nested = false,
  ) {}
  static connect(url: string): PostgresStore {
    const client = postgres(url, { max: 10, idle_timeout: 20 });
    return new PostgresStore(drizzle(client), client);
  }
  async get<T extends RecordData>(kind: Kind, id: string, owner?: string): Promise<T | undefined> {
    const t = tables[kind];
    const rows = await this.db
      .select({ data: t.data })
      .from(t)
      .where(owner ? and(eq(t.id, id), eq(t.owner, owner)) : eq(t.id, id))
      .limit(1);
    return rows[0]?.data as T | undefined;
  }
  async list<T extends RecordData>(kind: Kind, owner?: string): Promise<T[]> {
    const t = tables[kind];
    return (
      await this.db
        .select({ data: t.data })
        .from(t)
        .where(owner ? eq(t.owner, owner) : undefined)
    ).map((r) => r.data as T);
  }
  async replay<T extends RecordData>(
    owner: string,
    sessionId: string,
    after: number,
    limit: number,
  ): Promise<{ rows: T[]; oldestSeq?: number }> {
    const t = tables.events;
    const seq = sql<number>`(${t.data}->>'seq')::bigint`;
    const scope = and(
      eq(t.owner, owner),
      sql`${t.data}->>'sessionId' = ${sessionId}`,
      or(isNull(t.expiresAt), gt(t.expiresAt, Date.now())),
    );
    const [rows, first] = await Promise.all([
      this.db
        .select({ data: t.data })
        .from(t)
        .where(and(scope, sql`${seq} > ${after}`))
        .orderBy(seq)
        .limit(limit),
      this.db.select({ seq }).from(t).where(scope).orderBy(seq).limit(1),
    ]);
    return {
      rows: rows.map((row) => row.data as T),
      oldestSeq: first[0] ? Number(first[0].seq) : undefined,
    };
  }
  async put(kind: Kind, value: RecordData): Promise<void> {
    const t = tables[kind];
    const row = {
      id: value.id,
      owner: value.owner,
      data: value,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt ?? null,
    };
    await this.db.insert(t).values(row).onConflictDoUpdate({ target: t.id, set: row });
  }
  async insert(kind: Kind, value: RecordData): Promise<boolean> {
    const t = tables[kind];
    return (
      (
        await this.db
          .insert(t)
          .values({
            id: value.id,
            owner: value.owner,
            data: value,
            createdAt: value.createdAt,
            expiresAt: value.expiresAt ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: t.id })
      ).length === 1
    );
  }
  async remove(kind: Kind, id: string): Promise<void> {
    await this.db.delete(tables[kind]).where(eq(tables[kind].id, id));
  }
  async atomic<T>(key: string, fn: (tx: Store) => Promise<T>): Promise<T> {
    if (this.nested) return fn(this);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      return fn(new PostgresStore(tx as unknown as PostgresJsDatabase, undefined, true));
    });
  }
  async prune(now: number): Promise<void> {
    for (const kind of kinds)
      await this.db.delete(tables[kind]).where(lt(tables[kind].expiresAt, now));
  }
  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }
  async close(): Promise<void> {
    await this.client?.end();
  }
}

/** Test fixture only. Production entrypoint always requires PostgreSQL. */
export class MemoryStore implements Store {
  private rows = new Map<Kind, Map<string, RecordData>>(kinds.map((kind) => [kind, new Map()]));
  private queue = Promise.resolve();
  async get<T extends RecordData>(kind: Kind, id: string, owner?: string): Promise<T | undefined> {
    const data = this.rows.get(kind)?.get(id);
    return data && (!owner || data.owner === owner) ? (structuredClone(data) as T) : undefined;
  }
  async list<T extends RecordData>(kind: Kind, owner?: string): Promise<T[]> {
    return structuredClone(
      [...this.rows.get(kind)!.values()].filter((r) => !owner || r.owner === owner),
    ) as T[];
  }
  async replay<T extends RecordData>(
    owner: string,
    sessionId: string,
    after: number,
    limit: number,
  ): Promise<{ rows: T[]; oldestSeq?: number }> {
    const rows = (await this.list<T>("events", owner))
      .filter((r) => r.sessionId === sessionId && (!r.expiresAt || r.expiresAt > Date.now()))
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    return {
      rows: rows.filter((r) => Number(r.seq) > after).slice(0, limit),
      oldestSeq: rows[0] ? Number(rows[0].seq) : undefined,
    };
  }
  async put(kind: Kind, value: RecordData): Promise<void> {
    this.rows.get(kind)!.set(value.id, structuredClone(value));
  }
  async insert(kind: Kind, value: RecordData): Promise<boolean> {
    if (this.rows.get(kind)!.has(value.id)) return false;
    await this.put(kind, value);
    return true;
  }
  async remove(kind: Kind, id: string): Promise<void> {
    this.rows.get(kind)!.delete(id);
  }
  async atomic<T>(_key: string, fn: (tx: Store) => Promise<T>): Promise<T> {
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    const backup = structuredClone(this.rows);
    try {
      return await fn(this);
    } catch (error) {
      this.rows = backup;
      throw error;
    } finally {
      release();
    }
  }
  async prune(now: number): Promise<void> {
    for (const rows of this.rows.values())
      for (const [id, row] of rows) if (row.expiresAt && row.expiresAt < now) rows.delete(id);
  }
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
