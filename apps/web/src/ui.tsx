import {
  AlertCircle,
  Check,
  Command,
  Laptop,
  LoaderCircle,
  type LucideIcon,
  Monitor,
  Sparkles,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <div className="brand-symbol">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="m7 24 7.5-16a1.7 1.7 0 0 1 3 0L25 24M11 17.5h10" />
          <circle cx="25" cy="7" r="1.4" />
        </svg>
      </div>
      {!compact && (
        <span>
          AgentPanel<span className="brand-dot">.</span>
        </span>
      )}
    </div>
  );
}

export function Spinner({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={19} />
      <span>{label}</span>
    </div>
  );
}
export function Notice({
  children,
  tone = "error",
  onRetry,
}: {
  children: ReactNode;
  tone?: "error" | "info" | "success";
  onRetry?: () => void;
}) {
  return (
    <div className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"}>
      {tone === "success" ? <Check size={18} /> : <AlertCircle size={18} />}
      <span>{children}</span>
      {onRetry && (
        <button type="button" className="text-button" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}
export function Empty({
  icon: Icon = Sparkles,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={27} strokeWidth={1.4} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose?: () => void;
  wide?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector<HTMLElement>('button,input,select,textarea,[tabindex="0"]')?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") close.current?.();
      if (event.key === "Tab") {
        const elements = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
          ) || []),
        ];
        const first = elements[0],
          last = elements[elements.length - 1];
        if (!first) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        className={`modal glass ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <div className="modal-heading">
          <h2 id={id}>{title}</h2>
          {onClose && (
            <button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}>
              <X size={20} />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

export function AgentMark({
  agent,
  small = false,
}: {
  agent: "claude" | "codex";
  small?: boolean;
}) {
  return (
    <span
      className={`agent-mark ${agent} ${small ? "small" : ""}`}
      title={agent === "claude" ? "Claude Code" : "Codex"}
    >
      {agent === "claude" ? (
        <Sparkles size={small ? 13 : 20} />
      ) : (
        <Command size={small ? 13 : 20} />
      )}
    </span>
  );
}
export function DeviceIcon({ platform, size = 24 }: { platform: string; size?: number }) {
  const Icon = /darwin|mac/i.test(platform) ? Laptop : Monitor;
  return <Icon size={size} strokeWidth={1.5} />;
}
const statuses: Record<string, string> = {
  idle: "就绪",
  running: "运行中",
  waiting: "等待审批",
  completed: "已完成",
  error: "出现错误",
  readonly: "只读",
};
export function Status({ status }: { status: string }) {
  return (
    <span className={`status ${status}`}>
      <span />
      {statuses[status] || status}
    </span>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
