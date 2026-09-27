import type { AgentKind } from "@agentpanel/protocol";

/** Internal log evidence, independent of whether AgentPanel may write to the session. */
export type LocalActivity = {
  status: "running" | "completed" | "error";
  at: number;
  turnId?: string;
};

export function localActivity(
  agent: AgentKind,
  record: Record<string, any>,
  previous: LocalActivity | undefined,
  at: number,
): LocalActivity | undefined {
  const p = record.payload ?? {};
  const set = (status: LocalActivity["status"], turnId = previous?.turnId): LocalActivity => ({
    status,
    at,
    ...(turnId ? { turnId } : {}),
  });
  if (agent === "codex") {
    if (record.type === "event_msg") {
      if (p.type === "task_started") return set("running", p.turn_id);
      // A delayed terminal record for a preceding turn must not finish a newer turn.
      if (p.turn_id && previous?.turnId && p.turn_id !== previous.turnId) return previous;
      if (["task_complete", "task_completed", "turn_aborted"].includes(p.type))
        return set(previous?.status === "error" ? "error" : "completed");
      if (["task_failed", "turn_failed"].includes(p.type)) return set("error");
      if (p.type === "user_message") return set("running");
      if (p.type === "agent_message" && ["final", "final_answer"].includes(p.phase))
        return set("completed");
    }
    if (record.type === "turn_context" && p.turn_id !== previous?.turnId)
      return set("running", p.turn_id);
    if (record.type === "response_item") {
      if (p.type === "message" && p.role === "assistant") {
        if (["final", "final_answer"].includes(p.phase)) return set("completed");
        if (!previous || previous.status === "running") return set("running");
      }
      if (
        [
          "reasoning",
          "function_call",
          "custom_tool_call",
          "function_call_output",
          "custom_tool_call_output",
        ].includes(p.type) &&
        (!previous || previous.status === "running")
      )
        return set("running");
    }
    // Accounting, settings and item_completed records may arrive after task_complete.
    return previous;
  }

  if (record.isSidechain || record.isMeta) return previous;
  const message = record.message ?? {};
  const content = message.content;
  const parts: Record<string, any>[] = Array.isArray(content) ? content : [];
  if (record.type === "user") {
    const text = typeof content === "string" ? content : parts.map((p) => p.text ?? "").join("\n");
    if (/^\[Request interrupted by user(?: for tool use)?\]/.test(text)) return set("completed");
    if (parts.some((p) => p.type === "tool_result"))
      return previous?.status === "running" ? set("running") : previous;
    if (text.trim()) return set("running", record.uuid);
  }
  if (record.type === "assistant") {
    if (record.isApiErrorMessage) return set("error");
    if (["end_turn", "stop_sequence", "max_tokens"].includes(message.stop_reason))
      return set("completed");
    return set("running");
  }
  if (record.type === "system" && record.subtype === "turn_duration")
    return set(previous?.status === "error" ? "error" : "completed");
  if (record.type === "result") return set(record.is_error ? "error" : "completed");
  return previous;
}
