import type { AgentCapability, AgentQuota } from "@agentpanel/protocol";
import { useEffect, useState } from "react";
import { AgentMark } from "./ui";

export function quotaIsStale(quota: AgentQuota, online: boolean, now: number) {
  return (
    !online || quota.status === "stale" || (quota.staleAt !== undefined && now >= quota.staleAt)
  );
}
const date = (value: number) => new Date(value).toLocaleString();
const percent = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);

export function AgentQuotaCard({ agent, online }: { agent: AgentCapability; online: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const quota = agent.quota;
  const stale = quota && quotaIsStale(quota, online, now);
  const execution = agent.executionAvailable ?? agent.authenticated;
  return (
    <section className="agent-quota">
      <div className="agent-quota-heading">
        <AgentMark agent={agent.kind} small />
        <strong>{agent.kind === "claude" ? "Claude Code" : "Codex"}</strong>
        <small>
          {!agent.installed
            ? "未安装"
            : execution === true
              ? "可运行任务"
              : execution === false
                ? "运行受限"
                : "运行状态未知"}
        </small>
      </div>
      {agent.version && <p className="quota-meta">{agent.version}</p>}
      {agent.authMessage && <p className="agent-execution-reason">{agent.authMessage}</p>}
      <div className={`quota-windows ${stale ? "quota-stale" : ""}`}>
        {quota?.windows.map((window) => (
          <div className="quota-window" key={window.id}>
            <div>
              <span>{window.label}</span>
              <strong>
                {stale ? "上次剩余" : "剩余"} {percent(100 - window.usedPercent)}%
              </strong>
            </div>
            <meter
              min={0}
              max={100}
              value={100 - window.usedPercent}
              aria-label={`${window.label}${stale ? "上次" : ""}剩余百分比`}
            />
            {window.resetsAt !== undefined && (
              <p>
                {date(window.resetsAt)} 重置{now >= window.resetsAt ? "（待刷新）" : ""}
              </p>
            )}
          </div>
        ))}
        {!quota?.windows.length && (
          <p className="quota-message" role="status">
            {quota?.message ?? "额度信息尚未上报，请确认 Daemon 与 Relay 均已更新并重启"}
          </p>
        )}
        {stale && !!quota.windows.length && (
          <p className="quota-message">
            {online ? "额度数据已过期，等待刷新" : "设备离线，显示上次查询结果"}
          </p>
        )}
        {quota?.source && (
          <p className="quota-meta">
            {quota.source}
            {quota.updatedAt !== undefined && ` · ${date(quota.updatedAt)} 更新`}
          </p>
        )}
        {quota?.retryAt !== undefined && quota.retryAt > now && (
          <p className="quota-meta">{date(quota.retryAt)} 后可重试</p>
        )}
      </div>
    </section>
  );
}
