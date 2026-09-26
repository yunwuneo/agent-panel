import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { makeEnvelope, parseEnvelope } from "../packages/protocol/src";

const root = resolve(import.meta.dir, "..");
const temp = resolve(root, ".local/protocol-check");
await mkdir(temp, { recursive: true });
await Bun.write(
  resolve(temp, "envelope.json"),
  JSON.stringify(
    makeEnvelope(
      "session.event",
      {
        kind: "tool.call",
        text: "你好，Liquid Glass 🌊",
        input: { nullable: null, list: [true, 1.25, { nested: "值" }] },
        toolName: "Edit",
      },
      { seq: 42, sessionId: "session_contract" },
    ),
  ),
);
const compiler = Bun.spawn(
  [
    "swiftc",
    "apps/apple/AgentPanel/Generated/Protocol.generated.swift",
    "apps/apple/AgentPanel/EnvelopeFactory.swift",
    "apps/apple/AgentPanel/Timeline.swift",
    "apps/apple/Tests/ProtocolChecks.swift",
    "-o",
    resolve(temp, "check"),
    "-module-cache-path",
    resolve(temp, "modules"),
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (await compiler.exited) process.exit(1);
const runner = Bun.spawn(
  [resolve(temp, "check"), resolve(temp, "envelope.json"), resolve(temp, "outgoing.json")],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (await runner.exited) process.exit(1);
const outgoing = (await Bun.file(resolve(temp, "outgoing.json")).json()).map(parseEnvelope);
if (
  outgoing[0].type !== "session.send" ||
  outgoing[0].payload.prompt !== "Swift → TS 🌊" ||
  outgoing[1].type !== "fs.listDir" ||
  outgoing[1].payload.path !== ""
)
  throw new Error("Swift outgoing command mismatch");
console.log("TypeScript: native Swift outgoing command validates, including integer timestamp");
