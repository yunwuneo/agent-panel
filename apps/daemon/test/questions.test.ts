import { expect, test } from "bun:test";
import { makeEnvelope, parseEnvelope, type Question } from "@agentpanel/protocol";
import { askUserQuestions, ClaudeAdapter, claudeAnswers } from "../src/adapters/claude";
import { CodexAdapter, codexQuestions } from "../src/adapters/codex";
import { RpcProcess } from "../src/adapters/rpc";
import type { AdapterContext } from "../src/adapters/types";
import { configSchema } from "../src/config";

const config = (input: Record<string, unknown> = {}) => configSchema.parse({ ...input });
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const ask = {
  questions: [
    {
      question: "用哪个数据库？",
      header: "数据库",
      options: [
        { label: "Postgres", description: "关系型" },
        { label: "SQLite", description: "嵌入式" },
      ],
      multiSelect: false,
    },
    {
      question: "启用哪些功能？",
      header: "功能",
      options: [
        { label: "缓存", description: "" },
        { label: "日志", description: "" },
      ],
      multiSelect: true,
    },
  ],
};

test("AskUserQuestion 归一化为问题，答案按问题文本回填，多选以逗号连接", () => {
  const questions = askUserQuestions(ask)!;
  expect(questions.map((q) => q.id)).toEqual(["用哪个数据库？", "启用哪些功能？"]);
  expect(questions[1]).toMatchObject({ multiSelect: true, allowOther: true, header: "功能" });
  expect(() =>
    parseEnvelope(
      makeEnvelope("approval.request", {
        id: "a",
        deviceId: "d",
        sessionId: "s",
        toolName: "AskUserQuestion",
        input: {},
        createdAt: 1,
        expiresAt: 2,
        status: "pending",
        questions,
      }),
    ),
  ).not.toThrow();
  expect(claudeAnswers(questions, { [questions[0]!.id]: ["SQLite"] })).toBeUndefined();
  expect(
    claudeAnswers(questions, {
      [questions[0]!.id]: ["SQLite"],
      [questions[1]!.id]: ["缓存", " 自定义 "],
    }),
  ).toEqual({ "用哪个数据库？": "SQLite", "启用哪些功能？": "缓存, 自定义" });
  expect(askUserQuestions({ questions: [] })).toBeUndefined();
});

test("Claude canUseTool 对 AskUserQuestion 发起问题审批并以 updatedInput.answers 放行", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test";
  let opts: any;
  const results: any[] = [];
  const requests: Parameters<AdapterContext["approve"]>[0][] = [];
  const adapter = new ClaudeAdapter(config({ allowPaidApi: true }), (args) => {
    opts = args.options;
    return {
      interrupt: async () => {},
      close: () => {},
      async *[Symbol.asyncIterator]() {
        yield { type: "system", session_id: "native" };
        const signal = new AbortController().signal;
        results.push(await opts.canUseTool("AskUserQuestion", ask, { signal, toolUseID: "q1" }));
        results.push(await opts.canUseTool("AskUserQuestion", ask, { signal, toolUseID: "q2" }));
        yield { type: "result", session_id: "native", subtype: "success", is_error: false };
      },
    };
  });
  let call = 0;
  try {
    await adapter.start({
      cwd: "/tmp",
      permissionMode: "default",
      emit: () => {},
      approve: async (tool) => {
        requests.push(tool);
        return call++ === 0
          ? {
              decision: "allow",
              answers: { "用哪个数据库？": ["Postgres"], "启用哪些功能？": ["日志"] },
            }
          : { decision: "deny" };
      },
    });
    await adapter.send("hello");
    while (adapter.running) await tick();
    expect(requests[0]?.questions?.length).toBe(2);
    expect(results[0]).toEqual({
      behavior: "allow",
      updatedInput: { ...ask, answers: { "用哪个数据库？": "Postgres", "启用哪些功能？": "日志" } },
    });
    expect(results[1].behavior).toBe("deny");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
    await adapter.close();
  }
});

test("Codex request_user_input 转为问题审批；敏感问题保留本地处理", async () => {
  expect(
    codexQuestions([{ id: "k", header: "", question: "Token?", isSecret: true }]),
  ).toBeUndefined();
  class FakeRpc extends RpcProcess {
    responses: { id: number | string; result: unknown }[] = [];
    override async start() {}
    override async close() {}
    override notify() {}
    override request(method: string) {
      return Promise.resolve(
        method === "account/read"
          ? { account: { type: "chatgpt" } }
          : method === "thread/start"
            ? { thread: { id: "native" }, modelProvider: "openai" }
            : method === "turn/start"
              ? { turn: { id: "turn" } }
              : {},
      );
    }
    override respond(id: number | string, result: unknown) {
      this.responses.push({ id, result });
    }
  }
  const rpc = new FakeRpc();
  let asked: Question[] | undefined;
  const adapter = new CodexAdapter(config(), rpc);
  await adapter.start({
    cwd: "/tmp",
    permissionMode: "default",
    emit: () => {},
    approve: async (tool) => {
      asked = tool.questions;
      return { decision: "allow", answers: { env: ["staging"], note: ["  先备份  "] } };
    },
  });
  await adapter.send("hello");
  rpc.onMessage({
    id: 7,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "native",
      turnId: "turn",
      itemId: "item",
      isBlocking: true,
      questions: [
        {
          id: "env",
          header: "环境",
          question: "部署到哪里？",
          options: [
            { label: "staging", description: "" },
            { label: "prod", description: "" },
          ],
        },
        { id: "note", header: "备注", question: "还有什么要求？", options: null },
      ],
    },
  });
  await tick();
  expect(asked?.map((q) => [q.id, q.allowOther])).toEqual([
    ["env", false],
    ["note", true],
  ]);
  expect(rpc.responses).toEqual([
    {
      id: 7,
      result: { answers: { env: { answers: ["staging"] }, note: { answers: ["先备份"] } } },
    },
  ]);
  await adapter.close();
});
