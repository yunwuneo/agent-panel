import { createRelay } from "./app";
import { loadConfig } from "./config";
import { startServer } from "./server";
import { PostgresStore } from "./store";

const config = loadConfig();
const store = PostgresStore.connect(config.databaseUrl);
await store.ping();
const relay = createRelay(store, config);
await relay.initialize();
const server = startServer(relay, config);
const maintenance = setInterval(() => {
  void relay.hub.maintenance().catch(() => console.error("Relay maintenance failed"));
}, 30_000);
console.log(`AgentPanel Relay listening on port ${server.port}`);
async function shutdown() {
  clearInterval(maintenance);
  relay.hub.close();
  await server.stop();
  await store.close();
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
