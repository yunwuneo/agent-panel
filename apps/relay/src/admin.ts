import { AuthService } from "./auth";
import { loadConfig } from "./config";
import { PostgresStore } from "./store";

const config = loadConfig();
const store = PostgresStore.connect(config.databaseUrl);
const auth = new AuthService(store, config);
try {
  const command = process.argv[2];
  if (command === "status") {
    console.log(JSON.stringify(await auth.status()));
  } else if (command === "reset-passkeys" && process.argv.includes("--confirm-reset-passkeys")) {
    await store.atomic(`auth:${auth.ownerId}`, async (tx) => {
      for (const kind of [
        "credentials",
        "challenges",
        "recovery_codes",
        "ws_tickets",
        "pairing_codes",
      ] as const) {
        for (const row of await tx.list(kind, auth.ownerId)) await tx.remove(kind, row.id);
      }
      for (const session of await tx.list("auth_sessions", auth.ownerId))
        await tx.put("auth_sessions", { ...session, revokedAt: Date.now() });
      await auth.audit(tx, "auth.operator_reset", {});
    });
    console.log(
      "Passkeys reset; existing client sessions revoked. Enroll a new Passkey using the configured bootstrap token.",
    );
  } else {
    console.error(
      "Usage: bun apps/relay/src/admin.ts status | reset-passkeys --confirm-reset-passkeys",
    );
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
