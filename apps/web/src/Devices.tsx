import type { Device } from "@agentpanel/protocol";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  Copy,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { api, errorText, post } from "./api";
import { command } from "./connection";
import { timeAgo } from "./events";
import { AgentQuotaCard } from "./Quota";
import { DeviceIcon, Empty, Modal, Notice, PageHeading, Spinner } from "./ui";

export function Devices({
  devices,
  onPair,
  onNew,
  onNotify,
}: {
  devices: Device[];
  onPair: () => void;
  onNew: (deviceId: string) => void;
  onNotify: (message: string) => void;
}) {
  const query = useQueryClient();
  const [editing, setEditing] = useState<Device>();
  const [name, setName] = useState("");
  const [revoking, setRevoking] = useState<Device>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState<string>();
  async function update(action: "rename" | "revoke") {
    const device = action === "rename" ? editing : revoking;
    if (!device) return;
    setBusy(true);
    setError("");
    try {
      await api(`/devices/${encodeURIComponent(device.id)}`, {
        method: action === "rename" ? "PATCH" : "DELETE",
        ...(action === "rename" ? { body: JSON.stringify({ name: name.trim() }) } : {}),
      });
      setEditing(undefined);
      setRevoking(undefined);
      await query.invalidateQueries({ queryKey: ["devices"] });
      onNotify(action === "rename" ? "设备名称已更新" : "设备已解绑，其访问凭据已吊销");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="YOUR CONNECTED WORLD"
        title="设备"
        description="每台设备上的智能伙伴，都在这里。"
        action={
          <button type="button" className="primary" onClick={onPair}>
            <Plus size={18} />
            连接设备
          </button>
        }
      />
      <div className="section-meta">
        <span>
          {devices.length} 台设备 · {devices.filter((device) => device.online).length} 台在线
        </span>
        <span>
          <ShieldCheck size={14} />
          专属配对，随时解绑
        </span>
      </div>
      {devices.length === 0 ? (
        <div className="surface">
          <Empty
            icon={Link2}
            title="连接你的第一台设备"
            action={
              <button type="button" className="primary" onClick={onPair}>
                <Plus size={16} />
                开始配对
              </button>
            }
          >
            在设备上运行 AgentPanel Daemon，然后输入配对码。你的 Claude Code 和 Codex 会在这里出现。
          </Empty>
        </div>
      ) : (
        <div className="device-grid">
          {devices.map((device) => (
            <article className="device-card glass" key={device.id}>
              <div className="device-top">
                <div className="device-illustration">
                  <DeviceIcon platform={device.platform} size={40} />
                </div>
                <span className={`online-badge ${device.online ? "online" : ""}`}>
                  <span />
                  {device.online ? "在线" : "离线"}
                </span>
              </div>
              <h2>{device.name}</h2>
              <p className="device-platform">
                {platformName(device.platform)}
                <span>·</span>
                {device.online ? "随时准备接续工作" : `上次连接 ${timeAgo(device.lastSeen)}`}
              </p>
              <div className="device-agents">
                {device.agents.map((agent) => (
                  <AgentQuotaCard key={agent.kind} agent={agent} online={device.online} />
                ))}
                {!device.agents.some((agent) => agent.installed) && (
                  <p className="muted">尚未检测到可用的 Agent</p>
                )}
              </div>
              <div className="device-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={!device.online}
                  onClick={() => onNew(device.id)}
                >
                  新建会话
                  <ArrowRight size={15} />
                </button>
                <div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`刷新 ${device.name} 的订阅额度`}
                    disabled={!device.online || refreshing === device.id}
                    onClick={async () => {
                      setRefreshing(device.id);
                      try {
                        await command("device.refresh", {}, { deviceId: device.id });
                        onNotify("已请求刷新额度；频繁刷新或服务限流时会稍后更新");
                      } catch (error) {
                        onNotify(errorText(error));
                      } finally {
                        setRefreshing(undefined);
                      }
                    }}
                  >
                    <RefreshCw size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`重命名 ${device.name}`}
                    onClick={() => {
                      setEditing(device);
                      setName(device.name);
                      setError("");
                    }}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-button danger-hover"
                    aria-label={`解绑 ${device.name}`}
                    onClick={() => {
                      setRevoking(device);
                      setError("");
                    }}
                  >
                    <Unplug size={16} />
                  </button>
                </div>
              </div>
            </article>
          ))}
          <button type="button" className="add-device-card" onClick={onPair}>
            <div>
              <Plus size={25} />
            </div>
            <strong>再连接一台设备</strong>
            <span>让工作空间，延伸得更远</span>
          </button>
        </div>
      )}
      {editing && (
        <Modal
          title="给设备一个熟悉的名字"
          onClose={busy ? undefined : () => setEditing(undefined)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void update("rename");
            }}
          >
            <label className="field">
              设备名称
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={128}
                required
              />
            </label>
            {error && <Notice>{error}</Notice>}
            <button type="submit" className="primary full" disabled={busy || !name.trim()}>
              保存名称
            </button>
          </form>
        </Modal>
      )}
      {revoking && (
        <Modal
          title={`解绑 ${revoking.name}？`}
          onClose={busy ? undefined : () => setRevoking(undefined)}
        >
          <p className="muted">
            解绑会立即吊销该设备的连接凭据，停止通过 AgentPanel
            操作它。设备需要重新配对才能再次连接。
          </p>
          {error && <Notice>{error}</Notice>}
          <div className="modal-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setRevoking(undefined)}
            >
              保留设备
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void update("revoke")}
            >
              确认解绑
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function platformName(value: string) {
  return /darwin|mac/i.test(value)
    ? "macOS"
    : /win/i.test(value)
      ? "Windows"
      : /linux/i.test(value)
        ? "Linux"
        : value;
}

export function PairDevice({ onClose }: { onClose: () => void }) {
  const [pair, setPair] = useState<{ code: string; expiresAt: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function generate() {
    setBusy(true);
    setError("");
    try {
      setPair(await post("/pairing"));
      setCopied(false);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const remaining = pair ? Math.max(0, Math.ceil((pair.expiresAt - now) / 1000)) : 0;
  return (
    <Modal title="把设备带进工作空间" eyebrow="CONNECT A DEVICE" onClose={onClose}>
      <p className="muted">在目标设备上使用一次性配对码绑定当前账号，再启动 Daemon。</p>
      {error && <Notice>{error}</Notice>}
      {pair && remaining > 0 ? (
        <>
          <div className="pair-qr">
            <QRCodeSVG
              value={JSON.stringify({ relayUrl: location.origin, code: pair.code })}
              size={150}
              level="M"
              marginSize={1}
            />
          </div>
          <div className="pair-code">
            <code>{pair.code}</code>
            <button
              type="button"
              className="icon-button"
              aria-label="复制配对码"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(pair.code);
                  setCopied(true);
                } catch {
                  setError("无法自动复制，请手动选择配对码。");
                }
              }}
            >
              {copied ? <Check size={19} /> : <Copy size={19} />}
            </button>
          </div>
          <p className="pair-expiry">
            {Math.floor(remaining / 60)} 分 {String(remaining % 60).padStart(2, "0")} 秒后失效 ·
            仅可使用一次
          </p>
          <div className="command-example">
            <span>在目标设备上依次运行</span>
            <code>
              agentpaneld pair --relay {location.origin} --code {pair.code}
              <br />
              agentpaneld run
            </code>
          </div>
          <Notice tone="info">
            配对只保存凭据。运行 agentpaneld run 并保持终端开启，看到“设备已连接
            Relay”后设备才会上线。
          </Notice>
        </>
      ) : (
        <div className="pair-start">
          <div className="empty-icon">
            <Link2 size={28} />
          </div>
          {pair && <p className="muted">配对码已过期，可以重新生成。</p>}
          <button type="button" className="primary" onClick={() => void generate()} disabled={busy}>
            {busy ? (
              <Spinner label="正在生成" />
            ) : (
              <>
                <Plus size={16} />
                生成配对码
              </>
            )}
          </button>
        </div>
      )}
    </Modal>
  );
}
