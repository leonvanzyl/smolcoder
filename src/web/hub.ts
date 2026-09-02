// The web hub: what `smol --web` serves. One local HTTP server hosting many
// sessions across many workspaces — the browser page shows them in a sidebar
// and can start, resume, switch between, close and delete them. All sessions
// share one SSE stream (events are tagged with a session id) and one random
// URL token; the server binds to loopback only.
//
// Sessions are saved under ~/.smolcoder/sessions/ as they run, so the sidebar
// survives a restart and any past session can be resumed. A second
// `smol --web` started elsewhere finds the running hub through
// ~/.smolcoder/web.json and adds its folder there instead of starting a
// second server.

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { DATA_DIR, loadConfig } from "../config";
import { noBackendsMessage, prepareModel, Session, SessionPrefs, SessionSnapshot } from "../session";
import { tryFetchJson } from "../util";
import { Event, SessionChannel } from "./channel";
import { PAGE_HTML } from "./page";
import { SessionMeta, SessionStore, WorkspaceStore, workspaceKey } from "./store";
import { Terminal } from "./terminal";

export type SessionFactory = (ui: SessionChannel, workspace: string, prefs: SessionPrefs) => Promise<Session>;

export interface HubOptions {
  port: number;
  prefs: SessionPrefs;
  help: string;
  version: string;
  dataDir?: string;
  /** Builds a live Session for a workspace (tests inject a fake). */
  factory?: SessionFactory;
  /** No stdout chatter (tests). */
  quiet?: boolean;
}

interface Live {
  id: string;
  workspace: string;
  channel: SessionChannel;
  session: Session | null;
  meta: SessionMeta;
  error: string | null;
  /** Snapshot to restore when a failed start is retried. */
  pendingRestore: SessionSnapshot | null;
  terminals: Map<string, Terminal>;
  saveTimer: NodeJS.Timeout | null;
  saving: boolean;
  dirty: boolean;
  /** Set when the user deleted the session: never write it back. */
  discard: boolean;
}

// ---- the running-hub record -----------------------------------------------

export interface HubRecord {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

const HUB_FILE = "web.json";

export function readHubRecord(dataDir = DATA_DIR): HubRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dataDir, HUB_FILE), "utf8"));
    if (r && typeof r.port === "number" && typeof r.token === "string") return r;
  } catch {
    /* none */
  }
  return null;
}

function writeHubRecord(rec: HubRecord, dataDir: string): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, HUB_FILE), JSON.stringify(rec));
  } catch {
    /* non-fatal: a second smol --web will just start its own server */
  }
}

function clearHubRecord(pid: number, dataDir: string): void {
  const rec = readHubRecord(dataDir);
  if (rec && rec.pid === pid) {
    try {
      fs.unlinkSync(path.join(dataDir, HUB_FILE));
    } catch {
      /* gone */
    }
  }
}

/** Is the hub a previous invocation recorded still answering? */
export async function pingHub(rec: HubRecord): Promise<boolean> {
  const r = await tryFetchJson(`http://127.0.0.1:${rec.port}/ping?k=${rec.token}`, undefined, 1500);
  return !!r?.ok;
}

