import type { Approval, Json } from "@agentpanel/protocol";
import type { ApprovalDecision } from "./adapters/types";

type Pending = { approval: Approval; settle: (decision: ApprovalDecision) => void };
export class ApprovalBroker {
  readonly pending = new Map<string, Pending>();
  constructor(
    private publish: (approval: Approval) => void,
    private timeoutMs: number,
  ) {}
  request(
    deviceId: string,
    sessionId: string,
    tool: { toolName: string; input: Json; toolCallId?: string; reason?: string },
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (Buffer.byteLength(JSON.stringify(tool.input)) > 512 * 1024)
      return Promise.resolve({
        decision: "deny",
        reason: "工具输入过大，无法完整展示远程审批；请在设备本地审核",
      });
    if (signal?.aborted) return Promise.resolve({ decision: "deny", reason: "任务已中断" });
    const approval: Approval = {
      id: crypto.randomUUID(),
      deviceId,
      sessionId,
      ...tool,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.timeoutMs,
      status: "pending",
    };
    return new Promise((resolve) => {
      const finish = (decision: ApprovalDecision, expired = false) => {
        if (!this.pending.delete(approval.id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.publish({
          ...approval,
          status: expired ? "expired" : decision.decision === "allow" ? "allowed" : "denied",
          reason: decision.reason ?? approval.reason,
        });
        resolve(decision);
      };
      const abort = () => finish({ decision: "deny", reason: "任务已中断" });
      const timer = setTimeout(
        () => finish({ decision: "deny", reason: "审批已过期" }, true),
        this.timeoutMs,
      );
      this.pending.set(approval.id, { approval, settle: finish });
      signal?.addEventListener("abort", abort, { once: true });
      this.publish(approval);
    });
  }
  decide(approvalId: string, sessionId: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(approvalId);
    if (!pending) throw new Error("审批已结束或不存在");
    if (pending.approval.sessionId !== sessionId) throw new Error("审批不属于该会话");
    if (Date.now() >= pending.approval.expiresAt) throw new Error("审批已过期");
    pending.settle(decision);
  }
  cancelSession(sessionId: string) {
    for (const { approval, settle } of this.pending.values())
      if (approval.sessionId === sessionId) settle({ decision: "deny", reason: "会话已停止" });
  }
  close() {
    for (const { settle } of this.pending.values())
      settle({ decision: "deny", reason: "设备服务已停止" });
  }
}
