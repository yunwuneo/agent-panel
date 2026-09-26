import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const unit = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("\n", "\\n")}"`;
export const serviceName = "cn.agentpanel.daemon";
export type ServicePlan = {
  path: string;
  content: string;
  install: string[][];
  uninstall: string[][];
};
export function servicePlan(
  os: NodeJS.Platform,
  argv: string[],
  configPath: string,
  home = homedir(),
  uid = process.getuid?.() ?? 0,
): ServicePlan {
  const args = [...argv, "run", "--config", configPath];
  if (args.some((arg) => /[\0\r\n]/.test(arg))) throw new Error("服务参数含非法控制字符");
  if (os === "darwin") {
    const path = join(home, "Library", "LaunchAgents", `${serviceName}.plist`);
    const log = join(dirname(configPath), "daemon.log");
    return {
      path,
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${serviceName}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string></dict><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`,
      install: [["launchctl", "bootstrap", `gui/${uid}`, path]],
      uninstall: [["launchctl", "bootout", `gui/${uid}/${serviceName}`]],
    };
  }
  if (os === "linux") {
    const path = join(home, ".config", "systemd", "user", "agentpaneld.service");
    return {
      path,
      content: `[Unit]\nDescription=AgentPanel device daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${args.map(unit).join(" ")}\nEnvironment=PATH=${unit(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}\nRestart=always\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
      install: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "agentpaneld.service"],
      ],
      uninstall: [["systemctl", "--user", "disable", "--now", "agentpaneld.service"]],
    };
  }
  if (os === "win32") {
    const path = join(dirname(configPath), "agentpaneld-task.xml");
    const quoteWin = (value: string) =>
      `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
    return {
      path,
      content: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>AgentPanel device daemon</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(args[0]!)}</Command><Arguments>${xml(args.slice(1).map(quoteWin).join(" "))}</Arguments></Exec></Actions></Task>`,
      install: [
        ["schtasks.exe", "/Create", "/TN", "AgentPanel", "/XML", path, "/F"],
        ["schtasks.exe", "/Run", "/TN", "AgentPanel"],
      ],
      uninstall: [
        ["schtasks.exe", "/End", "/TN", "AgentPanel"],
        ["schtasks.exe", "/Delete", "/TN", "AgentPanel", "/F"],
      ],
    };
  }
  throw new Error(`尚不支持系统服务：${os}`);
}
async function execute(args: string[], tolerateFailure = false) {
  const process = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  const code = await process.exited;
  if (code && !tolerateFailure) throw new Error(`${args[0]} 退出状态 ${code}`);
}
export async function installService(plan: ServicePlan, os = process.platform) {
  await mkdir(dirname(plan.path), { recursive: true, mode: 0o700 });
  await writeFile(
    plan.path,
    os === "win32" ? Buffer.from(`\ufeff${plan.content}`, "utf16le") : plan.content,
    { mode: 0o600 },
  );
  for (const command of plan.install) await execute(command);
}
export async function uninstallService(plan: ServicePlan) {
  for (const command of plan.uninstall) await execute(command, true);
  await rm(plan.path, { force: true });
  if (process.platform === "linux") await execute(["systemctl", "--user", "daemon-reload"]);
}
