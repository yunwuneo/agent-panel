/** Isolated browser acceptance harness. Never imported by production code. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Envelope, SessionEvent } from "@agentpanel/protocol";
import postgres from "postgres";
import { configSchema, pair } from "../../daemon/src/config";
import { SessionManager } from "../../daemon/src/manager";
import { Store as DaemonStore } from "../../daemon/src/store";
import { RelayConnection } from "../../daemon/src/transport";
import { createRelay } from "../../relay/src/app";
import { migrate } from "../../relay/src/migrate";
import { startServer } from "../../relay/src/server";
import { PostgresStore } from "../../relay/src/store";
import { ControlledAdapter } from "../../relay/test/controlled-adapter";
import { config } from "../../relay/test/helpers";

const directory = process.env.AGENTPANEL_E2E_DIRECTORY;
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!directory || !databaseUrl)
  throw new Error("E2E requires a private fixture directory and local PostgreSQL URL");
const port = Number(process.env.AGENTPANEL_E2E_PORT || "18879");
const origin = `http://localhost:${port}`;
const ownerEmail = "browser-test@example.invalid";
const bootstrapToken = `e2e-bootstrap-${crypto.randomUUID()}`;
const schema = `agentpanel_web_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
await admin.unsafe(`CREATE SCHEMA ${schema}`);
const database = new URL(databaseUrl);
database.searchParams.set("options", `-c search_path=${schema}`);
await migrate(database.toString());
const store = PostgresStore.connect(database.toString());
process.env.WEB_DIST = resolve(import.meta.dir, "../dist");
const relayConfig = {
  ...config,
  ownerEmail,
  bootstrapToken,
  databaseUrl: database.toString(),
  origin,
  allowedOrigins: [origin],
  port,
  host: "127.0.0.1",
};
const relay = createRelay(store, relayConfig);
await relay.initialize();
const server = startServer(relay, relayConfig);
const workspace = join(directory, "workspace");
await mkdir(join(workspace, "sample-project"), { recursive: true });
await writeFile(
  join(directory, "ready.json"),
  JSON.stringify({ origin, ownerEmail, bootstrapToken, workspace }),
  { mode: 0o600 },
);
let transport: RelayConnection | undefined;
let journal: DaemonStore | undefined;
let manager: SessionManager | undefined;
const adapters: ControlledAdapter[] = [];
let stopped = false;
let pairing = false;
const seen = new Set<string>();
const poll = setInterval(async () => {
  if (stopped) return;
  if (!transport && !pairing) {
    let code: string;
    try {
      code = JSON.parse(await readFile(join(directory, "pair.json"), "utf8")).code;
    } catch {
      return;
    }
    pairing = true;
    try {
      const daemonConfig = await pair(
        configSchema.parse({
          relayUrl: origin,
          name: "Mac · 浏览器验收",
          roots: [workspace],
          importHistory: false,
          claudeHome: join(directory, "claude"),
          codexHome: join(directory, "codex"),
        }),
        code,
        join(directory, "daemon.json"),
      );
      journal = new DaemonStore(join(directory, "daemon.sqlite"));
      manager = new SessionManager(
        daemonConfig,
        journal,
        (event: Envelope) => {
          if (transport) transport.publish(event);
          else journal?.enqueue(event);
        },
        () => {
          const adapter = new ControlledAdapter();
          adapter.nativeId = `browser-fixture-${crypto.randomUUID()}`;
          adapters.push(adapter);
          const originalStart = adapter.start.bind(adapter);
          adapter.start = async (context) =>
            originalStart({
              ...context,
              emit: (event: SessionEvent) =>
                context.emit({
                  ...event,
                  ...(event.messageId
                    ? { messageId: `${adapter.nativeId}:${event.messageId}` }
                    : {}),
                  ...(event.toolCallId
                    ? { toolCallId: `${adapter.nativeId}:${event.toolCallId}` }
                    : {}),
                }),
            });
          return adapter;
        },
      );
      transport = new RelayConnection(daemonConfig, journal, manager, [
        {
          kind: "codex",
          installed: true,
          authenticated: true,
          version: "isolated-browser-fixture",
          models: ["fixture-model"],
        },
        { kind: "claude", installed: false },
      ]);
      await manager.start();
      transport.start();
      await writeFile(
        join(directory, "paired.json"),
        JSON.stringify({ deviceId: daemonConfig.deviceId }),
        { mode: 0o600 },
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Fixture pairing failed");
    }
  }
  try {
    const action = JSON.parse(await readFile(join(directory, "action.json"), "utf8")) as {
      id: string;
      type: string;
    };
    if (seen.has(action.id)) return;
    seen.add(action.id);
    const adapter = adapters.at(-1);
    if (action.type === "offline-event" && adapter) {
      adapter.emit({
        kind: "message.done",
        role: "assistant",
        messageId: `offline-${action.id}`,
        text: "离线期间已保存的消息\n\n```ts\nconst connected = true;\n```",
      });
      adapter.emit({
        kind: "tool.result",
        toolCallId: `diff-${action.id}`,
        toolName: "Edit",
        output: "已更新示例",
        diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const ready = false;\n+const ready = true;",
      });
      await writeFile(join(directory, `done-${action.id}`), "ok");
    }
  } catch {
    /* Fixture control files appear only when a test needs them. */
  }
}, 100);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  stopped = true;
  clearInterval(poll);
  await transport?.close();
  await manager?.close();
  relay.hub.close();
  await server.stop(true);
  journal?.close();
  await store.close();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
