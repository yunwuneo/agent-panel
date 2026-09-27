import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { jwtVerify, SignJWT } from "jose";
import type { RelayConfig } from "./config";
import type { RecordData, Store } from "./store";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const digest = (input: string) => createHash("sha256").update(input).digest("hex");
export function secretEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
export const missing = () => new ApiError(404, "NOT_FOUND", "未找到记录");
export const unauthorized = () => new ApiError(401, "UNAUTHORIZED", "请重新登录");

export interface User extends RecordData {
  email: string;
  passwordHash?: string;
}
interface Credential extends RecordData {
  publicKey: string;
  counter: number;
  transports: string[];
}
interface Challenge extends RecordData {
  challenge: string;
  mode: "register" | "login" | "recover";
  recoveryHash?: string;
}
interface AuthSession extends RecordData {
  revokedAt?: number;
}
interface Refresh extends RecordData {
  sessionId: string;
  usedAt?: number;
}
export interface Principal {
  owner: string;
  role: "client" | "device";
  sessionId?: string;
  deviceId?: string;
}
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string };
  recoveryCodes?: string[];
}

// Injectable cryptographic provider is for security tests; production uses SimpleWebAuthn exclusively.
export type WebAuthnProvider = {
  registrationOptions: typeof generateRegistrationOptions;
  authenticationOptions: typeof generateAuthenticationOptions;
  verifyRegistration: typeof verifyRegistrationResponse;
  verifyAuthentication: typeof verifyAuthenticationResponse;
};
const provider: WebAuthnProvider = {
  registrationOptions: generateRegistrationOptions,
  authenticationOptions: generateAuthenticationOptions,
  verifyRegistration: verifyRegistrationResponse,
  verifyAuthentication: verifyAuthenticationResponse,
};

