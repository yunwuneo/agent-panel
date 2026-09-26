import { createHash, createPublicKey, verify } from "node:crypto";
import { chmod, copyFile, rename, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { type Config, version } from "./config";

const artifactSchema = z.object({
  platform: z.enum(["darwin", "linux", "win32"]),
  arch: z.enum(["arm64", "x64"]),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z
    .number()
    .int()
    .positive()
    .max(500 * 1024 * 1024),
});
const manifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  expiresAt: z.number().int().positive(),
  artifacts: z.array(artifactSchema).min(1),
});
export type UpdateManifest = z.infer<typeof manifestSchema>;
export function newerVersion(next: string, current: string) {
  const a = next.split(".").map(Number),
    b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}
export function verifyManifest(
  envelope: unknown,
  publicKey: string,
  currentVersion = version,
  now = Date.now(),
): UpdateManifest {
  const signed = z
    .object({ payload: z.string().max(200_000), signature: z.string().max(1000) })
    .parse(envelope);
  const bytes = Buffer.from(signed.payload, "base64");
  const key = createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, bytes, key, Buffer.from(signed.signature, "base64"))
  )
    throw new Error("更新清单签名无效");
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (manifest.expiresAt <= now) throw new Error("更新清单已过期");
  if (!newerVersion(manifest.version, currentVersion))
    throw new Error("更新版本必须高于当前版本，拒绝降级与重放");
  for (const artifact of manifest.artifacts) {
    const url = new URL(artifact.url);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("更新文件必须使用 HTTPS 且不含 URL 凭据");
  }
  return manifest;
}
export async function stageUpdate(
  config: Config,
  executablePath: string,
  currentVersion = version,
  download: typeof fetch = fetch,
): Promise<{ path: string; version: string } | null> {
  if (!config.updateManifestUrl || !config.updatePublicKey)
    throw new Error("请配置可信更新地址和固定的 Ed25519 公钥");
  if (new URL(config.updateManifestUrl).protocol !== "https:")
    throw new Error("更新清单必须使用 HTTPS");
  const response = await download(config.updateManifestUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`更新检查失败：HTTP ${response.status}`);
  if (!response.body) throw new Error("更新清单为空");
  const manifestReader = response.body.getReader();
  const manifestChunks: Uint8Array[] = [];
  let manifestBytes = 0;
  try {
    while (true) {
      const { done, value } = await manifestReader.read();
      if (done) break;
      manifestBytes += value.length;
      if (manifestBytes > 250_000) {
        await manifestReader.cancel();
        throw new Error("更新清单过大");
      }
      manifestChunks.push(value);
    }
  } finally {
    manifestReader.releaseLock();
  }
  const body = Buffer.concat(manifestChunks).toString("utf8");
  const manifest = verifyManifest(JSON.parse(body), config.updatePublicKey, currentVersion);
  const artifact = manifest.artifacts.find(
    (entry) => entry.platform === process.platform && entry.arch === process.arch,
  );
  if (!artifact) throw new Error("更新清单未包含当前平台");
  const binary = await download(artifact.url, {
    redirect: "error",
    signal: AbortSignal.timeout(300_000),
  });
  if (!binary.ok || !binary.body) throw new Error(`更新下载失败：HTTP ${binary.status}`);
  if (
    binary.headers.has("content-length") &&
    Number(binary.headers.get("content-length")) !== artifact.bytes
  )
    throw new Error("更新文件大小不符");
  const target = `${executablePath}.next`;
  const writer = Bun.file(target).writer();
  const hash = createHash("sha256");
  const reader = binary.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > artifact.bytes) {
        await reader.cancel();
        throw new Error("更新文件超过签名清单中的大小");
      }
      hash.update(value);
      writer.write(value);
    }
  } finally {
    await writer.end();
    reader.releaseLock();
  }
  if (size !== artifact.bytes || hash.digest("hex") !== artifact.sha256)
    throw new Error("更新文件校验失败；保留当前程序");
  await chmod(target, 0o700);
  return { path: target, version: manifest.version };
}
export function windowsUpdateScript(
  staged: string,
  executable: string,
  pid: number,
  restartArgs: string[],
) {
  const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return `$ErrorActionPreference = 'Stop'\nWait-Process -Id ${pid} -ErrorAction SilentlyContinue\ntry {\n  Copy-Item -LiteralPath ${ps(executable)} -Destination ${ps(`${executable}.previous`)} -Force\n  Move-Item -LiteralPath ${ps(staged)} -Destination ${ps(executable)} -Force\n} catch {\n  if (Test-Path -LiteralPath ${ps(`${executable}.previous`)}) { Copy-Item -LiteralPath ${ps(`${executable}.previous`)} -Destination ${ps(executable)} -Force }\n  throw\n}\n& schtasks.exe /Query /TN AgentPanel 2>$null | Out-Null\nif ($LASTEXITCODE -eq 0) { & schtasks.exe /Run /TN AgentPanel | Out-Null } else { Start-Process -FilePath ${ps(executable)} -ArgumentList @(${restartArgs.map(ps).join(",")}) }\n`;
}
export async function installUpdate(
  staged: string,
  executable: string,
  restartArgs: string[] = ["run"],
) {
  if (process.platform === "win32") {
    const path = `${executable}.apply-update.ps1`;
    await writeFile(path, windowsUpdateScript(staged, executable, process.pid, restartArgs), {
      mode: 0o600,
    });
    const helper = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    helper.unref();
    return "scheduled" as const;
  }
  const info = await stat(executable);
  await copyFile(executable, `${executable}.previous`);
  await chmod(staged, info.mode & 0o777);
  await rename(staged, executable);
  return "installed" as const;
}
