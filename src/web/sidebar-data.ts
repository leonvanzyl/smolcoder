// What the web sidebar shows beside each project and session, gathered from
// the file system and git: the folder picker listing (with prefix
// completion), sibling-project suggestions, project favicons, the branch and
// `+N −M` of a working tree, session search, and git worktrees for sessions
// started on a branch. All of it is UI metadata: none of it reaches the model.

import { execFile, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { Event, SessionMeta, SessionStore, workspaceKey } from "./store";

// ---- paths ------------------------------------------------------------------

export function tilde(p: string): string {
  const home = os.homedir();
  const same = process.platform === "win32" ? p.slice(0, home.length).toLowerCase() === home.toLowerCase() : p.startsWith(home);
  return same ? "~" + p.slice(home.length).replace(/\\/g, "/") : p;
}

export function expandHome(s: string): string {
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return s;
}

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "AGENTS.md", "pom.xml", "Gemfile"];
export function isProject(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
}

let rootsCache: { at: number; roots: string[] } | null = null;
function listRoots(): string[] {
  if (rootsCache && Date.now() - rootsCache.at < 60_000) return rootsCache.roots;
  let roots: string[];
  if (process.platform === "win32") {
    roots = [];
    for (let i = 67; i <= 90; i++) {
      // C: through Z:; A:/B: are floppy letters and slow to probe
      const r = `${String.fromCharCode(i)}:\\`;
      try {
        if (fs.existsSync(r)) roots.push(r);
      } catch {
        /* skip */
      }
    }
  } else {
    roots = ["/"];
  }
  rootsCache = { at: Date.now(), roots };
  return roots;
}

const SKIP_DIRS = /^(node_modules|\$recycle\.bin|system volume information|windows|program files( \(x86\))?|programdata|appdata)$/i;

/** A folder the picker would list (not hidden, not system clutter). */
const listable = (name: string) => !name.startsWith(".") && !SKIP_DIRS.test(name);

