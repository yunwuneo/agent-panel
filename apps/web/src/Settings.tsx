import type { Device, Session } from "@agentpanel/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Check,
  Fingerprint,
  Laptop,
  LogOut,
  Moon,
  Palette,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorText, post, type User } from "./api";
import PricingSettings from "./PricingSettings";
import { Notice, PageHeading, Spinner, Toggle } from "./ui";

interface PushSettings {
  id?: string;
  deviceId?: string;
  sessionId?: string;
  enabled: boolean;
  approval: boolean;
  completed: boolean;
  error: boolean;
  waiting: boolean;
  preview: boolean;
}
const defaults: PushSettings = {
  enabled: true,
  approval: true,
  completed: true,
  error: true,
  waiting: true,
  preview: false,
};
export type Theme = "system" | "light" | "dark";

export default function Settings({
  user,
  theme,
  setTheme,
  transparency,
  setTransparency,
  devices,
  sessions,
  onLogout,
  onNotify,
}: {
  user: User;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  transparency: boolean;
  setTransparency: (value: boolean) => void;
  devices: Device[];
  sessions: Session[];
  onLogout: () => void;
  onNotify: (message: string) => void;
}) {
  const query = useQueryClient();
  const config = useQuery({
    queryKey: ["push-config"],
    queryFn: () =>
      api<{ webPush: { enabled: boolean; publicKey: string | null }; apns: { enabled: boolean } }>(
        "/push/config",
      ),
  });
  const settings = useQuery({
    queryKey: ["push-settings"],
    queryFn: () => api<{ settings: PushSettings[] }>("/push/settings"),
  });
  const [scope, setScope] = useState("global");
  const [draft, setDraft] = useState<PushSettings>(defaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [permission, setPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );
  const [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    const row = settings.data?.settings.find((item) =>
      scope === "global"
        ? !item.deviceId && !item.sessionId
        : scope.startsWith("device:")
          ? item.deviceId === scope.slice(7) && !item.sessionId
          : item.sessionId === scope.slice(8),
    );
    setDraft({ ...defaults, ...row });
  }, [scope, settings.data]);
  useEffect(() => {
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker
        .getRegistration("/")
        .then((registration) => registration?.pushManager?.getSubscription())
        .then((subscription) => setSubscribed(Boolean(subscription)))
        .catch(() => undefined);
  }, []);
  async function subscribe() {
    setBusy(true);
    setError("");
    try {
      if (
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      )
        throw new Error("当前浏览器不支持 Web Push。iPhone / iPad 请先将工作空间添加到主屏幕。");
      const permission = await Notification.requestPermission();
      setPermission(permission);
      if (permission !== "granted")
        throw new Error("通知权限尚未开启。可在浏览器的网站设置中允许通知。");
      if (!config.data?.webPush.publicKey) throw new Error("Relay 尚未配置 Web Push。");
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const key = config.data.webPush.publicKey.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(
        atob(key.padEnd(Math.ceil(key.length / 4) * 4, "=")),
        (character) => character.charCodeAt(0),
      );
      const subscription =
        (await registration.pushManager.getSubscription()) ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes,
        }));
      const result = await post<{ id: string }>("/push/web", subscription.toJSON());
      localStorage.setItem("agentpanel.pushId", result.id);
      setSubscribed(true);
      onNotify("此浏览器已开启通知");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function unsubscribe() {
    setBusy(true);
    setError("");
    try {
      const id = localStorage.getItem("agentpanel.pushId");
      if (id) await api(`/push/${encodeURIComponent(id)}`, { method: "DELETE" });
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      localStorage.removeItem("agentpanel.pushId");
      setSubscribed(false);
      onNotify("此浏览器已关闭通知");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    const { id, deviceId, sessionId, ...values } = draft;
    try {
      await api("/push/settings", {
        method: "PUT",
        body: JSON.stringify({
          ...values,
          ...(scope.startsWith("device:")
            ? { deviceId: scope.slice(7) }
            : scope.startsWith("session:")
              ? { sessionId: scope.slice(8) }
              : {}),
        }),
      });
      await query.invalidateQueries({ queryKey: ["push-settings"] });
      onNotify("通知偏好已保存");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="MAKE YOURSELF AT HOME"
        title="偏好设置"
        description="让工作空间，保持你喜欢的样子。"
      />
      <div className="settings-layout">
        <section className="settings-section surface">
          <div className="settings-section-title">
            <Palette size={20} />
            <div>
              <h2>外观</h2>
              <p>像光一样轻盈，也照顾每一次专注。</p>
            </div>
          </div>
          <span className="field-label">主题</span>
          <div className="theme-options">
            {(
              [
                { id: "light", label: "浅色", icon: Sun },
                { id: "dark", label: "深色", icon: Moon },
                { id: "system", label: "跟随系统", icon: Laptop },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                className={theme === id ? "selected" : ""}
                onClick={() => setTheme(id)}
              >
                <div className={`theme-preview ${id}`}>
                  <div />
                  <span />
                  <span />
                </div>
                <span>
                  <Icon size={14} />
                  {label}
                  {theme === id && <Check size={14} />}
                </span>
              </button>
            ))}
          </div>
          <Toggle
            label="减少透明度"
            description="使用更实的背景，提高文字对比度；同时尊重系统减少动态效果设置。"
            checked={transparency}
            onChange={setTransparency}
          />
        </section>
        <section className="settings-section surface">
          <div className="settings-section-title">
            <Fingerprint size={20} />
            <div>
              <h2>你的账号</h2>
              <p>通行密钥，让安全变得简单。</p>
            </div>
          </div>
          <div className="account-row">
            <div className="profile-avatar">{user.email.charAt(0).toUpperCase()}</div>
            <div>
              <strong>{user.email}</strong>
              <small>
                <ShieldCheck size={12} />
                通过通行密钥保护
              </small>
            </div>
          </div>
          <p className="muted small-text">
            恢复码可在无法使用通行密钥时重设登录凭据。请在安全的位置离线保存。
          </p>
          <button type="button" className="secondary" onClick={onLogout}>
            <LogOut size={16} />
            退出登录
          </button>
        </section>
        <PricingSettings />
        <section className="settings-section surface notifications">
          <div className="settings-section-title">
            <Bell size={20} />
            <div>
              <h2>通知</h2>
              <p>需要你时，恰好出现。</p>
            </div>
          </div>
          {config.isPending ? (
            <Spinner />
          ) : config.isError ? (
            <Notice onRetry={() => void config.refetch()}>{errorText(config.error)}</Notice>
          ) : (
            <div className="notification-status">
              <div>
                <strong>{subscribed ? "此浏览器已开启通知" : "开启浏览器通知"}</strong>
                <p>
                  {!config.data.webPush.enabled
                    ? "Relay 尚未配置 Web Push，配置后即可启用。"
                    : permission === "denied"
                      ? "浏览器已阻止通知，可在网站设置中修改。"
                      : "及时获知权限审批、任务完成与重要进展。"}
                </p>
              </div>
              <button
                type="button"
                className="secondary"
                disabled={busy || !config.data.webPush.enabled}
                onClick={() => void (subscribed ? unsubscribe() : subscribe())}
              >
                {subscribed ? "关闭通知" : "开启通知"}
              </button>
            </div>
          )}
          {settings.isError && (
            <Notice onRetry={() => void settings.refetch()}>{errorText(settings.error)}</Notice>
          )}
          <label className="field notification-scope">
            应用范围
            <select value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="global">全局默认</option>
              <optgroup label="设备">
                {devices.map((device) => (
                  <option key={device.id} value={`device:${device.id}`}>
                    {device.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="会话">
                {sessions.slice(0, 100).map((session) => (
                  <option key={session.id} value={`session:${session.id}`}>
                    {session.title || session.id}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <Toggle
            label="启用此范围的通知"
            checked={draft.enabled}
            onChange={(enabled) => setDraft({ ...draft, enabled })}
          />
          {(
            [
              {
                key: "approval",
                label: "权限审批",
                description: "Agent 需要你允许或拒绝一项操作时",
              },
              { key: "completed", label: "任务完成", description: "一轮工作完成时" },
              { key: "error", label: "出现错误", description: "需要留意的问题发生时" },
              { key: "waiting", label: "等待输入", description: "需要你接续会话时" },
              {
                key: "preview",
                label: "显示通知正文",
                description: "默认隐藏内容，保护锁屏与共享屏幕上的隐私",
              },
            ] as const
          ).map(({ key, label, description }) => (
            <Toggle
              key={key}
              label={label}
              description={description}
              checked={draft[key]}
              disabled={!draft.enabled}
              onChange={(value) => setDraft({ ...draft, [key]: value })}
            />
          ))}
          {error && <Notice>{error}</Notice>}
          <button
            type="button"
            className="primary"
            disabled={busy || settings.isPending || settings.isError}
            onClick={() => void save()}
          >
            {busy ? "正在保存…" : "保存通知偏好"}
          </button>
        </section>
      </div>
      <div className="settings-footer">
        <strong>AgentPanel</strong>
        <span>你的设备。你的智能伙伴。你的工作方式。</span>
        <small>会话事件默认保存 30 天 · 审批审计 180 天 · 用量汇总长期保存</small>
      </div>
    </>
  );
}
