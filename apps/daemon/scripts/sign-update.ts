import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    key: { type: "string" },
    version: { type: "string" },
    "base-url": { type: "string" },
    out: { type: "string" },
    days: { type: "string" },
  },
});
if (
  !values.key ||
  !values.version ||
  !values["base-url"] ||
  !values.out ||
  !/^\d+\.\d+\.\d+$/.test(values.version)
)
  throw new Error(
    "用法：bun scripts/sign-update.ts --key PRIVATE_KEY.pem --version X.Y.Z --base-url https://host/releases/ --out manifest.json [--days 7]",
  );
const base = new URL(values["base-url"].replace(/\/?$/, "/"));
if (base.protocol !== "https:") throw new Error("更新地址必须使用 HTTPS");
const key = createPrivateKey(await readFile(resolve(values.key), "utf8"));
if (key.asymmetricKeyType !== "ed25519") throw new Error("仅支持 Ed25519 密钥");
const days = Number(values.days ?? 7);
if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("有效期必须为 1–90 天");
const platforms = [
  ["darwin", "arm64", "darwin-arm64"],
  ["darwin", "x64", "darwin-x64"],
  ["linux", "x64", "linux-x64"],
  ["linux", "arm64", "linux-arm64"],
  ["win32", "x64", "windows-x64.exe"],
];
const artifacts = [];
for (const [platform, arch, suffix] of platforms) {
  const name = `agentpaneld-${suffix}`;
  const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
  artifacts.push({
    platform,
    arch,
    url: new URL(name, base).href,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}
const payload = Buffer.from(
  JSON.stringify({ version: values.version, expiresAt: Date.now() + days * 86_400_000, artifacts }),
);
await writeFile(
  resolve(values.out),
  `${JSON.stringify(
    { payload: payload.toString("base64"), signature: sign(null, payload, key).toString("base64") },
    null,
    2,
  )}\n`,
);
console.log(`已签署 ${values.version} 更新清单（${artifacts.length} 个平台构建）`);