/** Ask a running hub to add a workspace (and optionally start a session). */
export function askHubToOpen(rec: HubRecord, workspace: string, start: boolean): Promise<{ id?: string; path?: string } | null> {
  return tryFetchJson(
    `http://127.0.0.1:${rec.port}/workspaces/add?k=${rec.token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: workspace, start }),
    },
    5000
  );
}

// ---- helpers ----------------------------------------------------------------

function tilde(p: string): string {
  const home = os.homedir();
  const same = process.platform === "win32" ? p.slice(0, home.length).toLowerCase() === home.toLowerCase() : p.startsWith(home);
  return same ? "~" + p.slice(home.length).replace(/\\/g, "/") : p;
}

function expandHome(s: string): string {
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return s;
}

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "AGENTS.md", "pom.xml", "Gemfile"];
function isProject(dir: string): boolean {
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

/** Folder listing for the "open folder" picker. Exported for tests. */
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
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.test(e.name))
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

function defaultFactory(help: string): SessionFactory {
  return async (ui, workspace, prefs) => {
    const cfg = loadConfig();
    const chosen = await prepareModel(prefs, cfg, (label) => ui.startSpinner(label));
    ui.stopSpinner();
    if (!chosen) throw new Error(noBackendsMessage());
    return new Session(ui, { workspace, chosen, prefs, cfg, help });
  };
}

// ---- the hub ----------------------------------------------------------------

export class WebHub {
  readonly authToken = crypto.randomBytes(9).toString("base64url");
  readonly dataDir: string;
  port: number;

  private server: http.Server | null = null;
  private clients = new Set<http.ServerResponse>();
  private live = new Map<string, Live>();
  private metas = new Map<string, SessionMeta>();
  private store: SessionStore;
  private workspaces: WorkspaceStore;
  private factory: SessionFactory;
  private hubTimer: NodeJS.Timeout | null = null;
  private termCounter = 0;
  private stopped = false;

  constructor(private opts: HubOptions) {
    this.port = opts.port;
    this.dataDir = opts.dataDir ?? DATA_DIR;
    this.store = new SessionStore(this.dataDir);
    this.workspaces = new WorkspaceStore(this.dataDir);
    for (const m of this.store.listMetas()) this.metas.set(m.id, m);
    this.factory = opts.factory ?? defaultFactory(opts.help);
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/?k=${this.authToken}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.route(req, res));
      this.server = server;
      server.once("error", reject);
      server.listen(this.opts.port, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") this.port = addr.port;
        writeHubRecord({ port: this.port, token: this.authToken, pid: process.pid, startedAt: Date.now() }, this.dataDir);
        resolve();
      });
    });
  }

  /** Synchronous teardown for exit paths: save what has something to save,
   * kill background tasks and terminals, drop the running-hub record. */
  shutdownSync(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const live of this.live.values()) {
      if (live.saveTimer) clearTimeout(live.saveTimer);
      try {
        if (!live.discard && live.session && live.channel.title) this.saveSync(live);
      } catch {
        /* best effort */
      }
      live.session?.taskManager.killAll();
      for (const t of live.terminals.values()) t.close();
    }
    clearHubRecord(process.pid, this.dataDir);
    for (const c of this.clients) c.end();
    this.server?.close();
  }

  close(): void {
    this.shutdownSync();
  }

  private log(s: string): void {
    if (!this.opts.quiet) console.log(s);
  }

  // ---- sessions ---------------------------------------------------------------

  addWorkspace(p: string): void {
    this.workspaces.add(p);
    this.changed();
  }

  /** Start a new session in a workspace; returns its id right away while the
   * model is detected and loaded in the background. */
  openSession(workspace: string): string {
    const id = crypto.randomBytes(4).toString("hex");
    this.workspaces.add(workspace);
    const now = Date.now();
    const live = this.makeLive(id, { id, workspace, title: "", createdAt: now, updatedAt: now });
    void this.spawn(live, null);
    this.changed();
    return id;
  }

  /** Bring a saved session back to life (or retry one that failed to start). */
  resumeSession(id: string): boolean {
    const existing = this.live.get(id);
    if (existing) {
      if (existing.error) void this.spawn(existing, existing.pendingRestore);
      return true;
    }
    const meta = this.metas.get(id);
    if (!meta) return false;
    const body = this.store.loadBody(id);
    const live = this.makeLive(id, meta);
    live.channel.title = meta.title;
    if (body) {
      live.channel.replay = body.events.slice(-2000);
      for (const ev of live.channel.replay) this.send(ev);
    }
    this.workspaces.add(meta.workspace);
    void this.spawn(live, body?.snapshot ?? null);
    this.changed();
    return true;
  }

  closeSession(id: string): boolean {
    const live = this.live.get(id);
    if (!live) return false;
    if (!live.session) {
      // Still starting (or failed to start): there is no loop to unwind.
      live.channel.close();
      this.dropLive(live);
      return true;
    }
    live.channel.cancel();
    live.channel.requestExit();
    return true;
  }

  deleteSession(id: string): void {
    const live = this.live.get(id);
    if (live) {
      live.discard = true;
      this.closeSession(id);
    }
    this.store.delete(id);
    this.metas.delete(id);
    this.changed();
  }

  renameSession(id: string, title: string): void {
    title = title.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) return;
    const live = this.live.get(id);
    if (live) {
      live.channel.title = title;
      live.meta.title = title;
      this.scheduleSave(live);
    }
    const meta = this.metas.get(id);
    if (meta) {
      meta.title = title;
      try {
        this.store.saveMeta(meta);
      } catch {
        /* non-fatal */
      }
    }
    this.changed();
  }

  /** Forget a workspace and delete its saved sessions. Returns an error
   * message when it still has open sessions. */
  removeWorkspace(p: string): string | null {
    const key = workspaceKey(p);
    for (const live of this.live.values()) {
      if (workspaceKey(live.workspace) === key) return "close its open sessions first";
    }
    for (const m of [...this.metas.values()]) {
      if (workspaceKey(m.workspace) === key) {
        this.store.delete(m.id);
        this.metas.delete(m.id);
      }
    }
    this.workspaces.remove(p);
    this.changed();
    return null;
  }

  private makeLive(id: string, meta: SessionMeta): Live {
    const channel = new SessionChannel(id, {
      send: (ev) => this.send(ev),
      changed: () => this.changed(),
      touched: (sid) => this.touched(sid),
    });
    const live: Live = {
      id,
      workspace: meta.workspace,
      channel,
      session: null,
      meta,
      error: null,
      pendingRestore: null,
      terminals: new Map(),
      saveTimer: null,
      saving: false,
      dirty: false,
      discard: false,
    };
    this.live.set(id, live);
    return live;
  }

  private async spawn(live: Live, restore: SessionSnapshot | null): Promise<void> {
    live.error = null;
    live.pendingRestore = restore;
    live.channel.phase = "starting";
    this.changed();
    let prefs: SessionPrefs = this.opts.prefs;
    if (restore) {
      // A saved bypass mode is not inherited silently, same as the config:
      // the user re-enables it per session.
      const mode = restore.mode === "bypass" ? "edit" : restore.mode ?? prefs.mode;
      prefs = { ...prefs, mode, model: restore.model ?? prefs.model, effort: restore.effort !== undefined ? restore.effort : prefs.effort };
    }
    try {
      const session = await this.factory(live.channel, live.workspace, prefs);
      if (live.channel.closed || this.live.get(live.id) !== live) {
        session.taskManager.killAll();
        return;
      }
      live.session = session;
      session.onExit = () => this.sessionEnded(live.id);
      live.channel.getState = () => session.state();
      if (restore) session.restore(restore);
      live.meta.model = session.chosen.id;
      live.meta.backend = session.chosen.backend;
      session.announce();
      if (restore) {
        live.channel.status(
          `· session resumed${restore.mode === "bypass" ? " in edit mode (bypass is not restored)" : ""} — earlier command approvals are not remembered`
        );
      }
      this.log(`  ● ${live.id} · ${tilde(live.workspace)} · ${session.chosen.id}`);
      this.changed();
      session.run().catch((err) => live.channel.error(String(err?.message ?? err)));
    } catch (err: any) {
      live.error = String(err?.message ?? err);
      live.channel.phase = "error";
      live.channel.error(live.error);
      live.channel.warn("Start a backend, then click this session in the sidebar to retry.");
      this.changed();
    }
  }

  private sessionEnded(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    if (!live.discard && live.session && live.channel.title) {
      try {
        this.saveSync(live);
      } catch {
        /* best effort */
      }
    }
    this.dropLive(live);
    this.log(`  ○ ${id} closed`);
  }

  private dropLive(live: Live): void {
    if (live.saveTimer) {
      clearTimeout(live.saveTimer);
      live.saveTimer = null;
    }
    for (const t of live.terminals.values()) t.close();
    live.terminals.clear();
    if (this.live.get(live.id) === live) this.live.delete(live.id);
    this.send({ t: "closed", sid: live.id });
    this.changed();
  }

  // ---- saving -----------------------------------------------------------------

  private touched(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    live.meta.updatedAt = Date.now();
    this.scheduleSave(live);
  }

  private scheduleSave(live: Live): void {
    live.dirty = true;
    if (live.saveTimer) return;
    live.saveTimer = setTimeout(() => {
      live.saveTimer = null;
      void this.save(live);
    }, 1500);
  }

  private async save(live: Live): Promise<void> {
    // Untitled sessions (nothing sent yet) are not worth a file.
    if (!live.session || live.discard || !live.channel.title) return;
    if (live.saving) {
      live.dirty = true;
      return;
    }
    live.saving = true;
    live.dirty = false;
    try {
      live.meta.title = live.channel.title;
      this.metas.set(live.id, live.meta);
      this.store.saveMeta(live.meta);
      await this.store.saveBody(live.id, { snapshot: live.session.snapshot(), events: live.channel.replay });
    } catch {
      /* disk trouble is not worth interrupting the session for */
    }
    live.saving = false;
    if (live.dirty) this.scheduleSave(live);
  }

  private saveSync(live: Live): void {
    if (!live.session) return;
    live.meta.title = live.channel.title;
    this.metas.set(live.id, live.meta);
    this.store.saveMeta(live.meta);
    this.store.saveBodySync(live.id, { snapshot: live.session.snapshot(), events: live.channel.replay });
  }

  // ---- terminals --------------------------------------------------------------

  openTerminal(sid: string): { tid: string; cwd: string } | null {
    const live = this.live.get(sid);
    if (!live) return null;
    const tid = `t${++this.termCounter}`;
    this.send({ t: "termopen", sid, tid, cwd: live.workspace });
    const term = new Terminal(tid, live.workspace, {
      output: (text) => this.send({ t: "term", sid, tid, s: text }),
      done: (code, cwd) => this.send({ t: "termdone", sid, tid, code, cwd }),
    });
    live.terminals.set(tid, term);
    this.changed();
    return { tid, cwd: term.cwd };
  }

  closeTerminal(sid: string, tid: string): void {
    const live = this.live.get(sid);
    const t = live?.terminals.get(tid);
    if (!live || !t) return;
    t.close();
    live.terminals.delete(tid);
    this.send({ t: "termclosed", sid, tid });
    this.changed();
  }

  // ---- broadcasting -----------------------------------------------------------

  private send(ev: Event): void {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of this.clients) c.write(line);
  }

  /** Coalesced: many status flips in one tick produce one snapshot. */
  private changed(): void {
    if (this.hubTimer) return;
    this.hubTimer = setTimeout(() => {
      this.hubTimer = null;
      this.send(this.snapshot());
    }, 25);
  }

  /** What the sidebar shows. Exported through the SSE stream and /ping. */
  snapshot(): Event {
    const groups = new Map<string, { path: string; sessions: any[]; last: number }>();
    const group = (p: string) => {
      const key = workspaceKey(p);
      let g = groups.get(key);
      if (!g) {
        g = { path: p, sessions: [], last: 0 };
        groups.set(key, g);
      }
      return g;
    };
    for (const w of this.workspaces.list()) {
      const g = group(w.path);
      g.last = Math.max(g.last, w.lastOpened);
    }
    for (const m of this.metas.values()) {
      if (this.live.has(m.id)) continue;
      group(m.workspace).sessions.push({
        id: m.id,
        title: m.title,
        status: "stored",
        live: false,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        model: m.model,
        terminals: [],
      });
    }
    for (const l of this.live.values()) {
      group(l.workspace).sessions.push({
        id: l.id,
        title: l.channel.title || l.meta.title,
        status: l.channel.phase,
        live: true,
        createdAt: l.meta.createdAt,
        updatedAt: l.meta.updatedAt,
        model: l.meta.model,
        terminals: [...l.terminals.values()].map((t) => ({ tid: t.id, cwd: t.cwd })),
      });
    }
    const workspaces = [...groups.values()]
      .map((g) => {
        g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        const last = Math.max(g.last, ...g.sessions.map((s) => s.updatedAt));
        return { path: g.path, name: path.basename(g.path) || g.path, display: tilde(g.path), last, sessions: g.sessions };
      })
      .sort((a, b) => b.last - a.last);
    return { t: "hub", home: os.homedir(), sep: path.sep, version: this.opts.version, workspaces };
  }

  // ---- http ---------------------------------------------------------------------

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const origin = req.headers.origin;
    const sameOrigin =
      !origin || origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
    if (url.searchParams.get("k") !== this.authToken || !sameOrigin) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden — open smolcoder's printed URL (it includes the session key)");
      return;
    }
    const json = (code: number, body: any) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET") {
      switch (url.pathname) {
        case "/":
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(PAGE_HTML);
          return;
        case "/ping":
          json(200, { ok: true, pid: process.pid, version: this.opts.version });
          return;
        case "/events":
          this.sse(req, res);
          return;
        case "/fs":
          json(200, browseDir(url.searchParams.get("path")));
          return;
        default:
          res.writeHead(404);
          res.end();
          return;
      }
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (d) => {
        body += d;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        let data: any = {};
        try {
          data = body ? JSON.parse(body) : {};
        } catch {
          /* ignore */
        }
        try {
          json(200, this.handlePost(url.pathname, data) ?? {});
        } catch (err: any) {
          json(400, { error: String(err?.message ?? err) });
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }

  private sse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const write = (ev: Event) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    write(this.snapshot());
    for (const l of this.live.values()) {
      for (const ev of l.channel.replay) write(ev);
      write(l.channel.stateEvent());
      for (const t of l.terminals.values()) {
        write({ t: "termopen", sid: l.id, tid: t.id, cwd: t.cwd });
        if (t.buffer) write({ t: "term", sid: l.id, tid: t.id, s: t.buffer });
      }
    }
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  private checkDir(p: any): string {
    const s = String(p ?? "").trim();
    if (!s) throw new Error("path is required");
    const abs = path.resolve(expandHome(s));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`not a folder: ${abs}`);
    return abs;
  }

  private handlePost(p: string, d: any): any {
    const sid = String(d.sid ?? "");
    const live = () => {
      const l = this.live.get(sid);
      if (!l) throw new Error("no such session");
      return l;
    };
    switch (p) {
      case "/msg":
        live().channel.handleMessage(String(d.text ?? ""));
        return {};
      case "/confirm":
        live().channel.handleAnswer(Number(d.id), d.answer);
        return {};
      case "/select":
        live().channel.handleAnswer(Number(d.id), d.index);
        return {};
      case "/cycle": {
        const l = live();
        l.channel.onModeCycle?.();
        l.channel.refresh();
        return {};
      }
      case "/cancel":
        live().channel.cancel();
        return {};
      case "/sessions/new":
        return { id: this.openSession(this.checkDir(d.workspace)) };
      case "/sessions/resume":
        if (!this.resumeSession(String(d.id ?? ""))) throw new Error("unknown session");
        return { id: d.id };
      case "/sessions/close":
        this.closeSession(String(d.id ?? ""));
        return {};
      case "/sessions/delete":
        this.deleteSession(String(d.id ?? ""));
        return {};
      case "/sessions/rename":
        this.renameSession(String(d.id ?? ""), String(d.title ?? ""));
        return {};
      case "/workspaces/add": {
        const ws = this.checkDir(d.path);
        this.workspaces.add(ws);
        this.changed();
        return d.start ? { path: ws, id: this.openSession(ws) } : { path: ws };
      }
      case "/workspaces/remove": {
        const err = this.removeWorkspace(String(d.path ?? ""));
        if (err) throw new Error(err);
        return {};
      }
      case "/term/open": {
        const r = this.openTerminal(sid);
        if (!r) throw new Error("no such session");
        return r;
      }
      case "/term/input": {
        const t = live().terminals.get(String(d.tid ?? ""));
        if (!t) throw new Error("no such terminal");
        t.write(String(d.text ?? ""));
        return {};
      }
      case "/term/interrupt": {
        const t = live().terminals.get(String(d.tid ?? ""));
        if (!t) throw new Error("no such terminal");
        t.interrupt();
        return {};
      }
      case "/term/close":
        this.closeTerminal(sid, String(d.tid ?? ""));
        return {};
      default:
        throw new Error(`unknown endpoint ${p}`);
    }
  }
}
