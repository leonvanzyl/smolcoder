// On-disk memory for the web hub: saved sessions (so the sidebar survives a
// restart and any session can be resumed) and the list of workspaces the
// user has opened. Plain JSON files under ~/.smolcoder/, one pair per session:
// a small .meta.json that is read at startup, and the heavy transcript body
// that is only loaded when a session is resumed.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { SessionSnapshot } from "../session";

export type Event = Record<string, any>;

export interface SessionMeta {
  id: string;
  workspace: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  backend?: string;
  /** Requests and replies in the saved transcript (shown in /sessions). */
  messages?: number;
  // Sidebar metadata (UI only; never part of the model's context).
  pinnedAt?: number;
  archivedAt?: number;
  /** When a page last looked at the session. */
  lastVisitedAt?: number;
  /** When the agent last went from busy/waiting back to idle. */
  lastTurnEndedAt?: number;
  /** How that last turn ended. */
  lastOutcome?: SessionOutcome;
  /** For worktree sessions: the project folder; `workspace` is the worktree. */
  project?: string;
  worktree?: { path: string; branch: string };
}

export type SessionOutcome = "completed" | "error" | "cancelled";
const OUTCOMES = new Set(["completed", "error", "cancelled"]);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The optional sidebar fields of a meta read from disk, valid ones only. */
function sidebarFields(m: any): Partial<SessionMeta> {
  const out: Partial<SessionMeta> = {};
  for (const k of ["pinnedAt", "archivedAt", "lastVisitedAt", "lastTurnEndedAt"] as const) {
    const v = num(m[k]);
    if (v !== undefined) out[k] = v;
  }
  if (OUTCOMES.has(m.lastOutcome)) out.lastOutcome = m.lastOutcome;
  if (typeof m.project === "string" && m.project) out.project = m.project;
  const wt = m.worktree;
  if (wt && typeof wt.path === "string" && typeof wt.branch === "string") out.worktree = { path: wt.path, branch: wt.branch };
  return out;
}

function countMessages(messages: unknown): number | undefined {
  if (!Array.isArray(messages)) return undefined;
  return messages.filter(
    (m: any) => m && (m.role === "user" || m.role === "assistant") && !m.compactNote && !m.historyNote && String(m.content ?? "").trim()
  ).length;
}

export interface SessionBody {
  snapshot: SessionSnapshot;
  /** The UI event replay, so a resumed session shows its transcript. */
  events: Event[];
}

/** Session ids are short hex (the TUI's are longer). They become file names
 * under the data folder, so nothing else is accepted anywhere. */
export const SESSION_ID_RE = /^[a-z0-9_-]{1,64}$/i;

export function validSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

function parseBody(text: string): SessionBody | null {
  const b = JSON.parse(text);
  if (!b || typeof b !== "object" || !b.snapshot) return null;
  return { snapshot: b.snapshot, events: Array.isArray(b.events) ? b.events : [] };
}

