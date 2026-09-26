import { createECDH, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const file = resolve(import.meta.dir, "../.env");
if (await Bun.file(file).exists()) {
  console.log(".env already exists; preserved without changes.");
} else {
  const owner = process.argv[2];
  if (!owner || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner))
    throw new Error("Usage: bun scripts/setup.ts owner@example.com");
  const password = randomBytes(24).toString("hex");
  const vapidKey = createECDH("prime256v1");
  vapidKey.generateKeys();
  const vapid = {
    publicKey: vapidKey.getPublicKey().toString("base64url"),
    privateKey: vapidKey.getPrivateKey().toString("base64url"),
  };
  const values = {
    OWNER_EMAIL: owner,
    BOOTSTRAP_TOKEN: randomBytes(32).toString("hex"),
    JWT_SECRET: randomBytes(32).toString("hex"),
    POSTGRES_PASSWORD: password,
    POSTGRES_PORT: "55432",
    DATABASE_URL: `postgres://agentpanel:${password}@127.0.0.1:55432/agentpanel`,
    PUBLIC_ORIGIN: "http://localhost:5173",
    ALLOWED_ORIGINS: "http://localhost:5173,http://localhost:8787",
    WEBAUTHN_RP_ID: "localhost",
    PORT: "8787",
    EVENT_RETENTION_DAYS: "30",
    AUDIT_RETENTION_DAYS: "180",
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: `mailto:${owner}`,
  };
  await writeFile(
    file,
    `${Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created private .env, bootstrap secret and Web Push VAPID keys. Values were not printed.",
  );
}