/** Folder listing for the "open folder" picker. */
export function browseDir(input: string | null | undefined): Record<string, any> {
  const home = os.homedir();
  const target = input && input.trim() ? path.resolve(expandHome(input.trim())) : home;
  const roots = listRoots();
  const base = { path: target, display: tilde(target), home, roots };
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return { ...base, error: `not a folder: ${target}`, parent: path.dirname(target), dirs: [] };
  }
  if (!st.isDirectory()) return { ...base, error: `not a folder: ${target}`, parent: path.dirname(target), dirs: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err: any) {
    return { ...base, error: `cannot read ${target}: ${err?.message ?? err}`, parent: path.dirname(target), dirs: [] };
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && listable(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .slice(0, 500)
    .map((e) => {
      const full = path.join(target, e.name);
      let project = false;
      try {
        project = isProject(full);
      } catch {
        /* unreadable */
      }
      return { name: e.name, path: full, project };
    });
  const parent = path.dirname(target);
  return { ...base, parent: parent === target ? null : parent, dirs, project: isProject(target) };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Tab completion for a typed path: an existing folder (or one ending in a
 * separator) lists its subfolders with `prefix: ""`; otherwise the parent is
 * listed, keeping only subfolders whose names start with the typed basename
 * (case-insensitive), and `prefix` is that basename. */
export function completeDir(input: string | null | undefined): Record<string, any> {
  const raw = String(input ?? "").trim();
  const typed = /^[A-Za-z]:$/.test(raw) ? raw + path.sep : raw;
  if (!typed || /[\\/]$/.test(typed) || isDir(path.resolve(expandHome(typed)))) return { ...browseDir(typed), prefix: "" };
  const abs = path.resolve(expandHome(typed));
  const prefix = path.basename(abs);
  const listing = browseDir(path.dirname(abs));
  const lower = prefix.toLowerCase();
  return { ...listing, prefix, dirs: listing.dirs.filter((d: any) => d.name.toLowerCase().startsWith(lower)) };
}

/** Limits for the picker's listing as the server answers it while typing. */
const LIST_SCAN_MAX = 5000;
const LIST_SHOW_MAX = 500;
const LIST_TIME_MS = 1500;

async function isProjectAsync(dir: string): Promise<boolean> {
  for (const m of PROJECT_MARKERS) {
    try {
      await fs.promises.access(path.join(dir, m));
      return true;
    } catch {
      /* next marker */
    }
  }
  return false;
}

/** browseDir without blocking the hub: asynchronous reads, at most
 * LIST_SCAN_MAX entries looked at, and project flags only while there is
 * time (past the deadline the rest are listed without one). `filter` keeps
 * only names it accepts (prefix completion). */
export async function browseDirAsync(
  input: string | null | undefined,
  opts: { filter?: (name: string) => boolean; timeMs?: number } = {}
): Promise<Record<string, any>> {
  const deadline = Date.now() + (opts.timeMs ?? LIST_TIME_MS);
  const home = os.homedir();
  const target = input && input.trim() ? path.resolve(expandHome(input.trim())) : home;
  const roots = listRoots();
  const base = { path: target, display: tilde(target), home, roots };
  const fail = (error: string) => ({ ...base, error, parent: path.dirname(target), dirs: [] });
  try {
    if (!(await fs.promises.stat(target)).isDirectory()) return fail(`not a folder: ${target}`);
  } catch {
    return fail(`not a folder: ${target}`);
  }
  const names: string[] = [];
  let truncated = false;
  let dir: fs.Dir | null = null;
  try {
    dir = await fs.promises.opendir(target);
    for (let i = 0; ; i++) {
      if (i >= LIST_SCAN_MAX || Date.now() > deadline) {
        truncated = true;
        break;
      }
      const e = await dir.read();
      if (!e) break;
      if (e.isDirectory() && listable(e.name) && (!opts.filter || opts.filter(e.name))) names.push(e.name);
    }
  } catch (err: any) {
    return fail(`cannot read ${target}: ${err?.message ?? err}`);
  } finally {
    try {
      await dir?.close();
    } catch {
      /* closed */
    }
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  if (names.length > LIST_SHOW_MAX) truncated = true;
  const shown = names.slice(0, LIST_SHOW_MAX);
  const dirs = await Promise.all(
    shown.map(async (name) => {
      const full = path.join(target, name);
      const project = Date.now() < deadline ? await isProjectAsync(full) : false;
      return { name, path: full, project };
    })
  );
  const parent = path.dirname(target);
  return { ...base, parent: parent === target ? null : parent, dirs, project: await isProjectAsync(target), ...(truncated ? { truncated } : {}) };
}

/** completeDir without blocking the hub (see browseDirAsync). */
export async function completeDirAsync(input: string | null | undefined): Promise<Record<string, any>> {
  const raw = String(input ?? "").trim();
  const typed = /^[A-Za-z]:$/.test(raw) ? raw + path.sep : raw;
  const abs = path.resolve(expandHome(typed || "~"));
  let folder = !typed || /[\\/]$/.test(typed);
  if (!folder) {
    try {
      folder = (await fs.promises.stat(abs)).isDirectory();
    } catch {
      folder = false;
    }
  }
  if (folder) return { ...(await browseDirAsync(typed)), prefix: "" };
  const prefix = path.basename(abs);
  const lower = prefix.toLowerCase();
  const listing = await browseDirAsync(path.dirname(abs), { filter: (n) => n.toLowerCase().startsWith(lower) });
  return { ...listing, prefix };
}

// ---- suggestions --------------------------------------------------------------

const SUGGEST_MAX = 12;
const SUGGEST_SCAN = 200;
let suggestCache: { key: string; at: number; dirs: { name: string; path: string; display: string }[] } | null = null;

/** Project-looking folders next to the known workspaces (children of their
 * parent folders) that are not in the list yet, newest first. */
export function suggestWorkspaces(known: string[]): { name: string; path: string; display: string }[] {
  const knownKeys = new Set(known.map(workspaceKey));
  const cacheKey = [...knownKeys].sort().join("\n");
  if (suggestCache && suggestCache.key === cacheKey && Date.now() - suggestCache.at < 30_000) return suggestCache.dirs;
  const parents = new Map<string, string>();
  for (const k of known) {
    const parent = path.dirname(path.resolve(k));
    if (parent !== path.resolve(k)) parents.set(workspaceKey(parent), parent);
  }
  const found = new Map<string, { name: string; path: string; display: string; mtime: number }>();
  for (const parent of parents.values()) {
    let dir: fs.Dir | null = null;
    try {
      dir = fs.opendirSync(parent);
      for (let i = 0; i < SUGGEST_SCAN; i++) {
        const e = dir.readSync();
        if (!e) break;
        if (!e.isDirectory() || !listable(e.name)) continue;
        const full = path.join(parent, e.name);
        const key = workspaceKey(full);
        if (knownKeys.has(key) || found.has(key)) continue;
        try {
          if (!isProject(full)) continue;
          found.set(key, { name: e.name, path: full, display: tilde(full), mtime: fs.statSync(full).mtimeMs });
        } catch {
          /* unreadable */
        }
      }
    } catch {
      /* unreadable parent */
    } finally {
      try {
        dir?.closeSync();
      } catch {
        /* closed */
      }
    }
  }
  const dirs = [...found.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SUGGEST_MAX)
    .map(({ name, path: p, display }) => ({ name, path: p, display }));
  suggestCache = { key: cacheKey, at: Date.now(), dirs };
  return dirs;
}

// ---- project icons ------------------------------------------------------------

const ICON_FILES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/icon.svg",
  "app/icon.png",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  "assets/icon.png",
  "icon.png",
  "logo.svg",
];
const ICON_MAX_BYTES = 512 * 1024;
const ICON_TTL = 60_000;
const iconCache = new Map<string, { at: number; file: string | null }>();

/** The project's favicon (first hit wins), re-checked at most once a minute. */
export function findProjectIcon(dir: string): string | null {
  const key = workspaceKey(dir);
  const hit = iconCache.get(key);
  if (hit && Date.now() - hit.at < ICON_TTL) return hit.file;
  let file: string | null = null;
  for (const rel of ICON_FILES) {
    const p = path.join(dir, rel);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0 && st.size <= ICON_MAX_BYTES) {
        file = p;
        break;
      }
    } catch {
      /* not there */
    }
  }
  iconCache.set(key, { at: Date.now(), file });
  return file;
}

