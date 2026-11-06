// The inline TUI: an accent-bar input block with the
// session status (mode · model · effort · ctx) inside it, a slash-command menu
// that opens above the input as you type "/", "@" file mentions, arrow-key
// pickers with fuzzy type-to-filter, a ctrl+p command palette, ctrl+r history
// search and shift+tab mode cycling. Hand-rolled ANSI, zero deps, written into
// normal scrollback (no alternate screen).
//
// Output model: finished output is *committed* to scrollback; below it sits a
// small *frame* that is erased and redrawn — the input block while waiting for
// input, and while the agent runs a live region: the unfinished markdown line,
// the reasoning ticker and a 1-row footer (spinner · action · elapsed · esc ·
// ctx). Writes are batched every ~33ms and wrapped in synchronized output, with
// the cursor hidden during the repaint, so streaming never flickers.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findCommand } from "../commands";
import { DATA_DIR } from "../config";
import { Plan } from "../plan";
import { PromptOptions, SelectOption, SelectOpts, SessionUI, SlashCommand, ToolOutcome, summarizeArgs } from "../ui";
import { fuzzyFilter } from "../util";
import { diffCounts, renderDiff } from "./diff";
import { LineEditor, layoutBuffer } from "./editor";
import { FileEntry, FileIndex } from "./files";
import { PromptHistory } from "./history";
import { Key, KeyDecoder } from "./keys";
import { MarkdownStream } from "./markdown";
import { ctxPercent, fitSegments, fitStatus } from "./status";
import { oscIsLight, setTheme, theme } from "./theme";
import { padEndWidth, stringWidth, truncateWidth } from "./width";

type State = "hidden" | "idle" | "select" | "confirm" | "prompt";

const SELECT_ROWS = 10;
const MENU_ROWS = 8;
const FLUSH_MS = 33; // ~30 repaints per second at most
const ESC_WAIT_MS = 40; // a lone ESC this long without a follow-up is the Esc key
const RESIZE_MS = 150;
const STALL_MS = 1000; // no stream activity this long → "working…"
const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** One shaded row of the input block: accent bar + content padded to width,
 * with the block background re-applied after any color reset inside. */
function boxRow(content: string, w: number): string {
  const t = theme;
  const inner = Math.max(1, w - 2);
  const body = padEndWidth(content, inner);
  const bg = t.boxBg;
  const shaded = bg ? body.split(t.reset).join(t.reset + bg) : body;
  return `${bg}${t.accentCode}${t.g.bar}${t.opts.color ? "\x1b[39m" : ""} ${shaded}${t.reset}`;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtElapsed(ms);
}

