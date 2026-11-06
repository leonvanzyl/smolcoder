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
import { noBackendsMessage, prepareModel, Session, SessionPrefs, SessionSnapshot, setupWithoutLocalModels } from "../session";
import { tryFetchJson } from "../util";
import { Attachment, classifyUpload, extOf, MAX_UPLOAD_BYTES, mimeForExt, safeName } from "../attachments";
import { Event, SessionChannel, uploadUrl } from "./channel";
import { PAGE_HTML } from "./page";
import { SESSION_ID_RE, SessionMeta, SessionStore, WorkspaceStore, workspaceKey } from "./store";
import { Terminal } from "./terminal";
import * as side from "./sidebar-data";
import { expandHome, groupOf, tilde } from "./sidebar-data";

export { browseDir, completeDir } from "./sidebar-data";

export type SessionFactory = (ui: SessionChannel, workspace: string, prefs: SessionPrefs) => Promise<Session>;

/** Upload ids are 16 hex chars; session ids follow SESSION_ID_RE. Both end
 * up in file paths under the data folder, so nothing else is accepted. */
const UPLOAD_ID_RE = /^[a-f0-9]{16}$/;

/** A worktree the hub did not remove, and why (shown to the user). */
export interface KeptWorktree {
  path: string;
  reason: string;
}

/** Recent SSE lines kept so a page that reconnects gets only what it missed. */
const RING_EVENTS = 10_000;
const RING_BYTES = 16 * 1024 * 1024;

/** The self-hosted UI font (Inter Variable, Latin), shipped in assets/fonts.
 * Resolved from the package root: this file runs as dist/web/hub.js, both in
 * a checkout and in an npm-installed copy. */
export const FONT_ROUTE = "/fonts/inter-latin-wght-normal.woff2";
export const FONT_FILE = path.join(__dirname, "..", "..", "assets", "fonts", "inter-latin-wght-normal.woff2");
let fontBytes: Buffer | null | undefined;
function serveFont(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (fontBytes === undefined) {
    try { fontBytes = fs.readFileSync(FONT_FILE); } catch { fontBytes = null; }
  }
  if (!fontBytes) {
    // Missing file: the CSS stack falls back to Segoe UI / system-ui.
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": "font/woff2",
    "content-length": fontBytes.length,
    "cache-control": "public, max-age=31536000, immutable",
  });
  res.end(req.method === "HEAD" ? undefined : fontBytes);
}

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
  /** Files uploaded for the next message, by id, until that message is sent. */
  uploads: Map<string, Attachment>;
  saveTimer: NodeJS.Timeout | null;
  saving: boolean;
  dirty: boolean;
  /** Set when the user deleted the session: never write it back. */
  discard: boolean;
  /** Model-written title attempts so far (bounded). */
  titleTries: number;
  /** The user renamed it by hand: never overwrite that. */
  titleByUser: boolean;
  saveFailed?: boolean;
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

// ---- @-mention file list ------------------------------------------------------

const MENTION_SKIP = new Set([".git", "node_modules", ".hg", ".svn"]);
const MENTION_CAP = 5000;

/** The top-level .gitignore as simple matchers: "name", "dir/", "/path",
 * "*.log". Negations and deeper globs are ignored (it only trims a list). */
