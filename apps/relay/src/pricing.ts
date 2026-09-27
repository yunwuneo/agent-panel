import {
  emptyUsage,
  isQuotaProbe,
  type ModelPrice,
  modelParts,
  type Usage,
} from "@agentpanel/protocol";
import { digest } from "./auth";
import type { RecordData, Store } from "./store";

export const PRICE_VERSION = "reference-2026-09-27";
export const PRICE_NOTE =
  "USD / 百万 Token；标准短上下文参考价，Claude 缓存写入按 5 分钟。未计长上下文、Fast、Batch、地区等差异，不代表订阅账单。来源已报告的费用优先保留；其余历史用量按当前设置重算。";
const sources = {
  openai: "https://developers.openai.com/api/docs/pricing",
  claude: "https://platform.claude.com/docs/en/about-claude/pricing",
};
const defaults: ModelPrice[] = [
  { model: "gpt-6-astra", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { model: "gpt-6-sol", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { model: "gpt-6-luna", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  { model: "gpt-5.6-sol", input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  { model: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { model: "claude-sonnet-5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { model: "claude-opus-5", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { model: "claude-opus-4-8", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
];
type PriceRow = RecordData & { price: ModelPrice };
export const priceId = (owner: string, model: string) => digest(JSON.stringify([owner, model]));
export async function effectivePrices(store: Store, owner: string) {
  const prices = new Map(defaults.map((price) => [price.model, price]));
  const overrides = await store.list<PriceRow>("model_prices", owner);
  for (const row of overrides) prices.set(row.price.model, row.price);
  return { prices, overrides };
}
export async function priceCatalog(store: Store, owner: string) {
  const { prices, overrides } = await effectivePrices(store, owner);
  const custom = new Set(overrides.map((row) => row.price.model));
  const observed = new Set<string>();
  for (const row of await store.list<
    RecordData & {
      usage: Usage;
      agent: string;
      project: string;
      source?: string;
      excludedReason?: string;
    }
  >("usage", owner)) {
    if (row.excludedReason || isQuotaProbe({ ...row, cwd: row.project })) continue;
    for (const part of modelParts(row.usage)) if (part.model) observed.add(part.model);
  }
  return {
    version: PRICE_VERSION,
    unit: "USD / 1M tokens",
    note: PRICE_NOTE,
    models: [...new Set([...prices.keys(), ...observed])].sort().map((model) => ({
      model,
      price: prices.get(model) ?? null,
      observed: observed.has(model),
      source: custom.has(model) ? "custom" : prices.has(model) ? "official" : "unknown",
      ...(prices.has(model) && !custom.has(model)
        ? {
            sourceUrl: sources[model.startsWith("claude-") ? "claude" : "openai"],
            checkedAt: "2026-09-27",
          }
        : {}),
    })),
  };
}

/** Estimate without mutating stored source usage, so edits can lower historical costs. */
export function priceUsage(usage: Usage, prices: Map<string, ModelPrice>) {
  if (usage.costUsd !== undefined) return { usage, missingModels: [] as string[] };
  let parts = modelParts(usage);
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
  // Incomplete legacy model attribution must not silently price the whole session as its last model.
  if (fields.some((field) => parts.reduce((n, part) => n + part[field], 0) !== usage[field]))
    parts = [{ ...emptyUsage(), ...usage, model: undefined }];
  let cost = 0;
  let priced = parts.length === 0;
  const missingModels = new Set<string>();
  for (const part of parts) {
    const price = part.model ? prices.get(part.model) : undefined;
    if (!price) {
      missingModels.add(part.model ?? "未记录模型");
      continue;
    }
    priced = true;
    cost +=
      (Math.max(0, part.inputTokens - part.cacheReadTokens - part.cacheWriteTokens) * price.input +
        part.outputTokens * price.output +
        part.cacheReadTokens * price.cacheRead +
        part.cacheWriteTokens * price.cacheWrite) /
      1_000_000;
  }
  return {
    usage: { ...usage, ...(priced ? { costUsd: cost, pricingVersion: PRICE_VERSION } : {}) },
    missingModels: [...missingModels],
  };
}
