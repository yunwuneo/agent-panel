import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const version = "0.1.0";
export const configSchema = z.object({
  relayUrl: z.string().url().default("http://localhost:8787"),
  deviceId: z.string().optional(),
  deviceToken: z.string().optional(),
  name: z.string().min(1).max(100).default(hostname()),
  roots: z.array(z.string().min(1)).min(1).default(["*"]),
  claudeHome: z.string().default(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")),
  codexHome: z.string().default(process.env.CODEX_HOME ?? join(homedir(), ".codex")),
  codexExecutable: z.string().default("codex"),
  codexModelProvider: z.string().min(1).optional(),
  claudeExecutable: z.string().optional(),
  approvalTimeoutMs: z.number().int().min(1000).max(86_400_000).default(600_000),
  scanIntervalMs: z.number().int().min(1000).default(30_000),
  importHistory: z.boolean().default(true),
  allowPaidApi: z.boolean().default(false),
  quotaEnabled: z.boolean().default(true),
  quotaRefreshIntervalMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
  updateManifestUrl: z.string().url().optional(),
  updatePublicKey: z.string().optional(),
  autoUpdate: z.boolean().default(false),
});
export type Config = z.infer<typeof configSchema>;
export const defaultConfigPath = () =>
  process.env.AGENTPANEL_CONFIG ?? join(homedir(), ".agentpanel", "config.json");

export async function loadConfig(path = defaultConfigPath()): Promise<Config> {
  let value: unknown = {};
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = configSchema.parse(value);
  validateRelayUrl(config.relayUrl);
  return config;
}

export function validateRelayUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error("Relay URL 必须为不含凭据、查询参数的 HTTP(S) 地址");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("非本机 Relay 必须使用 HTTPS");
  }
  return url;
}

export async function saveConfig(config: Config, path = defaultConfigPath()) {
  configSchema.parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  if (platform() !== "win32") await chmod(path, 0o600);
}

export async function pair(
  config: Config,
  code: string,
  configPath = defaultConfigPath(),
): Promise<Config> {
  const url = validateRelayUrl(config.relayUrl);
  const response = await fetch(new URL("/api/pairing/redeem", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: config.name, platform: platform() }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`设备配对失败（HTTP ${response.status}）`);
  const result = z
    .object({ deviceId: z.string().min(1), deviceToken: z.string().min(1) })
    .parse(await response.json());
  const updated = { ...config, ...result };
  await saveConfig(updated, resolve(configPath));
  return updated;
}