function gitignoreMatchers(root: string): ((rel: string, name: string) => boolean)[] {
  let text = "";
  try {
    text = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const out: ((rel: string, name: string) => boolean)[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    line = line.replace(/\/+$/, "");
    const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
    line = line.replace(/^\/+/, "");
    if (!line || line.includes("**")) continue;
    const re = new RegExp(
      "^" + line.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$",
      process.platform === "win32" ? "i" : ""
    );
    out.push(anchored ? (rel) => re.test(rel) : (_rel, name) => re.test(name));
  }
  return out;
}

/** Workspace files for the composer's @ menu: relative, "/"-separated,
 * breadth first, capped. Skips VCS folders, node_modules and simple
 * .gitignore entries. Exported for tests. */
export function listWorkspaceFiles(root: string, cap = MENTION_CAP): { files: string[]; truncated: boolean } {
  const ignore = gitignoreMatchers(root);
  const ignored = (rel: string, name: string) => ignore.some((m) => m(rel, name));
  const files: string[] = [];
  const queue: string[] = [""];
  let truncated = false;
  let dirs = 0;
  while (queue.length) {
    const rel = queue.shift()!;
    if (++dirs > 20_000) {
      truncated = true;
      break;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (MENTION_SKIP.has(e.name) || ignored(r, e.name)) continue;
      if (e.isDirectory()) queue.push(r);
      else if (e.isFile() || e.isSymbolicLink()) {
        if (files.length >= cap) {
          truncated = true;
          return { files, truncated };
        }
        files.push(r);
      }
    }
  }
  return { files, truncated };
}

function defaultFactory(help: string): SessionFactory {
  return async (ui, workspace, prefs) => {
    const cfg = loadConfig();
    let chosen = await prepareModel(prefs, cfg, (label) => ui.startSpinner(label));
    ui.stopSpinner();
    // Nothing on this computer: the page offers to look on the network.
    if (!chosen) chosen = await setupWithoutLocalModels(ui, prefs);
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
  /** SSE event ids are "<boot>.<seq>": a page left over from an earlier hub
   * never resumes from this one's numbers. */
  private readonly boot = crypto.randomBytes(3).toString("hex");
  private seq = 0;
  private ring: { seq: number; line: string }[] = [];
  private ringBytes = 0;
  /** Sidebar git facts (branch, +N −M), refreshed off the snapshot path. */
  private git = new side.GitInfo(() => this.changed());
  private savedText = new side.SavedText();
  /** Unsaved worktree sessions that just closed, while their worktree is
   * being removed (exit paths list them instead of leaking them). */
  private releasing = new Map<string, SessionMeta>();

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
      // A worktree session with nothing saved: drop its worktree when that
      // loses nothing, otherwise keep it listed so it is not orphaned.
      if (!live.discard && live.meta.worktree && !this.metas.has(live.id)) {
        const r = side.removeWorktreeSync(groupOf(live.meta), live.meta.worktree.path);
        if (!r.removed) this.keepListed(live.meta);
      }
    }
    // Still being removed when the hub stops: list them (the folder may stay).
    for (const meta of this.releasing.values()) if (!this.metas.has(meta.id)) this.keepListed(meta);
    this.releasing.clear();
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
  openSession(workspace: string, extra: Partial<SessionMeta> = {}, id = crypto.randomBytes(4).toString("hex")): string {
    this.workspaces.add(extra.project ?? workspace);
    const now = Date.now();
    const live = this.makeLive(id, { id, workspace, title: "", createdAt: now, updatedAt: now, ...extra });
    void this.spawn(live, null);
    this.changed();
    return id;
  }

  /** A new session in its own git worktree on `branch` (new or existing). */
  async openSessionOnBranch(project: string, branch: string): Promise<string> {
    const id = crypto.randomBytes(4).toString("hex");
    const wt = side.worktreePathFor(this.dataDir, project, id);
    await side.addWorktree(project, wt, branch);
    return this.openSession(wt, { project, worktree: { path: wt, branch } }, id);
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
      live.channel.restoreReplay(body.events);
      // Old turns, not news: flagged so no page notifies about them.
      for (const ev of live.channel.replay) this.send({ ...ev, replay: true });
    }
    this.workspaces.add(groupOf(meta));
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

  /** The id of a session this hub knows (live or saved), or an error. Every
   * request naming a session goes through here before anything touches disk. */
  private knownSession(id: unknown): string {
    const s = typeof id === "string" ? id : "";
    if (!SESSION_ID_RE.test(s) || !(this.live.has(s) || this.metas.has(s))) throw new Error("unknown session");
    return s;
  }

  /** Delete a session: its files, uploads and (when nothing in it would be
   * lost) its worktree. Resolves with the worktree it kept, if any. */
  async deleteSession(id: string): Promise<{ kept?: KeptWorktree }> {
    id = this.knownSession(id);
    const live = this.live.get(id);
    const meta = live?.meta ?? this.metas.get(id)!;
    if (live) {
      live.discard = true;
      this.closeSession(id);
    }
    this.store.delete(id);
    this.metas.delete(id);
    try {
      fs.rmSync(this.uploadsDir(id), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    this.changed();
    const wt = meta.worktree;
    if (!wt) return {};
    // Only once the session has left: never under a running agent.
    if (!(await this.afterClose(id))) return { kept: { path: wt.path, reason: "the session was still closing" } };
    const r = await side.removeWorktree(groupOf(meta), wt.path);
    return r.removed ? {} : { kept: { path: wt.path, reason: r.reason ?? "it has changes" } };
  }

  renameSession(id: string, title: string): void {
    id = this.knownSession(id);
    title = title.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) return;
    const live = this.live.get(id);
    if (live) {
      live.channel.title = title;
      live.meta.title = title;
      live.titleByUser = true;
      live.channel.pushState();
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

  /** Forget a workspace and delete its saved sessions. Their worktrees go
   * only when nothing in them would be lost; the rest are kept on disk and
   * reported. Throws when the workspace still has open sessions. */
  async removeWorkspace(p: string): Promise<{ kept: KeptWorktree[] }> {
    const key = workspaceKey(p);
    for (const live of this.live.values()) {
      if (workspaceKey(groupOf(live.meta)) === key) throw new Error("close its open sessions first");
    }
    const worktrees: SessionMeta[] = [];
    for (const m of [...this.metas.values()]) {
      if (workspaceKey(groupOf(m)) === key) {
        if (m.worktree) worktrees.push(m);
        this.store.delete(m.id);
        this.metas.delete(m.id);
      }
    }
    this.workspaces.remove(p);
    this.changed();
    const kept: KeptWorktree[] = [];
    for (const m of worktrees) {
      const r = await side.removeWorktree(groupOf(m), m.worktree!.path);
      if (!r.removed) kept.push({ path: m.worktree!.path, reason: r.reason ?? "it has changes" });
    }
    return { kept };
  }

  // ---- sidebar metadata (UI only) --------------------------------------------

  /** Change a session's meta, live and saved, and persist it when saved. */
  editMeta(id: string, fn: (m: SessionMeta) => void): SessionMeta {
    const live = this.live.get(id);
    const saved = this.metas.get(id);
    const meta = live?.meta ?? saved;
    if (!meta) throw new Error("unknown session");
    fn(meta);
    if (saved && saved !== meta) fn(saved);
    if (saved) {
      try {
        this.store.saveMeta(meta);
      } catch {
        /* non-fatal */
      }
    }
    this.changed();
    return meta;
  }

  /** Archive (closing it when live) or restore. A worktree stays as it is:
   * archive is undoable and must not lose a file (an .env, a build output),
   * so only an explicit delete removes a worktree, and only a clean one. */
  archiveSession(id: string, archived: boolean): Record<string, never> {
    id = this.knownSession(id);
    this.editMeta(id, (m) => (archived ? (m.archivedAt = Date.now()) : delete m.archivedAt));
    if (archived) this.closeSession(id);
    return {};
  }

  /** Resolves true once a closing session has left, false after `ms`. */
  private async afterClose(id: string, ms = 5000): Promise<boolean> {
    const t0 = Date.now();
    while (this.live.has(id) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
    return !this.live.has(id);
  }

  /** busy|waiting -> idle: remember when and how the turn ended. */
  private turnEnded(live: Live): void {
    if (live.channel.pickerTurn) return;
    live.meta.lastTurnEndedAt = Date.now();
    const outcome = live.session?.state().outcome;
    if (outcome === "completed" || outcome === "error" || outcome === "cancelled") live.meta.lastOutcome = outcome;
    if (this.metas.has(live.id) || live.channel.title) this.scheduleSave(live);
    void this.git.refresh(live.workspace);
  }

  /** Titles, then transcripts. A search whose page went away (the page
   * aborts a query once a newer one is typed) stops reading files and
   * answers `stale: true` with no hits. */
  async searchSessions(q: string, cancelled: () => boolean = () => false): Promise<{ hits: Record<string, any>[]; stale?: boolean }> {
    const items: side.SearchItem[] = [];
    const item = (m: SessionMeta, title: string, text: () => string | Promise<string>) =>
      items.push({ id: m.id, title, workspace: groupOf(m), archived: !!m.archivedAt, updatedAt: m.updatedAt, text });
    for (const l of this.live.values()) item(l.meta, l.channel.title || l.meta.title, () => side.replayText(l.channel.replay));
    for (const m of this.metas.values()) if (!this.live.has(m.id)) item(m, m.title, () => this.savedText.get(this.store, m.id));
    const hits = await side.searchSessions(items, q, { stale: () => this.stopped || cancelled() });
    return hits ? { hits } : { hits: [], stale: true };
  }

  /** Folders the sidebar lists: the workspace list plus sessions' projects. */
  private knownFolders(): string[] {
    const out = this.workspaces.list().map((w) => w.path);
    for (const m of this.metas.values()) out.push(groupOf(m));
    for (const l of this.live.values()) out.push(groupOf(l.meta));
    return out;
  }

  private serveProjectIcon(res: http.ServerResponse, p: string): void {
    const key = p ? workspaceKey(p) : "";
    const known = !!key && this.knownFolders().some((f) => workspaceKey(f) === key);
    const file = known ? side.findProjectIcon(path.resolve(p)) : null;
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    side.serveIcon(res, file);
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
      uploads: new Map(),
      saveTimer: null,
      saving: false,
      dirty: false,
      discard: false,
      // A saved session already has a name; only fresh ones get one written.
      titleTries: meta.title ? 99 : 0,
      titleByUser: false,
    };
    channel.onPhase = (from, to) => {
      if (to === "idle" && (from === "busy" || from === "waiting")) this.turnEnded(live);
    };
    this.live.set(id, live);
    return live;
  }

  /** After the first turn: replace the verbatim first-message title with a
   * short model-written one. Bounded retries, never over a manual rename. */
  private async autoTitle(live: Live): Promise<void> {
    if (!live.session || live.titleByUser || live.titleTries >= 2) return;
    live.titleTries++;
    const title = await live.session.suggestTitle();
    if (!title || live.titleByUser || live.channel.closed || this.live.get(live.id) !== live) return;
    live.channel.title = title;
    live.meta.title = title;
    live.channel.pushState();
    this.changed();
    this.scheduleSave(live);
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
      prefs = { ...prefs, mode, backend: restore.backend, model: restore.model ?? prefs.model, baseUrl: restore.baseUrl, effort: restore.effort !== undefined ? restore.effort : prefs.effort, resumed: true };
    }
    try {
      if (live.meta.worktree) await side.ensureWorktree(groupOf(live.meta), live.meta.worktree);
      const session = await this.factory(live.channel, live.workspace, prefs);
      if (live.channel.closed || this.live.get(live.id) !== live) {
        session.taskManager.killAll();
        return;
      }
      live.session = session;
      session.onExit = () => this.sessionEnded(live.id);
      session.onTurnDone = () => void this.autoTitle(live);
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
      // A failed start must not leave "looking for model servers…" spinning.
      live.channel.stopSpinner();
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
    // Nothing was saved, so nothing lists this worktree any more: remove it
    // (freeing its branch) when that loses nothing, otherwise list it.
    if (!live.discard && live.meta.worktree && !this.metas.has(live.id)) void this.releaseWorktree(live.meta);
  }

  private async releaseWorktree(meta: SessionMeta): Promise<void> {
    this.releasing.set(meta.id, meta);
    let removed = false;
    try {
      removed = (await side.removeWorktree(groupOf(meta), meta.worktree!.path)).removed;
    } catch {
      /* kept */
    }
    if (!this.releasing.delete(meta.id)) return; // the hub stopped and listed it already
    if (!removed && !this.metas.has(meta.id) && !this.live.has(meta.id)) this.keepListed(meta);
  }

  /** Save a session that has no transcript as a listed one, so the
   * worktree it keeps can be found (and resumed) from the sidebar. */
  private keepListed(meta: SessionMeta): void {
    if (!meta.title && meta.worktree) meta.title = `Worktree on ${meta.worktree.branch}`;
    meta.updatedAt = Date.now();
    this.metas.set(meta.id, meta);
    try {
      this.store.saveMeta(meta);
    } catch {
      /* listed for this run at least */
    }
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
      live.saveFailed = false;
    } catch (err: any) {
      if (!live.saveFailed) {
        live.saveFailed = true;
        live.channel.warn(`Session could not be saved: ${err?.message ?? err}. Keep this session open and check free disk space and permissions.`);
      }
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
    if (ev.t === "hub") {
      // A sidebar snapshot replaces the one before, and a resuming page gets
      // a fresh one anyway: no id, and never kept in the resume ring.
      const line = `data: ${JSON.stringify(ev)}\n\n`;
      for (const c of this.clients) c.write(line);
      return;
    }
    const seq = ++this.seq;
    const line = `id: ${this.boot}.${seq}\ndata: ${JSON.stringify(ev)}\n\n`;
    this.ring.push({ seq, line });
    this.ringBytes += line.length;
    while (this.ring.length > RING_EVENTS || (this.ringBytes > RING_BYTES && this.ring.length > 1)) {
      this.ringBytes -= this.ring.shift()!.line.length;
    }
    for (const c of this.clients) c.write(line);
  }

  /** The events after `lastId`, when the ring still holds all of them. */
  private missedSince(lastId: string | undefined): string[] | null {
    const m = /^([a-f0-9]+)\.(\d+)$/.exec(String(lastId ?? "").trim());
    if (!m || m[1] !== this.boot) return null;
    const last = Number(m[2]);
    if (last > this.seq) return null;
    if (last === this.seq) return [];
    const first = this.ring[0]?.seq ?? this.seq + 1;
    if (first > last + 1) return null; // a gap: some of what it missed is gone
    return this.ring.filter((r) => r.seq > last).map((r) => r.line);
  }

  /** Coalesced: many status flips in one tick produce one snapshot. */
  private changed(): void {
    if (this.hubTimer || this.stopped) return;
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
    const entries = new Map(this.workspaces.list().map((w) => [workspaceKey(w.path), w]));
    for (const w of entries.values()) {
      const g = group(w.path);
      g.last = Math.max(g.last, w.lastOpened);
    }
    for (const m of this.metas.values()) {
      if (this.live.has(m.id)) continue;
      group(groupOf(m)).sessions.push({
        id: m.id,
        title: m.title,
        status: "stored",
        live: false,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        model: m.model,
        terminals: [],
        ...side.sessionFields(m, this.git),
      });
    }
    for (const l of this.live.values()) {
      group(groupOf(l.meta)).sessions.push({
        id: l.id,
        title: l.channel.title || l.meta.title,
        status: l.channel.phase,
        live: true,
        createdAt: l.meta.createdAt,
        updatedAt: l.meta.updatedAt,
        model: l.meta.model,
        terminals: [...l.terminals.values()].map((t) => ({ tid: t.id, cwd: t.cwd })),
        phaseSince: l.channel.phaseSince,
        ...side.sessionFields(l.meta, this.git),
      });
    }
    const workspaces = [...groups.values()]
      .map((g) => {
        g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        const last = Math.max(g.last, ...g.sessions.map((s) => s.updatedAt));
        const w = entries.get(workspaceKey(g.path));
        return {
          path: g.path,
          name: path.basename(g.path) || g.path,
          display: tilde(g.path),
          last,
          sessions: g.sessions,
          pinnedAt: w?.pinnedAt,
          order: w?.order,
          addedAt: w?.addedAt,
          lastOpened: w?.lastOpened,
          icon: side.findProjectIcon(g.path) !== null,
          git: this.git.get(g.path),
        };
      })
      .sort((a, b) => b.last - a.last);
    return { t: "hub", home: os.homedir(), sep: path.sep, version: this.opts.version, workspaces };
  }

  // ---- http ---------------------------------------------------------------------

  /** host:port forms the page may be served under. */
  private loopbackNames(): string[] {
    const names = ["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${this.port}`);
    // Port 80 is the default: browsers then leave it out of Host and Origin.
    if (this.port === 80) names.push("127.0.0.1", "localhost", "[::1]");
    return names;
  }

  private hostAllowed(host: string | undefined): boolean {
    const h = String(host ?? "").trim().toLowerCase();
    return this.loopbackNames().includes(h);
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    // DNS rebinding: a page on another site whose name now points at
    // 127.0.0.1 reaches this server with its own name in Host. Only the
    // loopback names are served, on every route (the font included).
    if (!this.hostAllowed(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden — open smolcoder's printed URL (http://127.0.0.1:" + this.port + "/…)");
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const origin = req.headers.origin;
    const sameOrigin = !origin || this.loopbackNames().some((h) => origin === `http://${h}`);
    // The bundled UI font is public, and CSS url() cannot carry the key, so
    // this one path is served before the key check (same origin still applies).
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === FONT_ROUTE && sameOrigin) {
      serveFont(req, res);
      return;
    }
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
        case "/files": {
          const live = this.live.get(String(url.searchParams.get("sid") ?? ""));
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          json(200, listWorkspaceFiles(live.workspace));
          return;
        }
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
        case "/fs": {
          const p = url.searchParams.get("path");
          (url.searchParams.get("complete") === "1" ? side.completeDirAsync(p) : side.browseDirAsync(p)).then(
            (r) => json(200, r),
            (err: any) => json(400, { error: String(err?.message ?? err) })
          );
          return;
        }
        case "/workspaces/suggest":
          json(200, { dirs: side.suggestWorkspaces(this.knownFolders()) });
          return;
        case "/workspaces/icon":
          this.serveProjectIcon(res, String(url.searchParams.get("path") ?? ""));
          return;
        case "/sessions/search": {
          let gone = false;
          res.on("close", () => (gone = true));
          this.searchSessions(String(url.searchParams.get("q") ?? ""), () => gone).then(
            (r) => {
              if (!gone) json(200, r);
            },
            (err: any) => json(400, { error: String(err?.message ?? err) })
          );
          return;
        }
        case "/upload":
          this.serveUpload(res, url);
          return;
        default:
          res.writeHead(404);
          res.end();
          return;
      }
    }
    if (req.method === "POST") {
      if (url.pathname === "/upload") {
        this.receiveUpload(req, res, url);
        return;
      }
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
        Promise.resolve()
          .then(() => this.handlePost(url.pathname, data))
          .then(
            (r) => json(200, r ?? {}),
            (err: any) => json(400, { error: String(err?.message ?? err) })
          );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }

  /** One stream for every session. A reconnecting page sends Last-Event-ID
   * (the browser does it by itself; ?last= works too): when the ring still
   * holds everything after it, only that is sent and the page keeps its DOM.
   * Otherwise (first visit, a gap, another hub) "reset" and a full replay.
   * Either way it ends with "synced", which carries the current id. */
  private sse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const write = (ev: Event) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const lastId = (req.headers["last-event-id"] as string | undefined) ?? url.searchParams.get("last") ?? undefined;
    const missed = this.missedSince(lastId);
    if (missed) {
      for (const line of missed) res.write(line);
      write(this.snapshot());
    } else {
      write({ t: "reset" });
      write(this.snapshot());
      for (const l of this.live.values()) {
        for (const ev of l.channel.replay) write(ev);
        write(l.channel.stateEvent());
        for (const t of l.terminals.values()) {
          write({ t: "termopen", sid: l.id, tid: t.id, cwd: t.cwd });
          if (t.buffer) write({ t: "term", sid: l.id, tid: t.id, s: t.buffer });
        }
      }
    }
    res.write(`id: ${this.boot}.${this.seq}\ndata: ${JSON.stringify({ t: "synced", resumed: !!missed })}\n\n`);
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  // ---- attachments ---------------------------------------------------------

  private uploadsDir(sid: string): string {
    // "" would be the whole uploads folder and ".." the data folder.
    if (!SESSION_ID_RE.test(sid)) throw new Error("not a session id");
    return path.join(this.dataDir, "uploads", sid);
  }

  /** One file for a live session, sent as the raw request body with the name
   * in the query string (a pasted screenshot has no name; the page makes one). */
  private receiveUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const reply = (code: number, body: any) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const sid = String(url.searchParams.get("sid") ?? "");
    const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
    if (!live) {
      reply(404, { error: "no such session" });
      req.resume();
      return;
    }
    const name = safeName(url.searchParams.get("name"));
    const mime = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (d: Buffer) => {
      if (failed) return;
      size += d.length;
      if (size > MAX_UPLOAD_BYTES) {
        failed = true;
        reply(413, { error: `"${name}" is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB upload limit.` });
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => {
      if (failed) return;
      const bytes = Buffer.concat(chunks);
      const verdict = classifyUpload(name, mime, bytes);
      if ("error" in verdict) {
        reply(415, { error: verdict.error });
        return;
      }
      const id = crypto.randomBytes(8).toString("hex");
      const dir = this.uploadsDir(sid);
      const file = path.join(dir, `${id}.${extOf(name, mime)}`);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, bytes);
      } catch (err: any) {
        reply(500, { error: `could not store the upload: ${err?.message ?? err}` });
        return;
      }
      const att: Attachment = { id, name, kind: verdict.kind, mime: verdict.mime, size: bytes.length, path: file };
      live.uploads.set(id, att);
      const model = live.session?.chosen;
      const warning =
        att.kind === "image" && model?.vision === false
          ? `${model.id} cannot see images — switch to a vision-capable model with /models`
          : undefined;
      reply(200, { id, name, kind: att.kind, size: att.size, url: uploadUrl(sid, id), ...(warning ? { warning } : {}) });
    });
  }

  /** A stored upload, for the page's thumbnails and "open" links. */
  private serveUpload(res: http.ServerResponse, url: URL): void {
    const sid = String(url.searchParams.get("sid") ?? "");
    const id = String(url.searchParams.get("id") ?? "");
    const file = SESSION_ID_RE.test(sid) && UPLOAD_ID_RE.test(id) ? this.findUpload(sid, id) : null;
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": mimeForExt(path.extname(file).slice(1)), "content-length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  }

  private findUpload(sid: string, id: string): string | null {
    const dir = this.uploadsDir(sid);
    try {
      const entry = fs.readdirSync(dir).find((f) => f.startsWith(id + "."));
      return entry ? path.join(dir, entry) : null;
    } catch {
      return null;
    }
  }

  /** The user took a chip off the composer: forget the file. */
  private removeUpload(live: Live, id: string): void {
    const att = live.uploads.get(id);
    live.uploads.delete(id);
    const file = att?.path ?? (UPLOAD_ID_RE.test(id) ? this.findUpload(live.id, id) : null);
    if (!file) return;
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }

  private checkDir(p: any): string {
    const s = String(p ?? "").trim();
    if (!s) throw new Error("path is required");
    const abs = path.resolve(expandHome(s));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`not a folder: ${abs}`);
    return abs;
  }

  /** A folder named in a request (it need not exist any more). */
  private folderArg(p: any): string {
    const s = String(p ?? "").trim();
    if (!s) throw new Error("path is required");
    return path.resolve(expandHome(s));
  }

  private handlePost(p: string, d: any): any | Promise<any> {
    const sid = String(d.sid ?? "");
    const live = () => {
      const l = this.live.get(sid);
      if (!l) throw new Error("no such session");
      return l;
    };
    switch (p) {
      case "/msg": {
        const l = live();
        const ids: string[] = Array.isArray(d.attachments) ? d.attachments.map(String) : [];
        const attachments = ids.map((id) => l.uploads.get(id));
        if (attachments.some((a) => !a)) throw new Error("an attachment is no longer available — add it again");
        for (const id of ids) l.uploads.delete(id);
        l.channel.handleMessage(String(d.text ?? ""), attachments as Attachment[], typeof d.via === "string" ? d.via : undefined);
        return {};
      }
      case "/queue/remove":
        if (!live().channel.removeQueued(Number(d.id))) throw new Error("that message is no longer waiting");
        return {};
      case "/queue/resume":
        live().channel.resumeQueue();
        return {};
      case "/queue/clear":
        live().channel.clearQueue();
        return {};
      case "/select/star":
        return live()
          .channel.star(Number(d.id), Number(d.index))
          .then((options) => {
            if (!options) throw new Error("this list cannot be starred");
            return { options };
          });
      case "/command/args":
        return live()
          .channel.commandArgs(String(d.name ?? ""))
          .then((options) => ({ options }));
      case "/upload/remove":
        this.removeUpload(live(), String(d.id ?? ""));
        return {};
      case "/confirm":
        live().channel.handleAnswer(Number(d.id), d.answer);
        return {};
      case "/select":
        live().channel.handleAnswer(Number(d.id), d.index);
        return {};
      case "/prompt":
        live().channel.handleAnswer(Number(d.id), typeof d.value === "string" ? d.value : null);
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
      case "/sessions/new": {
        const ws = this.checkDir(d.workspace);
        const branch = typeof d.branch === "string" ? d.branch.trim() : "";
        return branch ? this.openSessionOnBranch(ws, branch).then((id) => ({ id })) : { id: this.openSession(ws) };
      }
      case "/sessions/seen":
        this.editMeta(this.knownSession(d.id), (m) => (m.lastVisitedAt = Date.now()));
        return {};
      case "/sessions/unread":
        this.editMeta(this.knownSession(d.id), (m) => {
          m.lastTurnEndedAt ??= m.updatedAt || Date.now();
          m.lastVisitedAt = m.lastTurnEndedAt - 1;
        });
        return {};
      case "/sessions/pin":
        this.editMeta(this.knownSession(d.id), (m) => (d.pinned ? (m.pinnedAt = Date.now()) : delete m.pinnedAt));
        return {};
      case "/sessions/archive":
        return this.archiveSession(d.id, !!d.archived);
      case "/workspaces/pin":
        this.workspaces.setPinned(this.folderArg(d.path), !!d.pinned);
        this.changed();
        return {};
      case "/workspaces/order":
        this.workspaces.setOrder(Array.isArray(d.paths) ? d.paths.map((p: any) => this.folderArg(p)) : []);
        this.changed();
        return {};
      case "/sessions/resume":
        if (!this.resumeSession(this.knownSession(d.id))) throw new Error("unknown session");
        return { id: d.id };
      case "/sessions/close":
        this.closeSession(this.knownSession(d.id));
        return {};
      case "/sessions/delete":
        return this.deleteSession(d.id);
      case "/sessions/rename":
        this.renameSession(d.id, String(d.title ?? ""));
        return {};
      case "/workspaces/add": {
        const ws = this.checkDir(d.path);
        this.workspaces.add(ws);
        this.changed();
        return d.start ? { path: ws, id: this.openSession(ws) } : { path: ws };
      }
      case "/workspaces/remove":
        return this.removeWorkspace(this.folderArg(d.path));
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