/** Send an icon file. SVG gets a CSP that keeps any script in it inert. */
export function serveIcon(res: http.ServerResponse, file: string): void {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const headers: Record<string, string | number> = {
    "content-type": ext === ".svg" ? "image/svg+xml" : ext === ".ico" ? "image/x-icon" : "image/png",
    "content-length": bytes.length,
    "cache-control": "private, max-age=300",
  };
  if (ext === ".svg") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  res.writeHead(200, headers);
  res.end(bytes);
}

// ---- git ----------------------------------------------------------------------

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git without a shell. Never rejects: a missing git is just !ok. */
export function runGit(args: string[], cwd: string, timeout = 3000): Promise<GitResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        args,
        { cwd, timeout, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        (err, stdout, stderr) => {
          const msg = String(stderr ?? "").trim() || (err ? String((err as any).message ?? err) : "");
          resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: msg });
        }
      );
    } catch (err: any) {
      resolve({ ok: false, stdout: "", stderr: String(err?.message ?? err) });
    }
  });
}

/** The checked-out branch from `<dir>/.git/HEAD` (a worktree's `.git` file
 * points at its gitdir). Detached: the first 7 chars of the commit. Not a
 * repository: null. */
export function readGitBranch(dir: string): string | null {
  const dotgit = path.join(dir, ".git");
  let gitdir = dotgit;
  try {
    if (fs.statSync(dotgit).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, "utf8"));
      if (!m) return null;
      gitdir = path.resolve(dir, m[1]);
    }
    const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (ref) return ref[1].replace(/^refs\/heads\//, "");
    return /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** "3 files changed, 10 insertions(+), 2 deletions(-)" -> {added, removed}. */
export function parseShortstat(s: string): { added: number; removed: number } {
  const a = /(\d+) insertions?\(\+\)/.exec(s);
  const r = /(\d+) deletions?\(-\)/.exec(s);
  return { added: a ? Number(a[1]) : 0, removed: r ? Number(r[1]) : 0 };
}

export interface GitInfoView {
  branch: string;
  added: number;
  removed: number;
}

interface GitEntry {
  dir: string;
  branch: string | null;
  branchAt: number;
  added: number;
  removed: number;
  statAt: number;
  running: boolean;
  again: boolean;
}

const BRANCH_TTL = 5_000;
const STAT_TTL = 60_000;

/** Branch and `git diff --shortstat HEAD` per folder, cached. `get` never
 * waits on git: a stale entry is refreshed in the background and
 * `onChange` fires when the numbers move. */
export class GitInfo {
  private cache = new Map<string, GitEntry>();

  constructor(private onChange: () => void) {}

  private entry(dir: string): GitEntry {
    const key = workspaceKey(dir);
    let e = this.cache.get(key);
    if (!e) {
      e = { dir, branch: null, branchAt: 0, added: 0, removed: 0, statAt: 0, running: false, again: false };
      this.cache.set(key, e);
    }
    return e;
  }

  get(dir: string): GitInfoView | null {
    const e = this.entry(dir);
    const now = Date.now();
    if (now - e.branchAt > BRANCH_TTL) {
      e.branch = readGitBranch(dir);
      e.branchAt = now;
    }
    if (!e.branch) return null;
    if (now - e.statAt > STAT_TTL) void this.refresh(dir);
    return { branch: e.branch, added: e.added, removed: e.removed };
  }

  /** Re-read now (a turn just ended there). */
  async refresh(dir: string): Promise<void> {
    const e = this.entry(dir);
    if (e.running) {
      e.again = true;
      return;
    }
    e.running = true;
    e.statAt = Date.now();
    try {
      const branch = readGitBranch(dir);
      e.branchAt = Date.now();
      let added = 0;
      let removed = 0;
      if (branch) {
        const r = await runGit(["--no-optional-locks", "diff", "--shortstat", "HEAD"], dir, 3000);
        if (r.ok) ({ added, removed } = parseShortstat(r.stdout));
      }
      const moved = branch !== e.branch || added !== e.added || removed !== e.removed;
      e.branch = branch;
      e.added = added;
      e.removed = removed;
      e.statAt = Date.now();
      if (moved) this.onChange();
    } catch {
      /* never throw */
    } finally {
      e.running = false;
    }
    if (e.again) {
      e.again = false;
      await this.refresh(dir);
    }
  }
}

// ---- worktrees ------------------------------------------------------------------

export function validBranchName(b: string): boolean {
  return /^[A-Za-z0-9._\/-]{1,100}$/.test(b) && !b.includes("..") && !b.startsWith("-");
}

export function worktreePathFor(dataDir: string, project: string, id: string): string {
  return path.join(dataDir, "worktrees", `${path.basename(project) || "project"}-${id}`);
}

/** `git worktree add` on a new or existing branch. Throws git's message. */
export async function addWorktree(project: string, wtPath: string, branch: string): Promise<void> {
  if (!validBranchName(branch)) throw new Error(`not a valid branch name: ${branch}`);
  if (!fs.existsSync(path.join(project, ".git"))) throw new Error(`not a git repository: ${project}`);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const exists = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], project, 10_000);
  const args = exists.ok ? ["worktree", "add", wtPath, branch] : ["worktree", "add", "-b", branch, wtPath];
  const r = await runGit(args, project, 30_000);
  if (!r.ok) throw new Error(r.stderr || "git worktree add failed");
}

