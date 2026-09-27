import type { AgentCapability, Answers, Question, SessionEvent, Usage } from "@agentpanel/protocol";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config";
import { claudeUsage, emptyUsage, mergeUsage } from "../indexer";
import { type AdapterContext, type AgentAdapter, jsonValue } from "./types";

/** AskUserQuestion input → normalized questions; the question text doubles as its id, as the SDK keys answers by it. */
export function askUserQuestions(input: Record<string, unknown>): Question[] | undefined {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const questions = raw
    .filter((q): q is Record<string, any> => !!q && typeof q.question === "string")
    .map((q) => ({
      id: q.question as string,
      header: typeof q.header === "string" ? q.header : undefined,
      question: q.question as string,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o: any) => typeof o?.label === "string")
        .map((o: any) => ({
          label: o.label as string,
          ...(typeof o.description === "string" ? { description: o.description } : {}),
        })),
      multiSelect: q.multiSelect === true,
      allowOther: true,
    }));
  return questions.length ? questions : undefined;
}
/** SDK format: question text → answer; multiple selections are comma-separated. Undefined unless every question is answered. */
export function claudeAnswers(questions: Question[], answers: Answers | undefined) {
  if (!answers) return undefined;
  const result: Record<string, string> = {};
  for (const question of questions) {
    const values = (answers[question.id] ?? []).map((v) => v.trim()).filter(Boolean);
    if (!values.length) return undefined;
    result[question.question] = values.join(", ");
  }
  return result;
}

type QueryStream = AsyncIterable<any> & { interrupt(): Promise<unknown>; close(): void };
type QueryFactory = (args: { prompt: string; options: Record<string, any> }) => QueryStream;

export function claudeAuthentication(
  config: Config,
  env = process.env,
): { available: boolean; message: string } {
  const configured =
    !!env.ANTHROPIC_API_KEY ||
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_VERTEX === "1" ||
    env.CLAUDE_CODE_USE_FOUNDRY === "1";
  if (!configured)
    return {
      available: false,
      message: "Claude SDK 需要 API Key 或受支持云服务凭据；不使用 Claude 订阅 OAuth 登录态",
    };
  if (!config.allowPaidApi)
    return {
      available: false,
      message: "已发现 API/云服务配置，但本设备尚未允许付费调用（allowPaidApi=false）",
    };
  return { available: true, message: "已配置 API/云服务认证" };
}

