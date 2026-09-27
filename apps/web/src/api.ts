import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { serializedRefresh } from "./auth-refresh";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface User {
  id: string;
  email: string;
}
interface AuthResult {
  accessToken: string;
  expiresIn: number;
  user: User;
  recoveryCodes?: string[];
}
let accessToken: string | null = null;
let refreshFlight: Promise<AuthResult> | null = null;
let expire: (() => void) | undefined;
export function onExpired(callback: () => void) {
  expire = callback;
}

export async function refresh(): Promise<AuthResult> {
  if (!refreshFlight) {
    refreshFlight = serializedRefresh(
      () =>
        fetch("/api/auth/refresh", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(30_000),
        }).then(async (response) => {
          if (!response.ok) throw new ApiError(response.status, "登录已过期，请重新登录。");
          const data = (await response.json()) as AuthResult;
          accessToken = data.accessToken;
          return data;
        }),
      typeof navigator === "undefined" ? undefined : navigator.locks,
    ).finally(() => {
      refreshFlight = null;
    });
  }
  return refreshFlight;
}

export async function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(`/api${path}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(30_000),
    credentials: "include",
    headers,
  });
  if (
    response.status === 401 &&
    retry &&
    (!path.startsWith("/auth/") || path === "/auth/logout" || path === "/auth/me")
  ) {
    try {
      await refresh();
    } catch (error) {
      accessToken = null;
      expire?.();
      throw error;
    }
    return api<T>(path, options, false);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      typeof body.error === "string"
        ? body.error
        : body.error?.message || body.message || `请求失败（${response.status}）`,
    );
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export async function authenticate(
  mode: "login" | "register" | "recovery",
  email: string,
  secret: string,
): Promise<AuthResult> {
  if (!window.PublicKeyCredential)
    throw new Error(
      "此浏览器不支持通行密钥。请使用最新版 Safari、Chrome 或 Edge，并通过 HTTPS 或 localhost 打开。",
    );
  const result =
    mode === "login"
      ? await post<{
          challengeId: string;
          options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
        }>("/auth/login/options", { email })
      : await post<{
          challengeId: string;
          options: Parameters<typeof startRegistration>[0]["optionsJSON"];
        }>(`/auth/${mode}/options`, {
          email,
          ...(mode === "register" ? { bootstrapToken: secret } : { recoveryCode: secret }),
        });
  const response =
    mode === "login"
      ? await startAuthentication({
          optionsJSON: result.options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
        })
      : await startRegistration({
          optionsJSON: result.options as Parameters<typeof startRegistration>[0]["optionsJSON"],
        });
  const auth = await post<AuthResult>(`/auth/${mode === "login" ? "login" : "register"}/verify`, {
    challengeId: result.challengeId,
    response,
  });
  accessToken = auth.accessToken;
  return auth;
}

export async function passwordAuthenticate(
  mode: "login" | "register" | "recovery",
  email: string,
  secret: string,
  password: string,
): Promise<AuthResult> {
  const auth =
    mode === "login"
      ? await post<AuthResult>("/auth/password/login", { email, password })
      : mode === "register"
        ? await post<AuthResult>("/auth/password/register", {
            email,
            bootstrapToken: secret,
            password,
          })
        : await post<AuthResult>("/auth/password/recover", {
            email,
            recoveryCode: secret,
            password,
          });
  accessToken = auth.accessToken;
  return auth;
}

export async function logout() {
  await post("/auth/logout");
  accessToken = null;
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误，请稍后重试。";
}
export function queryString(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
}
