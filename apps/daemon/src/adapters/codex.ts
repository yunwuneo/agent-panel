import { join } from "node:path";
import type { AgentCapability, SessionEvent, Usage } from "@agentpanel/protocol";
import type { Config } from "../config";
import { codexUsage, emptyUsage, mergeUsage } from "../indexer";
import { type RpcMessage, RpcProcess } from "./rpc";
import { type AdapterContext, type AgentAdapter, jsonValue } from "./types";

const serverArgs = (config: Config) => [
  "app-server",
  "--listen",
  "stdio://",
  ...(config.codexModelProvider
    ? ["-c", `model_provider=${JSON.stringify(config.codexModelProvider)}`]
    : []),
];

export async function codexProfileProblem(config: Config): Promise<string | undefined> {
  if (!config.codexModelProvider) return;
  const file = Bun.file(join(config.codexHome, "config.toml"));
  if (!(await file.exists())) return;
  try {
    const local = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
    if (
      local.model_catalog_json &&
      local.model_provider &&
      local.model_provider !== config.codexModelProvider
    ) {
      return "提供方覆盖与现有自定义模型目录不一致；请用独立 codexHome 登录并获取官方模型目录，原配置无需修改";
    }
  } catch {
    return "无法读取 Codex 配置，无法确认模型目录与认证一致";
  }
}

