import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Fingerprint,
  KeyRound,
  Laptop,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { api, authenticate, errorText, type User } from "./api";
import { Brand, Modal, Notice, Spinner } from "./ui";

export default function Auth({
  onLogin,
}: {
  onLogin: (user: User, recoveryCodes?: string[]) => void;
}) {
  const status = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api<{ configured: boolean; registered: boolean; rpId: string }>("/auth/status"),
  });
  const [recovery, setRecovery] = useState(false);
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mode = recovery ? "recovery" : status.data?.registered ? "login" : "register";
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await authenticate(mode, email.trim(), secret.trim());
      onLogin(result.user, result.recoveryCodes);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-top">
        <Brand />
        <span className="auth-top-note">
          <span className="tiny-dot" /> 你的设备 · 你的空间
        </span>
      </div>
      <main className="auth-layout">
        <section className="auth-story">
          <div className="pill">
            <Sparkles size={14} /> A little closer to your next idea
          </div>
          <h1>
            灵感在此，
            <br />
            <span>无论身在何处。</span>
          </h1>
          <p>
            连接你的设备，让 Claude Code 与 Codex
            <br className="desktop-break" /> 随时接续工作。你的下一步，从这里开始。
          </p>
          <div className="glass-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-tile tile-back">
              <Laptop size={42} strokeWidth={1} />
            </div>
            <div className="art-tile tile-main">
              <Brand compact />
              <div className="art-line" />
              <div className="art-line short" />
              <span className="art-dot" />
            </div>
            <div className="art-tile tile-small">
              <Sparkles size={25} strokeWidth={1.2} />
            </div>
            <div className="art-caption">
              <span className="tiny-dot" /> 在同一片工作空间，自由流动
            </div>
          </div>
        </section>
        <section className="auth-form glass">
          <div className="auth-icon">
            <Fingerprint size={30} strokeWidth={1.4} />
          </div>
          <div className="eyebrow">WELCOME TO AGENTPANEL</div>
          <h2>
            {mode === "recovery"
              ? "找回你的工作空间"
              : mode === "register"
                ? "为工作空间，配一把钥匙"
                : "很高兴，又见到你"}
          </h2>
          <p className="muted">
            {mode === "recovery"
              ? "使用恢复码验证身份，并创建新的通行密钥。"
              : mode === "register"
                ? "创建你的专属账号，使用通行密钥安全登录。"
                : "使用通行密钥，轻松回到你的工作空间。"}
          </p>
          {status.isPending ? (
            <Spinner label="正在连接工作空间" />
          ) : status.isError ? (
            <Notice onRetry={() => void status.refetch()}>{errorText(status.error)}</Notice>
          ) : !status.data.configured ? (
            <Notice tone="info">
              工作空间尚未配置。请先在本地 Relay 配置账号邮箱及首次注册密钥，然后刷新页面。
            </Notice>
          ) : (
            <form onSubmit={submit}>
              <label className="field">
                邮箱
                <input
                  name="email"
                  type="email"
                  autoComplete="username webauthn"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  disabled={busy}
                />
              </label>
              {mode !== "login" && (
                <label className="field">
                  {mode === "register" ? "首次注册密钥" : "一次性恢复码"}
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={
                      mode === "register" ? "输入本地配置中的注册密钥" : "输入你保存的恢复码"
                    }
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    required
                    disabled={busy}
                  />
                </label>
              )}
              {error && <Notice>{error}</Notice>}
              <button className="primary auth-submit" type="submit" disabled={busy}>
                {busy ? (
                  <Spinner label="请在系统窗口中完成验证" />
                ) : (
                  <>
                    <Fingerprint size={19} />
                    {mode === "login"
                      ? "使用通行密钥登录"
                      : mode === "register"
                        ? "创建通行密钥"
                        : "验证并重设通行密钥"}
                    <ArrowRight size={17} />
                  </>
                )}
              </button>
              {status.data.registered && (
                <button
                  className="text-button auth-recovery"
                  type="button"
                  onClick={() => {
                    setRecovery(!recovery);
                    setSecret("");
                    setError("");
                  }}
                  disabled={busy}
                >
                  {recovery ? (
                    <>
                      <ArrowLeft size={14} />
                      返回登录
                    </>
                  ) : (
                    "无法使用通行密钥？"
                  )}
                </button>
              )}
            </form>
          )}
          <div className="auth-security">
            <ShieldCheck size={15} />
            <span>由设备上的 Face ID、Touch ID 或安全密钥保护</span>
          </div>
        </section>
      </main>
      <footer className="auth-footer">
        <span>一个空间，连接所有可能。</span>
        <span>AGENTPANEL / PERSONAL AGENT WORKSPACE</span>
      </footer>
    </div>
  );
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  function download() {
    const blob = new Blob(
      [`AgentPanel 一次性恢复码\n请离线安全保存，每个代码只能使用一次。\n\n${codes.join("\n")}\n`],
      { type: "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "AgentPanel-recovery-codes.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Modal title="保管好你的备用钥匙" eyebrow="RECOVERY CODES">
      <p className="muted">
        通行密钥已就绪。恢复码仅在此显示一次，每个只能使用一次。请保存在安全的位置，以便无法使用通行密钥时找回账号。
      </p>
      <div className="recovery-codes">
        {codes.map((code) => (
          <code key={code}>{code}</code>
        ))}
      </div>
      <button type="button" className="secondary full" onClick={download}>
        <KeyRound size={17} />
        下载恢复码
      </button>
      <label className="check-row">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        我已将恢复码保存在安全的位置
      </label>
      <button type="button" className="primary full" disabled={!saved} onClick={onDone}>
        进入工作空间
        <ArrowRight size={17} />
      </button>
    </Modal>
  );
}