/** Bring back a worktree folder that is gone (archived, or deleted by hand). */
export async function ensureWorktree(project: string, wt: { path: string; branch: string }): Promise<void> {
  if (fs.existsSync(wt.path)) return;
  await runGit(["worktree", "prune"], project, 10_000);
  fs.mkdirSync(path.dirname(wt.path), { recursive: true });
  const r = await runGit(["worktree", "add", wt.path, wt.branch], project, 30_000);
  if (!r.ok) throw new Error(`could not restore the worktree on ${wt.branch}: ${r.stderr || "git worktree add failed"}`);
}

/** What happened to a worktree the hub tried to drop. */
export interface WorktreeRemoval {
  removed: boolean;
  /** Why it was kept (when it was): shown to the user with its path. */
  reason?: string;
}

/** `git status` that also lists untracked and gitignored files (an .env, a
 * build output): anything there would be lost with the folder. */
const STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain", "--ignored"];

function keptBecause(status: GitResult): WorktreeRemoval {
  if (!status.ok) return { removed: false, reason: "git could not check it for changes" };
  return { removed: false, reason: "it has changes" };
}

/** Remove a session's worktree only when nothing in it would be lost: no
 * uncommitted change, no untracked file, no ignored file. Never forced, and
 * the folder is never deleted by hand; whatever git refuses stays. The
 * branch always stays. */