export class CodexAdapter implements AgentAdapter {
  nativeId?: string;
  running = false;
  private context?: AdapterContext;
  private turnId?: string;
  private activeSince = 0;
  private usage: Usage = emptyUsage();
  private abort = new AbortController();
  private initialized = false;
  private interruptRequested = false;
  constructor(
    private config: Config,
    private rpc = new RpcProcess(),
  ) {}
  async start(context: AdapterContext) {
    const profileProblem = await codexProfileProblem(this.config);
    if (profileProblem) throw new Error(profileProblem);
    this.context = context;
    this.usage = context.usage ?? emptyUsage();
    this.rpc.onMessage = (message) =>
      void this.receive(message).catch((error) =>
        this.emit({ kind: "error", error: { code: "CODEX_PROTOCOL", message: String(error) } }),
      );
    this.rpc.onExit = (error) => {
      if (this.initialized) {
        this.abort.abort();
        this.running = false;
        this.emit({ kind: "error", error: { code: "CODEX_EXIT", message: error.message } });
      }
    };
    await this.rpc.start(this.config.codexExecutable, serverArgs(this.config), {
      cwd: context.cwd,
      env: { ...process.env, CODEX_HOME: this.config.codexHome },
    });
    try {
      await this.rpc.request("initialize", {
        clientInfo: { name: "agentpanel", title: "AgentPanel", version: "0.1.0" },
      });
      this.rpc.notify("initialized");
      const account = await this.rpc.request("account/read", { refreshToken: false });
      if (!account.account && account.requiresOpenaiAuth !== false)
        throw new Error("Codex 尚未登录，请先在设备本地运行 codex login");
      if (account.account?.type !== "chatgpt" && !this.config.allowPaidApi)
        throw new Error("当前 Codex 模型提供方可能产生 API 费用；allowPaidApi=false，已停止");
      const result = await this.rpc.request(context.nativeId ? "thread/resume" : "thread/start", {
        ...(context.nativeId ? { threadId: context.nativeId } : {}),
        cwd: context.cwd,
        ...(context.model ? { model: context.model } : {}),
        ...(this.config.codexModelProvider
          ? { modelProvider: this.config.codexModelProvider }
          : {}),
        approvalPolicy: context.permissionMode === "acceptEdits" ? "on-request" : "untrusted",
        sandbox: context.permissionMode === "plan" ? "read-only" : "workspace-write",
        approvalsReviewer: "user",
        ...(!context.nativeId ? { serviceName: "agentpanel" } : {}),
      });
      if (!this.config.allowPaidApi && result.modelProvider !== "openai")
        throw new Error("解析后的会话不是官方 OpenAI 提供方；付费调用未获授权，已停止");
      this.nativeId = result.thread.id;
      this.initialized = true;
      this.emit({
        kind: "message.done",
        role: "system",
        text: context.nativeId ? "已连接本地 Codex 会话" : "Codex 会话已创建",
        nativeId: this.nativeId,
      });
    } catch (error) {
      await this.rpc.close();
      throw error;
    }
  }
  async send(prompt: string) {
    if (!this.context || !this.nativeId || !this.initialized)
      throw new Error("Codex 会话尚未初始化");
    if (this.running) throw new Error("当前轮次仍在运行");
    this.running = true;
    this.turnId = undefined;
    this.interruptRequested = false;
    this.abort = new AbortController();
    this.activeSince = Date.now();
    this.emit({ kind: "message.done", role: "user", text: prompt, messageId: crypto.randomUUID() });
    try {
      const result = await this.rpc.request("turn/start", {
        threadId: this.nativeId,
        input: [{ type: "text", text: prompt }],
        cwd: this.context.cwd,
        ...(this.context.model ? { model: this.context.model } : {}),
      });
      this.turnId = result.turn.id;
      if (this.interruptRequested && this.running)
        await this.rpc.request("turn/interrupt", { threadId: this.nativeId, turnId: this.turnId });
    } catch (error) {
      this.running = false;
      throw error;
    }
  }
  private emit(event: SessionEvent) {
    this.context?.emit({ ...event, nativeId: this.nativeId, turnId: event.turnId ?? this.turnId });
  }
  private async receive(message: RpcMessage) {
    const p = message.params ?? {};
    if (p.threadId && this.nativeId && p.threadId !== this.nativeId) return;
    if (message.id !== undefined && message.method) {
      await this.serverRequest(message);
      return;
    }
    const item = p.item ?? {};
    switch (message.method) {
      case "turn/started":
        this.running = true;
        this.turnId = p.turn.id;
        this.activeSince ||= Date.now();
        this.emit({ kind: "turn.start" });
        break;
      case "turn/completed": {
        this.running = false;
        this.usage = {
          ...this.usage,
          turns: (this.usage.turns ?? 0) + 1,
          activeMs:
            (this.usage.activeMs ?? 0) + (this.activeSince ? Date.now() - this.activeSince : 0),
        };
        this.activeSince = 0;
        if (p.turn.error)
          this.emit({
            kind: "error",
            error: { code: "CODEX_TURN_FAILED", message: p.turn.error.message },
          });
        this.emit({ kind: "usage", usage: this.usage });
        this.emit({ kind: "turn.end", text: p.turn.status });
        this.abort.abort();
        break;
      }
      case "item/agentMessage/delta":
        this.emit({ kind: "message.delta", role: "assistant", messageId: p.itemId, text: p.delta });
        break;
      case "item/reasoning/summaryTextDelta":
        this.emit({ kind: "thinking.delta", messageId: p.itemId, text: p.delta });
        break;
      case "item/commandExecution/outputDelta":
        this.emit({ kind: "tool.result", toolCallId: p.itemId, output: p.delta });
        break;
      case "turn/diff/updated":
        this.emit({
          kind: "tool.result",
          toolName: "文件变更",
          toolCallId: `diff_${p.turnId}`,
          diff: p.diff,
        });
        break;
      case "thread/tokenUsage/updated":
        if (p.tokenUsage?.total) {
          this.usage = mergeUsage(this.usage, codexUsage(p.tokenUsage.total));
          this.emit({ kind: "usage", usage: this.usage });
        }
        break;
      case "item/started":
        if (
          [
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "dynamicToolCall",
            "webSearch",
            "collabToolCall",
          ].includes(item.type)
        )
          this.emit({
            kind: "tool.call",
            toolCallId: item.id,
            toolName: item.tool ?? item.type,
            input: jsonValue(item.arguments ?? item.command ?? item.changes ?? item.query ?? {}),
          });
        break;
      case "item/completed":
        if (item.type === "agentMessage")
          this.emit({
            kind: "message.done",
            role: "assistant",
            messageId: item.id,
            text: item.text,
          });
        else if (item.type === "plan")
          this.emit({ kind: "thinking.delta", messageId: item.id, text: item.text });
        else if (
          [
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "dynamicToolCall",
            "webSearch",
            "collabToolCall",
          ].includes(item.type)
        )
          this.emit({
            kind: "tool.result",
            toolCallId: item.id,
            toolName: item.tool ?? item.type,
            output: jsonValue(
              item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.status,
            ),
            ...(item.type === "fileChange"
              ? { diff: (item.changes ?? []).map((change: any) => change.diff ?? "").join("\n") }
              : {}),
          });
        break;
      case "error":
        this.emit({
          kind: "error",
          error: { code: "CODEX_ERROR", message: p.error?.message ?? "Codex 未知错误" },
        });
        break;
      case "warning":
        this.emit({ kind: "message.done", role: "system", text: p.message });
        break;
    }
  }
  private async serverRequest(message: RpcMessage) {
    const { method, id } = message;
    const p = message.params ?? {};
    if (id === undefined) return;
    if (!this.context) {
      this.rpc.reject(id, "Session unavailable");
      return;
    }
    if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ].includes(method ?? "")
    ) {
      const response = await this.context.approve(
        {
          toolCallId: p.itemId,
          toolName: method!.split("/")[1]!,
          input: jsonValue({
            command: p.command,
            cwd: p.cwd,
            permissions: p.permissions,
            grantRoot: p.grantRoot,
          }),
          reason: p.reason,
        },
        this.abort.signal,
      );
      if (method === "item/permissions/requestApproval")
        this.rpc.respond(id, {
          permissions: response.decision === "allow" ? (p.permissions ?? {}) : {},
          scope: "turn",
        });
      else this.rpc.respond(id, { decision: response.decision === "allow" ? "accept" : "decline" });
    } else if (method === "mcpServer/elicitation/request") {
      // Form/URL authorization cannot be reduced to a boolean tool approval.
      this.emit({
        kind: "message.done",
        role: "system",
        text: p.message ?? "MCP 需要在本地完成交互式授权",
      });
      this.rpc.respond(id, { action: "decline", content: null });
    } else if (method === "item/tool/requestUserInput") {
      this.emit({
        kind: "message.done",
        role: "system",
        text: `需要补充输入：${(p.questions ?? []).map((q: any) => q.question).join("\n")}。请继续发送消息回答。`,
      });
      this.rpc.respond(id, { answers: {} });
    } else this.rpc.reject(id, `Unsupported server request: ${method}`);
  }
  async interrupt() {
    this.interruptRequested = true;
    this.abort.abort();
    if (this.running && this.turnId && this.nativeId)
      await this.rpc.request("turn/interrupt", { threadId: this.nativeId, turnId: this.turnId });
  }
  async close() {
    await this.interrupt().catch(() => {});
    await this.rpc.close();
    this.running = false;
  }
}

