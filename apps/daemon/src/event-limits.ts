import type { Json, SessionEvent } from "@agentpanel/protocol";

const fieldLimit = 64 * 1024;
const clip = (value: string) => {
  const bytes = Buffer.from(value);
  return bytes.length <= fieldLimit
    ? value
    : `${new TextDecoder().decode(bytes.subarray(0, fieldLimit), { stream: true })}\n[内容超过远程单条展示限制；完整内容保留在设备原始会话日志中]`;
};
const clipJson = (value: Json): Json => {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized) <= fieldLimit
    ? value
    : { preview: clip(serialized), truncated: true };
};

/** Keep oversized native tool output from permanently blocking Relay's 1 MiB frame limit. */
export function boundedEvent(event: SessionEvent): SessionEvent {
  return {
    ...event,
    ...(event.text ? { text: clip(event.text) } : {}),
    ...(event.diff ? { diff: clip(event.diff) } : {}),
    ...(event.input !== undefined ? { input: clipJson(event.input) } : {}),
    ...(event.output !== undefined ? { output: clipJson(event.output) } : {}),
    ...(event.error ? { error: { ...event.error, message: clip(event.error.message) } } : {}),
  };
}
