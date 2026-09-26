import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { createRelay } from "../src/app";
import type { RelayConfig } from "../src/config";
import type { Store } from "../src/store";

export const config: RelayConfig = {
  databaseUrl: "test-only",
  ownerEmail: "owner@example.invalid",
  bootstrapToken: "test-bootstrap-".repeat(4),
  jwtSecret: "test-jwt-secret-".repeat(4),
  origin: "http://localhost:5173",
  allowedOrigins: ["http://localhost:5173"],
  rpId: "localhost",
  port: 8787,
  secureCookies: false,
  accessTtlSeconds: 600,
  refreshTtlMs: 86400_000,
  eventRetentionDays: 30,
  auditRetentionDays: 180,
  apnsProduction: false,
};
const hash = (input: Buffer | string) => createHash("sha256").update(input).digest();
const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** Minimal CTAP2 CBOR encoder for a real ES256 software authenticator used only in tests. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof value === "number") return head(value >= 0 ? 0 : 1, value >= 0 ? value : -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map)
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]),
    ]);
  throw new Error("Unsupported CBOR fixture");
}
export class Authenticator {
  readonly id = randomBytes(32);
  private privateKey: KeyObject;
  private publicKey: KeyObject;
  counter = 0;
  constructor() {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }
  register(challenge: string, origin = config.origin, rpId = config.rpId) {
    const jwk = this.publicKey.export({ format: "jwk" });
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const authData = Buffer.concat([
      hash(rpId),
      Buffer.from([0x45]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      Buffer.from([0, this.id.length]),
      this.id,
      cose,
    ]);
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64(JSON.stringify({ type: "webauthn.create", challenge, origin })),
        attestationObject: b64(
          cbor(
            new Map<string, unknown>([
              ["fmt", "none"],
              ["attStmt", new Map()],
              ["authData", authData],
            ]),
          ),
        ),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
  login(challenge: string, origin = config.origin) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([hash(config.rpId), Buffer.from([0x05]), counter]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin }));
    const signature = sign("sha256", Buffer.concat([authData, hash(clientData)]), this.privateKey);
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
export async function setup(store: Store, override: Partial<RelayConfig> = {}) {
  const relay = createRelay(store, { ...config, ...override });
  await relay.initialize();
  const authenticator = new Authenticator();
  const challenge = await relay.auth.registrationOptions(config.ownerEmail, config.bootstrapToken);
  const credentials = await relay.auth.registrationVerify(
    challenge.challengeId,
    authenticator.register(challenge.options.challenge) as never,
  );
  const principal = await relay.auth.authenticate(credentials.accessToken);
  const request = async (
    path: string,
    data?: unknown,
    method = data === undefined ? "GET" : "POST",
    access = credentials.accessToken,
  ) => {
    return relay.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
        origin: config.origin,
      },
      ...(data !== undefined
        ? { body: typeof data === "string" ? data : JSON.stringify(data) }
        : {}),
    });
  };
  const pair = async () => {
    const result = await request("/api/pairing", {});
    const pairing = (await result.json()) as { code: string };
    const claimed = await request("/api/pairing/redeem", {
      code: pairing.code,
      name: "Test Mac",
      platform: "darwin",
    });
    const device = (await claimed.json()) as { deviceId: string; deviceToken: string };
    return {
      ...device,
      principal: await relay.auth.authenticate(device.deviceToken),
      code: pairing.code,
    };
  };
  return { ...relay, credentials, principal, authenticator, request, pair };
}