export async function removeWorktree(project: string, wtPath: string): Promise<WorktreeRemoval> {
  if (!fs.existsSync(wtPath)) {
    await runGit(["worktree", "prune"], project, 10_000);
    return { removed: true };
  }
  const status = await runGit(STATUS_ARGS, wtPath, 15_000);
  if (!status.ok || status.stdout.trim()) return keptBecause(status);
  const r = await runGit(["worktree", "remove", wtPath], project, 30_000);
  if (!r.ok) return { removed: false, reason: `git would not remove it (${(r.stderr || "unknown error").split("\n")[0].slice(0, 160)})` };
  return { removed: true };
}

function runGitSync(args: string[], cwd: string, timeout: number): GitResult {
  try {
    const r = spawnSync("git", args, {
      cwd,
      timeout,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: r.status === 0 && !r.error, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? r.error?.message ?? "").trim() };
  } catch (err: any) {
    return { ok: false, stdout: "", stderr: String(err?.message ?? err) };
  }
}

/** removeWorktree for exit paths, where nothing can be awaited. */
export function removeWorktreeSync(project: string, wtPath: string): WorktreeRemoval {
  if (!fs.existsSync(wtPath)) {
    runGitSync(["worktree", "prune"], project, 5_000);
    return { removed: true };
  }
  const status = runGitSync(STATUS_ARGS, wtPath, 5_000);
  if (!status.ok || status.stdout.trim()) return keptBecause(status);
  const r = runGitSync(["worktree", "remove", wtPath], project, 10_000);
  return r.ok ? { removed: true } : { removed: false, reason: "git would not remove it" };
}

// ---- snapshot fields ------------------------------------------------------------

/** The project folder a session is listed under. */
export function groupOf(m: SessionMeta): string {
  return m.project ?? m.workspace;
}

/** The sidebar fields of one session in the hub snapshot. */
export function sessionFields(m: SessionMeta, git: GitInfo): Record<string, any> {
  return {
    backend: m.backend,
    pinnedAt: m.pinnedAt,
    archivedAt: m.archivedAt,
    lastVisitedAt: m.lastVisitedAt,
    lastTurnEndedAt: m.lastTurnEndedAt,
    lastOutcome: m.lastOutcome,
    unread: !!m.lastTurnEndedAt && m.lastTurnEndedAt > (m.lastVisitedAt || 0),
    ...(m.worktree ? { worktree: { path: m.worktree.path, branch: m.worktree.branch }, git: git.get(m.worktree.path) } : {}),
  };
}

// ---- search ----------------------------------------------------------------------

