import type { SessionEvent } from "@agentpanel/protocol";
import type { AdapterContext, AgentAdapter } from "../../daemon/src/adapters/types";

/** The actual manager, approval broker, journals and transports run unchanged.
 * Only the external model provider is replaced by this deterministic adapter. */
export class ControlledAdapter implements AgentAdapter {
  nativeId = "controlled-native-session";
  running = false;
  context?: AdapterContext;
  prompts: string[] = [];
  private release?: () => void;
  private interrupted = false;
  async start(context: AdapterContext) {
    this.context = context;
  }
  async send(prompt: string) {
    const context = this.context!;
    this.running = true;
    this.interrupted = false;
    this.prompts.push(prompt);
    const turn = this.prompts.length;
    context.emit({ kind: "turn.start", turnId: `turn-${turn}`, nativeId: this.nativeId });
    context.emit({ kind: "message.done", role: "user", text: prompt, messageId: `user-${turn}` });
    context.emit({
      kind: "message.delta",
      role: "assistant",
      text: "stream ",
      messageId: `assistant-${turn}`,
    });
    if (prompt === "hold")
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    else if (prompt === "allow" || prompt === "deny") {
      context.emit({
        kind: "tool.call",
        toolName: "ControlledTool",
        input: { operation: prompt },
        toolCallId: `tool-${turn}`,
      });
      const decision = await context.approve({
        toolName: "ControlledTool",
        input: { operation: prompt },
        toolCallId: `tool-${turn}`,
      });
      context.emit({
        kind: "tool.result",
        toolName: "ControlledTool",
        toolCallId: `tool-${turn}`,
        output: { decision: decision.decision },
      });
    }
    context.emit({
      kind: "message.done",
      role: "assistant",
      text: this.interrupted ? "interrupted" : `done ${prompt}`,
      messageId: `assistant-${turn}`,
    });
    context.emit({
      kind: "usage",
      usage: {
        inputTokens: turn * 10,
        outputTokens: turn * 5,
        cacheReadTokens: turn,
        cacheWriteTokens: 0,
        turns: turn,
        activeMs: turn * 100,
        costUsd: turn / 1000,
        pricingVersion: "controlled-test",
      },
    });
    this.running = false;
    context.emit({
      kind: "turn.end",
      text: this.interrupted ? "interrupted" : "completed",
      turnId: `turn-${turn}`,
    });
  }
  emit(event: SessionEvent) {
    this.context!.emit(event);
  }
  async interrupt() {
    this.interrupted = true;
    this.release?.();
    this.release = undefined;
  }
  async close() {
    await this.interrupt();
  }
}
