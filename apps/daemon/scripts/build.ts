import { mkdir } from "node:fs/promises";

const targets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
] as const;
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
for (const target of targets) {
  const name = `agentpaneld-${target.replace("bun-", "")}${target.includes("windows") ? ".exe" : ""}`;
  const result = await Bun.build({
    entrypoints: [new URL("../src/cli.ts", import.meta.url).pathname],
    compile: { target, outfile: new URL(`../dist/${name}`, import.meta.url).pathname },
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, `构建失败：${target}`);
  console.log(name);
}
