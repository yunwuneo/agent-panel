import type { Approval, Device, Session } from "@agentpanel/protocol";
import {
  ArrowRight,
  ChevronRight,
  Folder,
  LockKeyhole,
  MessageSquare,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import { projectName, timeAgo } from "./events";
import { AgentMark, DeviceIcon, Empty, PageHeading, Status } from "./ui";

export function Workspace({
  sessions,
  devices,
  approvals,
  onSelect,
  onNew,
  onPair,
}: {
  sessions: Session[];
  devices: Device[];
  approvals: Approval[];
  onSelect: (session: Session) => void;
  onNew: () => void;
  onPair: () => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [groupBy, setGroupBy] = useState<"project" | "device">("project");
  const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const filtered = recent.filter(
    (session) =>
      `${session.title} ${session.cwd} ${devices.find((device) => device.id === session.deviceId)?.name || ""}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()) &&
      (filter === "all" ||
        (filter === "active"
          ? ["running", "waiting"].includes(session.status)
          : session.agent === filter)),
  );
  const groups = new Map<string, Session[]>();
  for (const session of filtered) {
    const key = groupBy === "project" ? session.cwd : session.deviceId;
    groups.set(key, [...(groups.get(key) || []), session]);
  }
  const active = sessions.filter((session) => ["running", "waiting"].includes(session.status));
  return (
    <>
      <PageHeading
        eyebrow="MAKE ROOM FOR YOUR NEXT IDEA"
        title="你的工作空间"
        description="保持专注，让智能伙伴接续每一个想法。"
        action={
          <button
            type="button"
            className="primary"
            onClick={onNew}
            disabled={!devices.some((device) => device.online)}
          >
            <Plus size={18} />
            新建会话
          </button>
        }
      />
      <div className="overview-strip glass">
        <div>
          <span className="overview-icon violet">
            <DeviceIcon platform="macOS" size={21} />
          </span>
          <span>
            <small>已连接设备</small>
            <strong>
              {devices.filter((device) => device.online).length}
              <span> / {devices.length}</span>
            </strong>
          </span>
          <span className="metric-note">在线，随时开始</span>
        </div>
        <div>
          <span className="overview-icon mint">
            <Sparkles size={20} />
          </span>
          <span>
            <small>正在进行</small>
            <strong>
              {active.length}
              <span> 个会话</span>
            </strong>
          </span>
          <span className="metric-note">灵感正在发生</span>
        </div>
        <div>
          <span className="overview-icon amber">
            <ShieldCheck size={21} />
          </span>
          <span>
            <small>等待你的决定</small>
            <strong>
              {approvals.length}
              <span> 项审批</span>
            </strong>
          </span>
          <span className="metric-note">每一步，都由你掌握</span>
        </div>
      </div>
      {approvals.length > 0 && (
        <div className="attention-banner">
          <div className="attention-spark">
            <ShieldCheck size={21} />
          </div>
          <div>
            <strong>有 {approvals.length} 项操作，等待你的决定</strong>
            <p>
              {approvals[0].toolName} ·{" "}
              {sessions.find((session) => session.id === approvals[0].sessionId)?.title ||
                "Agent 正在等待权限"}
            </p>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const session = sessions.find((session) => session.id === approvals[0].sessionId);
              if (session) onSelect(session);
            }}
          >
            查看审批
            <ArrowRight size={15} />
          </button>
        </div>
      )}
      <div className="section-heading">
        <div>
          <h2>会话</h2>
          <span>{sessions.length} 个想法，在这里继续</span>
        </div>
        <div className="segmented small">
          <button
            type="button"
            className={groupBy === "project" ? "active" : ""}
            onClick={() => setGroupBy("project")}
          >
            按项目
          </button>
          <button
            type="button"
            className={groupBy === "device" ? "active" : ""}
            onClick={() => setGroupBy("device")}
          >
            按设备
          </button>
        </div>
      </div>
      <div className="session-toolbar">
        <div className="filter-tabs">
          {[
            ["all", "全部"],
            ["active", "进行中"],
            ["claude", "Claude"],
            ["codex", "Codex"],
          ].map(([key, label]) => (
            <button
              type="button"
              key={key}
              className={filter === key ? "active" : ""}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="搜索会话"
            placeholder="搜索会话或项目…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search && (
            <button
              type="button"
              className="icon-button"
              aria-label="清空搜索"
              onClick={() => setSearch("")}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {devices.length === 0 ? (
        <div className="surface">
          <Empty
            icon={Sparkles}
            title="你的下一个好想法，从连接开始"
            action={
              <button type="button" className="primary" onClick={onPair}>
                <Plus size={17} />
                连接第一台设备
              </button>
            }
          >
            把常用设备加入工作空间，即可查看历史、创建会话，与智能伙伴一起完成工作。
          </Empty>
        </div>
      ) : filtered.length === 0 ? (
        <div className="surface">
          <Empty
            icon={MessageSquare}
            title={search || filter !== "all" ? "暂时没有匹配的会话" : "留一点空间，给下一个好想法"}
          >
            {search || filter !== "all"
              ? "试试其他关键词，或切换筛选条件。"
              : "新建一个会话，或者等待设备同步本地历史。所有进展都会在这里汇合。"}
          </Empty>
        </div>
      ) : (
        <div className="session-groups">
          {[...groups.entries()].map(([key, group]) => (
            <section className="session-group" key={key}>
              <div className="group-heading">
                <Folder size={15} />
                <strong>
                  {groupBy === "project"
                    ? projectName(key)
                    : devices.find((device) => device.id === key)?.name || "未知设备"}
                </strong>
                <span>{group.length}</span>
                {groupBy === "project" && <small title={key}>{key}</small>}
              </div>
              <div className="session-rows">
                {group.map((session) => (
                  <button
                    type="button"
                    className="session-row"
                    key={session.id}
                    onClick={() => onSelect(session)}
                  >
                    <AgentMark agent={session.agent} />
                    <div className="session-row-main">
                      <strong>
                        {session.title || "未命名会话"}
                        {session.readOnly && <LockKeyhole size={12} />}
                      </strong>
                      <span>
                        {devices.find((device) => device.id === session.deviceId)?.name || "设备"}
                        <span className="bullet">·</span>
                        {session.source === "local" ? "本地会话" : "AgentPanel"}
                        {groupBy === "device" && (
                          <>
                            <span className="bullet">·</span>
                            {projectName(session.cwd)}
                          </>
                        )}
                      </span>
                    </div>
                    <Status status={session.status} />
                    <time>{timeAgo(session.updatedAt)}</time>
                    <ChevronRight className="row-chevron" size={16} />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <div className="workspace-footnote">
        <span className="tiny-dot" />
        让进展自然发生，一次专注一个想法。
      </div>
    </>
  );
}
