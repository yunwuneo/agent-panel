import type { Approval, Device, Session } from "@agentpanel/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Bell,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  LayoutDashboard,
  Menu,
  Monitor,
  Moon,
  Plus,
  Settings2,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import Auth, { RecoveryCodes } from "./Auth";
import { api, errorText, logout, onExpired, refresh, type User } from "./api";
import { useConnection } from "./connection";
import { Devices, PairDevice } from "./Devices";
import NewSession from "./NewSession";
import { Workspace } from "./Sessions";
import Settings, { type Theme } from "./Settings";
import Stats from "./Stats";
import { Brand, Notice, Spinner } from "./ui";

const Chat = lazy(() => import("./Chat"));

type View = "workspace" | "devices" | "stats" | "settings";
const navigation = [
  { id: "workspace", label: "工作空间", icon: LayoutDashboard },
  { id: "devices", label: "设备", icon: Monitor },
  { id: "stats", label: "用量与洞察", icon: ChartNoAxesCombined },
  { id: "settings", label: "偏好设置", icon: Settings2 },
] as const;

export default function App() {
  const query = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [view, setView] = useState<View>("workspace");
  const [selectedId, setSelectedId] = useState(
    new URLSearchParams(location.search).get("session") || "",
  );
  const [selectedFallback, setSelectedFallback] = useState<Session>();
  const [pairing, setPairing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [initialDevice, setInitialDevice] = useState<string>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
  const [theme, setThemeState] = useState<Theme>(
    (localStorage.getItem("agentpanel.theme") as Theme) || "system",
  );
  const [transparency, setTransparencyState] = useState(
    localStorage.getItem("agentpanel.reduce-transparency") === "true",
  );
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api<{ devices: Device[] }>("/devices"),
    enabled: Boolean(user),
    refetchInterval: 30_000,
  });
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api<{ sessions: Session[] }>("/sessions"),
    enabled: Boolean(user),
    refetchInterval: 30_000,
  });
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api<{ approvals: Approval[] }>("/approvals?status=pending"),
    enabled: Boolean(user),
    refetchInterval: 15_000,
  });
  const deviceList = devices.data?.devices || [];
  const sessionList = sessions.data?.sessions || [];
  const approvalList = approvals.data?.approvals || [];
  const selected =
    sessionList.find((session) => session.id === selectedId) ||
    (selectedFallback?.id === selectedId ? selectedFallback : undefined);
  const connection = useConnection(
    Boolean(user),
    deviceList.map((device) => device.id),
    selectedId || undefined,
  );
  useEffect(() => {
    let active = true;
    void refresh()
      .then((auth) => {
        if (active) setUser(auth.user);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setInitializing(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    onExpired(() => {
      setUser(null);
      query.clear();
      setSelectedId("");
      setSelectedFallback(undefined);
    });
  }, [query]);
  useEffect(() => {
    const preference = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (preference.matches ? "dark" : "light") : theme;
    };
    apply();
    preference.addEventListener("change", apply);
    return () => preference.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.reduceTransparency = String(transparency);
  }, [transparency]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && user) {
        event.preventDefault();
        if (deviceList.some((device) => device.online)) {
          setCreating(true);
          setInitialDevice(undefined);
        }
      }
    };
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, [user, deviceList]);
  function setTheme(value: Theme) {
    setThemeState(value);
    localStorage.setItem("agentpanel.theme", value);
  }
  function setTransparency(value: boolean) {
    setTransparencyState(value);
    localStorage.setItem("agentpanel.reduce-transparency", String(value));
  }
  function navigate(next: View) {
    setView(next);
    setSelectedId("");
    setMenu(false);
    history.replaceState(null, "", location.pathname);
  }
  function select(session: Session) {
    setSelectedId(session.id);
    setSelectedFallback(session);
    setView("workspace");
    setMenu(false);
    const url = new URL(location.href);
    url.searchParams.set("session", session.id);
    history.replaceState(null, "", url);
  }
  function create(deviceId?: string) {
    setInitialDevice(deviceId);
    setCreating(true);
  }
  async function signOut() {
    setError("");
    try {
      await logout();
      setUser(null);
      setSelectedId("");
      setSelectedFallback(undefined);
      query.clear();
    } catch (error) {
      setError(errorText(error));
    }
  }
  if (initializing)
    return (
      <div className="app-loading">
        <Brand />
        <Spinner label="正在打开你的工作空间" />
      </div>
    );
  if (!user)
    return (
      <Auth
        onLogin={(user, codes) => {
          setUser(user);
          setRecoveryCodes(codes?.length ? codes : undefined);
          void query.invalidateQueries();
        }}
      />
    );
  return (
    <div className="app-shell">
      {menu && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar glass ${menu ? "open" : ""}`}>
        <div className="sidebar-brand">
          <Brand />
          <button
            type="button"
            className="icon-button mobile-close"
            aria-label="关闭导航"
            onClick={() => setMenu(false)}
          >
            <X size={19} />
          </button>
        </div>
        <button
          type="button"
          className="sidebar-new"
          onClick={() => create()}
          disabled={!deviceList.some((device) => device.online)}
        >
          <Plus size={17} />
          <span>新建会话</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="nav-caption">你的空间</div>
        <nav aria-label="主导航">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => navigate(id)}
            >
              <Icon size={19} strokeWidth={1.7} />
              <span>{label}</span>
              {id === "devices" && deviceList.length > 0 && <small>{deviceList.length}</small>}
              {id === "workspace" && approvalList.length > 0 && (
                <small className="nav-alert">{approvalList.length}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="sidebar-device-title">
          <span className="nav-caption">已连接的设备</span>
          <button
            type="button"
            className="icon-button"
            aria-label="添加设备"
            onClick={() => setPairing(true)}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="sidebar-device-list">
          {deviceList.slice(0, 6).map((device) => (
            <button type="button" key={device.id} onClick={() => navigate("devices")}>
              <span className={`device-led ${device.online ? "on" : ""}`} />
              <span>{device.name}</span>
            </button>
          ))}
          {deviceList.length === 0 && (
            <button type="button" className="sidebar-connect" onClick={() => setPairing(true)}>
              连接第一台设备
              <ArrowUpRight size={14} />
            </button>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Sparkles size={21} strokeWidth={1.3} />
            <strong>留点空间，给灵感。</strong>
            <p>你的智能伙伴，随时待命。</p>
          </div>
          <button type="button" className="profile" onClick={() => navigate("settings")}>
            <div className="profile-avatar">{user.email.charAt(0).toUpperCase()}</div>
            <span>
              <strong>个人工作空间</strong>
              <small>{user.email}</small>
            </span>
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              type="button"
              className="icon-button menu-toggle"
              aria-label="打开导航"
              onClick={() => setMenu(true)}
            >
              <Menu size={20} />
            </button>
            <span>个人空间</span>
            <ChevronRight size={13} />
            <strong>
              {selected ? "会话" : navigation.find((item) => item.id === view)?.label}
            </strong>
          </div>
          <div className="topbar-actions">
            <div
              className={`connection-indicator ${connection.state}`}
              title={connection.issue || "通过安全连接同步设备与会话"}
            >
              <span />
              {connection.state === "connected"
                ? "已同步"
                : connection.state === "offline"
                  ? "离线"
                  : "正在连接"}
            </div>
            <span className="topbar-separator" />
            <button
              type="button"
              className="icon-button"
              aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
              onClick={() =>
                setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
              }
            >
              {document.documentElement.dataset.theme === "dark" ? (
                <Sun size={18} />
              ) : (
                <Moon size={18} />
              )}
            </button>
            <button
              type="button"
              className="icon-button notification-button"
              aria-label={`通知，${approvalList.length} 项待审批`}
              onClick={() => {
                const session = sessionList.find((item) => item.id === approvalList[0]?.sessionId);
                if (session) select(session);
                else navigate("settings");
              }}
            >
              <Bell size={18} />
              {approvalList.length > 0 && <span />}
            </button>
            <button
              type="button"
              className="topbar-avatar"
              onClick={() => navigate("settings")}
              aria-label="账号设置"
            >
              {user.email.charAt(0).toUpperCase()}
            </button>
          </div>
        </header>
        {selected && view === "workspace" ? (
          <Suspense fallback={<Spinner label="正在打开会话" />}>
            <Chat
              key={selected.id}
              session={selected}
              device={deviceList.find((device) => device.id === selected.deviceId)}
              approvals={approvalList.filter((approval) => approval.sessionId === selected.id)}
              connection={connection.state}
              onBack={() => navigate("workspace")}
              onSession={select}
              onNotify={setToast}
            />
          </Suspense>
        ) : (
          <main className="page-content" id="main-content">
            {error && <Notice>{error}</Notice>}
            {(devices.isError || sessions.isError || approvals.isError) && (
              <Notice onRetry={() => void query.invalidateQueries()}>
                {errorText(devices.error || sessions.error || approvals.error)}
              </Notice>
            )}
            {devices.isPending || sessions.isPending ? (
              <Spinner label="正在同步工作空间" />
            ) : view === "workspace" ? (
              <Workspace
                sessions={sessionList}
                devices={deviceList}
                approvals={approvalList}
                onSelect={select}
                onNew={() => create()}
                onPair={() => setPairing(true)}
              />
            ) : view === "devices" ? (
              <Devices
                devices={deviceList}
                onPair={() => setPairing(true)}
                onNew={create}
                onNotify={setToast}
              />
            ) : view === "stats" ? (
              <Stats
                devices={deviceList}
                sessions={sessionList}
                onPricing={() => {
                  setView("settings");
                  requestAnimationFrame(() =>
                    document.getElementById("model-pricing")?.scrollIntoView({ block: "start" }),
                  );
                }}
              />
            ) : (
              <Settings
                user={user}
                theme={theme}
                setTheme={setTheme}
                transparency={transparency}
                setTransparency={setTransparency}
                devices={deviceList}
                sessions={sessionList}
                onLogout={() => void signOut()}
                onNotify={setToast}
              />
            )}
          </main>
        )}
      </div>
      {pairing && <PairDevice onClose={() => setPairing(false)} />}{" "}
      {creating && (
        <NewSession
          devices={deviceList}
          sessions={sessionList}
          initialDevice={initialDevice}
          onClose={() => setCreating(false)}
          onCreated={(session) => {
            setCreating(false);
            select(session);
          }}
        />
      )}{" "}
      {recoveryCodes && (
        <RecoveryCodes codes={recoveryCodes} onDone={() => setRecoveryCodes(undefined)} />
      )}{" "}
      {toast && (
        <div className="toast glass" role="status">
          <Check size={17} />
          {toast}
          <button
            type="button"
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