export async function probeCodex(config: Config): Promise<AgentCapability> {
  const executable = Bun.which(config.codexExecutable);
  if (!executable)
    return {
      kind: "codex",
      installed: false,
      authenticated: false,
      authMessage: "请在本地安装 Codex CLI",
    };
  const process = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "ignore" });
  const version = (await new Response(process.stdout).text()).trim();
  await process.exited;
  const profileProblem = await codexProfileProblem(config);
  if (profileProblem)
    return {
      kind: "codex",
      installed: true,
      version,
      authenticated: false,
      models: [],
      authMessage: profileProblem,
    };
  const rpc = new RpcProcess();
  try {
    await rpc.start(executable, serverArgs(config), {
      env: { ...globalThis.process.env, CODEX_HOME: config.codexHome },
    });
    await rpc.request(
      "initialize",
      { clientInfo: { name: "agentpanel", title: "AgentPanel", version: "0.1.0" } },
      15_000,
    );
    rpc.notify("initialized");
    const account = await rpc.request("account/read", { refreshToken: false }, 15_000);
    const models = await rpc.request("model/list", {}, 15_000).catch(() => ({ data: [] }));
    const authenticated =
      (!!account.account || account.requiresOpenaiAuth === false) &&
      (account.account?.type === "chatgpt" || config.allowPaidApi);
    return {
      kind: "codex",
      installed: true,
      version,
      authenticated,
      models: (models.data ?? []).map((m: any) => m.model ?? m.id),
      authMessage: authenticated
        ? `已登录（${account.account?.type ?? "external-provider"}）`
        : account.account || account.requiresOpenaiAuth === false
          ? "当前模型提供方可能产生 API 费用，allowPaidApi=false"
          : "请运行 codex login",
    };
  } catch (error) {
    return {
      kind: "codex",
      installed: true,
      version,
      authenticated: false,
      authMessage: String(error),
    };
  } finally {
    await rpc.close();
  }
}
