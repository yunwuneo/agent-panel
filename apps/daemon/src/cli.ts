#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { type Envelope, makeEnvelope } from "@agentpanel/protocol";
import { probeClaude } from "./adapters/claude";
import { probeCodex } from "./adapters/codex";
import { configSchema, defaultConfigPath, loadConfig, pair, saveConfig, version } from "./config";
import { SessionManager } from "./manager";
import { installService, servicePlan, uninstallService } from "./services";
import { Store } from "./store";
import { RelayConnection } from "./transport";
import { installUpdate, stageUpdate } from "./updater";

const help = `AgentPanel daemon ${version}

  agentpaneld init [--relay http://localhost:8787] [--config PATH] [--codex-home PATH] [--codex-provider openai]
  agentpaneld pair --code CODE [--relay URL] [--name NAME]
  agentpaneld run [--config PATH]
  agentpaneld doctor [--json]                  检查安装和认证，不发起模型调用
  agentpaneld index [--json]                   扫描本地会话，不继续任何会话
  agentpaneld debug --agent codex --cwd DIR --prompt TEXT [--resume ID]
  agentpaneld install|uninstall [--preview]    当前用户的系统服务
  agentpaneld update                          验签并安装已配置来源的更新

通用选项：--config PATH，默认 ~/.agentpanel/config.json。
debug 默认拒绝需要审批的工具；--interactive 可在 stdin 输入 allow/deny 审批 ID。
Claude API/云服务与 Codex API 调用必须在配置中显式设置 allowPaidApi=true。
默认 roots=["*"] 允许所有目录；可改为绝对路径列表。`;

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      relay: { type: "string" },
      code: { type: "string" },
      name: { type: "string" },
      agent: { type: "string" },
      cwd: { type: "string" },
      prompt: { type: "string" },
      resume: { type: "string" },
      model: { type: "string" },
      "permission-mode": { type: "string" },
      interactive: { type: "boolean" },
      preview: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
      version: { type: "boolean" },
      "codex-home": { type: "string" },
      "codex-provider": { type: "string" },
    },
  });
  const command = positionals[0] ?? "help";
  if (values.version) {
    console.log(version);
    return;
  }
  if (command === "help" || values.help) {
    console.log(help);
    return;
  }
  const configPath = resolve(values.config ?? defaultConfigPath());
  let config = await loadConfig(configPath);
  if (values.relay) config.relayUrl = values.relay;
  if (values.name) config.name = values.name;
  if (values["codex-home"]) config.codexHome = resolve(values["codex-home"]);
  if (values["codex-provider"]) config.codexModelProvider = values["codex-provider"];
  config = configSchema.parse(config);
  if (command === "init") {
    await saveConfig(config, configPath);
    console.log(`配置已保存：${configPath}`);
    return;
  }
  if (command === "pair") {
    if (!values.code) throw new Error("请通过 --code 提供客户端生成的配对码");
    const paired = await pair(config, values.code, configPath);
    console.log(`设备已配对：${paired.deviceId}`);
    return;
  }
  if (command === "doctor") {
    const agents = await Promise.all([probeClaude(config), probeCodex(config)]);
    console.log(
      JSON.stringify(
        {
          version,
          platform: process.platform,
          arch: process.arch,
          paired: !!config.deviceToken,
          roots: config.roots,
          agents,
        },
        null,
        values.json ? undefined : 2,
      ),
    );
    return;
  }
  if (["install", "uninstall"].includes(command)) {
    const entry = process.argv[1];
    const launch = entry?.endsWith(".ts") ? [process.execPath, resolve(entry)] : [process.execPath];
    const plan = servicePlan(process.platform, launch, configPath);
    if (values.preview) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    if (command === "install") await installService(plan);
    else await uninstallService(plan);
    console.log(
      command === "install"
        ? "AgentPanel 用户服务已安装并启动"
        : "AgentPanel 用户服务已卸载；配置和历史保留",
    );
    return;
  }
  if (command === "update") {
    if (process.argv[1]?.endsWith(".ts"))
      throw new Error("源码开发模式请更新仓库；自动更新仅用于单文件可执行程序");
    const staged = await stageUpdate(config, process.execPath);
    if (staged) {
      const status = await installUpdate(staged.path, process.execPath, [
        "run",
        "--config",
        configPath,
      ]);
      console.log(
        status === "scheduled"
          ? `已验证 ${staged.version}，进程退出后替换并重新启动；上一版本保留为 .previous`
          : `已安装 ${staged.version}，重启 daemon 后生效；上一版本保留为 .previous`,
      );
    }
    return;
  }
  if (!["run", "debug", "index"].includes(command))
    throw new Error(`未知命令 ${command}；使用 --help 查看帮助`);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const lockPath = `${configPath}.lock`;
  let locked = false;
  if (command === "run") {
    try {
      const previous = JSON.parse(await readFile(lockPath, "utf8"));
      if (typeof previous.pid === "number") {
        try {
          process.kill(previous.pid, 0);
          throw new Error(`此配置的 daemon 已运行（PID ${previous.pid}）`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await rm(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
    locked = true;
  }
  const deviceNamespace = createHash("sha256")
    .update(config.deviceId ?? "unpaired")
    .digest("hex")
    .slice(0, 16);
  const store = new Store(
    `${configPath}.${command === "debug" ? "debug" : deviceNamespace}.sqlite`,
  );
  let connection: RelayConnection | undefined;
  let manager: SessionManager;
  let closeStarted = false;
  let updateTimer: ReturnType<typeof setInterval> | undefined;
  const close = async () => {
    if (closeStarted) return;
    closeStarted = true;
    if (updateTimer) clearInterval(updateTimer);
    await connection?.close();
    await manager?.close();
    store.close();
    if (locked) await rm(lockPath, { force: true });
  };
  let finished: (() => void) | undefined;
  let debugFailed = false;
  const complete = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const publish = (message: Envelope) => {
    if (command === "debug") {
      console.log(JSON.stringify(message));
      if (message.type === "session.event" && message.payload.kind === "error") debugFailed = true;
      if (
        message.type === "approval.request" &&
        message.payload.status === "pending" &&
        !values.interactive
      )
        queueMicrotask(() =>
          manager.approvals.decide(message.payload.id, message.payload.sessionId, {
            decision: "deny",
            reason: "调试 CLI 未启用交互式审批",
          }),
        );
      if (message.type === "session.event" && message.payload.kind === "turn.end") finished?.();
    } else if (command === "run") {
      store.enqueue(message);
      connection?.publish(message);
    }
  };
  manager = new SessionManager(config, store, publish);
  const stop = () => {
    finished?.();
    void close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (command === "index") {
      await manager.indexer.scan();
      const sessions = [...manager.sessions.values()];
      console.log(
        JSON.stringify(
          values.json
            ? sessions
            : {
                count: sessions.length,
                agents: {
                  claude: sessions.filter((s) => s.agent === "claude").length,
                  codex: sessions.filter((s) => s.agent === "codex").length,
                },
              },
          null,
          values.json ? undefined : 2,
        ),
      );
      return;
    }
    if (command === "debug") {
      if (!values.cwd || !values.prompt || !["claude", "codex"].includes(values.agent ?? ""))
        throw new Error("debug 需要 --agent claude|codex --cwd DIR --prompt TEXT");
      const permissionMode = values["permission-mode"] ?? "default";
      if (!["default", "acceptEdits", "plan"].includes(permissionMode))
        throw new Error("未知权限模式");
      const sessionId = `debug_${crypto.randomUUID()}`;
      if (values.resume) {
        await manager.indexer.scan();
        const session = [...manager.sessions.values()].find(
          (s) => s.nativeId === values.resume && s.agent === values.agent,
        );
        if (!session) throw new Error("未找到待继续会话");
        await manager.command(
          makeEnvelope(
            "session.resume",
            {
              nativeId: values.resume,
              prompt: values.prompt,
              model: values.model,
              permissionMode: permissionMode as "default" | "acceptEdits" | "plan",
            },
            { sessionId: session.id },
          ),
        );
      } else
        await manager.command(
          makeEnvelope(
            "session.create",
            {
              agent: values.agent as "claude" | "codex",
              cwd: resolve(values.cwd),
              prompt: values.prompt,
              model: values.model,
              permissionMode: permissionMode as "default" | "acceptEdits" | "plan",
            },
            { sessionId },
          ),
        );
      const input = values.interactive
        ? createInterface({ input: process.stdin, crlfDelay: Infinity })
        : undefined;
      input?.on("line", (line) => {
        const [decision, id] = line.trim().split(/\s+/);
        const pending = id ? manager.approvals.pending.get(id) : undefined;
        if (pending && ["allow", "deny"].includes(decision ?? "")) {
          try {
            manager.approvals.decide(id!, pending.approval.sessionId, {
              decision: decision as "allow" | "deny",
            });
          } catch (error) {
            console.error(String(error));
          }
        }
      });
      await complete;
      input?.close();
      if (debugFailed) throw new Error("调试会话运行失败，详情见输出的统一错误事件");
      return;
    }
    const agents = await Promise.all([probeClaude(config), probeCodex(config)]);
    connection = new RelayConnection(config, store, manager, agents);
    connection.start();
    await manager.start();
    if (config.autoUpdate) {
      updateTimer = setInterval(
        () =>
          void (async () => {
            if (
              [...manager.adapters.values()].some((adapter) => adapter.running) ||
              manager.approvals.pending.size ||
              process.argv[1]?.endsWith(".ts")
            )
              return;
            const staged = await stageUpdate(config, process.execPath);
            if (staged) {
              await installUpdate(staged.path, process.execPath, ["run", "--config", configPath]);
              await close();
              process.exit(0);
            }
          })().catch((error) => console.error("自动更新未应用：", String(error))),
        6 * 60 * 60 * 1000,
      );
    }
    await complete;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await close();
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
