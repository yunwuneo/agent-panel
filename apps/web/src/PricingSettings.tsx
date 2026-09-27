import { type ModelPrice, ModelPriceSchema } from "@agentpanel/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import { useState } from "react";
import { api, errorText } from "./api";
import { Notice, Spinner } from "./ui";

interface PriceEntry {
  model: string;
  price: ModelPrice | null;
  source: "official" | "custom" | "unknown";
  sourceUrl?: string;
  checkedAt?: string;
  observed: boolean;
}
interface Catalog {
  models: PriceEntry[];
  note: string;
}
export const priceFields = [
  ["input", "非缓存输入"],
  ["output", "输出"],
  ["cacheRead", "缓存读取"],
  ["cacheWrite", "缓存写入"],
] as const;
export function parsePriceDraft(model: string, draft: Record<string, string>): ModelPrice {
  if (priceFields.some(([key]) => !draft[key]?.trim()))
    throw new Error("请填写四项单价；免费项目请明确填 0。未知价格可保持未设置。");
  const result = ModelPriceSchema.safeParse({
    model,
    ...Object.fromEntries(priceFields.map(([key]) => [key, Number(draft[key])])),
  });
  if (!result.success) throw new Error("请输入有效模型名称和 0 至 1,000,000 之间的单价。");
  return result.data;
}
function PriceEditor({ entry, onSaved }: { entry: PriceEntry; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(priceFields.map(([key]) => [key, entry.price?.[key]?.toString() ?? ""])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(reset = false) {
    setBusy(true);
    setError("");
    try {
      if (reset)
        await api(`/pricing?model=${encodeURIComponent(entry.model)}`, { method: "DELETE" });
      else
        await api("/pricing", {
          method: "PUT",
          body: JSON.stringify(parsePriceDraft(entry.model, draft)),
        });
      await onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="price-editor">
      <p className="muted small-text">
        {entry.source === "custom" ? (
          "自定义单价"
        ) : entry.source === "official" ? (
          <>
            官方参考价 · {entry.checkedAt} ·{" "}
            <a href={entry.sourceUrl} target="_blank" rel="noreferrer">
              查看来源
            </a>
          </>
        ) : (
          "价格未知，请按你的计费方案填写。"
        )}
      </p>
      <div className="price-fields">
        {priceFields.map(([key, label]) => (
          <label className="field" key={key}>
            {label}
            <input
              type="number"
              min="0"
              max="1000000"
              step="any"
              placeholder="未设置"
              value={draft[key]}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
            />
          </label>
        ))}
      </div>
      {error && <Notice>{error}</Notice>}
      <div className="price-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? "正在保存…" : "保存模型单价"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || entry.source !== "custom"}
          onClick={() => void save(true)}
        >
          恢复默认
        </button>
      </div>
    </div>
  );
}
export default function PricingSettings() {
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: ["pricing"], queryFn: () => api<Catalog>("/pricing") });
  const [selected, setSelected] = useState("");
  const [custom, setCustom] = useState("");
  const [message, setMessage] = useState("");
  const model =
    selected === "__custom__"
      ? custom.trim()
      : selected ||
        catalog.data?.models.find((entry) => entry.observed)?.model ||
        catalog.data?.models[0]?.model ||
        "";
  const entry = catalog.data?.models.find((entry) => entry.model === model) ?? {
    model,
    price: null,
    source: "unknown" as const,
    observed: false,
  };
  return (
    <section className="settings-section surface pricing-settings" id="model-pricing">
      <div className="settings-section-title">
        <Coins size={20} />
        <div>
          <h2>模型费用</h2>
          <p>每百万 Token 的美元单价 · 保存后重新估算历史用量</p>
        </div>
      </div>
      {catalog.isPending ? (
        <Spinner />
      ) : catalog.isError ? (
        <Notice onRetry={() => void catalog.refetch()}>{errorText(catalog.error)}</Notice>
      ) : (
        <>
          <label className="field">
            模型
            <select
              value={selected || model}
              onChange={(event) => {
                setSelected(event.target.value);
                setMessage("");
              }}
            >
              {catalog.data.models.map((entry) => (
                <option key={entry.model} value={entry.model}>
                  {entry.model}
                  {entry.source === "unknown" ? " · 未设置" : ""}
                </option>
              ))}
              <option value="__custom__">添加其他模型…</option>
            </select>
          </label>
          {selected === "__custom__" && (
            <label className="field">
              准确模型名称
              <input
                value={custom}
                maxLength={128}
                onChange={(event) => setCustom(event.target.value)}
                placeholder="与用量记录中的模型名称一致"
              />
            </label>
          )}
          {model && (
            <PriceEditor
              key={`${model}:${JSON.stringify(entry.price)}`}
              entry={entry}
              onSaved={async () => {
                await catalog.refetch();
                await queryClient.invalidateQueries({ queryKey: ["stats"] });
                setMessage("已保存，历史估算已更新。");
              }}
            />
          )}
          {message && <p role="status">{message}</p>}
          <p className="muted small-text">{catalog.data.note}</p>
        </>
      )}
    </section>
  );
}
