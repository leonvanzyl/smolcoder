// On-disk memory for the web hub: saved sessions (so the sidebar survives a
// restart and any session can be resumed) and the list of workspaces the
// user has opened. Plain JSON files under ~/.smolcoder/, one pair per session:
// a small .meta.json that is read at startup, and the heavy transcript body
// that is only loaded when a session is resumed.

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
}

export interface SessionBody {
  snapshot: SessionSnapshot;
  /** The UI event replay, so a resumed session shows its transcript. */
  events: Event[];
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function writeAtomicAsync(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

export class SessionStore {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "sessions");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private metaPath(id: string): string {
    return path.join(this.dir, `${id}.meta.json`);
  }

  private bodyPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  listMetas(): SessionMeta[] {
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
        if (m && typeof m.id === "string" && typeof m.workspace === "string") {
          out.push({
            id: m.id,
            workspace: m.workspace,
            title: String(m.title ?? ""),
            createdAt: Number(m.createdAt) || 0,
            updatedAt: Number(m.updatedAt) || 0,
            model: m.model,
            backend: m.backend,
          });
        }
      } catch {
        /* skip a broken file */
      }
    }
    return out;
  }

  saveMeta(meta: SessionMeta): void {
    writeAtomic(this.metaPath(meta.id), JSON.stringify(meta));
  }

  saveBody(id: string, body: SessionBody): Promise<void> {
    return writeAtomicAsync(this.bodyPath(id), JSON.stringify(body));
  }

  saveBodySync(id: string, body: SessionBody): void {
    writeAtomic(this.bodyPath(id), JSON.stringify(body));
  }

  loadBody(id: string): SessionBody | null {
    try {
      const b = JSON.parse(fs.readFileSync(this.bodyPath(id), "utf8"));
      if (!b || typeof b !== "object" || !b.snapshot) return null;
      return { snapshot: b.snapshot, events: Array.isArray(b.events) ? b.events : [] };
    } catch {
      return null;
    }
  }

  delete(id: string): void {
    for (const p of [this.metaPath(id), this.bodyPath(id)]) {
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
          .map((e: any) => ({ path: e.path, addedAt: Number(e.addedAt) || 0, lastOpened: Number(e.lastOpened) || 0 }));
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