/** A temp name no other writer (another save, another process) can pick. */
function tmpName(file: string): string {
  return `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
}

function writeAtomic(file: string, data: string): void {
  const tmp = tmpName(file);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never written */
    }
    throw err;
  }
}

/** One session's body saves: at most one write runs; a save asked for while
 * one runs replaces any other waiting one (the last write wins). */
interface SaveSlot {
  next: SessionBody | null;
  done: Promise<void>;
}

export class SessionStore {
  readonly dir: string;
  private slots = new Map<string, SaveSlot>();
  /** Bumped by a sync save or a delete: an async write still in flight then
   * drops its file instead of putting older data back. */
  private gen = new Map<string, number>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "sessions");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private checkId(id: string): string {
    if (!validSessionId(id)) throw new Error(`not a session id: ${JSON.stringify(String(id).slice(0, 80))}`);
    return id;
  }

  private metaPath(id: string): string {
    return path.join(this.dir, `${this.checkId(id)}.meta.json`);
  }

  private bodyPath(id: string): string {
    return path.join(this.dir, `${this.checkId(id)}.json`);
  }

  private bump(id: string): void {
    this.gen.set(id, (this.gen.get(id) ?? 0) + 1);
  }

  /** Every saved session (without message counts; listForWorkspace has them). */
  listMetas(withCounts = false): SessionMeta[] {
    const out: SessionMeta[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return out;
    }
    for (const n of names) {
      if (!n.endsWith(".meta.json")) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.dir, n), "utf8"));
        // The id names the session's files: it must be valid and match this one.
        if (m && validSessionId(m.id) && n === `${m.id}.meta.json` && typeof m.workspace === "string") {
          out.push({
            id: m.id,
            workspace: m.workspace,
            title: String(m.title ?? ""),
            createdAt: Number(m.createdAt) || 0,
            updatedAt: Number(m.updatedAt) || 0,
            model: m.model,
            backend: m.backend,
            ...sidebarFields(m),
            ...(withCounts && typeof m.messages === "number" ? { messages: m.messages } : {}),
          });
        }
      } catch {
        /* skip a broken file */
      }
    }
    return out;
  }

  /** A meta saved without a message count keeps the one on disk. */
  saveMeta(meta: SessionMeta): void {
    let out = meta;
    if (meta.messages === undefined) {
      const old = this.readMeta(meta.id);
      if (typeof old?.messages === "number") out = { ...meta, messages: old.messages };
    }
    writeAtomic(this.metaPath(meta.id), JSON.stringify(out));
  }

  private readMeta(id: string): Record<string, any> | null {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(id), "utf8"));
    } catch {
      return null;
    }
  }

  /** Keep the meta's message count in step with the body just written. */
  private noteCount(id: string, body: SessionBody): void {
    const n = countMessages(body.snapshot?.messages);
    const old = this.readMeta(id);
    if (n === undefined || !old || old.messages === n) return;
    try {
      writeAtomic(this.metaPath(id), JSON.stringify({ ...old, messages: n }));
    } catch {
      /* the count is cosmetic */
    }
  }

  /** Saves of one session never overlap: one asked for while another is
   * writing waits for it, and only the newest waiting body is written. */
  saveBody(id: string, body: SessionBody): Promise<void> {
    const file = this.bodyPath(id);
    const slot = this.slots.get(id);
    if (slot) {
      slot.next = body;
      return slot.done;
    }
    const s: SaveSlot = { next: body, done: Promise.resolve() };
    this.slots.set(id, s);
    s.done = (async () => {
      try {
        while (s.next) {
          const b = s.next;
          s.next = null;
          const gen = this.gen.get(id) ?? 0;
          const tmp = tmpName(file);
          try {
            await fs.promises.writeFile(tmp, JSON.stringify(b));
            // A sync save or a delete happened meanwhile: they win.
            if ((this.gen.get(id) ?? 0) !== gen) {
              fs.rmSync(tmp, { force: true });
              continue;
            }
            fs.renameSync(tmp, file);
          } catch (err) {
            fs.rmSync(tmp, { force: true });
            throw err;
          }
          this.noteCount(id, b);
        }
      } finally {
        this.slots.delete(id);
      }
    })();
    return s.done;
  }

  saveBodySync(id: string, body: SessionBody): void {
    const file = this.bodyPath(id);
    this.bump(id);
    const slot = this.slots.get(id);
    if (slot) slot.next = null;
    writeAtomic(file, JSON.stringify(body));
    this.noteCount(id, body);
  }

  /** Saved sessions of one workspace, most recently used first. */
  listForWorkspace(workspace: string): SessionMeta[] {
    const key = workspaceKey(workspace);
    return this.listMetas(true)
      .filter((m) => workspaceKey(m.workspace) === key)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The saved body's modification time, or null when there is none. */
  bodyMtime(id: string): number | null {
    try {
      return fs.statSync(this.bodyPath(id)).mtimeMs;
    } catch {
      return null;
    }
  }

  loadBody(id: string): SessionBody | null {
    try {
      return parseBody(fs.readFileSync(this.bodyPath(id), "utf8"));
    } catch {
      return null;
    }
  }

  /** loadBody without blocking the event loop on the read (search). */
  async loadBodyAsync(id: string): Promise<SessionBody | null> {
    try {
      return parseBody(await fs.promises.readFile(this.bodyPath(id), "utf8"));
    } catch {
      return null;
    }
  }

  delete(id: string): void {
    const files = [this.metaPath(id), this.bodyPath(id)];
    this.bump(id);
    const slot = this.slots.get(id);
    if (slot) slot.next = null;
    for (const p of files) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
  }
}

export interface WorkspaceEntry {
  path: string;
  addedAt: number;
  lastOpened: number;
  pinnedAt?: number;
  /** Manual sort position (index in the last order the page sent). */
  order?: number;
}

/** Normalized form for comparisons: resolved, no trailing separator, and
 * case-folded on Windows where paths are case-insensitive. */
export function workspaceKey(p: string): string {
  let r = path.resolve(p);
  if (r.length > 1 && /[\\/]$/.test(r) && path.dirname(r) !== r) r = r.slice(0, -1);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

export class WorkspaceStore {
  private readonly file: string;
  private entries: WorkspaceEntry[] = [];

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "workspaces.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(raw)) {
        this.entries = raw
          .filter((e: any) => e && typeof e.path === "string")
          .map((e: any) => {
            const out: WorkspaceEntry = { path: e.path, addedAt: Number(e.addedAt) || 0, lastOpened: Number(e.lastOpened) || 0 };
            if (num(e.pinnedAt) !== undefined) out.pinnedAt = e.pinnedAt;
            if (num(e.order) !== undefined) out.order = e.order;
            return out;
          });
      }
    } catch {
      this.entries = [];
    }
  }

  list(): WorkspaceEntry[] {
    return this.entries.slice();
  }

  has(p: string): boolean {
    const key = workspaceKey(p);
    return this.entries.some((e) => workspaceKey(e.path) === key);
  }

  add(p: string): WorkspaceEntry {
    const key = workspaceKey(p);
    let e = this.entries.find((x) => workspaceKey(x.path) === key);
    if (!e) {
      e = { path: path.resolve(p), addedAt: Date.now(), lastOpened: Date.now() };
      this.entries.push(e);
    } else {
      e.lastOpened = Date.now();
    }
    this.save();
    return e;
  }

  touch(p: string): void {
    const key = workspaceKey(p);
    const e = this.entries.find((x) => workspaceKey(x.path) === key);
    if (e) {
      e.lastOpened = Date.now();
      this.save();
    }
  }

  /** Pin or unpin a folder (added to the list when it is not there yet). */
  setPinned(p: string, pinned: boolean): void {
    const key = workspaceKey(p);
    let e = this.entries.find((x) => workspaceKey(x.path) === key);
    if (!e) {
      if (!pinned) return;
      e = { path: path.resolve(p), addedAt: Date.now(), lastOpened: Date.now() };
      this.entries.push(e);
    }
    if (pinned) e.pinnedAt = Date.now();
    else delete e.pinnedAt;
    this.save();
  }

  /** A manual order: each listed folder gets its index; the rest lose theirs. */
  setOrder(paths: string[]): void {
    const index = new Map<string, number>();
    paths.forEach((p, i) => {
      const key = workspaceKey(p);
      if (!index.has(key)) index.set(key, i);
    });
    for (const e of this.entries) {
      const i = index.get(workspaceKey(e.path));
      if (i === undefined) delete e.order;
      else e.order = i;
    }
    this.save();
  }

  remove(p: string): void {
    const key = workspaceKey(p);
    this.entries = this.entries.filter((x) => workspaceKey(x.path) !== key);
    this.save();
  }

  private save(): void {
    try {
      writeAtomic(this.file, JSON.stringify(this.entries, null, 2));
    } catch {
      /* non-fatal */
    }
  }
}
