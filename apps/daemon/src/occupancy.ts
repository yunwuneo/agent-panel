import { stat } from "node:fs/promises";
import type { IndexedSession } from "./indexer";

export type Occupancy = {
  busy: boolean;
  reason?: string;
  /** Positive liveness evidence. Probe failures only imply read-only, never running. */
  live?: boolean;
  recentWrite?: boolean;
};
export type OccupancyProbe = (session: IndexedSession) => Promise<Occupancy>;
type ProbeResult = { code: number; text: string };
type RunProbe = (args: string[]) => Promise<ProbeResult>;

async function runProbe(args: string[]): Promise<ProbeResult> {
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, 5000);
    try {
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      return { code: timedOut ? -1 : code, text };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { code: -1, text: "" };
  }
}

/** One process/file-handle snapshot per scan, shared by all sessions (including unchanged logs). */
export function createOccupancyProbe(
  now: () => number = Date.now,
  run: RunProbe = runProbe,
): OccupancyProbe {
  let snapshot:
    | Promise<{ handles: Map<string, boolean>; processes: string[]; failed: boolean }>
    | undefined;
  const inspect = () =>
    (snapshot ??= (async () => {
      const handles = new Map<string, boolean>();
      if (process.platform === "win32") {
        const result = await run([
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ]);
        try {
          if (result.code !== 0) throw new Error("probe failed");
          const rows = JSON.parse(result.text);
          return {
            handles,
            processes: (Array.isArray(rows) ? rows : [rows])
              .filter((row) => row.ProcessId !== process.pid)
              .map((row) => String(row.CommandLine ?? "")),
            // Open handles cannot be ruled out without elevation on Windows.
            failed: true,
          };
        } catch {
          return { handles, processes: [], failed: true };
        }
      }
      const lsof = Bun.which("lsof");
      const results = await Promise.allSettled([
        lsof ? run([lsof, "-nP", "-Fpfan"]) : Promise.resolve({ code: -1, text: "" }),
        run(["ps", "-axo", "pid=,args="]),
      ]);
      const files = results[0].status === "fulfilled" ? results[0].value : { code: -1, text: "" };
      const ps = results[1].status === "fulfilled" ? results[1].value : { code: -1, text: "" };
      let pid = 0;
      let access = "";
      for (const line of files.text.split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        if (line.startsWith("f")) access = "";
        if (line.startsWith("a")) access = line.slice(1);
        if (line.startsWith("n") && pid && pid !== process.pid) {
          const path = line.slice(1);
          handles.set(path, handles.get(path) === true || access === "w" || access === "u");
        }
      }
      const processes = ps.text.split("\n").filter((line) => {
        const parts = line.trim().split(/\s+/);
        return (
          Number(parts[0]) !== process.pid &&
          /(?:^|[\\/])(?:claude|codex)(?:\.exe)?$/.test(parts[1] ?? "")
        );
      });
      return { handles, processes, failed: ![0, 1].includes(files.code) || ps.code !== 0 };
    })());

  return async (session) => {
    const file = await stat(session.logPath).catch(() => undefined);
    if (!file) return { busy: true, reason: "无法确认本地日志的状态，保持只读" };
    const recentWrite = now() - file.mtimeMs < 30_000;
    if (
      recentWrite &&
      (session.localActivity?.status !== "running" || now() - session.localActivity.at < 30_000)
    )
      return { busy: true, recentWrite: true, reason: "本地会话最近 30 秒仍有写入" };
    const state = await inspect();
    if (state.handles.has(session.logPath))
      return {
        busy: true,
        live: state.handles.get(session.logPath),
        recentWrite,
        reason: "本地进程正在使用该会话日志",
      };
    if (session.nativeId && state.processes.some((line) => line.includes(session.nativeId!)))
      return { busy: true, live: true, reason: "检测到正在继续该会话的进程" };
    if (recentWrite) return { busy: true, recentWrite: true, reason: "本地会话最近 30 秒仍有写入" };
    if (state.failed) return { busy: true, reason: "无法完整确认本地进程或日志占用，保持只读" };
    return { busy: false };
  };
}

export async function detectOccupancy(
  session: IndexedSession,
  now = Date.now(),
): Promise<Occupancy> {
  return createOccupancyProbe(() => now)(session);
}

export function localSessionStatus(
  session: IndexedSession,
  occupancy: Occupancy,
  now = Date.now(),
) {
  const activity = session.localActivity;
  if (activity?.status === "running") {
    if (occupancy.live || (occupancy.recentWrite && now - activity.at < 30_000)) return "running";
    return "idle";
  }
  return activity?.status ?? "idle";
}
