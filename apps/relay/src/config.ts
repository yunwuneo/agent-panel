export interface RelayConfig {
  databaseUrl: string;
  ownerEmail: string;
  bootstrapToken: string;
  jwtSecret: string;
  origin: string;
  allowedOrigins: string[];
  rpId: string;
  port: number;
  host?: string;
  secureCookies: boolean;
  accessTtlSeconds: number;
  refreshTtlMs: number;
  eventRetentionDays: number;
  auditRetentionDays: number;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
  apnsKeyPath?: string;
  apnsKeyId?: string;
  apnsTeamId?: string;
  apnsTopic?: string;
  apnsIosTopic?: string;
  apnsMacosTopic?: string;
  apnsProduction: boolean;
  appleAppIds?: string[];
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}. See .env.example.`);
    return value;
  };
  const origin = env.PUBLIC_ORIGIN ?? "http://localhost:5173";
  const url = new URL(origin);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("PUBLIC_ORIGIN requires HTTPS outside localhost.");
  }
  const jwtSecret = required("JWT_SECRET");
  const bootstrapToken = required("BOOTSTRAP_TOKEN");
  if (jwtSecret.length < 32 || bootstrapToken.length < 32)
    throw new Error("JWT_SECRET and BOOTSTRAP_TOKEN require at least 32 characters.");
  return {
    databaseUrl: required("DATABASE_URL"),
    ownerEmail: required("OWNER_EMAIL").toLowerCase(),
    jwtSecret,
    bootstrapToken,
    origin: url.origin,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? origin).split(",").map((v) => new URL(v.trim()).origin),
    rpId: env.WEBAUTHN_RP_ID ?? url.hostname,
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
    secureCookies: url.protocol === "https:",
    accessTtlSeconds: 600,
    refreshTtlMs: 30 * 86400_000,
    eventRetentionDays: positive(env.EVENT_RETENTION_DAYS, 30),
    auditRetentionDays: positive(env.AUDIT_RETENTION_DAYS, 180),
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY,
    vapidSubject: env.VAPID_SUBJECT,
    apnsKeyPath: env.APNS_KEY_PATH,
    apnsKeyId: env.APNS_KEY_ID,
    apnsTeamId: env.APNS_TEAM_ID,
    apnsTopic: env.APNS_TOPIC,
    apnsIosTopic: env.APNS_IOS_TOPIC,
    apnsMacosTopic: env.APNS_MACOS_TOPIC,
    apnsProduction: env.APNS_PRODUCTION === "true",
    appleAppIds: env.APPLE_APP_IDS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function positive(value: string | undefined, fallback: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error("Retention days must be positive integers");
  return n;
}
