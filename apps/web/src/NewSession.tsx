import type {
  AgentKind,
  Device,
  DirectoryListing,
  PermissionMode,
  Session,
} from "@agentpanel/protocol";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Folder,
  FolderOpen,
  History,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { errorText } from "./api";
import { command } from "./connection";
import { AgentMark, Modal, Notice, Spinner } from "./ui";

export default function NewSession({
  devices,
  sessions,
  initialDevice,
  onClose,
  onCreated,
}: {
  devices: Device[];
  sessions: Session[];
  initialDevice?: string;
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const query = useQueryClient();
  const [deviceId, setDeviceId] = useState(
    initialDevice || devices.find((device) => device.online)?.id || "",
  );
  const [cwd, setCwd] = useState("");
  const [agent, setAgent] = useState<AgentKind>(
    () =>
      devices
        .find((device) => device.id === deviceId)
        ?.agents.find(
          (candidate) =>
            candidate.installed &&
            (candidate.executionAvailable ?? candidate.authenticated) !== false,
        )?.kind || "claude",
  );
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [prompt, setPrompt] = useState("");
  const [listing, setListing] = useState<DirectoryListing & { hasMore?: boolean }>();
  const [browsing, setBrowsing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const device = devices.find((item) => item.id === deviceId);
  const capability = device?.agents.find((item) => item.kind === agent);
  const recent = [
    ...new Set(
      sessions.filter((session) => session.deviceId === deviceId).map((session) => session.cwd),
    ),
  ].slice(0, 5);
  async function browse(path: string) {
    setLoading(true);
    setError("");
    setBrowsing(true);
    try {
      setListing(await command<DirectoryListing>("fs.listDir", { path }, { deviceId }));
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await command<{ session: Session }>(
        "session.create",
        {
          agent,
          cwd,
          prompt: prompt.trim(),
          ...(model.trim() ? { model: model.trim() } : {}),
          permissionMode,
        },
        { deviceId },
      );
      await query.invalidateQueries({ queryKey: ["sessions"] });
      if (result?.session) onCreated(result.session);
      else throw new Error("设备未返回会话。请先检查会话列表，避免重复创建。");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  function changeDevice(id: string) {
    setDeviceId(id);
    setCwd("");
    setListing(undefined);
    setBrowsing(false);
    setModel("");
    const first = devices
      .find((device) => device.id === id)
      ?.agents.find(
        (item) => item.installed && (item.executionAvailable ?? item.authenticated) !== false,
      );
    if (first) setAgent(first.kind);
  }
  return (
    <Modal
      title={browsing ? "选择工作目录" : "下一件想完成的事"}
      eyebrow={browsing ? "CHOOSE YOUR WORKSPACE" : "A NEW CONVERSATION"}
      onClose={busy ? undefined : onClose}
      wide
    >
      {browsing ? (
        <>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setBrowsing(false);
              setError("");
            }}
          >
            <ArrowLeft size={15} />
            返回新建会话
          </button>
          <div className="directory-location">
            <FolderOpen size={19} />
            <span>{listing ? listing.path || "选择一个根目录" : "正在打开目录"}</span>
          </div>
          {error && <Notice>{error}</Notice>}
          {loading ? (
            <Spinner label="正在读取设备目录" />
          ) : (
            <div className="directory-list">
              {listing?.parent && (
                <button type="button" onClick={() => void browse(listing.parent!)}>
                  <ArrowLeft size={17} />
                  <span>上一级目录</span>
                </button>
              )}
              {listing?.entries.map((entry) => (
                <button type="button" key={entry.path} onClick={() => void browse(entry.path)}>
                  <Folder size={18} />
                  <span>{entry.name}</span>
                  <ChevronRight size={16} />
                </button>
              ))}
              {listing && listing.entries.length === 0 && (
                <p className="muted">这个目录中没有子目录，可以直接选用。</p>
              )}
              {listing?.hasMore && (
                <p className="muted">当前目录内容较多，输入完整路径可直接定位。</p>
              )}
            </div>
          )}
          <button
            type="button"
            className="primary full"
            disabled={loading || !listing?.path}
            onClick={() => {
              if (listing) {
                setCwd(listing.path);
                setBrowsing(false);
              }
            }}
          >
            <Check size={17} />
            选择此目录
          </button>
        </>
      ) : (
        <form onSubmit={create}>
          <div className="form-row">
            <label className="field">
              设备
              <select
                value={deviceId}
                onChange={(event) => changeDevice(event.target.value)}
                required
              >
                <option value="" disabled>
                  选择在线设备
                </option>
                {devices.map((device) => (
                  <option key={device.id} value={device.id} disabled={!device.online}>
                    {device.name}
                    {device.online ? "" : " · 离线"}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              工作目录
              <div className="input-button">
                <input
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  placeholder="输入路径，或点击浏览"
                  required
                />
                <button
                  type="button"
                  title="浏览目录"
                  aria-label="浏览工作目录"
                  disabled={!device?.online}
                  onClick={() => void browse(cwd)}
                >
                  <FolderOpen size={19} />
                </button>
              </div>
            </label>
          </div>
          {recent.length > 0 && (
            <div className="recent-dirs">
              <History size={13} />
              {recent.map((path) => (
                <button type="button" key={path} onClick={() => setCwd(path)} title={path}>
                  {path.split(/[\\/]/).filter(Boolean).pop()}
                </button>
              ))}
            </div>
          )}
          <span className="field-label">选择你的智能伙伴</span>
          <div className="agent-options">
            {(["claude", "codex"] as const).map((kind) => {
              const cap = device?.agents.find((item) => item.kind === kind);
              return (
                <button
                  type="button"
                  className={agent === kind ? "selected" : ""}
                  key={kind}
                  disabled={
                    !cap?.installed || (cap.executionAvailable ?? cap.authenticated) === false
                  }
                  onClick={() => {
                    setAgent(kind);
                    setModel("");
                  }}
                >
                  <AgentMark agent={kind} />
                  <span>
                    <strong>{kind === "claude" ? "Claude Code" : "Codex"}</strong>
                    <small>
                      {!cap?.installed
                        ? "尚未安装"
                        : (cap.executionAvailable ?? cap.authenticated) === false
                          ? cap.authMessage || "当前设备暂不可运行任务"
                          : kind === "claude"
                            ? "从想法到细节，协作创造"
                            : "理解代码，专注完成"}
                    </small>
                  </span>
                  {agent === kind && <Check size={16} />}
                </button>
              );
            })}
          </div>
          <div className="form-row">
            <label className="field">
              模型
              <input
                list="agent-models"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="使用设备默认模型"
              />
              <datalist id="agent-models">
                {capability?.models?.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </label>
            <label className="field">
              权限模式
              <select
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
              >
                <option value="default">默认 · 按需审批</option>
                <option value="acceptEdits">允许文件编辑</option>
                <option value="plan">仅计划 · 不执行修改</option>
              </select>
            </label>
          </div>
          <label className="field">
            想完成什么？
            <textarea
              className="new-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="描述目标、补充背景，或从一个小想法开始…"
              rows={4}
              maxLength={100000}
              required
            />
          </label>
          {error && <Notice>{error}</Notice>}
          <div className="create-footer">
            <span>
              <ShieldCheck size={14} />
              需要授权时，会先征求你的决定
            </span>
            <button
              type="submit"
              className="primary"
              disabled={
                busy ||
                !device?.online ||
                !capability?.installed ||
                (capability.executionAvailable ?? capability.authenticated) === false ||
                !cwd.trim() ||
                !prompt.trim()
              }
            >
              {busy ? (
                <Spinner label="正在创建" />
              ) : (
                <>
                  开始会话
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
