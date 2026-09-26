import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The outbox and command journal survive network/daemon restarts. SQLite never contains agent credentials. */
export class Store {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, body TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scans (path TEXT PRIMARY KEY, offset INTEGER NOT NULL, remainder TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (path !== ":memory:" && process.platform !== "win32") chmodSync(path, 0o600);
  }
  enqueue(message: { id: string }) {
    this.db
      .query("INSERT OR IGNORE INTO outbox VALUES (?, ?, ?)")
      .run(message.id, JSON.stringify(message), Date.now());
  }
  acknowledge(id: string) {
    this.db.query("DELETE FROM outbox WHERE id=?").run(id);
  }
  pending<T>(limit = 250): T[] {
    return (
      this.db.query("SELECT body FROM outbox ORDER BY created, rowid LIMIT ?").all(limit) as {
        body: string;
      }[]
    ).map((row) => JSON.parse(row.body));
  }
  claimCommand(message: { id: string }) {
    const result = this.db
      .query("INSERT OR IGNORE INTO commands VALUES (?, ?, 'received', NULL, ?)")
      .run(message.id, JSON.stringify(message), Date.now());
    return result.changes > 0;
  }
  command(id: string) {
    return this.db.query("SELECT state, result FROM commands WHERE id=?").get(id) as {
      state: string;
      result: string | null;
    } | null;
  }
  startCommand(id: string) {
    this.db.query("UPDATE commands SET state='started' WHERE id=?").run(id);
  }
  completeCommand(id: string, result: unknown) {
    this.db
      .query("UPDATE commands SET state='completed', result=? WHERE id=?")
      .run(JSON.stringify(result), id);
  }
  unfinishedCommands<T>(): { state: string; message: T }[] {
    return (
      this.db.query("SELECT state, body FROM commands WHERE state != 'completed'").all() as {
        state: string;
        body: string;
      }[]
    ).map((row) => ({ state: row.state, message: JSON.parse(row.body) }));
  }
  putSession(session: { id: string }) {
    this.db
      .query("INSERT OR REPLACE INTO sessions VALUES (?, ?)")
      .run(session.id, JSON.stringify(session));
  }
  sessions<T>(): T[] {
    return (this.db.query("SELECT body FROM sessions").all() as { body: string }[]).map((row) =>
      JSON.parse(row.body),
    );
  }
  getScan<T>(path: string): { offset: number; remainder: string; body: T } | undefined {
    const row = this.db
      .query("SELECT offset, remainder, body FROM scans WHERE path=?")
      .get(path) as { offset: number; remainder: string; body: string } | null;
    return row ? { ...row, body: JSON.parse(row.body) } : undefined;
  }
  setScan(path: string, offset: number, remainder: string, body: unknown) {
    this.db
      .query("INSERT OR REPLACE INTO scans VALUES (?, ?, ?, ?)")
      .run(path, offset, remainder, JSON.stringify(body));
  }
  getMeta(key: string) {
    return (
      this.db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null
    )?.value;
  }
  setMeta(key: string, value: string) {
    this.db.query("INSERT OR REPLACE INTO metadata VALUES (?, ?)").run(key, value);
  }
  close() {
    this.db.close();
  }
}
