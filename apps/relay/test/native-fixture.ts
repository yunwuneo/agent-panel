/** Disposable local native UI acceptance fixture. Never imported by production. */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Envelope, makeEnvelope } from "@agentpanel/protocol";
import postgres from "postgres";
import { configSchema, pair } from "../../daemon/src/config";
import { SessionManager } from "../../daemon/src/manager";
import { Store as DaemonStore } from "../../daemon/src/store";
import { RelayConnection } from "../../daemon/src/transport";
import { migrate } from "../src/migrate";
import { startServer } from "../src/server";
import { PostgresStore } from "../src/store";
import { ControlledAdapter } from "./controlled-adapter";
import { config, setup } from "./helpers";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("A local DATABASE_URL is required for the disposable fixture");
const temporary = await mkdtemp(join(tmpdir(), "agentpanel-native-qa-"));
const statePath = resolve(process.env.NATIVE_QA_STATE ?? ".local/native-qa.json");
const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const schema = `agentpanel_native_${crypto.randomUUID().replaceAll("-", "")}`;
await admin.unsafe(`CREATE SCHEMA ${schema}`);
const database = new URL(databaseUrl);
database.searchParams.set("options", `-c search_path=${schema}`);
await migrate(database.toString());
const store = PostgresStore.connect(database.toString());
const relay = await setup(store, { accessTtlSeconds: 3600 });
const server = startServer(relay, { ...config, port: 0 });
const origin = `http://127.0.0.1:${server.port}`;
const request = async (path: string, data: unknown = {}) => {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${relay.credentials.accessToken}`,
      Origin: config.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
  return response.json() as Promise<any>;
};
const pairing = await request("/api/pairing");
const device = await pair(
  configSchema.parse({
    relayUrl: origin,
    name: "Mac · 本地验收",
    roots: [temporary],
    importHistory: false,
    approvalTimeoutMs: 3600_000,
    claudeHome: join(temporary, "claude"),
    codexHome: join(temporary, "codex"),
  }),
  pairing.code,
  join(temporary, "config.json"),
);
const journal = new DaemonStore(join(temporary, "daemon.sqlite"));
let transport: RelayConnection | undefined;
const manager = new SessionManager(
  device,
  journal,
  (event: Envelope) => {
    if (transport) transport.publish(event);
    else journal.enqueue(event);
  },
  () => {
    const adapter = new ControlledAdapter();
    adapter.nativeId = `fixture_${crypto.randomUUID()}`;
    return adapter;
  },
);
transport = new RelayConnection(device, journal, manager, [
  { kind: "codex", installed: true, authenticated: true, version: "验收适配器" },
  { kind: "claude", installed: false },
]);
await manager.start();
transport.start();
await request(
  "/api/commands",
  makeEnvelope(
    "session.create",
    { agent: "codex", cwd: temporary, title: "已完成 · 用量统计样例", prompt: "resumed" },
    { deviceId: device.deviceId },
  ),
);
const created = await request(
  "/api/commands",
  makeEnvelope(
    "session.create",
    { agent: "codex", cwd: temporary, title: "远程工作台 · 实际链路验收", prompt: "allow" },
    { deviceId: device.deviceId },
  ),
);
const deadline = Date.now() + 10_000;
while (Date.now() < deadline && (await store.list("approvals", relay.principal.owner)).length === 0)
  await Bun.sleep(50);
if ((await store.list("approvals", relay.principal.owner)).length === 0)
  throw new Error("Fixture approval did not arrive");
await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
await writeFile(
  statePath,
  JSON.stringify({
    origin,
    accessToken: relay.credentials.accessToken,
    refreshToken: relay.credentials.refreshToken,
    user: relay.credentials.user,
    sessionId: created.sessionId,
    deviceId: device.deviceId,
    createdAt: Date.now(),
  }),
  { mode: 0o600 },
);
await chmod(statePath, 0o600);
console.log(
  "Disposable native QA fixture ready; credentials saved privately in .local/native-qa.json",
);
const maintenance = setInterval(() => {
  void relay.hub.maintenance().catch(() => {});
}, 30_000);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(maintenance);
  await transport?.close();
  await manager.close();
  relay.hub.close();
  await server.stop(true);
  await Bun.sleep(100);
  journal.close();
  await store.close();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  await rm(temporary, { recursive: true, force: true });
  await rm(statePath, { force: true });
  process.exit(0);
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
