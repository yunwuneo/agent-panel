import type { Device, Session } from "@agentpanel/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  ChartNoAxesCombined,
  Coins,
  Database,
  Layers3,
  SlidersHorizontal,
  Timer,
} from "lucide-react";
import { useMemo, useState } from "react";
import { api, errorText, queryString } from "./api";
import { formatNumber, projectName } from "./events";
import { AgentMark, Empty, Notice, PageHeading, Spinner } from "./ui";
import { totalTokens, uncachedInput } from "./usage";

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  costComplete?: boolean;
  unpricedSessions?: number;
  sessionCount: number;
  turnCount: number;
  activeMs: number;
}
interface StatsData {
  totals: Totals;
  groups: (Partial<Totals> & {
    deviceId?: string;
    agent?: "claude" | "codex";
    project?: string;
    day?: string;
    totals?: Totals;
  })[];
  priceVersion: string;
}

export default function Stats({ devices, sessions }: { devices: Device[]; sessions: Session[] }) {
  const [days, setDays] = useState("30");
  const [deviceId, setDeviceId] = useState("");
  const [agent, setAgent] = useState("");
  const [project, setProject] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const dateRange = useMemo(
    () => ({
      from: fromDate
        ? new Date(`${fromDate}T00:00:00`).getTime()
        : Date.now() - Number(days) * 86400000,
      to: toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : Date.now(),
    }),
    [days, fromDate, toDate],
  );
  const filters = { deviceId, agent, project, ...dateRange };
  const query = useQuery({
    queryKey: ["stats", filters],
    queryFn: () => api<StatsData>(`/stats?${queryString(filters)}`),
  });
  const totals = query.data?.totals;
  const breakdown = totals
    ? [
        {
          label: "非缓存输入",
          value: uncachedInput(totals),
          className: "input",
          icon: ArrowDownLeft,
        },
        { label: "输出", value: totals.outputTokens, className: "output", icon: ArrowUpRight },
        {
          label: "缓存读取",
          value: totals.cacheReadTokens,
          className: "cache-read",
          icon: Database,
        },
        {
          label: "缓存写入",
          value: totals.cacheWriteTokens,
          className: "cache-write",
          icon: Layers3,
        },
      ]
    : [];
  const tokenTotal = totals ? totalTokens(totals) : 0;
  const projects = [...new Set(sessions.map((session) => session.cwd))];
  return (
    <>
      <PageHeading
        eyebrow="A CLEARER VIEW OF YOUR WORK"
        title="用量与洞察"
        description="看见投入，也看见每一次专注的积累。"
        action={
          <div className="date-preset">
            <CalendarDays size={16} />
            <select
              aria-label="统计时间范围"
              value={days}
              onChange={(event) => {
                setDays(event.target.value);
                setFromDate("");
                setToDate("");
              }}
            >
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
              <option value="90">最近 90 天</option>
              <option value="365">最近一年</option>
            </select>
          </div>
        }
      />
      <div className="stats-filters surface">
        <SlidersHorizontal size={17} />
        <select
          aria-label="按设备筛选"
          value={deviceId}
          onChange={(event) => setDeviceId(event.target.value)}
        >
          <option value="">所有设备</option>
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name}
            </option>
          ))}
        </select>
        <select
          aria-label="按 Agent 筛选"
          value={agent}
          onChange={(event) => setAgent(event.target.value)}
        >
          <option value="">所有 Agent</option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <select
          aria-label="按项目筛选"
          value={project}
          onChange={(event) => setProject(event.target.value)}
        >
          <option value="">所有项目</option>
          {projects.map((path) => (
            <option key={path} value={path}>
              {projectName(path)}
            </option>
          ))}
        </select>
        <div className="date-range">
          <input
            type="date"
            aria-label="开始日期"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
          />
          <span>至</span>
          <input
            type="date"
            aria-label="结束日期"
            value={toDate}
            min={fromDate || undefined}
            onChange={(event) => setToDate(event.target.value)}
          />
        </div>
      </div>
      {query.isPending ? (
        <Spinner label="正在汇总用量" />
      ) : query.isError ? (
        <Notice onRetry={() => void query.refetch()}>{errorText(query.error)}</Notice>
      ) : (
        totals && (
          <>
            <div className="stats-metrics">
              <div className="stat-metric glass">
                <span>
                  <Activity size={16} />总 Token
                </span>
                <strong>{formatNumber(tokenTotal)}</strong>
                <small>输入、输出与缓存用量</small>
              </div>
              <div className="stat-metric glass">
                <span>
                  <Layers3 size={16} />
                  会话与轮次
                </span>
                <strong>
                  {formatNumber(totals.sessionCount)}
                  <em> / {formatNumber(totals.turnCount)}</em>
                </strong>
                <small>个会话 / 个轮次</small>
              </div>
              <div className="stat-metric glass">
                <span>
                  <Coins size={16} />
                  估算费用
                </span>
                <strong>
                  {totals.costUsd !== undefined ? (
                    <>
                      <em>$</em>
                      {totals.costUsd.toFixed(2)}
                    </>
                  ) : (
                    <em>价格未知</em>
                  )}
                </strong>
                <small>
                  {totals.costComplete === false
                    ? "USD · 仅含已知价格的部分用量"
                    : "USD · 基于可用用量和价格"}
                </small>
              </div>
              <div className="stat-metric glass">
                <span>
                  <Timer size={16} />
                  活跃时长
                </span>
                <strong>
                  {(totals.activeMs / 3600000).toFixed(1)}
                  <em> h</em>
                </strong>
                <small>已记录的 Agent 活跃时间</small>
              </div>
            </div>
            <section className="token-panel surface">
              <div className="section-heading">
                <div>
                  <h2>Token 构成</h2>
                  <span>每一份投入，都有迹可循</span>
                </div>
                <span className="muted small-text">
                  {new Date(dateRange.from).toLocaleDateString("zh-CN")} —{" "}
                  {new Date(dateRange.to).toLocaleDateString("zh-CN")}
                </span>
              </div>
              {tokenTotal === 0 ? (
                <Empty icon={ChartNoAxesCombined} title="这个时间段，还没有用量记录">
                  当设备同步历史或完成会话后，真实用量会显示在这里。
                </Empty>
              ) : (
                <>
                  <div
                    className="token-bar"
                    role="img"
                    aria-label={breakdown.map((item) => `${item.label} ${item.value}`).join("，")}
                  >
                    {breakdown
                      .filter((item) => item.value > 0)
                      .map((item) => (
                        <div
                          key={item.label}
                          className={item.className}
                          style={{ flexGrow: item.value }}
                          title={`${item.label}: ${item.value.toLocaleString()}`}
                        />
                      ))}
                  </div>
                  <div className="token-legend">
                    {breakdown.map((item) => (
                      <div key={item.label}>
                        <span className={`legend-dot ${item.className}`} />
                        <span>{item.label}</span>
                        <strong>{formatNumber(item.value)}</strong>
                        <small>{((item.value / tokenTotal) * 100).toFixed(1)}%</small>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
            <section className="stats-detail surface">
              <div className="section-heading">
                <div>
                  <h2>用量明细</h2>
                  <span>按设备、智能伙伴与项目查看</span>
                </div>
                <span className="muted small-text">{query.data.groups.length} 条汇总</span>
              </div>
              {query.data.groups.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>项目 / 设备</th>
                        <th>Agent</th>
                        <th>Token</th>
                        <th>会话</th>
                        <th>估算费用</th>
                      </tr>
                    </thead>
                    <tbody>
                      {query.data.groups.map((group) => {
                        const values = group.totals || group;
                        return (
                          <tr
                            key={`${group.deviceId}-${group.agent}-${group.project}-${group.day || ""}`}
                          >
                            <td>
                              <strong title={group.project}>
                                {group.project ? projectName(group.project) : "全部项目"}
                              </strong>
                              <small>
                                {devices.find((device) => device.id === group.deviceId)?.name ||
                                  group.day ||
                                  "所有设备"}
                              </small>
                            </td>
                            <td>
                              {group.agent ? (
                                <span className="table-agent">
                                  <AgentMark agent={group.agent} small />
                                  {group.agent === "claude" ? "Claude" : "Codex"}
                                </span>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td>{formatNumber(totalTokens(values))}</td>
                            <td>{values.sessionCount || 0}</td>
                            <td>
                              {values.costUsd !== undefined
                                ? `$${values.costUsd.toFixed(3)}${values.costComplete === false ? "（部分）" : ""}`
                                : "价格未知"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted detail-empty">暂无汇总明细</p>
              )}
            </section>
            <p className="stats-note">
              费用是估算值，不代表服务商实际账单。价格版本：{query.data.priceVersion || "尚未提供"}
              。统计仅包含设备已同步的数据。
            </p>
          </>
        )
      )}
    </>
  );
}
