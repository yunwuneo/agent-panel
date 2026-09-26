import { stat } from "node:fs/promises";
import type { IndexedSession } from "./indexer";

export type Occupancy = { busy: boolean; reason?: string };
/** Conservative heuristic: active file handles, explicit resume command lines, and fresh writes. */
export async function detectOccupancy(
  session: IndexedSession,
  now = Date.now(),
): Promise<Occupancy> {
  const file = await stat(session.logPath).catch(() => undefined);
  if (!file) return { busy: true, reason: "无法确认本地日志的状态，保持只读" };
  if (now - file.mtimeMs < 30_000) return { busy: true, reason: "本地会话最近 30 秒仍有写入" };
  if (process.platform === "win32") {
    const probe = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    try {
      const text = await new Response(probe.stdout).text();
      if ((await probe.exited) !== 0) return { busy: true, reason: "无法获取进程状态，保持只读" };
      const rows = JSON.parse(text);
      if (
        (Array.isArray(rows) ? rows : [rows]).some(
          (row) => row.ProcessId !== process.pid && row.CommandLine?.includes(session.nativeId),
        )
      )
        return { busy: true, reason: "检测到持有会话 ID 的本地进程" };
      // Windows cannot reliably identify open JSONL handles without elevation.
      return {
        busy: true,
        reason: "Windows 本地会话占用无法可靠确认，保留只读；新建会话可正常操作",
      };
    } catch {
      return { busy: true, reason: "无法验证本地进程，保持只读" };
    }
  }
  const lsof = Bun.which("lsof");
  if (!lsof) return { busy: true, reason: "未安装 lsof，无法确认日志占用" };
  const proc = Bun.spawn([lsof, "-t", "--", session.logPath], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0 && code !== 1) return { busy: true, reason: "日志占用检测失败" };
  if (output.split(/\s+/).some((pid) => pid && Number(pid) !== process.pid))
    return { busy: true, reason: "本地进程正在使用该会话日志" };
  const ps = Bun.spawn(["ps", "-axo", "pid=,args="], { stdout: "pipe", stderr: "ignore" });
  const lines = await new Response(ps.stdout).text();
  if ((await ps.exited) !== 0) return { busy: true, reason: "进程扫描失败" };
  if (
    session.nativeId &&
    lines.split("\n").some((line) => {
      const parts = line.trim().split(/\s+/);
      const executable = parts[1] ?? "";
      return (
        Number(parts[0]) !== process.pid &&
        /(?:^|[\\/])(?:claude|codex)(?:\.exe)?$/.test(executable) &&
        line.includes(session.nativeId ?? "")
      );
    })
  )
    return { busy: true, reason: "检测到正在继续该会话的进程" };
  return { busy: false };
}
