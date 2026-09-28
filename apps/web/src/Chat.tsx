import type { Approval, Device, Envelope, Session } from "@agentpanel/protocol";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  FileCode2,
  History,
  LockKeyhole,
  MessageCircleQuestion,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { errorText, post } from "./api";
import { type ConnectionState, command, loadEvents } from "./connection";
import { type ConversationItem, conversation, mergeEvents, projectName } from "./events";
import { localHistoryOptions } from "./history";
import { AgentMark, Empty, Notice, Spinner, Status } from "./ui";

export default function Chat({
  session,
  device,
  approvals,
  connection,
  onBack,
  onSession,
  onNotify,
}: {
  session: Session;
  device?: Device;
  approvals: Approval[];
  connection: ConnectionState;
  onBack: () => void;
  onSession: (session: Session) => void;
  onNotify: (message: string) => void;
}) {
  const query = useQueryClient();
  const events = useQuery({
    queryKey: ["events", session.id],
    queryFn: async () => {
      const loaded = await loadEvents(session.id);
      return mergeEvents(query.getQueryData<Envelope[]>(["events", session.id]) || [], loaded);
    },
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canReadHistory = !!device?.online && connection === "connected";
  const history = useInfiniteQuery(localHistoryOptions(session, canReadHistory));
  const [atBottom, setAtBottom] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const allEvents = useMemo(
    () => mergeEvents(history.data?.pages.flatMap((page) => page.events) ?? [], events.data ?? []),
    [history.data, events.data],
  );
  const messages = useMemo(() => conversation(allEvents), [allEvents]);
  const running = ["running", "waiting"].includes(session.status);
  const writable = !session.readOnly && device?.online && connection === "connected";
  // biome-ignore lint/correctness/useExhaustiveDependencies: Follow history and streaming updates while the reader stays at the bottom.
  useEffect(() => {
    if (atBottom && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [atBottom, allEvents]);
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !writable || busy) return;
    setBusy(true);
    setError("");
    try {
      if (
        session.source === "local" ||
        session.status === "completed" ||
        session.status === "error"
      ) {
        const result = await command<{ session: Session }>(
          "session.resume",
          { nativeId: session.nativeId, prompt: prompt.trim() },
          { deviceId: session.deviceId, sessionId: session.id },
        );
        if (result?.session) onSession(result.session);
      } else
        await command(
          "session.send",
          { prompt: prompt.trim() },
          { deviceId: session.deviceId, sessionId: session.id },
        );
      setPrompt("");
      setAtBottom(true);
      await query.invalidateQueries({ queryKey: ["sessions"] });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function interrupt() {
    setBusy(true);
    setError("");
    try {
      await command("session.interrupt", {}, { deviceId: session.deviceId, sessionId: session.id });
      onNotify("中断请求已发送");
      await query.invalidateQueries({ queryKey: ["sessions"] });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="chat-layout">
      <header className="chat-heading">
        <button
          type="button"
          className="icon-button back-button"
          aria-label="返回工作空间"
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </button>
        <AgentMark agent={session.agent} />
        <div className="chat-title">
          <h1>{session.title || "未命名会话"}</h1>
          <span>
            {device?.name || "设备"}
            <span className="bullet">/</span>
            <span title={session.cwd}>{projectName(session.cwd)}</span>
          </span>
        </div>
        <Status status={session.status} />
      </header>
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
        }}
      >
        <div className="chat-messages">
          {history.isFetching && !history.isFetchingNextPage && <Spinner label="正在读取历史" />}
          {history.isError && (
            <Notice
              onRetry={
                canReadHistory
                  ? () =>
                      void (history.isFetchNextPageError
                        ? history.fetchNextPage()
                        : history.refetch())
                  : undefined
              }
            >
              历史读取失败：{errorText(history.error)}
            </Notice>
          )}
          {history.hasNextPage && (
            <button
              type="button"
              className="history-button"
              onClick={() => {
                setAtBottom(false);
                void history.fetchNextPage();
              }}
              disabled={history.isFetching || !canReadHistory}
            >
              {history.isFetchingNextPage ? (
                <Spinner label="正在读取历史" />
              ) : (
                <>
                  <History size={15} />
                  加载更早的消息
                </>
              )}
            </button>
          )}
          {events.isPending && <Spinner label="正在同步会话" />}
          {events.isError && (
            <Notice onRetry={() => void events.refetch()}>{errorText(events.error)}</Notice>
          )}
          {messages.length === 0 &&
            !events.isPending &&
            !history.isFetching &&
            !history.isError && (
              <Empty
                icon={Sparkles}
                title={session.source === "local" ? "暂无历史消息" : "想法已就位"}
              >
                {session.source === "local"
                  ? canReadHistory
                    ? "这段会话还没有可显示的历史消息。"
                    : "等待设备连接，连接恢复后会自动读取历史。"
                  : "智能伙伴的消息、思考摘要和操作进展会显示在这里。"}
              </Empty>
            )}
          {messages.map((message) => (
            <Message key={message.id} message={message} agent={session.agent} />
          ))}
          {running && messages.length > 0 && (
            <div className="working-indicator">
              <span />
              <span />
              <span />
              <small>{session.status === "waiting" ? "正在等待你的决定" : "正在继续工作"}</small>
            </div>
          )}
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
          <div className="chat-end-marker" />
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          className="jump-bottom secondary"
          onClick={() => {
            setAtBottom(true);
            scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown size={15} />
          最新消息
        </button>
      )}
      <div className="composer-area">
        {session.readOnly && (
          <Notice tone="info">
            <LockKeyhole size={13} />
            此会话当前只读。
            {session.busyReason ||
              "检测到本地占用或暂时无法确认可安全接管。请在本地结束占用后等待状态刷新。"}
          </Notice>
        )}
        {!device?.online && (
          <Notice tone="info">设备离线。历史仍可查看，连接恢复后可继续操作。</Notice>
        )}
        {connection !== "connected" && device?.online && (
          <Notice tone="info">正在恢复连接与离线消息，请稍候。</Notice>
        )}
        {error && <Notice>{error}</Notice>}
        <form className={`composer glass ${session.readOnly ? "disabled" : ""}`} onSubmit={send}>
          <textarea
            ref={textArea}
            aria-label="发送消息"
            placeholder={
              session.readOnly
                ? "会话只读，暂时无法发送消息"
                : running
                  ? "等待当前轮次完成，或先中断…"
                  : "继续聊聊，或交给它下一件事…"
            }
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(180, event.target.scrollHeight)}px`;
            }}
            disabled={!writable || busy || running}
            rows={2}
            maxLength={100000}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!running) event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="composer-bottom">
            <span>
              <AgentMark agent={session.agent} small />
              {session.agent === "claude" ? "Claude Code" : "Codex"}
              <span className="composer-hint">Shift + Enter 换行</span>
            </span>
            {running ? (
              <button
                type="button"
                className="interrupt-button"
                disabled={busy || !writable}
                onClick={() => void interrupt()}
              >
                <Square size={13} fill="currentColor" />
                中断
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                aria-label={session.source === "local" ? "继续本地会话" : "发送消息"}
                disabled={busy || !writable || !prompt.trim()}
              >
                {busy ? <span className="button-spinner" /> : <ArrowUp size={20} />}
              </button>
            )}
          </div>
        </form>
        <p className="composer-disclaimer">你始终掌握决定权。需要权限的操作，会先等待你的审批。</p>
      </div>
    </div>
  );
}

function Message({ message, agent }: { message: ConversationItem; agent: "claude" | "codex" }) {
  const [copied, setCopied] = useState(false);
  if (message.kind === "error") return <Notice>{message.text}</Notice>;
  if (message.kind === "thinking")
    return (
      <details className="thinking">
        <summary>
          <Sparkles size={14} />
          思考摘要
          <ChevronDown size={14} />
        </summary>
        <div>{message.text}</div>
      </details>
    );
  if (message.kind === "tool")
    return (
      <details className="tool-message">
        <summary>
          <span className="tool-icon">
            <Terminal size={15} />
          </span>
          <strong>{message.toolName}</strong>
          <span className={`tool-state ${message.complete ? "done" : ""}`}>
            {message.complete ? (
              <>
                <Check size={12} />
                已完成
              </>
            ) : (
              "运行中"
            )}
          </span>
          <ChevronDown size={14} />
        </summary>
        <div className="tool-body">
          {message.input !== undefined && (
            <>
              <div className="code-label">输入</div>
              <pre>{renderJson(message.input)}</pre>
            </>
          )}
          {message.output !== undefined && (
            <>
              <div className="code-label">输出</div>
              <pre>{renderJson(message.output)}</pre>
            </>
          )}
          {message.diff && (
            <>
              <div className="code-label">
                <FileCode2 size={13} />
                文件变更
              </div>
              <pre className="diff">
                {message.diff.split("\n").map((line, index) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: A diff is immutable text; repeated lines need their fixed position.
                    key={`${index}:${line}`}
                    className={
                      line.startsWith("+") && !line.startsWith("+++")
                        ? "addition"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? "deletion"
                          : line.startsWith("@@")
                            ? "chunk"
                            : ""
                    }
                  >
                    {line}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </>
          )}
        </div>
      </details>
    );
  const user = message.role === "user";
  return (
    <article className={`message ${user ? "user-message" : "assistant-message"}`}>
      <div className="message-author">
        {user ? <div className="user-avatar">你</div> : <AgentMark agent={agent} small />}
        <strong>{user ? "你" : agent === "claude" ? "Claude Code" : "Codex"}</strong>
        <time>
          {new Date(message.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
        </time>
      </div>
      <div className="message-content markdown">
        <ReactMarkdown
          rehypePlugins={[rehypeHighlight]}
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, href }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
            pre: ({ children }) => (
              <div className="markdown-code">
                <pre>{children}</pre>
              </div>
            ),
          }}
        >
          {message.text}
        </ReactMarkdown>
      </div>
      {!user && message.complete && message.text && (
        <button
          type="button"
          className="message-copy"
          title="复制消息"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(message.text);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              /* Manual selection remains available. */
            }
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      )}
    </article>
  );
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  return approval.questions?.length ? (
    <QuestionCard approval={approval} />
  ) : (
    <ToolApprovalCard approval={approval} />
  );
}

function useCountdown() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Agent 提问（Claude AskUserQuestion / Codex request_user_input）：选择选项或填写自定义回答。 */
function QuestionCard({ approval }: { approval: Approval }) {
  const query = useQueryClient();
  const questions = approval.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const now = useCountdown();
  const expired = now >= approval.expiresAt;
  const answerOf = (id: string) => {
    const text = other[id]?.trim();
    return [...(picked[id] ?? []), ...(text ? [text] : [])];
  };
  const complete = questions.every((q) => answerOf(q.id).length > 0);
  function toggle(id: string, label: string, multi: boolean) {
    setPicked((current) => {
      const chosen = current[id] ?? [];
      if (!multi) return { ...current, [id]: chosen[0] === label ? [] : [label] };
      return {
        ...current,
        [id]: chosen.includes(label) ? chosen.filter((v) => v !== label) : [...chosen, label],
      };
    });
    if (!multi) setOther((current) => ({ ...current, [id]: "" }));
  }
  async function submit(decision: "allow" | "deny") {
    setBusy(true);
    setError("");
    try {
      await post(`/approvals/${encodeURIComponent(approval.id)}/decision`, {
        decision,
        ...(decision === "allow"
          ? { answers: Object.fromEntries(questions.map((q) => [q.id, answerOf(q.id)])) }
          : {}),
      });
      await query.invalidateQueries({ queryKey: ["approvals"] });
      await query.invalidateQueries({ queryKey: ["sessions"] });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="approval-card question-card">
      <div className="approval-heading">
        <span>
          <MessageCircleQuestion size={20} />
        </span>
        <div>
          <strong>{expired ? "提问已过期" : "Agent 在等你的回答"}</strong>
          <p>回答后，任务会继续执行</p>
        </div>
        <span className="approval-time">
          <Clock3 size={12} />
          {expired ? "已过期" : `${Math.ceil((approval.expiresAt - now) / 60000)} 分钟`}
        </span>
      </div>
      {questions.map((q) => (
        <fieldset key={q.id} className="question" disabled={busy || expired}>
          <legend>
            {q.header && <span className="question-tag">{q.header}</span>}
            {q.question}
            {q.multiSelect && <em>可多选</em>}
          </legend>
          <div className="question-options">
            {q.options.map((option) => {
              const active = picked[q.id]?.includes(option.label) ?? false;
              return (
                <button
                  type="button"
                  key={option.label}
                  className={active ? "question-option active" : "question-option"}
                  aria-pressed={active}
                  onClick={() => toggle(q.id, option.label, !!q.multiSelect)}
                >
                  <strong>{option.label}</strong>
                  {option.description && <span>{option.description}</span>}
                </button>
              );
            })}
          </div>
          {(q.allowOther || q.options.length === 0) && (
            <input
              className="question-other"
              value={other[q.id] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setOther((current) => ({ ...current, [q.id]: value }));
                if (value && !q.multiSelect) setPicked((current) => ({ ...current, [q.id]: [] }));
              }}
              placeholder={q.options.length ? "其他回答…" : "输入你的回答…"}
              maxLength={4000}
            />
          )}
        </fieldset>
      ))}
      {error && <Notice>{error}</Notice>}
      <div className="approval-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy || expired}
          onClick={() => void submit("deny")}
        >
          <X size={16} />
          跳过
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || expired || !complete}
          onClick={() => void submit("allow")}
        >
          <Check size={16} />
          提交回答
        </button>
      </div>
    </article>
  );
}

function ToolApprovalCard({ approval }: { approval: Approval }) {
  const query = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const now = useCountdown();
  const expired = now >= approval.expiresAt;
  async function decide(decision: "allow" | "deny") {
    setBusy(true);
    setError("");
    try {
      await post(`/approvals/${encodeURIComponent(approval.id)}/decision`, {
        decision,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      await query.invalidateQueries({ queryKey: ["approvals"] });
      await query.invalidateQueries({ queryKey: ["sessions"] });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="approval-card">
      <div className="approval-heading">
        <span>
          <ShieldCheck size={20} />
        </span>
        <div>
          <strong>{expired ? "审批已过期" : "下一步，由你决定"}</strong>
          <p>{approval.toolName} 请求操作权限</p>
        </div>
        <span className="approval-time">
          <Clock3 size={12} />
          {expired ? "已过期" : `${Math.ceil((approval.expiresAt - now) / 60000)} 分钟`}
        </span>
      </div>
      <pre>{renderJson(approval.input)}</pre>
      <label className="field sr-label">
        决定说明（可选）
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="补充一条说明（可选）"
          maxLength={2000}
          disabled={busy || expired}
        />
      </label>
      {error && <Notice>{error}</Notice>}
      <div className="approval-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy || expired}
          onClick={() => void decide("deny")}
        >
          <X size={16} />
          拒绝
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || expired}
          onClick={() => void decide("allow")}
        >
          <Check size={16} />
          允许本次操作
        </button>
      </div>
    </article>
  );
}

function renderJson(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
