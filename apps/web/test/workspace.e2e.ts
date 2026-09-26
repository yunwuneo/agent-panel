import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
let fixture: ChildProcess;
let directory: string;
let info: { origin: string; ownerEmail: string; bootstrapToken: string; workspace: string };
let logs = "";
async function readEventually<T>(path: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Fixture did not become ready: ${logs.slice(-1500)}`);
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "agentpanel-browser-"));
  fixture = spawn(
    process.env.BUN_EXECUTABLE || join(root, ".tools/node_modules/.bin/bun"),
    ["apps/web/test/fixture.ts"],
    {
      cwd: root,
      env: { ...process.env, AGENTPANEL_E2E_DIRECTORY: directory },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  fixture.stdout?.on("data", (data) => {
    logs += data;
  });
  fixture.stderr?.on("data", (data) => {
    logs += data;
  });
  info = await readEventually(join(directory, "ready.json"));
  await mkdir(join(root, ".local/web-screenshots"), { recursive: true });
});
test.afterAll(async () => {
  if (fixture && fixture.exitCode === null) {
    const exited = new Promise<void>((resolve) => fixture.once("exit", () => resolve()));
    fixture.kill("SIGTERM");
    await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("real browser Passkey, pairing, approvals, replay, statistics and responsive Liquid Glass", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(info.origin);
  await expect(page.getByRole("heading", { name: "为工作空间，配一把钥匙" })).toBeVisible();
  await page.screenshot({
    path: join(root, ".local/web-screenshots/welcome-desktop.png"),
    fullPage: true,
  });
  await page.getByLabel("邮箱").fill(info.ownerEmail);
  await page.getByLabel("首次注册密钥").fill(info.bootstrapToken);
  await page.getByRole("button", { name: "创建通行密钥", exact: true }).click();
  await expect(page.getByRole("heading", { name: "保管好你的备用钥匙" })).toBeVisible();
  await page.getByRole("checkbox", { name: "我已将恢复码保存在安全的位置" }).check();
  await page.getByRole("button", { name: "进入工作空间" }).click();
  await expect(page.getByRole("heading", { name: "你的工作空间", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "连接第一台设备", exact: true }).last().click();
  await page.getByRole("button", { name: "生成配对码" }).click();
  const code = await page.locator(".pair-code code").innerText();
  await writeFile(join(directory, "pair.json"), JSON.stringify({ code }), { mode: 0o600 });
  await readEventually(join(directory, "paired.json"));
  await page.getByRole("button", { name: "关闭对话框" }).click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设备" })
    .click();
  await expect(page.getByRole("heading", { name: "Mac · 浏览器验收" })).toBeVisible();
  await expect(page.locator(".online-badge.online")).toBeVisible();
  await page.getByRole("button", { name: "重命名 Mac · 浏览器验收" }).click();
  await page.getByLabel("设备名称").fill("Mac · 专注空间");
  await page.getByRole("button", { name: "保存名称" }).click();
  await expect(page.getByRole("heading", { name: "Mac · 专注空间" })).toBeVisible();
  await page.screenshot({
    path: join(root, ".local/web-screenshots/devices-desktop.png"),
    fullPage: true,
  });
  await page.locator(".device-card").getByRole("button", { name: "新建会话" }).click();
  await page.getByPlaceholder("输入路径，或点击浏览").fill(info.workspace);
  await page.getByRole("button", { name: "浏览工作目录" }).click();
  await expect(page.getByRole("button", { name: "sample-project" })).toBeVisible();
  await page.getByRole("button", { name: "选择此目录" }).click();
  await page.getByRole("button", { name: /Codex 理解代码/ }).click();
  await page.getByLabel("想完成什么？").fill("allow");
  await page.getByRole("button", { name: "开始会话" }).click();
  await expect(page.getByText("下一步，由你决定")).toBeVisible();
  await expect(page.locator(".assistant-message")).toContainText("stream");
  await page.screenshot({
    path: join(root, ".local/web-screenshots/approval-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "允许本次操作" }).click();
  await expect(page.locator(".assistant-message")).toContainText("done allow");
  await expect(page.getByRole("textbox", { name: "发送消息", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "发送消息", exact: true }).fill("deny");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("下一步，由你决定")).toBeVisible();
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.locator(".assistant-message").last()).toContainText("done deny");
  await expect(page.getByRole("textbox", { name: "发送消息", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "发送消息", exact: true }).fill("hold");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "中断", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "中断", exact: true }).click();
  await expect(page.locator(".assistant-message").last()).toContainText("interrupted");
  await context.setOffline(true);
  await writeFile(
    join(directory, "action.json"),
    JSON.stringify({ id: "replay-check", type: "offline-event" }),
  );
  await expect
    .poll(async () => readFile(join(directory, "done-replay-check"), "utf8").catch(() => ""))
    .toBe("ok");
  await context.setOffline(false);
  // Reload is a full offline replay from persisted Relay events, with no renderer state retained.
  await page.reload();
  await expect(page.getByText("离线期间已保存的消息")).toBeVisible();
  await expect(
    page.locator(".assistant-message").filter({ hasText: "离线期间已保存的消息" }),
  ).toHaveCount(1);
  await page.getByText("Edit", { exact: true }).click();
  await expect(page.locator(".addition")).toContainText("const ready = true;");
  await page.screenshot({
    path: join(root, ".local/web-screenshots/chat-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "返回工作空间" }).click();
  await page.screenshot({
    path: join(root, ".local/web-screenshots/workspace-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "用量与洞察" })
    .click();
  await expect(page.locator(".stats-metrics")).toBeVisible();
  await expect(page.locator(".stats-metrics")).not.toContainText("NaN");
  await page.screenshot({
    path: join(root, ".local/web-screenshots/stats-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "偏好设置" })
    .click();
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("switch", { name: "减少透明度", exact: false }).check();
  await expect(page.locator("html")).toHaveAttribute("data-reduce-transparency", "true");
  await page.getByRole("switch", { name: "任务完成", exact: false }).uncheck();
  await page.getByRole("button", { name: "保存通知偏好" }).click();
  await expect(page.getByRole("status").filter({ hasText: "通知偏好已保存" })).toBeVisible();
  await page.screenshot({
    path: join(root, ".local/web-screenshots/settings-dark.png"),
    fullPage: true,
  });
  await page.getByRole("switch", { name: "减少透明度", exact: false }).uncheck();
  await page.getByRole("button", { name: "浅色", exact: true }).click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作空间" })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "你的工作空间", exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.screenshot({
    path: join(root, ".local/web-screenshots/workspace-mobile.png"),
    fullPage: true,
  });
  await page.locator(".session-row").first().click();
  await expect(page.getByText("离线期间已保存的消息")).toBeVisible();
  await page.screenshot({
    path: join(root, ".local/web-screenshots/chat-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 980 });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "偏好设置" })
    .click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "很高兴，又见到你" })).toBeVisible();
  await page.getByLabel("邮箱").fill(info.ownerEmail);
  await page.getByRole("button", { name: "使用通行密钥登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "你的工作空间", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
