import { z } from "zod";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);
const Id = z.string().min(1).max(256);
const Timestamp = z.number().int().nonnegative();
export const AgentKindSchema = z.enum(["claude", "codex"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "plan"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export const ErrorSchema = z.object({ code: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ErrorSchema>;
export const QuotaWindowSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(100),
  usedPercent: z.number().min(0).max(100),
  windowMinutes: z.number().int().positive().optional(),
  resetsAt: Timestamp.optional(),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;
export const AgentQuotaSchema = z.object({
  status: z.enum(["loading", "available", "stale", "unavailable", "error"]),
  source: z.string().max(80).optional(),
  checkedAt: Timestamp,
  updatedAt: Timestamp.optional(),
  staleAt: Timestamp.optional(),
  retryAt: Timestamp.optional(),
  message: z.string().max(500).optional(),
  windows: z.array(QuotaWindowSchema).max(16),
});
export type AgentQuota = z.infer<typeof AgentQuotaSchema>;
export const AgentCapabilitySchema = z.object({
  kind: AgentKindSchema,
  installed: z.boolean(),
  version: z.string().optional(),
  // Legacy execution readiness; this does not describe subscription authentication.
  authenticated: z.boolean().optional(),
  executionAvailable: z.boolean().optional(),
  models: z.array(z.string()).optional(),
  authMessage: z.string().optional(),
  quota: AgentQuotaSchema.optional(),
});
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;
export const DeviceSchema = z.object({
  id: Id,
  name: z.string().min(1).max(128),
  platform: z.string(),
  hostname: z.string().optional(),
  online: z.boolean(),
  agents: z.array(AgentCapabilitySchema),
  lastSeen: Timestamp,
});
export type Device = z.infer<typeof DeviceSchema>;
export const TokenCountsSchema = z.object({
  // All input tokens, including the separately reported cached reads/writes.
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
});
export const ModelUsageSchema = TokenCountsSchema.extend({ model: z.string().optional() });
export type ModelUsage = z.infer<typeof ModelUsageSchema>;
export const UsageSchema = TokenCountsSchema.extend({
  costUsd: z.number().nonnegative().optional(),
  model: z.string().optional(),
  pricingVersion: z.string().optional(),
  turns: z.number().int().nonnegative().optional(),
  activeMs: z.number().nonnegative().optional(),
  byModel: z.array(ModelUsageSchema).optional(),
});
export type Usage = z.infer<typeof UsageSchema>;
export const UsageDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  usage: UsageSchema,
});
export type UsageDay = z.infer<typeof UsageDaySchema>;
export const SessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting",
  "completed",
  "error",
  "readonly",
]);
export const SessionSchema = z.object({
  id: Id,
  deviceId: Id,
  agent: AgentKindSchema,
  cwd: z.string(),
  title: z.string(),
  status: SessionStatusSchema,
  source: z.enum(["managed", "local"]),
  nativeId: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  readOnly: z.boolean(),
  busyReason: z.string().optional(),
  excludedReason: z.literal("quota-probe").optional(),
  usage: UsageSchema.optional(),
  usageByDay: z.array(UsageDaySchema).optional(),
});
export type Session = z.infer<typeof SessionSchema>;
export function isQuotaProbe(session: { agent: string; cwd: string; source?: string }) {
  return (
    session.agent === "claude" &&
    session.source !== "managed" &&
    session.cwd
      .replaceAll("\\", "/")
      .replace(/\/+$/, "")
      .endsWith("/Library/Application Support/CodexBar/ClaudeProbe")
  );
}
export const ModelPriceSchema = z.object({
  model: z.string().trim().min(1).max(128),
  input: z.number().finite().min(0).max(1_000_000),
  output: z.number().finite().min(0).max(1_000_000),
  cacheRead: z.number().finite().min(0).max(1_000_000),
  cacheWrite: z.number().finite().min(0).max(1_000_000),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export const SessionEventSchema = z.object({
  kind: z.enum([
    "message.delta",
    "message.done",
    "thinking.delta",
    "tool.call",
    "tool.result",
    "turn.start",
    "turn.end",
    "usage",
    "error",
  ]),
  role: z.enum(["user", "assistant", "system"]).optional(),
  text: z.string().optional(),
  messageId: Id.optional(),
  toolCallId: Id.optional(),
  toolName: z.string().optional(),
  input: JsonSchema.optional(),
  output: JsonSchema.optional(),
  diff: z.string().optional(),
  usage: UsageSchema.optional(),
  error: ErrorSchema.optional(),
  turnId: Id.optional(),
  nativeId: z.string().optional(),
  model: z.string().optional(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export const ApprovalSchema = z.object({
  id: Id,
  deviceId: Id,
  sessionId: Id,
  toolCallId: Id.optional(),
  toolName: z.string(),
  input: JsonSchema,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  status: z.enum(["pending", "allowed", "denied", "expired"]),
  reason: z.string().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
export const DirectoryEntrySchema = z.object({ name: z.string(), path: z.string() });
export const DirectoryListingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(DirectoryEntrySchema),
  roots: z.array(z.string()).optional(),
  recent: z.array(z.string()).optional(),
});
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;
export const NotificationPreferencesSchema = z.object({
  deviceId: Id.optional(),
  sessionId: Id.optional(),
  approvals: z.boolean(),
  completed: z.boolean(),
  errors: z.boolean(),
  waiting: z.boolean(),
  showContent: z.boolean(),
});
export const StatsQuerySchema = z.object({
  deviceId: Id.optional(),
  agent: AgentKindSchema.optional(),
  project: z.string().optional(),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  groupBy: z.enum(["day", "device", "agent", "project"]).optional(),
});
export const StatsBucketSchema = z.object({
  key: z.string(),
  sessions: z.number(),
  usage: UsageSchema,
});
export const StatsResultSchema = z.object({
  sessions: z.number(),
  usage: UsageSchema,
  buckets: z.array(StatsBucketSchema),
});

export const payloadSchemas = {
  "device.hello": z.object({
    name: z.string(),
    platform: z.string(),
    hostname: z.string().optional(),
    agents: z.array(AgentCapabilitySchema),
    version: z.string().optional(),
  }),
  "device.status": DeviceSchema,
  "device.refresh": z.object({}),
  "session.create": z.object({
    agent: AgentKindSchema,
    cwd: z.string().min(1),
    prompt: z.string().min(1).max(100_000),
    model: z.string().optional(),
    permissionMode: PermissionModeSchema.optional(),
    title: z.string().optional(),
  }),
  "session.resume": z.object({
    nativeId: z.string().optional(),
    prompt: z.string().max(100_000).optional(),
    model: z.string().optional(),
    permissionMode: PermissionModeSchema.optional(),
  }),
  "session.send": z.object({ prompt: z.string().min(1).max(100_000) }),
  "session.interrupt": z.object({}),
  "session.list": z.object({}),
  "session.history": z.object({
    limit: z.number().int().min(1).max(1000).optional(),
    before: Timestamp.optional(),
  }),
  "session.snapshot": z.object({ sessions: z.array(SessionSchema) }),
  "session.event": SessionEventSchema,
  "approval.request": ApprovalSchema,
  "approval.decide": z.object({
    approvalId: Id,
    decision: z.enum(["allow", "deny"]),
    reason: z.string().max(2000).optional(),
  }),
  "fs.listDir": z.object({ path: z.string() }),
  "stats.query": StatsQuerySchema,
  "stats.result": StatsResultSchema,
  result: z.object({
    requestId: Id,
    ok: z.boolean(),
    data: JsonSchema.optional(),
    error: ErrorSchema.optional(),
  }),
  ack: z.object({ ackId: Id, seq: z.number().int().nonnegative().optional() }),
  subscribe: z.object({ deviceIds: z.array(Id).optional(), sessionIds: z.array(Id).optional() }),
  ping: z.object({}),
  pong: z.object({}),
} as const;
export type MessageType = keyof typeof payloadSchemas;
const envelopeFields = {
  v: z.literal(1),
  id: Id,
  deviceId: Id.optional(),
  sessionId: Id.optional(),
  seq: z.number().int().nonnegative().optional(),
  ts: Timestamp,
};
const variants = Object.entries(payloadSchemas).map(([type, payload]) =>
  z.object({ ...envelopeFields, type: z.literal(type), payload }),
);
export const EnvelopeSchema = z.discriminatedUnion(
  "type",
  variants as [(typeof variants)[number], ...(typeof variants)[number][]],
);
export const MessageSchema = EnvelopeSchema;
export type Envelope<T extends MessageType = MessageType> = T extends MessageType
  ? {
      v: 1;
      id: string;
      type: T;
      deviceId?: string;
      sessionId?: string;
      seq?: number;
      ts: number;
      payload: z.infer<(typeof payloadSchemas)[T]>;
    }
  : never;
export type WireMessage = Envelope;
export type EnvelopeScope = {
  id?: string;
  deviceId?: string;
  sessionId?: string;
  seq?: number;
  ts?: number;
};
export function makeEnvelope<T extends MessageType>(
  type: T,
  payload: z.infer<(typeof payloadSchemas)[T]>,
  scope: EnvelopeScope = {},
): Envelope<T> {
  return { v: 1, id: crypto.randomUUID(), ts: Date.now(), ...scope, type, payload } as Envelope<T>;
}
export function parseEnvelope(value: unknown): Envelope {
  const parsed = EnvelopeSchema.parse(value) as Envelope;
  if (parsed.type === "session.event") {
    const e = parsed.payload;
    if (e.kind === "usage" && !e.usage) throw new Error("usage event requires usage");
    if (e.kind === "error" && !e.error) throw new Error("error event requires error");
  }
  return parsed;
}
export const COMMAND_TYPES = [
  "device.refresh",
  "session.create",
  "session.resume",
  "session.send",
  "session.interrupt",
  "session.list",
  "session.history",
  "fs.listDir",
  "approval.decide",
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];
export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(a.costUsd !== undefined || b.costUsd !== undefined
      ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) }
      : {}),
    turns: (a.turns ?? 0) + (b.turns ?? 0),
    activeMs: (a.activeMs ?? 0) + (b.activeMs ?? 0),
    ...(a.byModel || b.byModel
      ? { byModel: combineModelUsage(modelParts(a), modelParts(b), "add") }
      : {}),
  };
}

export function modelParts(usage: Usage): ModelUsage[] {
  if (usage.byModel) return usage.byModel;
  if (
    !usage.inputTokens &&
    !usage.outputTokens &&
    !usage.cacheReadTokens &&
    !usage.cacheWriteTokens
  )
    return [];
  return [
    {
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    },
  ];
}
export function combineModelUsage(
  a: ModelUsage[],
  b: ModelUsage[],
  operation: "add" | "max" | "subtract",
): ModelUsage[] {
  const result = new Map<string, ModelUsage>();
  for (const part of a) result.set(part.model ?? "", { ...part });
  for (const part of b) {
    const key = part.model ?? "";
    const previous = result.get(key) ?? { ...emptyUsage(), model: part.model };
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ] as const)
      previous[field] =
        operation === "add"
          ? previous[field] + part[field]
          : operation === "max"
            ? Math.max(previous[field], part[field])
            : Math.max(0, previous[field] - part[field]);
    result.set(key, previous);
  }
  return [...result.values()].filter(
    (p) => p.inputTokens || p.outputTokens || p.cacheReadTokens || p.cacheWriteTokens,
  );
}

// Named schemas form the deterministic Swift model generation input. Transport
// payloads remain JSON values until decoded using their corresponding schema.
export const SwiftEnvelopeSchema = z.object({
  ...envelopeFields,
  type: z.string(),
  payload: JsonSchema,
});
export const namedSchemas = {
  APQuotaWindow: QuotaWindowSchema,
  APAgentQuota: AgentQuotaSchema,
  APAgentCapability: AgentCapabilitySchema,
  APDevice: DeviceSchema,
  APUsage: UsageSchema,
  APModelUsage: ModelUsageSchema,
  APModelPrice: ModelPriceSchema,
  APUsageDay: UsageDaySchema,
  APSession: SessionSchema,
  APError: ErrorSchema,
  APSessionEvent: SessionEventSchema,
  APApproval: ApprovalSchema,
  APDirectoryEntry: DirectoryEntrySchema,
  APDirectoryListing: DirectoryListingSchema,
  APNotificationPreferences: NotificationPreferencesSchema,
  APStatsQuery: StatsQuerySchema,
  APStatsBucket: StatsBucketSchema,
  APStatsResult: StatsResultSchema,
  APEnvelope: SwiftEnvelopeSchema,
};