export class AuthService {
  readonly ownerId: string;
  private key: Uint8Array;
  constructor(
    readonly store: Store,
    readonly config: RelayConfig,
    private webauthn = provider,
  ) {
    this.ownerId = `usr_${digest(config.ownerEmail).slice(0, 32)}`;
    this.key = new TextEncoder().encode(config.jwtSecret);
  }
  async initialize() {
    await this.store.insert("users", {
      id: this.ownerId,
      owner: this.ownerId,
      email: this.config.ownerEmail,
      createdAt: Date.now(),
    });
  }
  async status() {
    const user = await this.store.get<User>("users", this.ownerId, this.ownerId);
    return {
      configured: true,
      registered: await this.registered(this.store),
      passwordEnabled: !!user?.passwordHash,
      rpId: this.config.rpId,
    };
  }
  /** The owner counts as registered once any sign-in method exists: a passkey or a password. */
  private async registered(tx: Store) {
    if ((await tx.list("credentials", this.ownerId)).length) return true;
    return !!(await tx.get<User>("users", this.ownerId, this.ownerId))?.passwordHash;
  }
  private validateEmail(email: string) {
    if (!secretEqual(email.toLowerCase().trim(), this.config.ownerEmail))
      throw new ApiError(400, "AUTH_FAILED", "账号或凭据无效");
  }
  async registrationOptions(email: string, bootstrapToken: string) {
    this.validateEmail(email);
    if (!secretEqual(bootstrapToken, this.config.bootstrapToken))
      throw new ApiError(401, "AUTH_FAILED", "账号或凭据无效");
    if (await this.registered(this.store))
      throw new ApiError(409, "ALREADY_REGISTERED", "账号已注册，请直接登录");
    return this.newRegistrationChallenge("register");
  }
  private async newRegistrationChallenge(mode: "register" | "recover", recoveryHash?: string) {
    const options = await this.webauthn.registrationOptions({
      rpName: "AgentPanel",
      rpID: this.config.rpId,
      userName: this.config.ownerEmail,
      userID: new TextEncoder().encode(this.ownerId),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const challengeId = token();
    await this.store.put("challenges", {
      id: challengeId,
      owner: this.ownerId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      challenge: options.challenge,
      mode,
      recoveryHash,
    });
    return { challengeId, options };
  }
  async recoveryOptions(email: string, recoveryCode: string) {
    this.validateEmail(email);
    const hash = digest(recoveryCode.replace(/[\s-]/g, "").toUpperCase());
    if (!(await this.store.get("recovery_codes", hash, this.ownerId)))
      throw new ApiError(401, "AUTH_FAILED", "账号或恢复码无效");
    return this.newRegistrationChallenge("recover", hash);
  }
  async registrationVerify(
    challengeId: string,
    response: Parameters<typeof verifyRegistrationResponse>[0]["response"],
  ): Promise<Tokens> {
    return this.store.atomic(`auth:${this.ownerId}`, async (tx) => {
      const challenge = await this.challenge(tx, challengeId);
      if (challenge.mode === "login") throw unauthorized();
      if (challenge.mode === "register" && (await this.registered(tx)))
        throw new ApiError(409, "ALREADY_REGISTERED", "账号已注册");
      if (
        challenge.mode === "recover" &&
        !(await tx.get("recovery_codes", challenge.recoveryHash!, this.ownerId))
      )
        throw unauthorized();
      let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        result = await this.webauthn.verifyRegistration({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: this.config.allowedOrigins,
          expectedRPID: this.config.rpId,
          requireUserVerification: true,
        });
      } catch {
        throw new ApiError(400, "PASSKEY_INVALID", "Passkey 验证失败");
      }
      if (!result.verified || !result.registrationInfo)
        throw new ApiError(400, "PASSKEY_INVALID", "Passkey 验证失败");
      const credential = result.registrationInfo.credential;
      if (challenge.mode === "recover") {
        for (const existing of await tx.list("credentials", this.ownerId))
          await tx.remove("credentials", existing.id);
        for (const session of await tx.list("auth_sessions", this.ownerId))
          await tx.put("auth_sessions", { ...session, revokedAt: Date.now() });
      }
      await tx.put("credentials", {
        id: credential.id,
        owner: this.ownerId,
        createdAt: Date.now(),
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports ?? [],
      });
      await tx.remove("challenges", challengeId);
      const recoveryCodes = await this.replaceRecoveryCodes(tx);
      await this.audit(tx, "auth.register", { recovered: challenge.mode === "recover" });
      return { ...(await this.createSession(tx)), recoveryCodes };
    });
  }
  private async replaceRecoveryCodes(tx: Store) {
    for (const old of await tx.list("recovery_codes", this.ownerId))
      await tx.remove("recovery_codes", old.id);
    const recoveryCodes = Array.from({ length: 8 }, () =>
      randomBytes(12).toString("hex").toUpperCase(),
    );
    for (const code of recoveryCodes)
      await tx.put("recovery_codes", {
        id: digest(code),
        owner: this.ownerId,
        createdAt: Date.now(),
      });
    return recoveryCodes;
  }
  private hashPassword(password: string) {
    return Bun.password.hash(password, { algorithm: "argon2id" });
  }
  /** First-time registration with the bootstrap token and a password instead of a passkey. */
  async passwordRegister(email: string, bootstrapToken: string, password: string): Promise<Tokens> {
    this.validateEmail(email);
    if (!secretEqual(bootstrapToken, this.config.bootstrapToken))
      throw new ApiError(401, "AUTH_FAILED", "账号或凭据无效");
    const passwordHash = await this.hashPassword(password);
    return this.store.atomic(`auth:${this.ownerId}`, async (tx) => {
      if (await this.registered(tx))
        throw new ApiError(409, "ALREADY_REGISTERED", "账号已注册，请直接登录");
      const user = await tx.get<User>("users", this.ownerId, this.ownerId);
      await tx.put("users", { ...user!, passwordHash });
      const recoveryCodes = await this.replaceRecoveryCodes(tx);
      await this.audit(tx, "auth.register", { method: "password" });
      return { ...(await this.createSession(tx)), recoveryCodes };
    });
  }
  async passwordLogin(email: string, password: string): Promise<Tokens> {
    this.validateEmail(email);
    const user = await this.store.get<User>("users", this.ownerId, this.ownerId);
    if (!user?.passwordHash || !(await Bun.password.verify(password, user.passwordHash))) {
      await this.audit(this.store, "auth.password_failed", {});
      throw new ApiError(401, "AUTH_FAILED", "账号或密码错误");
    }
    return this.store.atomic(`auth:${this.ownerId}`, async (tx) => {
      await this.audit(tx, "auth.login", { method: "password" });
      return this.createSession(tx);
    });
  }
  /** A recovery code resets the password and, like passkey recovery, signs out every session. */
  async passwordRecover(email: string, recoveryCode: string, password: string): Promise<Tokens> {
    this.validateEmail(email);
    const hash = digest(recoveryCode.replace(/[\s-]/g, "").toUpperCase());
    const passwordHash = await this.hashPassword(password);
    return this.store.atomic(`auth:${this.ownerId}`, async (tx) => {
      if (!(await tx.get("recovery_codes", hash, this.ownerId)))
        throw new ApiError(401, "AUTH_FAILED", "账号或恢复码无效");
      const user = await tx.get<User>("users", this.ownerId, this.ownerId);
      await tx.put("users", { ...user!, passwordHash });
      for (const session of await tx.list("auth_sessions", this.ownerId))
        await tx.put("auth_sessions", { ...session, revokedAt: Date.now() });
      const recoveryCodes = await this.replaceRecoveryCodes(tx);
      await this.audit(tx, "auth.password_reset", { recovered: true });
      return { ...(await this.createSession(tx)), recoveryCodes };
    });
  }
  /** Sets or changes the password of a signed-in owner; other sessions are signed out. */
  async setPassword(principal: Principal, currentPassword: string | undefined, password: string) {
    const passwordHash = await this.hashPassword(password);
    await this.store.atomic(`auth:${principal.owner}`, async (tx) => {
      const user = await tx.get<User>("users", principal.owner, principal.owner);
      if (!user) throw unauthorized();
      if (
        user.passwordHash &&
        !(currentPassword && (await Bun.password.verify(currentPassword, user.passwordHash)))
      )
        throw new ApiError(400, "PASSWORD_INVALID", "当前密码错误");
      await tx.put("users", { ...user, passwordHash });
      for (const session of await tx.list<AuthSession>("auth_sessions", principal.owner))
        if (session.id !== principal.sessionId && !session.revokedAt)
          await tx.put("auth_sessions", { ...session, revokedAt: Date.now() });
      await this.audit(tx, "auth.password_set", { changed: !!user.passwordHash }, principal.owner);
    });
  }
  async loginOptions(email: string) {
    this.validateEmail(email);
    const credentials = await this.store.list<Credential>("credentials", this.ownerId);
    const options = await this.webauthn.authenticationOptions({
      rpID: this.config.rpId,
      userVerification: "required",
      allowCredentials: credentials.map((c) => ({ id: c.id, transports: c.transports as never })),
    });
    const challengeId = token();
    await this.store.put("challenges", {
      id: challengeId,
      owner: this.ownerId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      challenge: options.challenge,
      mode: "login",
    });
    return { challengeId, options };
  }
  async loginVerify(
    challengeId: string,
    response: Parameters<typeof verifyAuthenticationResponse>[0]["response"],
  ): Promise<Tokens> {
    return this.store.atomic(`auth:${this.ownerId}`, async (tx) => {
      const challenge = await this.challenge(tx, challengeId);
      if (challenge.mode !== "login") throw unauthorized();
      const credential = await tx.get<Credential>("credentials", response.id, this.ownerId);
      if (!credential) throw unauthorized();
      let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        result = await this.webauthn.verifyAuthentication({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: this.config.allowedOrigins,
          expectedRPID: this.config.rpId,
          requireUserVerification: true,
          credential: {
            id: credential.id,
            publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
            counter: credential.counter,
            transports: credential.transports as never,
          },
        });
      } catch {
        throw new ApiError(400, "PASSKEY_INVALID", "Passkey 验证失败");
      }
      if (!result.verified) throw new ApiError(400, "PASSKEY_INVALID", "Passkey 验证失败");
      await tx.put("credentials", { ...credential, counter: result.authenticationInfo.newCounter });
      await tx.remove("challenges", challengeId);
      await this.audit(tx, "auth.login", {});
      return this.createSession(tx);
    });
  }
  private async challenge(tx: Store, id: string): Promise<Challenge> {
    const row = await tx.get<Challenge>("challenges", id, this.ownerId);
    if (!row?.expiresAt || row.expiresAt < Date.now())
      throw new ApiError(400, "CHALLENGE_EXPIRED", "验证已过期，请重试");
    return row;
  }
  private async createSession(tx: Store): Promise<Tokens> {
    const sessionId = token();
    await tx.put("auth_sessions", {
      id: sessionId,
      owner: this.ownerId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.refreshTtlMs,
    });
    return this.issueTokens(tx, sessionId, this.ownerId);
  }
  private async issueTokens(tx: Store, sessionId: string, owner: string): Promise<Tokens> {
    const refreshToken = `apr_${token()}`;
    await tx.put("refresh_tokens", {
      id: digest(refreshToken),
      owner,
      sessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.refreshTtlMs,
    });
    const accessToken = await new SignJWT({ sid: sessionId, role: "client" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(owner)
      .setIssuer("agentpanel-relay")
      .setAudience("agentpanel-client")
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTtlSeconds}s`)
      .sign(this.key);
    const user = await tx.get<User>("users", owner, owner);
    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.accessTtlSeconds,
      user: { id: owner, email: user!.email },
    };
  }
  async refresh(rawToken: string): Promise<Tokens> {
    const hash = digest(rawToken);
    // All session mutation shares this lock: replayed refresh tokens must revoke the entire family.
    const outcome = await this.store.atomic(`auth:${this.ownerId}`, async (tx) => {
      const row = await tx.get<Refresh>("refresh_tokens", hash);
      if (!row) return undefined;
      const session = await tx.get<AuthSession>("auth_sessions", row.sessionId, row.owner);
      if (
        !session ||
        session.revokedAt ||
        !session.expiresAt ||
        session.expiresAt < Date.now() ||
        !row.expiresAt ||
        row.expiresAt < Date.now()
      )
        return undefined;
      if (row.usedAt) {
        await tx.put("auth_sessions", { ...session, revokedAt: Date.now() });
        await this.audit(tx, "auth.refresh_reuse", {}, row.owner);
        return undefined;
      }
      await tx.put("refresh_tokens", { ...row, usedAt: Date.now() });
      return this.issueTokens(tx, row.sessionId, row.owner);
    });
    if (!outcome) throw unauthorized();
    return outcome;
  }
  async authenticate(bearer: string): Promise<Principal> {
    if (bearer.startsWith("apd_")) {
      const devices = await this.store.list("devices");
      const hash = digest(bearer);
      const device = devices.find((d) => d.tokenHash === hash && !d.revokedAt);
      if (!device) throw unauthorized();
      return { role: "device", owner: device.owner, deviceId: device.id };
    }
    try {
      const { payload } = await jwtVerify(bearer, this.key, {
        algorithms: ["HS256"],
        issuer: "agentpanel-relay",
        audience: "agentpanel-client",
      });
      if (!payload.sub || typeof payload.sid !== "string" || payload.role !== "client")
        throw unauthorized();
      const session = await this.store.get<AuthSession>("auth_sessions", payload.sid, payload.sub);
      if (!session || session.revokedAt || !session.expiresAt || session.expiresAt < Date.now())
        throw unauthorized();
      return { owner: payload.sub, role: "client", sessionId: payload.sid };
    } catch {
      throw unauthorized();
    }
  }
  async stillActive(principal: Principal): Promise<boolean> {
    const row =
      principal.role === "device"
        ? await this.store.get("devices", principal.deviceId!, principal.owner)
        : await this.store.get("auth_sessions", principal.sessionId!, principal.owner);
    return (
      !!row &&
      !row.revokedAt &&
      (principal.role === "device" || (!!row.expiresAt && row.expiresAt > Date.now()))
    );
  }
  async logout(principal: Principal) {
    if (principal.sessionId) {
      const row = await this.store.get("auth_sessions", principal.sessionId, principal.owner);
      if (row) await this.store.put("auth_sessions", { ...row, revokedAt: Date.now() });
    }
  }
  async ticket(principal: Principal) {
    const value = token();
    const expiresAt = Date.now() + 30_000;
    await this.store.put("ws_tickets", {
      id: digest(value),
      owner: principal.owner,
      createdAt: Date.now(),
      expiresAt,
      principal,
    });
    return { ticket: value, expiresAt };
  }
  async redeemTicket(value: string): Promise<Principal> {
    const principal = await this.store.atomic(`ticket:${digest(value)}`, async (tx) => {
      const row = await tx.get("ws_tickets", digest(value));
      if (!row?.expiresAt || row.expiresAt < Date.now()) throw unauthorized();
      await tx.remove("ws_tickets", row.id);
      return row.principal as Principal;
    });
    if (!(await this.stillActive(principal))) throw unauthorized();
    return principal;
  }
  async audit(tx: Store, action: string, data: Record<string, unknown>, owner = this.ownerId) {
    await tx.put("audit", {
      id: token(),
      owner,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.auditRetentionDays * 86400_000,
      action,
      ...data,
    });
  }
}
