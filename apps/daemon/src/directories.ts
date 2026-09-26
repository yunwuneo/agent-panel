import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

async function visibleRoots(roots: string[]) {
  if (!roots.includes("*")) return roots;
  if (process.platform !== "win32") return ["/"];
  const drives: string[] = [];
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const drive = `${letter}:\\`;
    if (
      await stat(drive)
        .then((s) => s.isDirectory())
        .catch(() => false)
    )
      drives.push(drive);
  }
  return drives;
}

export async function allowedDirectory(path: string, roots: string[]): Promise<string> {
  if (!isAbsolute(path)) throw new Error("工作目录必须是绝对路径");
  const canonical = await realpath(path);
  if (roots.includes("*")) {
    if (!(await stat(canonical)).isDirectory()) throw new Error("指定路径不是目录");
    return canonical;
  }
  const allowed = await Promise.all(roots.map((root) => realpath(root)));
  if (
    !allowed.some((root) => {
      const rel = relative(root, canonical);
      return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
    })
  )
    throw new Error("该目录不在设备的根目录白名单内");
  if (!(await stat(canonical)).isDirectory()) throw new Error("指定路径不是目录");
  return canonical;
}

export async function listDirectories(path: string | undefined, roots: string[], limit = 500) {
  roots = await visibleRoots(roots);
  if (!path)
    return {
      path: "",
      roots,
      entries: roots.map((root) => ({ name: root, path: root })),
      hasMore: false,
    };
  const directory = await allowedDirectory(path, roots);
  const children = await readdir(directory, { withFileTypes: true });
  const entries: { name: string; path: string }[] = [];
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    const childPath = `${directory.replace(/[\\/]$/, "")}${sep}${child.name}`;
    try {
      await allowedDirectory(childPath, roots);
      entries.push({ name: child.name, path: childPath });
    } catch {
      /* Unreadable or escaping symlinks are intentionally absent. */
    }
    if (entries.length > limit) break;
  }
  return {
    path: directory,
    roots,
    entries: entries.slice(0, limit),
    hasMore: entries.length > limit,
  };
}
