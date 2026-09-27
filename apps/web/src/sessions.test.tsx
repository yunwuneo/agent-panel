import { expect, test } from "bun:test";
import { type Device, type Session, SessionSchema } from "@agentpanel/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { Workspace } from "./Sessions";

test("the workspace counts a running local read-only session and removes it on completion", () => {
  const local = SessionSchema.parse({
    id: "local",
    deviceId: "d",
    agent: "codex",
    cwd: "/tmp",
    title: "Local work",
    source: "local",
    status: "running",
    readOnly: true,
    createdAt: 1,
    updatedAt: 1,
  });
  const device = { id: "d", name: "Device", online: true, platform: "macOS", agents: [] } as Device;
  const render = (session: Session) =>
    renderToStaticMarkup(
      <Workspace
        sessions={[session]}
        devices={[device]}
        approvals={[]}
        onSelect={() => {}}
        onNew={() => {}}
        onPair={() => {}}
      />,
    );
  expect(render(local)).toContain("正在进行</small><strong>1<span> 个会话");
  expect(render({ ...local, status: "completed" })).toContain(
    "正在进行</small><strong>0<span> 个会话",
  );
});
