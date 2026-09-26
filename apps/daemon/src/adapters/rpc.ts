import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string };
};
export class RpcProcess {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private stderr = "";
  onMessage: (message: RpcMessage) => void = () => {};
  onExit: (error: Error) => void = () => {};
  async start(
    executable: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.process = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "pipe",
      windowsHide: true,
    });
    this.process.stderr.on("data", (data) => {
      this.stderr = (this.stderr + String(data)).slice(-4000);
    });
    createInterface({ input: this.process.stdout, crlfDelay: Infinity }).on("line", (line) => {
      try {
        const message = JSON.parse(line) as RpcMessage;
        if (typeof message.id === "number" && !message.method && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          clearTimeout(pending.timeout);
          if (message.error)
            pending.reject(new Error(`Codex ${message.error.code}: ${message.error.message}`));
          else pending.resolve(message.result);
        } else this.onMessage(message);
      } catch {
        /* A non-JSON diagnostic line is not a protocol event. */
      }
    });
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", (code, signal) =>
      this.fail(new Error(`Codex app-server 已退出（${code ?? signal}）`)),
    );
    await new Promise<void>((resolve, reject) => {
      this.process!.once("spawn", resolve);
      this.process!.once("error", reject);
    });
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.onExit(error);
  }
  request(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 请求超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, params: Record<string, unknown> = {}) {
    this.write({ method, params });
  }
  respond(id: number | string, result: unknown) {
    this.write({ id, result });
  }
  reject(id: number | string, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }
  private write(message: unknown) {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server 未连接");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
  async close() {
    if (!this.process || this.process.exitCode !== null) return;
    this.onExit = () => {};
    this.process.stdin.end();
    const child = this.process;
    const timeout = setTimeout(() => child.kill("SIGTERM"), 2000);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    clearTimeout(timeout);
  }
}