export class ClaudeAdapter implements AgentAdapter {
  nativeId?: string;
  running = false;
  private context?: AdapterContext;
  private stream?: QueryStream;
  private task?: Promise<void>;
  private abort?: AbortController;
  private usage: Usage = emptyUsage();
  private messageUsage = new Map<string, Usage>();
  constructor(
    private config: Config,
    private queryFactory: QueryFactory = query as unknown as QueryFactory,
  ) {}
  async start(context: AdapterContext) {
    const auth = claudeAuthentication(this.config);
    if (!auth.available) throw new Error(auth.message);
    this.context = context;
    this.nativeId = context.nativeId;
    this.usage = context.usage ?? emptyUsage();
  }
  async send(prompt: string) {
    if (!this.context) throw new Error("Claude 会话尚未初始化");
    if (this.running) throw new Error("当前轮次仍在运行");
    this.running = true;
    const turnId = crypto.randomUUID();
    this.abort = new AbortController();
    this.messageUsage.clear();
    const baseUsage = { ...this.usage };
    const started = Date.now();
    const emit = (event: SessionEvent) =>
      this.context!.emit({ ...event, nativeId: this.nativeId, turnId });
    emit({ kind: "message.done", role: "user", text: prompt, messageId: crypto.randomUUID() });
    emit({ kind: "turn.start" });
    // Never forward subscription OAuth credentials to an embedding product. Explicit API/cloud auth is required above.
    const env = { ...process.env };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
    delete env.CLAUDECODE;
    const context = this.context;
    const executable = this.config.claudeExecutable ?? Bun.which("claude");
    const options = {
      cwd: context.cwd,
      resume: this.nativeId,
      model: context.model,
      permissionMode: context.permissionMode,
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],
      env,
      abortController: this.abort,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal; toolUseID?: string; decisionReason?: string },
      ) => {
        const questions = toolName === "AskUserQuestion" ? askUserQuestions(input) : undefined;
        const decision = await context.approve(
          {
            toolName,
            input: jsonValue(input),
            toolCallId: options.toolUseID,
            reason: options.decisionReason,
            ...(questions ? { questions } : {}),
          },
          options.signal,
        );
        if (questions) {
          const answers = claudeAnswers(questions, decision.answers);
          return decision.decision === "allow" && answers
            ? { behavior: "allow", updatedInput: { ...input, answers } }
            : {
                behavior: "deny",
                message:
                  decision.reason ?? "用户未回答这些问题，请不要重复提问，按你的判断继续或结束。",
              };
        }
        return decision.decision === "allow"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: decision.reason ?? "用户拒绝了本次操作" };
      },
    };
    try {
      this.stream = this.queryFactory({ prompt, options });
    } catch (error) {
      this.running = false;
      throw error;
    }
    const stream = this.stream;
    this.task = (async () => {
      let messageId = crypto.randomUUID();
      let ended = false;
      try {
        for await (const message of stream) {
          if (message.session_id) this.nativeId = message.session_id;
          if (message.type === "stream_event") {
            const event = message.event;
            if (event.type === "message_start") messageId = event.message.id;
            if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta")
                emit({
                  kind: "message.delta",
                  role: "assistant",
                  messageId,
                  text: event.delta.text,
                });
              if (event.delta.type === "thinking_delta")
                emit({ kind: "thinking.delta", messageId, text: event.delta.thinking });
            }
          }
          if (message.type === "assistant") {
            for (const content of message.message.content ?? []) {
              if (content.type === "text")
                emit({
                  kind: "message.done",
                  role: "assistant",
                  messageId: message.message.id,
                  text: content.text,
                });
              if (content.type === "tool_use")
                emit({
                  kind: "tool.call",
                  toolCallId: content.id,
                  toolName: content.name,
                  input: jsonValue(content.input),
                });
            }
            if (message.message.usage) {
              const id = message.message.id;
              this.messageUsage.set(
                id,
                mergeUsage(
                  this.messageUsage.get(id) ?? emptyUsage(),
                  claudeUsage(message.message.usage),
                ),
              );
              const totals = { ...baseUsage, model: message.message.model };
              for (const usage of this.messageUsage.values()) {
                totals.inputTokens += usage.inputTokens;
                totals.outputTokens += usage.outputTokens;
                totals.cacheReadTokens += usage.cacheReadTokens;
                totals.cacheWriteTokens += usage.cacheWriteTokens;
              }
              this.usage = totals;
              emit({ kind: "usage", usage: this.usage });
            }
            if (message.error)
              emit({
                kind: "error",
                error: { code: "CLAUDE_ASSISTANT_ERROR", message: message.error },
              });
          }
          if (message.type === "user" && Array.isArray(message.message?.content)) {
            for (const part of message.message.content)
              if (part.type === "tool_result")
                emit({
                  kind: "tool.result",
                  toolCallId: part.tool_use_id,
                  output: jsonValue(part.content ?? ""),
                });
          }
          if (message.type === "result") {
            ended = true;
            this.usage = {
              ...this.usage,
              turns: (baseUsage.turns ?? 0) + 1,
              activeMs: (baseUsage.activeMs ?? 0) + Math.max(0, Date.now() - started),
              ...(typeof message.total_cost_usd === "number"
                ? {
                    costUsd: (baseUsage.costUsd ?? 0) + message.total_cost_usd,
                    pricingVersion: "provider-reported",
                  }
                : {}),
            };
            emit({ kind: "usage", usage: this.usage });
            if (message.is_error || message.subtype !== "success")
              emit({
                kind: "error",
                error: {
                  code: "CLAUDE_TURN_FAILED",
                  message: (message.errors ?? [message.result ?? message.subtype]).join("\n"),
                },
              });
            emit({ kind: "turn.end", text: message.is_error ? "failed" : "completed" });
          }
        }
      } catch (error) {
        if (!this.abort?.signal.aborted)
          emit({ kind: "error", error: { code: "CLAUDE_ERROR", message: String(error) } });
      } finally {
        this.running = false;
        if (!ended)
          emit({ kind: "turn.end", text: this.abort?.signal.aborted ? "interrupted" : "failed" });
        stream.close();
      }
    })();
  }
  async interrupt() {
    if (this.running && this.stream) {
      await this.stream.interrupt().catch(() => {});
      this.abort?.abort();
    }
  }
  async close() {
    await this.interrupt();
    this.stream?.close();
    await this.task;
    this.running = false;
  }
}

export async function probeClaude(config: Config): Promise<AgentCapability> {
  const executable = config.claudeExecutable ?? Bun.which("claude");
  const auth = claudeAuthentication(config);
  let version: string | undefined;
  if (executable) {
    const process = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "ignore" });
    version = (await new Response(process.stdout).text()).trim();
    await process.exited;
  }
  return {
    kind: "claude",
    installed: !!executable,
    ...(version ? { version } : {}),
    authenticated: auth.available && !!executable,
    executionAvailable: auth.available && !!executable,
    authMessage: executable
      ? auth.message
      : "请先在本地安装 Claude Code（编译版 daemon 使用本机 CLI）",
  };
}