function fmtChars(n: number): string {
  return n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`;
}

function clip(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** The footer's action label for a tool call that is running. */
function describeTool(name: string, args: Record<string, any>): string {
  const a = args ?? {};
  switch (name) {
    case "run_command":
      return "running " + clip(String(a.command ?? ""), 48);
    case "write_file":
      return "writing " + String(a.path ?? "a file");
    case "edit_file":
      return "editing " + String(a.path ?? "a file");
    case "read_file":
      return "reading " + String(a.path ?? "a file");
    case "search":
      return "searching " + clip(String(a.pattern ?? ""), 32);
    case "list_files":
      return "listing " + String(a.path ?? ".");
    case "plan":
      return "updating the plan";
    case "verification":
      return "checking " + clip(String(a.command ?? ""), 40);
    default:
      return name;
  }
}

function progressVerb(name: string): string {
  if (name === "write_file") return "writing a file";
  if (name === "edit_file") return "preparing an edit";
  if (name === "run_command") return "preparing a command";
  return "preparing " + name;
}

/** A row of the completion menu above the input. */
interface MenuItem {
  label: string;
  hint?: string;
  key?: string;
  current?: boolean;
  starred?: boolean;
  cmd?: SlashCommand;
  file?: FileEntry;
}

interface Menu {
  kind: "slash" | "args" | "files";
  items: MenuItem[];
  /** For args: the command; for files: where "@query" starts. */
  cmd?: SlashCommand;
  at?: number;
  loading?: boolean;
  /** Identifies the query, so the highlight resets when it changes. */
  sig: string;
}

type SelRow = { header: string } | { oi: number };

export interface TuiOptions {
  /** Prompt history file; null keeps history in memory only. */
  historyFile?: string | null;
}

export class Tui implements SessionUI {
  slashCommands: SlashCommand[] = [];
  getStatus: () => string = () => "";
  onModeCycle: (() => void) | null = null;
  onCancel: (() => void) | null = null;
  onExit: (() => void) | null = null;
  placeholder = "Describe a change…   / commands · @ files · ctrl+p palette";
  /** Shown dim on the left of the hint row (the workspace path). */
  hintLeft = "";
  /** Root for "@" file mentions; defaults to the hintLeft path, then cwd. */
  workspace = "";

  private ed = new LineEditor();
  private decoder = new KeyDecoder(() => Date.now() <= this.themeQueryUntil);
  private state: State = "hidden";
  private hist: PromptHistory;
  private histIdx = -1;
  private histStash = "";
  private menuIndex = 0;
  private menuTop = 0;
  private menuSig = "";
  /** Esc closed the menu; it stays closed until the text changes. */
  private menuClosedFor: string | null = null;
  private argCache = new Map<string, { items: SelectOption[] | null }>();
  private argsFor: string | null = null;
  private files = new FileIndex();
  private notice: string | null = null;
  private lastCtrlC = 0;
  private lastEsc = 0;
  private submitResolve: ((s: string) => void) | null = null;
  private sel: {
    title: string;
    options: SelectOption[];
    opts?: SelectOpts;
    filter: string;
    /** Position among the selectable rows. */
    index: number;
    /** First visible row: the list scrolls so the selection never leaves the window. */
    top: number;
    resolve: (i: number | null) => void;
  } | null = null;
  private promptState: {
    title: string;
    placeholder: string;
    secret?: boolean;
    ed: LineEditor;
    resolve: (s: string | null) => void;
  } | null = null;
  private started = false;
  private closed = false;
  private confirmState: {
    command: string;
    reason?: string;
    resolve: (r: "yes" | "no" | "always") => void;
  } | null = null;

  // ---- output pipeline ----
  private pending = "";
  private commitSeq = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private escTimer: NodeJS.Timeout | null = null;
  private resizeTimer: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;
  /** Visible widths of the frame lines on screen, the columns they were
   * drawn at, and where the cursor was parked (row, col). */
  private frameWidths: number[] = [];
  private frameCursor: { row: number; col: number } | null = null;
  private cursorShown = true;

  // ---- live state while the agent runs ----
  private busy = false;
  private activity = false;
  private turnStart = 0;
  private spinLabel: string | null = null;
  private spinStart = 0;
  private spinIdx = 0;
  private action = "";
  private actionKind: "wait" | "stream" | "tool" = "wait";
  private lastStream = 0;
  private md = new MarkdownStream(() => this.width());
  private think: { start: number; buf: string } | null = null;
  private thinkMd = new MarkdownStream(() => this.width(), { plain: true });
  /** ctrl+o: stream the full reasoning (dimmed) instead of a one-line ticker. */
  private verboseReasoning = false;
  private toolRow: { name: string; args: Record<string, any>; seq: number; start: number } | null = null;
  private themeQueryUntil = 0;

  constructor(opts: TuiOptions = {}) {
    const file = opts.historyFile === undefined ? path.join(DATA_DIR, "prompt-history.jsonl") : opts.historyFile;
    this.hist = new PromptHistory(file);
  }

  /** Safe to call twice: startup opens the TUI early when it has to ask where
   * the models are, and the session starts it again later. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    this.hist.load();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d: string | Buffer) => this.onData(String(d)));
    process.stdout.on("resize", () => this.onResize());
    let seq = "\x1b[?2004h"; // bracketed paste on
    // Ask the terminal for its background color (OSC 11), then for device
    // attributes: every terminal answers DA, so its reply ends the wait even
    // where OSC 11 is not supported. Both replies are swallowed by the key
    // decoder. Skipped on legacy consoles, which may echo unknown sequences.
    if (process.stdout.isTTY && process.stdin.isTTY && !theme.opts.ascii && theme.opts.color) {
      seq += "\x1b]11;?\x07\x1b[c";
      this.themeQueryUntil = Date.now() + 150;
    }
    this.write(seq);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.endThinking();
    this.endContent();
    this.spinLabel = null;
    this.busy = false;
    this.state = "hidden";
    for (const t of [this.flushTimer, this.escTimer, this.resizeTimer]) if (t) clearTimeout(t);
    this.flushTimer = this.escTimer = this.resizeTimer = null;
    this.stopTick();
    this.flush();
    this.write("\x1b[?2004l" + SHOW_CURSOR);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }

  // ---- input ---------------------------------------------------------------

  readInput(): Promise<string> {
    this.leaveRun();
    this.ed.clear();
    this.histIdx = -1;
    this.menuIndex = 0;
    this.menuClosedFor = null;
    this.state = "idle";
    this.flush();
    return new Promise((res) => (this.submitResolve = res));
  }

  select(title: string, options: SelectOption[], opts?: SelectOpts): Promise<number | null> {
    this.leaveRun(false);
    this.state = "select";
    return new Promise((resolve) => {
      this.sel = { title, options, opts, filter: "", index: 0, top: 0, resolve };
      const cur = this.selItems().findIndex((oi) => options[oi]?.current);
      this.sel.index = Math.max(0, cur);
      this.flush();
    });
  }

  prompt(title: string, placeholder = "", opts: PromptOptions = {}): Promise<string | null> {
    this.leaveRun(false);
    this.state = "prompt";
    return new Promise((resolve) => {
      this.promptState = { title, placeholder, secret: opts.secret, ed: new LineEditor(), resolve };
      this.flush();
    });
  }

  confirmCommand(command: string, reason?: string): Promise<"yes" | "no" | "always"> {
    this.leaveRun(false);
    this.state = "confirm";
    return new Promise((resolve) => {
      this.confirmState = { command, reason, resolve };
      this.flush();
    });
  }

  /** Before showing an input frame: finish streamed output; a new prompt
   * (end=true) also ends the running turn. */
  private leaveRun(end = true): void {
    this.endThinking();
    this.endContent();
    this.spinLabel = null;
    if (end) {
      this.busy = false;
      this.activity = false;
    }
  }

  // ---- key routing ---------------------------------------------------------

  private onData(data: string): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    this.handleKeys(this.decoder.decode(data));
    if (this.decoder.hasPending()) {
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        this.handleKeys(this.decoder.flush());
      }, ESC_WAIT_MS);
      this.escTimer.unref?.();
    }
  }

  private handleKeys(keys: Key[]): void {
    for (const key of keys) {
      if (key.type === "osc") {
        this.onOsc(key.text ?? "");
        continue;
      }
      if (key.type === "da") {
        this.themeQueryUntil = 0;
        continue;
      }
      if (key.type === "ctrlo") {
        this.toggleReasoning();
        continue;
      }
      switch (this.state) {
        case "idle":
          this.keyIdle(key);
          break;
        case "select":
          this.keySelect(key);
          break;
        case "confirm":
          this.keyConfirm(key);
          break;
        case "prompt":
          this.keyPrompt(key);
          break;
        case "hidden": // agent running
          if (key.type === "esc" || key.type === "ctrlc") this.onCancel?.();
          break;
      }
    }
  }

  private onOsc(body: string): void {
    if (!body.startsWith("11;") || Date.now() > this.themeQueryUntil) return;
    this.themeQueryUntil = 0;
    const light = oscIsLight(body.slice(3));
    if (light === null || light === theme.opts.light) return;
    setTheme({ light });
    this.refresh();
  }

  private toggleReasoning(): void {
    this.verboseReasoning = !this.verboseReasoning;
    const msg = this.verboseReasoning ? "reasoning: shown in full (ctrl+o to collapse)" : "reasoning: collapsed (ctrl+o to show)";
    if (this.state === "idle") {
      this.notice = msg;
      this.flush();
    } else if (this.state === "hidden") {
      // Switch mid-stream: the collapsed buffer is dropped, the full view starts here.
      if (this.think) this.think.buf = "";
      this.commit(theme.dim("· " + msg));
      this.schedule();
    }
  }

  private keyIdle(key: Key): void {
    const prevNotice = this.notice;
    this.notice = null;
    const menu = this.currentMenu();
    if (menu && this.keyMenu(key, menu)) return;
    switch (key.type) {
      case "char":
      case "text":
        this.ed.insert(key.text!);
        break;
      case "newline":
        this.ed.insert("\n");
        break;
      case "enter": {
        // A trailing backslash continues the line (shell-style).
        const b = this.ed.buffer;
        if (this.ed.cursor > 0 && b[this.ed.cursor - 1] === "\\") {
          this.ed.backspace();
          this.ed.insert("\n");
          break;
        }
        this.submitText(b);
        return;
      }
      case "tab":
        break;
      case "shifttab":
        this.onModeCycle?.();
        break;
      case "backspace":
        this.ed.backspace();
        break;
      case "wordbackspace":
      case "ctrlw":
        this.ed.deleteWordBack();
        break;
      case "delete":
        this.ed.del();
        break;
      case "worddelete":
        this.ed.deleteWordForward();
        break;
      case "left":
        this.ed.left();
        break;
      case "right":
        this.ed.right();
        break;
      case "wordleft":
        this.ed.wordLeft();
        break;
      case "wordright":
        this.ed.wordRight();
        break;
      case "home":
      case "ctrla":
        this.ed.home();
        break;
      case "end":
      case "ctrle":
        this.ed.end();
        break;
      case "ctrlu":
        this.ed.killToLineStart();
        break;
      case "ctrlk":
        this.ed.killToLineEnd();
        break;
      case "up":
        if (!this.ed.upLine()) this.historyPrev();
        break;
      case "down":
        if (!this.ed.downLine()) this.historyNext();
        break;
      case "esc": {
        // Never wipe a draft on one keypress: the first esc only warns.
        if (!this.ed.buffer) break;
        if (Date.now() - this.lastEsc < 1000 && prevNotice?.startsWith("esc again")) {
          this.hist.entries.push(this.ed.buffer); // ↑ brings it back (not saved to disk)
          this.ed.clear();
          this.lastEsc = 0;
          this.notice = "draft cleared · ↑ restores it";
        } else {
          this.lastEsc = Date.now();
          this.notice = "esc again to clear the draft";
        }
        break;
      }
      case "ctrlc": {
        if (this.ed.buffer.length > 0) {
          this.ed.clear();
        } else if (Date.now() - this.lastCtrlC < 1500) {
          this.onExit?.();
          return;
        } else {
          this.lastCtrlC = Date.now();
          this.notice = "press ctrl+c again to exit";
        }
        break;
      }
      case "ctrld":
        if (this.ed.buffer.length === 0) {
          this.onExit?.();
          return;
        }
        break;
      case "ctrlp":
        void this.openPalette();
        return;
      case "ctrlr":
        void this.openHistorySearch();
        return;
      case "f2":
        this.submitText("/models next");
        return;
      case "ctrll":
        this.write("\x1b[2J\x1b[H");
        this.frameWidths = [];
        this.frameCursor = null;
        break;
      default:
        break;
    }
    this.flush();
  }

  /** Keys the completion menu takes; false leaves the key to the editor. */
  private keyMenu(key: Key, menu: Menu): boolean {
    const n = menu.items.length;
    const pick = () => menu.items[Math.min(this.menuIndex, n - 1)];
    switch (key.type) {
      case "up":
        if (!n) return false;
        this.menuIndex = (this.menuIndex - 1 + n) % n;
        break;
      case "down":
        if (!n) return false;
        this.menuIndex = (this.menuIndex + 1) % n;
        break;
      case "pageup":
        this.menuIndex = Math.max(0, this.menuIndex - MENU_ROWS);
        break;
      case "pagedown":
        this.menuIndex = Math.max(0, Math.min(n - 1, this.menuIndex + MENU_ROWS));
        break;
      case "esc":
        this.menuClosedFor = this.ed.buffer;
        break;
      case "tab":
        if (!n) return true;
        this.complete(menu, pick(), "tab");
        break;
      case "enter":
        if (!n) {
          if (menu.kind === "files") return false;
          if (menu.kind === "args" && menu.loading) return true;
          return false; // submit what was typed
        }
        if (this.complete(menu, pick(), "enter")) return true;
        break;
      default:
        return false;
    }
    this.flush();
    return true;
  }

  /** Apply a menu choice. Returns true when it submitted the input. */
  private complete(menu: Menu, item: MenuItem, how: "tab" | "enter"): boolean {
    if (menu.kind === "slash" && item.cmd) {
      if (item.cmd.args || how === "tab") {
        this.ed.set("/" + item.cmd.name + " ");
        return false;
      }
      this.submitText("/" + item.cmd.name);
      return true;
    }
    if (menu.kind === "args" && menu.cmd) {
      const text = "/" + menu.cmd.name + " " + item.label;
      if (how === "tab") {
        this.ed.set(text);
        return false;
      }
      this.submitText(text);
      return true;
    }
    if (menu.kind === "files" && item.file && menu.at !== undefined) {
      const b = this.ed.buffer;
      const before = b.slice(0, menu.at);
      const after = b.slice(this.ed.cursor);
      if (item.file.dir && how === "tab") {
        // Step into the folder: the menu now lists what is inside.
        this.ed.buffer = before + "@" + item.file.path + after;
        this.ed.cursor = before.length + 1 + item.file.path.length;
        return false;
      }
      this.files.picked(item.file.path);
      const ins = item.file.path + (after.startsWith(" ") ? "" : " ");
      this.ed.buffer = before + ins + after;
      this.ed.cursor = before.length + ins.length;
      this.menuClosedFor = this.ed.buffer;
      return false;
    }
    return false;
  }

  private submitText(raw: string): void {
    const text = raw.trim();
    if (!text) {
      this.flush();
      return;
    }
    this.hist.add(text);
    this.state = "hidden";
    this.notice = null;
    // Echo the user's message as an accent-barred block.
    const t = theme;
    const block = text
      .split("\n")
      .map((l) => `${t.accent(t.g.bar)} ${t.bold(l)}`)
      .join("\n");
    this.commit(`\n${block}\n\n`);
    this.busy = true;
    this.activity = false;
    this.turnStart = Date.now();
    this.action = "thinking";
    this.actionKind = "wait";
    this.flush();
    const resolve = this.submitResolve;
    this.submitResolve = null;
    resolve?.(text);
  }

  private historyPrev(): void {
    const h = this.hist.entries;
    if (h.length === 0) return;
    if (this.histIdx === -1) {
      this.histStash = this.ed.buffer;
      this.histIdx = h.length - 1;
    } else if (this.histIdx > 0) {
      this.histIdx--;
    } else return;
    this.ed.set(h[this.histIdx]);
  }

  private historyNext(): void {
    const h = this.hist.entries;
    if (this.histIdx === -1) return;
    if (this.histIdx < h.length - 1) {
      this.histIdx++;
      this.ed.set(h[this.histIdx]);
    } else {
      this.histIdx = -1;
      this.ed.set(this.histStash);
    }
  }

  /** ctrl+p: every slash command, grouped, with its shortcut in the hint. */
  private async openPalette(): Promise<void> {
    const cmds = this.slashCommands;
    if (!cmds.length) return;
    const draft = { buffer: this.ed.buffer, cursor: this.ed.cursor };
    const options: SelectOption[] = cmds.map((cmd) => ({
      label: "/" + cmd.name,
      hint: cmd.desc + (cmd.key ? `  ${theme.g.dot} ${cmd.key}` : ""),
      group: cmd.group,
      keywords: [cmd.name, ...(cmd.aliases ?? [])].join(" "),
    }));
    const i = await this.select("Commands", options);
    this.backToIdle(draft);
    if (i === null) return this.flush();
    const cmd = cmds[i];
    if (cmd.args) {
      this.ed.set("/" + cmd.name + " ");
      this.flush();
    } else {
      this.submitText("/" + cmd.name);
    }
  }

  /** ctrl+r: fuzzy search through the prompt history, newest first. */
  private async openHistorySearch(): Promise<void> {
    const entries = [...this.hist.entries].reverse();
    if (!entries.length) {
      this.notice = "no prompt history yet";
      return this.flush();
    }
    const draft = { buffer: this.ed.buffer, cursor: this.ed.cursor };
    const options: SelectOption[] = entries.map((e) => {
      const lines = e.split("\n");
      return { label: clip(lines[0], 200), hint: lines.length > 1 ? `+${lines.length - 1} lines` : undefined, keywords: e };
    });
    const i = await this.select("Search history", options);
    this.backToIdle(draft);
    if (i !== null) this.ed.set(entries[i]);
    this.flush();
  }

  private backToIdle(draft: { buffer: string; cursor: number }): void {
    this.state = "idle";
    this.ed.buffer = draft.buffer;
    this.ed.cursor = draft.cursor;
    this.histIdx = -1;
  }

  // ---- pickers ---------------------------------------------------------------

  /** Display rows: group headers (when not filtering) and option indexes. */
  private selRows(): SelRow[] {
    const s = this.sel!;
    const opts = s.options;
    if (s.filter) {
      const idx = opts.map((_, i) => i);
      return fuzzyFilter(s.filter, idx, (i) => [opts[i].label, opts[i].hint, opts[i].keywords]).map((oi) => ({ oi }));
    }
    if (!opts.some((o) => o.group)) return opts.map((_, oi) => ({ oi }));
    const order: (string | undefined)[] = [];
    for (const o of opts) if (!order.includes(o.group)) order.push(o.group);
    const rows: SelRow[] = [];
    for (const g of order) {
      if (g) rows.push({ header: g });
      opts.forEach((o, oi) => {
        if (o.group === g) rows.push({ oi });
      });
    }
    return rows;
  }

  /** Option indexes in display order (what the cursor moves over). */
  private selItems(): number[] {
    return this.selRows().flatMap((r) => ("oi" in r ? [r.oi] : []));
  }

  private keySelect(key: Key): void {
    const s = this.sel!;
    const items = this.selItems();
    const n = items.length;
    switch (key.type) {
      case "up":
        s.index = n ? (s.index - 1 + n) % n : 0;
        break;
      case "down":
      case "tab":
        s.index = n ? (s.index + 1) % n : 0;
        break;
      case "pageup":
        s.index = Math.max(0, s.index - SELECT_ROWS);
        break;
      case "pagedown":
        s.index = Math.max(0, Math.min(n - 1, s.index + SELECT_ROWS));
        break;
      case "home":
        s.index = 0;
        break;
      case "end":
        s.index = Math.max(0, n - 1);
        break;
      case "char":
      case "text":
        s.filter += key.text!.replace(/[\r\n]/g, "");
        s.index = 0;
        s.top = 0;
        break;
      case "backspace":
        s.filter = Array.from(s.filter).slice(0, -1).join("");
        s.index = 0;
        s.top = 0;
        break;
      case "wordbackspace":
      case "ctrlw":
      case "ctrlu":
        s.filter = "";
        s.index = 0;
        s.top = 0;
        break;
      case "ctrlf": {
        if (!s.opts?.onStar || !n) break;
        const oi = items[Math.min(s.index, n - 1)];
        const was = s.options[oi];
        const next = s.opts.onStar(oi);
        if (Array.isArray(next)) {
          s.options = next;
          const same = (o: SelectOption) => o.label === was.label && o.group === was.group;
          let ni = next.findIndex(same);
          if (ni < 0) ni = next.findIndex((o) => o.label === was.label);
          const pos = this.selItems().indexOf(ni);
          s.index = pos >= 0 ? pos : Math.min(s.index, Math.max(0, this.selItems().length - 1));
        }
        break;
      }
      case "enter": {
        if (!n) break;
        this.endSelect(items[Math.min(s.index, n - 1)]);
        return;
      }
      case "esc":
      case "ctrlc":
        this.endSelect(null);
        return;
      default:
        break;
    }
    this.flush();
  }

  private endSelect(result: number | null): void {
    const s = this.sel!;
    this.sel = null;
    this.state = "hidden";
    this.flush();
    s.resolve(result);
  }

  private keyPrompt(key: Key): void {
    const p = this.promptState!;
    const finish = (value: string | null) => {
      this.promptState = null;
      this.state = "hidden";
      this.commit(theme.dim(`  ${p.title}: ${value === null ? "cancelled" : p.secret ? "(hidden)" : value}`));
      this.flush();
      p.resolve(value);
    };
    switch (key.type) {
      case "char":
      case "text":
        p.ed.insert(key.text!.replace(/[\r\n]+/g, " "));
        break;
      case "backspace":
        p.ed.backspace();
        break;
      case "wordbackspace":
      case "ctrlw":
        p.ed.deleteWordBack();
        break;
      case "delete":
        p.ed.del();
        break;
      case "worddelete":
        p.ed.deleteWordForward();
        break;
      case "left":
        p.ed.left();
        break;
      case "right":
        p.ed.right();
        break;
      case "wordleft":
        p.ed.wordLeft();
        break;
      case "wordright":
        p.ed.wordRight();
        break;
      case "home":
      case "ctrla":
        p.ed.home();
        break;
      case "end":
      case "ctrle":
        p.ed.end();
        break;
      case "ctrlu":
        p.ed.killToLineStart();
        break;
      case "ctrlk":
        p.ed.killToLineEnd();
        break;
      case "enter":
        finish(p.ed.buffer.trim() || null);
        return;
      case "esc":
      case "ctrlc":
        finish(null);
        return;
      default:
        break;
    }
    this.flush();
  }

  private keyConfirm(key: Key): void {
    const cs = this.confirmState!;
    let result: "yes" | "no" | "always" | null = null;
    if (key.type === "char") {
      const ch = key.text!.toLowerCase();
      if (ch === "y") result = "yes";
      else if (ch === "n") result = "no";
      else if (ch === "a") result = "always";
    } else if (key.type === "enter") result = "yes";
    else if (key.type === "esc" || key.type === "ctrlc") result = "no";
    if (result === null) return;
    this.confirmState = null;
    this.state = "hidden";
    this.commit(theme.dim(`  ${result === "always" ? "always allowed" : result} — ${cs.command}`));
    this.flush();
    cs.resolve(result);
  }

  // ---- the completion menu ---------------------------------------------------

  private fileRoot(): string {
    if (this.workspace) return this.workspace;
    if (this.hintLeft) {
      const p = this.hintLeft.replace(/^~(?=$|[\\/])/, os.homedir());
      try {
        if (fs.statSync(p).isDirectory()) return p;
      } catch {
        /* fall through */
      }
    }
    return process.cwd();
  }

  private findCommand(name: string): SlashCommand | undefined {
    return findCommand(name, this.slashCommands);
  }

  /** The menu for the text being typed: slash commands, a command's
   * argument values, or workspace files after "@". */
  private currentMenu(): Menu | null {
    const b = this.ed.buffer;
    if (this.menuClosedFor !== null) {
      if (this.menuClosedFor === b) return null;
      this.menuClosedFor = null;
    }
    let menu: Menu | null = null;
    if (b.startsWith("/") && !b.includes("\n")) {
      const m = /^\/(\S*)$/.exec(b);
      if (m) {
        this.argsFor = null;
        const cmds = m[1]
          ? fuzzyFilter(m[1], this.slashCommands, (c) => [c.name, (c.aliases ?? []).join(" "), c.desc])
          : this.slashCommands;
        menu = {
          kind: "slash",
          sig: "slash:" + m[1],
          items: cmds.map((cmd) => ({ label: "/" + cmd.name, hint: cmd.desc, key: cmd.key, cmd })),
        };
      } else {
        const a = /^\/(\S+) (.*)$/.exec(b);
        const cmd = a ? this.findCommand(a[1]) : undefined;
        if (a && cmd?.args) {
          const entry = this.loadArgs(cmd);
          const values = entry.items ?? [];
          const q = a[2].trim();
          const shown = q ? fuzzyFilter(q, values, (o) => [o.label, o.hint, o.keywords]) : values;
          menu = {
            kind: "args",
            cmd,
            loading: entry.items === null,
            sig: "args:" + cmd.name + ":" + q,
            items: shown.map((o) => ({ label: o.label, hint: o.hint, current: o.current, starred: o.starred })),
          };
        } else this.argsFor = null;
      }
    } else {
      this.argsFor = null;
      const before = b.slice(0, this.ed.cursor);
      const at = /(^|\s)@([^\s@]*)$/.exec(before);
      if (at) {
        const start = before.length - at[2].length - 1;
        let found: FileEntry[] = [];
        try {
          found = this.files.search(this.fileRoot(), at[2].replace(/\\/g, "/"));
        } catch {
          found = [];
        }
        menu = {
          kind: "files",
          at: start,
          sig: "files:" + at[2],
          items: found.map((f) => ({ label: f.path, file: f })),
        };
      }
    }
    if (!menu) {
      this.menuSig = "";
      return null;
    }
    if (menu.sig !== this.menuSig) {
      this.menuSig = menu.sig;
      this.menuIndex = 0;
      this.menuTop = 0;
      // With nothing typed yet, an argument list starts on the current value.
      if (menu.kind === "args" && menu.sig.endsWith(":")) this.menuIndex = Math.max(0, menu.items.findIndex((i) => i.current));
    }
    if (this.menuIndex >= menu.items.length) this.menuIndex = Math.max(0, menu.items.length - 1);
    // Files: a menu with nothing in it is just noise.
    if (menu.kind === "files" && !menu.items.length) return null;
    return menu;
  }

  /** Argument values are fetched each time a command enters arg mode. */
  private loadArgs(cmd: SlashCommand): { items: SelectOption[] | null } {
    if (this.argsFor !== cmd.name || !this.argCache.has(cmd.name)) {
      this.argsFor = cmd.name;
      const entry: { items: SelectOption[] | null } = { items: null };
      this.argCache.set(cmd.name, entry);
      Promise.resolve()
        .then(() => cmd.args!())
        .then(
          (items) => {
            entry.items = Array.isArray(items) ? items : [];
          },
          () => {
            entry.items = [];
          }
        )
        .then(() => {
          if (this.state === "idle") this.flush();
        });
    }
    return this.argCache.get(cmd.name)!;
  }

  // ---- rendering -----------------------------------------------------------

  private width(): number {
    return Math.max(10, (process.stdout.columns || 80) - 1);
  }

  private height(): number {
    return Math.max(6, process.stdout.rows || 24);
  }

  /** Lines of the frame for the current state, and where the cursor goes. */
  private buildFrame(): { lines: string[]; cursor: { row: number; col: number } | null } {
    const t = theme;
    const lines: string[] = [];
    let cursor: { row: number; col: number } | null = null;
    const W = this.width();

    if (this.state === "idle") {
      const menu = this.currentMenu();
      if (menu) lines.push(...this.menuLines(menu, Math.min(W, 80)));
      const inputW = W - 2;
      if (this.ed.buffer.length === 0) {
        cursor = { row: lines.length, col: 2 };
        lines.push(boxRow(t.dim(truncateWidth(this.placeholder, inputW)), W));
      } else {
        const lay = layoutBuffer(this.ed.buffer, this.ed.cursor, inputW);
        const maxRows = Math.max(3, this.height() - lines.length - 3);
        let from = 0;
        if (lay.rows.length > maxRows) from = Math.max(0, Math.min(lay.curRow - Math.floor(maxRows / 2), lay.rows.length - maxRows));
        const shown = lay.rows.slice(from, from + maxRows);
        cursor = { row: lines.length + lay.curRow - from, col: 2 + lay.curCol };
        for (const row of shown) lines.push(boxRow(row, W));
      }
      let status = "";
      try {
        status = this.getStatus();
      } catch {
        status = "";
      }
      lines.push(boxRow(fitStatus(status, inputW), W));
      if (this.notice) lines.push(" " + t.yellow(truncateWidth(this.notice, W - 1)));
    } else if (this.state === "select" && this.sel) {
      lines.push(...this.selectLines(Math.min(W, 80)));
    } else if (this.state === "prompt" && this.promptState) {
      const p = this.promptState;
      const w = Math.min(W, 72);
      lines.push(truncateWidth(`${t.accent(t.g.bar)} ${t.bold(p.title)}   ${t.dim("enter confirm · esc cancel")}`, W));
      const inner = w - 3;
      if (p.ed.buffer.length === 0) {
        cursor = { row: lines.length, col: 2 };
        lines.push(boxRow(t.dim(truncateWidth(p.placeholder, inner)), w));
      } else {
        // One line, scrolled so the cursor stays in view.
        const dot = t.opts.ascii ? "*" : "•";
        const shown = p.secret ? dot.repeat(Array.from(p.ed.buffer).length) : p.ed.buffer.replace(/\t/g, " ");
        const curText = p.secret ? dot.repeat(Array.from(p.ed.buffer.slice(0, p.ed.cursor)).length) : p.ed.buffer.slice(0, p.ed.cursor).replace(/\t/g, " ");
        const curW = stringWidth(curText);
        let skip = Math.max(0, curW - inner);
        let view = "";
        let seen = 0;
        for (const ch of shown) {
          const cw = stringWidth(ch);
          if (skip > 0) {
            skip -= cw;
            seen += cw;
            continue;
          }
          view += ch;
        }
        cursor = { row: lines.length, col: 2 + curW - seen };
        lines.push(boxRow(truncateWidth(view, inner), w));
      }
    } else if (this.state === "confirm" && this.confirmState) {
      const cs = this.confirmState;
      lines.push(truncateWidth(`${t.accent(t.g.bar)} ${t.yellow("run? ")}${t.bold(cs.command.replace(/\s+/g, " "))}`, W, t.g.ellipsis));
      if (cs.reason) lines.push(truncateWidth("  " + t.dim(cs.reason), W, t.g.ellipsis));
      const program = cs.command.trim().split(/\s+/)[0];
      lines.push(truncateWidth("  " + t.dim(`[y]es · [n]o · [a]lways allow '${program}' this session`), W));
    } else if (this.state === "hidden") {
      lines.push(...this.liveLines(W));
    }
    // Never taller than the screen: cursor-up cannot reach above its top.
    const maxLines = this.height() - 1;
    if (lines.length > maxLines) {
      const cut = lines.length - maxLines;
      lines.splice(0, cut);
      if (cursor) cursor = cursor.row - cut >= 0 ? { row: cursor.row - cut, col: cursor.col } : null;
    }
    return { lines, cursor };
  }

  private menuLines(menu: Menu, w: number): string[] {
    const t = theme;
    const out: string[] = [];
    const items = menu.items;
    if (menu.kind === "args" && menu.loading) return [" " + t.dim(`loading ${menu.cmd!.name} options${t.g.ellipsis}`)];
    if (!items.length) {
      if (menu.kind === "args") return [" " + t.dim("no matching values · enter sends what you typed")];
      return [" " + t.dim("no matching commands")];
    }
    if (this.menuIndex < this.menuTop) this.menuTop = this.menuIndex;
    if (this.menuIndex >= this.menuTop + MENU_ROWS) this.menuTop = this.menuIndex - MENU_ROWS + 1;
    this.menuTop = Math.max(0, Math.min(this.menuTop, items.length - MENU_ROWS));
    const nameW = menu.kind === "slash" ? Math.min(16, Math.max(...items.map((i) => stringWidth(i.label))) + 1) : 0;
    for (let i = this.menuTop; i < Math.min(items.length, this.menuTop + MENU_ROWS); i++) {
      const it = items[i];
      const sel = i === this.menuIndex;
      const mark = it.current ? t.g.current + " " : it.starred ? t.g.star + " " : menu.kind === "args" ? "  " : "";
      const label = menu.kind === "slash" ? padEndWidth(it.label, nameW) : it.label;
      const keyTxt = it.key ? ` ${it.key}` : "";
      const left = ` ${mark}${label}${it.hint ? " " + it.hint : ""}`;
      if (sel) {
        const room = w - stringWidth(keyTxt);
        out.push(`${t.selCode}${padEndWidth(left, room)}${keyTxt}${t.reset}`);
      } else {
        const markC = it.current ? t.green(mark) : it.starred ? t.yellow(mark) : mark;
        const labelC = menu.kind === "files" && it.file?.dir ? t.accent(label) : t.bold(label);
        const body = ` ${markC}${labelC}${it.hint ? " " + t.dim(it.hint) : ""}`;
        const room = w - stringWidth(keyTxt);
        const cut = truncateWidth(body, room, t.g.ellipsis);
        out.push(keyTxt ? padEndWidth(cut, room) + t.dim(keyTxt) : cut);
      }
    }
    const below = items.length - this.menuTop - MENU_ROWS;
    const above = this.menuTop;
    if (above > 0 || below > 0) {
      const parts = [];
      if (above > 0) parts.push(`${t.g.up} ${above}`);
      if (below > 0) parts.push(`${t.g.down} ${below} more`);
      const hint = menu.kind === "files" ? " · tab opens a folder" : "";
      out.push("  " + t.dim(parts.join("  ") + hint));
    } else if (menu.kind === "files") out.push("  " + t.dim("tab opens a folder · enter inserts the path"));
    return out;
  }

  private selectLines(w: number): string[] {
    const t = theme;
    const s = this.sel!;
    const lines: string[] = [];
    const keysHint = "esc cancel" + (s.opts?.onStar ? " · ctrl+f star" : "");
    lines.push(truncateWidth(`${t.accent(t.g.bar)} ${t.bold(s.title)}   ${t.dim(keysHint)}`, this.width()));
    lines.push(`${t.accent(t.g.bar)} ${s.filter ? s.filter : t.dim("type to filter")}`);
    const rows = this.selRows();
    const items = rows.flatMap((r, ri) => ("oi" in r ? [ri] : []));
    if (!items.length) lines.push(t.dim("   no matches"));
    s.index = Math.max(0, Math.min(s.index, items.length - 1));
    const selRow = items[s.index] ?? 0;
    // Keep the selection (and its group header, if any) inside the window.
    let want = selRow;
    if (selRow > 0 && "header" in rows[selRow - 1]) want = selRow - 1;
    if (want < s.top) s.top = want;
    if (selRow >= s.top + SELECT_ROWS) s.top = selRow - SELECT_ROWS + 1;
    s.top = Math.max(0, Math.min(s.top, rows.length - SELECT_ROWS));
    const optsIn = (from: number, to: number) => rows.slice(from, to).filter((r) => "oi" in r).length;
    const above = optsIn(0, s.top);
    if (above > 0) lines.push(t.dim(`   ${t.g.up} ${above} more`));
    for (let ri = s.top; ri < Math.min(rows.length, s.top + SELECT_ROWS); ri++) {
      const r = rows[ri];
      if ("header" in r) {
        lines.push(" " + t.dim(t.bold(truncateWidth(r.header, w - 1))));
        continue;
      }
      const o = s.options[r.oi];
      const marker = o.current ? t.g.current + " " : "  ";
      const star = o.starred ? t.g.star + " " : "";
      if (ri === selRow) {
        const plain = ` ${marker}${star}${o.label}${o.hint ? "  " + o.hint : ""}`;
        lines.push(`${t.selCode}${padEndWidth(plain, w)}${t.reset}`);
      } else {
        const body = ` ${o.current ? t.green(marker) : marker}${o.starred ? t.yellow(star) : ""}${o.label}${o.hint ? "  " + t.dim(o.hint) : ""}`;
        lines.push(truncateWidth(body, w, t.g.ellipsis));
      }
    }
    const below = optsIn(s.top + SELECT_ROWS, rows.length);
    if (below > 0) lines.push(t.dim(`   ${t.g.down} ${below} more (type to filter)`));
    return lines;
  }

  /** While the agent runs: the unfinished tail, the reasoning ticker and the footer. */
  private liveLines(W: number): string[] {
    const t = theme;
    const lines: string[] = [];
    if (this.closed) return lines;
    const tail = this.think && this.verboseReasoning ? this.thinkMd.tail() : this.md.tail();
    lines.push(...tail);
    if (this.think && !this.verboseReasoning) {
      const clean = this.think.buf.replace(/\s+/g, " ").trim();
      const room = W - 2;
      const shown = stringWidth(clean) > room ? t.g.ellipsis + Array.from(clean).slice(-(room - 1)).join("") : clean;
      lines.push(t.muted(truncateWidth(`${t.g.think} ${shown}`, W)));
    }
    if (this.footerVisible()) lines.push(this.footerLine(W));
    const max = this.height() - 1;
    return lines.length > max ? lines.slice(lines.length - max) : lines;
  }

  private footerVisible(): boolean {
    return this.state === "hidden" && !this.closed && (this.spinLabel !== null || (this.busy && this.activity));
  }

  private footerLine(W: number): string {
    const t = theme;
    const now = Date.now();
    const spin = t.accent(t.g.spinner[this.spinIdx % t.g.spinner.length]);
    let action = this.spinLabel ?? this.action ?? "";
    if (this.actionKind === "stream" && this.spinLabel === null && now - this.lastStream > STALL_MS) action = "working" + t.g.ellipsis;
    const since = this.busy ? this.turnStart : this.spinStart;
    let ctx = "";
    try {
      ctx = ctxPercent(this.getStatus());
    } catch {
      ctx = "";
    }
    const segs = [`${spin} ${action}`, t.dim(fmtElapsed(now - since)), t.dim(this.busy ? "esc interrupt" : "esc cancel")];
    const roles: ("model" | "mode" | "extra" | "ctx")[] = ["model", "mode", "extra"];
    if (ctx) {
      segs.push(t.dim("ctx " + ctx));
      roles.push("ctx");
    }
    return fitSegments(segs, W, roles);
  }

  private startTick(): void {
    if (this.tick) return;
    this.tick = setInterval(() => {
      this.spinIdx++;
      this.schedule();
    }, 100);
    this.tick.unref?.();
  }

  private stopTick(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  /** Physical rows from the top of the drawn frame to the cursor, using the
   * current column count — after a resize, terminals that reflow have
   * rewrapped the old lines. */
  private rowsAboveCursor(): number {
    const cols = Math.max(1, process.stdout.columns || 80);
    const rowsOf = (w: number) => Math.max(1, Math.ceil(w / cols));
    const n = this.frameWidths.length;
    if (!n) return 0;
    const cur = this.frameCursor ?? { row: n - 1, col: this.frameWidths[n - 1] };
    let up = 0;
    for (let i = 0; i < cur.row; i++) up += rowsOf(this.frameWidths[i]);
    const lineW = this.frameWidths[cur.row] ?? 0;
    const col = cur.col;
    up += col <= 0 ? 0 : Math.floor((col - (this.frameCursor && col < lineW ? 0 : 1)) / cols);
    return up;
  }

  private eraseFrame(): string {
    if (!this.frameWidths.length) return "";
    const up = this.rowsAboveCursor();
    this.frameWidths = [];
    this.frameCursor = null;
    return "\r" + (up > 0 ? `\x1b[${up}A` : "") + "\x1b[J";
  }

  /** Write everything committed since the last flush, then redraw the frame. */
  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const { lines, cursor } = this.closed ? { lines: [], cursor: null } : this.buildFrame();
    let seq = SYNC_ON + HIDE_CURSOR + this.eraseFrame() + this.pending;
    this.pending = "";
    seq += lines.join("\n");
    this.frameWidths = lines.map((l) => stringWidth(l));
    if (lines.length && cursor && cursor.row >= 0 && cursor.row < lines.length) {
      const up = lines.length - 1 - cursor.row;
      if (up > 0) seq += `\x1b[${up}A`;
      seq += "\r";
      if (cursor.col > 0) seq += `\x1b[${cursor.col}C`;
      this.frameCursor = cursor;
      seq += SHOW_CURSOR;
      this.cursorShown = true;
    } else {
      this.frameCursor = null;
      this.cursorShown = false;
      if (this.closed) seq += SHOW_CURSOR;
    }
    seq += SYNC_OFF;
    this.write(seq);
    if (this.footerVisible()) this.startTick();
    else this.stopTick();
  }

  private schedule(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private onResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.toolRow = null; // its row may have rewrapped: don't rewrite it in place
      this.flush();
    }, RESIZE_MS);
    this.resizeTimer.unref?.();
  }

  private write(s: string): void {
    if (s) process.stdout.write(s);
  }

  /** Append finished lines to scrollback (they are written on the next flush). */
  private commit(s: string): void {
    this.pending += s.endsWith("\n") ? s : s + "\n";
    this.commitSeq++;
  }

  /** Redraw the frame if one is on screen (status bar refresh, etc.). */
  refresh(): void {
    if (this.state !== "hidden") this.flush();
    else this.schedule();
  }

  // ---- AgentUI (output while the agent runs) -------------------------------

  /** Reasoning ended: say how long it took, in one dim line. */
  private endThinking(): void {
    if (!this.think) return;
    const secs = (Date.now() - this.think.start) / 1000;
    if (this.verboseReasoning) {
      const rows = this.thinkMd.end();
      if (rows.length) this.commit(rows.join("\n"));
    } else this.thinkMd.reset();
    this.think = null;
    this.commit(theme.muted(`${theme.g.think} thought for ${secs.toFixed(1)}s`));
  }

  /** The streamed reply is complete (or something else is printed): commit its tail. */
  private endContent(): void {
    if (this.md.idle) return;
    const rows = this.md.end();
    if (rows.length) this.commit(rows.join("\n"));
  }

  private stream(): void {
    this.spinLabel = null; // streaming started: the wait is over
    this.activity = true;
    this.actionKind = "stream";
    this.lastStream = Date.now();
  }

  token(text: string): void {
    if (!text) return;
    this.endThinking();
    this.stream();
    this.action = "responding";
    const rows = this.md.push(text);
    if (rows.length) this.commit(rows.join("\n"));
    this.schedule();
  }

  /** Reasoning streams as ONE grey line, cropped to the latest tail and
   * redrawn in place (or in full and dimmed after ctrl+o). It collapses to
   * "✦ thought for Ns" the moment anything else is printed. */
  thinking(text: string): void {
    if (this.state !== "hidden" || !text) return;
    if (!this.think) {
      this.endContent();
      this.think = { start: Date.now(), buf: "" };
    }
    this.stream();
    this.action = "thinking";
    if (this.verboseReasoning) {
      const rows = this.thinkMd.push(text);
      if (rows.length) this.commit(rows.join("\n"));
    } else {
      this.think.buf += text;
      if (this.think.buf.length > 4000) this.think.buf = this.think.buf.slice(-2000);
    }
    this.schedule();
  }

  toolArgsProgress(name: string, chars: number): void {
    this.endThinking();
    this.stream();
    this.action = `${progressVerb(name)} ${theme.g.dot} ${fmtChars(chars)}`;
    this.schedule();
  }

  private toolLine(mark: string, name: string, args: Record<string, any>, suffix = ""): string {
    const t = theme;
    const W = this.width();
    const sfx = suffix ? t.dim(` ${t.g.dot} ${suffix}`) : "";
    const head = `${mark} ${t.bold(name)} `;
    const room = W - stringWidth(head) - stringWidth(sfx);
    const summary = summarizeArgs(name, args).replace(/\s+/g, " ");
    return head + t.dim(truncateWidth(summary, Math.max(0, room), t.g.ellipsis)) + sfx;
  }

  toolCall(name: string, args: Record<string, any>): void {
    this.endThinking();
    this.endContent();
    this.spinLabel = null;
    const t = theme;
    this.commit(this.toolLine(t.muted(t.g.bullet), name, args));
    this.toolRow = { name, args, seq: this.commitSeq, start: Date.now() };
    this.activity = true;
    this.actionKind = "tool";
    this.action = describeTool(name, args);
    this.flush();
  }

  toolResult(result: string, outcome?: ToolOutcome): void {
    this.endThinking();
    this.endContent();
    const t = theme;
    const W = this.width();
    const row = this.toolRow;
    this.toolRow = null;
    const ok = outcome ? outcome.ok : !result.startsWith("Error");
    const ms = outcome ? outcome.durationMs : row ? Date.now() - row.start : undefined;
    const lines = result.split("\n");
    const isCmd = row?.name === "run_command" || row?.name === "verification";
    const exit = /\[exit code (\S+) in [\d.]+s\]/.exec(result);
    const suffixParts: string[] = [];
    if (isCmd && exit && exit[1] !== "0") suffixParts.push(`exit ${exit[1]}`);
    if (ms !== undefined) suffixParts.push(fmtDur(ms));
    const mark = ok ? t.green(t.g.ok) : t.red(t.g.fail);
    const details: string[] = [];

    if (row) {
      const line = this.toolLine(mark, row.name, row.args, suffixParts.join(` ${t.g.dot} `));
      if (row.seq === this.commitSeq) {
        // Nothing printed since the running row: replace it in place.
        this.pending += "\x1b[1A\r\x1b[2K";
      }
      this.commit(line);
    }

    const diff = outcome?.diff;
    if (isCmd) {
      // The last few lines of output, dimmed.
      let body = lines.slice();
      if (body[0]?.startsWith("Error: command exited")) body.shift();
      while (body.length && /^\s*$|^\[.*\]$/.test(body[body.length - 1])) body.pop();
      body = body.filter((l) => l.trim());
      const g = t.dim(t.g.gutter);
      for (const l of body.slice(-4)) details.push(`  ${g} ${t.dim(truncateWidth(l.replace(/\t/g, "  "), W - 4, t.g.ellipsis))}`);
    } else if (!ok) {
      const first = lines[0] ?? "";
      details.push("  " + t.red(truncateWidth(first, W - 2, t.g.ellipsis)));
    } else if (diff && row?.name === "edit_file") {
      details.push(...renderDiff(diff.before, diff.after, { width: W, maxRows: 12, firstLine: this.locate(diff.path, diff.after) }));
    } else if (diff && row?.name === "write_file") {
      const n = diff.after === "" ? 0 : diff.after.replace(/\n$/, "").split("\n").length;
      if (diff.before === "") details.push("  " + t.green(`+${n} line${n === 1 ? "" : "s"}`) + t.dim(" (new file)"));
      else {
        const { added, removed } = diffCounts(diff.before, diff.after);
        details.push(added || removed ? "  " + t.green(`+${added}`) + " " + t.red(`-${removed}`) + t.dim(" lines (overwrote)") : "  " + t.dim("unchanged"));
      }
    } else if (!row) {
      const first = lines[0] ?? "";
      details.push(`  ${mark} ${t.dim(truncateWidth(first, W - 4, t.g.ellipsis))}`);
    }
    if (ok && result.includes("Warning:")) {
      details.push("  " + t.yellow(truncateWidth("! " + result.slice(result.indexOf("Warning:")).split("\n")[0], W - 2, t.g.ellipsis)));
    }
    if (details.length) this.commit(details.join("\n"));
    this.action = "thinking";
    this.actionKind = "wait";
    this.flush();
  }

  /** Line number where an edit's new text starts, for the diff gutter. */
  private locate(p: string, after: string): number | undefined {
    if (!after) return undefined;
    try {
      const abs = path.resolve(this.fileRoot(), p);
      const st = fs.statSync(abs);
      if (st.size > 2_000_000) return undefined;
      const text = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
      const at = text.indexOf(after.replace(/\r\n/g, "\n"));
      if (at < 0 || text.indexOf(after, at + 1) >= 0) return undefined;
      return text.slice(0, at).split("\n").length;
    } catch {
      return undefined;
    }
  }

  resetResponse(): void {
    // Only the live tail goes: finished lines are already in scrollback.
    this.md.reset();
    this.thinkMd.reset();
    this.think = null;
    this.commit(theme.dim("[Interrupted response discarded]"));
    this.schedule();
  }

  println(s = ""): void {
    this.endThinking();
    this.endContent();
    this.commit(s);
    this.flush();
  }

  status(s: string): void {
    this.println(theme.muted(s));
  }

  turnEnd(label: string): void {
    this.endThinking();
    this.endContent();
    this.spinLabel = null;
    this.busy = false;
    this.activity = false;
    this.commit(`${theme.dim("■ " + label)}\n\n`);
    this.flush();
  }

  planUpdated(plan: Plan): void {
    this.endThinking();
    this.endContent();
    // A plan change arrives instead of a tool result: settle its running row.
    const row = this.toolRow;
    if (row) {
      this.toolRow = null;
      if (row.seq === this.commitSeq) this.pending += "\x1b[1A\r\x1b[2K";
      this.commit(this.toolLine(theme.green(theme.g.ok), row.name, row.args, fmtDur(Date.now() - row.start)));
    }
    const current = plan.currentIndex >= 0 ? plan.steps[plan.currentIndex].text : "complete";
    this.commit(theme.dim(`  Plan ${plan.doneCount}/${plan.steps.length} · ${current}`));
    this.flush();
  }

  warn(s: string): void {
    this.println(theme.yellow(s));
  }

  error(s: string): void {
    this.println(theme.red(s));
  }

  /** The spinner is the footer's first segment; its label is the action. */
  startSpinner(label: string): void {
    if (this.closed) return;
    this.spinLabel = label;
    this.spinStart = Date.now();
    if (this.busy) this.activity = true;
    if (this.state === "hidden") this.schedule();
  }

  stopSpinner(): void {
    if (this.spinLabel === null) return;
    this.spinLabel = null;
    if (this.state === "hidden") this.schedule();
  }
}
