// Workspace file list for "@" mentions. Walked once and cached (refreshed
// when older than 30s), skipping .git, node_modules (and a few VCS/venv folders) and simple
// top-level .gitignore entries, capped at 20k entries. Ranking is fuzzy, with
// basename matches and recently picked files first. Only the picked path is
// ever inserted into the prompt — never the file's contents.

import * as fs from "fs";
import * as path from "path";
import { fuzzyScore } from "../util";

const SKIP = new Set([".git", "node_modules", ".hg", ".svn", "__pycache__", ".venv", ".vs"]);
export const FILE_CAP = 20_000;
const MAX_AGE_MS = 30_000;

/** Turn simple .gitignore lines into a test on (relative path, basename, isDir). */
export function gitignoreMatcher(text: string): (rel: string, isDir: boolean) => boolean {
  const rules: { re: RegExp; dirOnly: boolean; anchored: boolean }[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/") || line.includes("/");
    line = line.replace(/^\//, "").replace(/^\*\*\//, "");
    const src = line
      .split("")
      .map((ch) => (ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : /[.+^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch))
      .join("");
    try {
      rules.push({ re: new RegExp(`^${src}$`), dirOnly, anchored });
    } catch {
      /* odd pattern: skip */
    }
  }
  return (rel, isDir) =>
    rules.some((r) => (!r.dirOnly || isDir) && (r.anchored ? r.re.test(rel) : r.re.test(rel.slice(rel.lastIndexOf("/") + 1))));
}

export interface FileEntry {
  /** Workspace-relative, forward slashes; directories end in "/". */
  path: string;
  dir: boolean;
}

export class FileIndex {
  private entries: FileEntry[] = [];
  private walkedAt = 0;
  private root = "";
  /** Most recently picked first. */
  recent: string[] = [];

  list(root: string): FileEntry[] {
    if (root !== this.root || Date.now() - this.walkedAt > MAX_AGE_MS) {
      this.root = root;
      this.entries = walk(root);
      this.walkedAt = Date.now();
    }
    return this.entries;
  }

  refresh(): void {
    this.walkedAt = 0;
  }

  picked(p: string): void {
    this.recent = [p, ...this.recent.filter((r) => r !== p)].slice(0, 20);
  }

  /** Ranked matches for the text after "@". A query ending in "/" (or with a
   * folder before the last "/") lists inside that folder. */
  search(root: string, query: string, limit = 50): FileEntry[] {
    const all = this.list(root);
    const slash = query.lastIndexOf("/");
    const dir = slash >= 0 ? query.slice(0, slash + 1) : "";
    const rest = slash >= 0 ? query.slice(slash + 1) : query;
    const pool = dir ? all.filter((e) => e.path.startsWith(dir) && e.path !== dir) : all;
    const recentRank = (p: string) => {
      const i = this.recent.indexOf(p);
      return i < 0 ? 0 : 60 - i;
    };
    if (!rest) {
      // Folder listing (or the top level): direct children, folders first;
      // recent picks lead at the top level.
      const depth = (p: string) => p.slice(dir.length).replace(/\/$/, "").split("/").length;
      const kids = pool.filter((e) => depth(e.path) === 1);
      kids.sort((a, b) => recentRank(b.path) - recentRank(a.path) || Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
      const recents = dir ? [] : this.recent.map((p) => all.find((e) => e.path === p)).filter((e): e is FileEntry => !!e);
      const seen = new Set<string>();
      return [...recents, ...kids].filter((e) => !seen.has(e.path) && !!seen.add(e.path)).slice(0, limit);
    }
    const scored: { e: FileEntry; s: number }[] = [];
    for (const e of pool) {
      const rel = e.path.slice(dir.length);
      const base = rel.replace(/\/$/, "").split("/").pop() ?? rel;
      const sb = fuzzyScore(rest, base);
      const sp = fuzzyScore(rest, rel);
      if (sb === null && sp === null) continue;
      const s = Math.max(sb === null ? -Infinity : sb * 1.5, sp ?? -Infinity) + recentRank(e.path) - rel.split("/").length * 0.5;
      scored.push({ e, s });
    }
    scored.sort((a, b) => b.s - a.s || a.e.path.length - b.e.path.length);
    return scored.slice(0, limit).map((x) => x.e);
  }
}

function walk(root: string): FileEntry[] {
  const out: FileEntry[] = [];
  let ignored: (rel: string, isDir: boolean) => boolean = () => false;
  try {
    ignored = gitignoreMatcher(fs.readFileSync(path.join(root, ".gitignore"), "utf8"));
  } catch {
    /* no .gitignore */
  }
  const queue: string[] = [""];
  // Breadth first, so the cap keeps the shallow (most useful) files.
  while (queue.length && out.length < FILE_CAP) {
    const relDir = queue.shift()!;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of names) {
      if (out.length >= FILE_CAP) break;
      if (d.isSymbolicLink()) continue;
      const rel = relDir + d.name;
      const isDir = d.isDirectory();
      if (isDir && SKIP.has(d.name)) continue;
      if (ignored(rel, isDir)) continue;
      if (isDir) {
        out.push({ path: rel + "/", dir: true });
        queue.push(rel + "/");
      } else if (d.isFile()) {
        out.push({ path: rel, dir: false });
      }
    }
  }
  return out;
}
