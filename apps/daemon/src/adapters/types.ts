import type {
  AgentCapability,
  Json,
  PermissionMode,
  SessionEvent,
  Usage,
} from "@agentpanel/protocol";

export type ApprovalDecision = { decision: "allow" | "deny"; reason?: string };
export type AdapterContext = {
  cwd: string;
  nativeId?: string;
  model?: string;
  permissionMode: PermissionMode;
  usage?: Usage;
  emit(event: SessionEvent): void;
  approve(
    tool: { toolName: string; input: Json; toolCallId?: string; reason?: string },
    signal?: AbortSignal,
  ): Promise<ApprovalDecision>;
};
export interface AgentAdapter {
  readonly nativeId?: string;
  readonly running: boolean;
  start(context: AdapterContext): Promise<void>;
  send(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
export type CapabilityProbe = () => Promise<AgentCapability>;
export function jsonValue(value: unknown): Json {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as Json;
}