/** What search reads of a transcript: the user's messages and the replies. */
export function replayText(events: Event[]): string {
  const parts: string[] = [];
  for (const e of events) if ((e.t === "user" || e.t === "token") && typeof e.s === "string") parts.push(e.s);
  return parts.join("\n");
}

/** In-memory size of a cached text (JS strings are UTF-16). */
const textBytes = (s: string) => s.length * 2;
export const SAVED_TEXT_CAP = 32 * 1024 * 1024;

/** Saved transcripts' text, re-read only when the body file changes. A
 * least-recently-used cache capped by size; files are read asynchronously. */
export class SavedText {
  private cache = new Map<string, { mtime: number; text: string }>();
  private bytes = 0;

  constructor(private cap = SAVED_TEXT_CAP) {}

  get size(): number {
    return this.bytes;
  }

  private drop(id: string): void {
    const hit = this.cache.get(id);
    if (!hit) return;
    this.bytes -= textBytes(hit.text);
    this.cache.delete(id);
  }

  async get(store: SessionStore, id: string): Promise<string> {
    const mtime = store.bodyMtime(id);
    if (mtime === null) {
      this.drop(id);
      return "";
    }
    const hit = this.cache.get(id);
    if (hit && hit.mtime === mtime) {
      // Most recently used goes to the end.
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit.text;
    }
    this.drop(id);
    const text = replayText((await store.loadBodyAsync(id))?.events ?? []);
    const size = textBytes(text);
    if (size > this.cap) return text; // too big to keep: searched, not cached
    this.cache.set(id, { mtime, text });
    this.bytes += size;
    for (const old of this.cache.keys()) {
      if (this.bytes <= this.cap) break;
      this.drop(old);
    }
    return text;
  }
}

export interface SearchItem {
  id: string;
  title: string;
  workspace: string;
  archived: boolean;
  updatedAt: number;
  text: () => string | Promise<string>;
}

const SEARCH_MAX = 50;

/** ~40 chars before and 60 after, whitespace collapsed, "…" where cut. */
export function snippetAt(text: string, index: number, length: number): { snippet: string; match: [number, number] } {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 60);
  const squash = (s: string) => s.replace(/\s+/g, " ");
  let before = squash(text.slice(start, index)).trimStart();
  if (start > 0) before = "…" + before;
  const hit = squash(text.slice(index, index + length));
  let after = squash(text.slice(index + length, end)).trimEnd();
  if (end < text.length) after += "…";
  return { snippet: before + hit + after, match: [before.length, hit.length] };
}

/** Title hits first, then transcript hits; case-insensitive substring.
 * Transcripts are read one at a time with a yield to the event loop between
 * them, so a search over many large sessions never stalls the hub; when
 * `stale()` turns true (a newer query arrived) it stops and returns null. */
export async function searchSessions(
  items: SearchItem[],
  query: string,
  opts: { limit?: number; stale?: () => boolean } = {}
): Promise<Record<string, any>[] | null> {
  const limit = opts.limit ?? SEARCH_MAX;
  const stale = opts.stale ?? (() => false);
  const q = query.trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const sorted = items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  const hits: Record<string, any>[] = [];
  const seen = new Set<string>();
  for (const it of sorted) {
    if (hits.length >= limit) return hits;
    if (!it.title.toLowerCase().includes(lower)) continue;
    seen.add(it.id);
    hits.push({ id: it.id, title: it.title, workspace: it.workspace, where: "title", archived: it.archived });
  }
  for (const it of sorted) {
    if (hits.length >= limit) break;
    if (seen.has(it.id)) continue;
    await new Promise<void>((r) => setImmediate(r));
    if (stale()) return null;
    const text = await it.text();
    if (stale()) return null;
    const m = re.exec(text);
    if (!m) continue;
    const { snippet, match } = snippetAt(text, m.index, m[0].length);
    hits.push({ id: it.id, title: it.title, workspace: it.workspace, where: "text", snippet, match, archived: it.archived });
  }
  return hits;
}
