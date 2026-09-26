#!/usr/bin/env bun
/** Test-only JSON-RPC fixture. Production code never selects or imports it. */
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("codex-test-fixture 0.1.0");
  process.exit(0);
}
let active: { threadId: string; turnId: string; prompt: string } | undefined;
let pendingApproval: number | undefined;
let counter = 0;
const send = (message: unknown) => console.log(JSON.stringify(message));
const notify = (method: string, params: unknown) => send({ method, params });
const complete = (text: string, status = "completed") => {
  if (!active) return;
  const { threadId, turnId } = active;
  notify("item/agentMessage/delta", {
    threadId,
    turnId,
    itemId: `message_${turnId}`,
    delta: text.slice(0, 4),
  });
  notify("item/agentMessage/delta", {
    threadId,
    turnId,
    itemId: `message_${turnId}`,
    delta: text.slice(4),
  });
  notify("item/completed", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: `message_${turnId}`, text },
  });
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      total: {
        inputTokens: 100 * counter,
        outputTokens: 20 * counter,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 0,
      },
    },
  });
  notify("turn/completed", { threadId, turn: { id: turnId, status } });
  active = undefined;
};
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request: any;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  const { id, method, params: p = {} } = request;
  if (!method) {
    if (id === pendingApproval) {
      pendingApproval = undefined;
      complete(
        request.result?.decision === "accept"
          ? "测试审批已允许，任务完成。"
          : "测试审批已拒绝，未执行命令。",
      );
    }
    continue;
  }
  const reply = (result: unknown) => send({ id, result });
  if (method === "initialize")
    reply({
      userAgent: "agentpanel-test-fixture",
      platformFamily: process.platform,
      platformOs: process.platform,
    });
  else if (method === "initialized") continue;
  else if (method === "account/read")
    reply({
      account: { type: "chatgpt", email: "fixture@example.invalid", planType: "test" },
      requiresOpenaiAuth: true,
    });
  else if (method === "model/list")
    reply({
      data: [{ id: "fixture-model", model: "fixture-model", isDefault: true }],
      nextCursor: null,
    });
  else if (method === "thread/start" || method === "thread/resume")
    reply({
      thread: { id: p.threadId ?? `fixture_${crypto.randomUUID()}` },
      model: "fixture-model",
      modelProvider: "openai",
    });
  else if (method === "turn/start") {
    counter++;
    active = { threadId: p.threadId, turnId: `turn_${counter}`, prompt: p.input?.[0]?.text ?? "" };
    reply({ turn: { id: active.turnId, status: "inProgress" } });
    notify("turn/started", { threadId: active.threadId, turn: { id: active.turnId } });
    if (/approval|审批/.test(active.prompt)) {
      pendingApproval = 7000 + counter;
      notify("item/started", {
        threadId: active.threadId,
        turnId: active.turnId,
        item: {
          id: `call_${counter}`,
          type: "commandExecution",
          command: "echo fixture",
          cwd: p.cwd,
          status: "inProgress",
        },
      });
      send({
        id: pendingApproval,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: active.threadId,
          turnId: active.turnId,
          itemId: `call_${counter}`,
          command: "echo fixture",
          cwd: p.cwd,
          reason: "测试审批流程；不会实际启动命令",
        },
      });
    } else if (!/interrupt|中断/.test(active.prompt))
      setTimeout(() => complete("AgentPanel 流式测试已完成。"), 50);
  } else if (method === "turn/interrupt") {
    reply({});
    complete("任务已中断。", "interrupted");
  } else
    send({ id, error: { code: -32601, message: `Test fixture does not implement ${method}` } });
}
