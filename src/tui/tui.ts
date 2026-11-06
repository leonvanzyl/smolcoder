// The full-screen TUI. It draws on the alternate screen into a grid of cells
// and writes only the cells that changed since the last frame, inside
// synchronized output, at most ~60 times a second.
//
// Screens: a home screen (the SMOL logo with the prompt box under it) until
// the first message, then the session: a header with the session title, the
// scrollable transcript (user messages as panels, markdown replies, compact
// tool rows, diffs, command output, the plan), the prompt box docked at the
// bottom with mode · model · effort · context on its last row, and a footer.
// Wide terminals get a sidebar. On top: the autocomplete popup (slash
// commands, their values, @ files), modal dialogs over a dimmed backdrop
// (pickers, the palette, help, prompts, command approval) and toasts.
//
// Mouse: the wheel scrolls; dragging selects transcript text, which is copied
// with OSC 52 (and the system clipboard where one is at hand). Shift+drag
// keeps the terminal's own selection in most terminals.

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { COMMAND_GROUPS, KEYBOARD, findCommand } from "../commands";
import { DATA_DIR } from "../config";
import { LOGO_ROWS, LOGO_WIDTH } from "../logo";
import { Plan } from "../plan";
import { PromptOptions, SelectOption, SelectOpts, SessionUI, SlashCommand, ToolOutcome } from "../ui";
import { fuzzyFilter } from "../util";
import {
  AssistantBlock,
  Block,
  INDENT,
  LayoutCtx,
  ModeKey,
  ReasoningBlock,
  ToolBlock,
  fmtDur,
  gapBetween,
  layoutBlock,
  modeColor,
} from "./blocks";
import { LineEditor, layoutBuffer } from "./editor";
import { FileEntry, FileIndex } from "./files";
import { PromptHistory } from "./history";
import { Key, KeyDecoder, MouseEvent } from "./keys";
import { Row, drawRow } from "./rows";
import { A_BOLD, A_INVERSE, A_ITALIC, Grid, PLAIN, Style, diffFrames } from "./screen";
import { StatusInfo, parseStatus } from "./status";
import { DEFAULT, luminance, oscColor, setTheme, theme } from "./theme";
import { middleTruncate, stringWidth, stripAnsi, truncateWidth, wrapAnsi } from "./width";

type State = "hidden" | "idle" | "select" | "confirm" | "prompt";

const MENU_ROWS = 8;
const LIST_ROWS = 18;
const FRAME_MS = 16; // at most ~60 frames a second
const ESC_WAIT_MS = 40; // a lone ESC this long without a follow-up is the Esc key
const RESIZE_MS = 30;
const STALL_MS = 1000; // no stream activity this long → "working…"
const SIDEBAR_MIN_COLS = 128;
const SIDEBAR_W = 40;

const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ENTER = "\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h" + HIDE_CURSOR + "\x1b[2J";
const LEAVE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[0m\x1b[?7h" + SHOW_CURSOR + "\x1b[?1049l";

/** The streams the TUI talks to (process.stdout / stdin unless a test hands in its own). */
export interface TermOut {
  write(s: string): unknown;
  columns?: number;
  rows?: number;
  isTTY?: boolean;
  on?(event: "resize", fn: () => void): unknown;
  removeListener?(event: "resize", fn: () => void): unknown;
}

export interface TermIn {
  on(event: "data", fn: (d: string | Buffer) => void): unknown;
  removeListener?(event: "data", fn: (d: string | Buffer) => void): unknown;
  setRawMode?(on: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setEncoding?(enc: BufferEncoding): unknown;
  isTTY?: boolean;
}

export interface TuiOptions {
  /** Prompt history file; null keeps history in memory only. */
  historyFile?: string | null;
  /** Where frames are written (defaults to process.stdout). */
  stdout?: TermOut;
  /** Where keys come from (defaults to process.stdin). */
  stdin?: TermIn;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
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
      return "Running " + clip(String(a.command ?? ""), 48);
    case "write_file":
      return "Writing " + String(a.path ?? "a file");
    case "edit_file":
      return "Editing " + String(a.path ?? "a file");
    case "read_file":
      return "Reading " + String(a.path ?? "a file");
    case "search":
      return "Searching " + clip(String(a.pattern ?? ""), 32);
    case "list_files":
      return "Listing " + String(a.path ?? ".");
    case "plan":
      return "Updating the plan";
    case "verification":
      return "Checking " + clip(String(a.command ?? ""), 40);
    default:
      return name;
  }
}

function progressVerb(name: string): string {
  if (name === "write_file") return "Writing a file";
  if (name === "edit_file") return "Preparing an edit";
  if (name === "run_command") return "Preparing a command";
  return "Preparing " + name;
}

/** A row of the completion popup. */
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

/** A dialog row: SelectOption plus a shortcut shown on the right, and rows
 * that only inform (help's key list). */
interface DialogOption extends SelectOption {
  key?: string;
  noop?: boolean;
}

type SelRow = { header: string; first: boolean } | { oi: number };

interface Toast {
  text: string;
  level: "info" | "success" | "warn" | "error";
  until: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Pos {
  line: number;
  col: number;
}

const active = new Set<Tui>();
let exitHooked = false;

/** Leave the alternate screen and restore the terminal of every open TUI
 * (crash paths call this before printing an error). */
export function restoreTerminal(): void {
  for (const t of [...active]) {
    try {
      t.close();
    } catch {
      /* best effort */
    }
  }
}

export class Tui implements SessionUI {
  slashCommands: SlashCommand[] = [];
  getStatus: () => string = () => "";
  onModeCycle: (() => void) | null = null;
  onCancel: (() => void) | null = null;
  onExit: (() => void) | null = null;
  placeholder = "Ask anything, or describe a change…";
  /** Shown on the footer's left (the workspace path). */
  hintLeft = "";
  /** Root for "@" file mentions; defaults to the hintLeft path, then cwd. */
  workspace = "";
  /** Shown beside the logo on the home screen. */
  version = "";

  private out: TermOut;
  private inp: TermIn;
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
  private lastCtrlC = 0;
  private lastEsc = 0;
  private escArmed = false;
  private submitResolve: ((s: string) => void) | null = null;
  /** Typed and sent while a turn was running: submitted at the next readInput. */
  private queued: string | null = null;
  private sel: {
    title: string;
    options: DialogOption[];
    opts?: SelectOpts;
    filter: string;
    /** Position among the selectable rows. */
    index: number;
    /** First visible row. */
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
  private confirmState: {
    command: string;
    reason?: string;
    index: number;
    resolve: (r: "yes" | "no" | "always") => void;
  } | null = null;
  private started = false;
  /** While the terminal is asked for its colours, the first frame waits
   * (up to a moment) so a light terminal never flashes the dark palette. */
  private holdUntil = 0;
  private closed = false;

  // ---- transcript ----
  private blocks: Block[] = [];
  private nextId = 1;
  private sessionTitle = "";
  private themeVer = 0;
  /** ctrl+o: full reasoning, longer diffs and output. */
  private verbose = false;

  // ---- live state while the agent runs ----
  private busy = false;
  private turnStart = 0;
  private spinLabel: string | null = null;
  private spinStart = 0;
  private spinIdx = 0;
  private action = "";
  private actionKind: "wait" | "stream" | "tool" = "wait";
  private lastStream = 0;
  private themeQueryUntil = 0;

  // ---- scrolling & selection ----
  private stick = true;
  private scrollTop = 0;
  private newBelow = false;
  private lastTotal = 0;
  private flat: Row[] = [];
  private selection: { a: Pos; b: Pos; dragging: boolean } | null = null;

  // ---- overlays ----
  private toasts: Toast[] = [];
  private notice: { text: string; until: number } | null = null;

  // ---- output pipeline ----
  private prev: Grid | null = null;
  private cursorOn = false;
  private lastFrame = 0;
  private frameTimer: NodeJS.Timeout | null = null;
  private escTimer: NodeJS.Timeout | null = null;
  private resizeTimer: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;
  /** Where things were drawn last frame (mouse hit-testing). */
  private hit: {
    msg: Rect | null;
    dialog: Rect | null;
    dialogRows: { y: number; index: number }[];
    menuRows: { y: number; index: number }[];
  } = { msg: null, dialog: null, dialogRows: [], menuRows: [] };
  private onDataFn = (d: string | Buffer) => this.onData(String(d));
  private onResizeFn = () => this.onResize();

  constructor(opts: TuiOptions = {}) {
    const file = opts.historyFile === undefined ? path.join(DATA_DIR, "prompt-history.jsonl") : opts.historyFile;
    this.hist = new PromptHistory(file);
    this.out = opts.stdout ?? process.stdout;
    this.inp = opts.stdin ?? process.stdin;
  }

  /** The session's title: its first message. */
  get title(): string {
    return this.sessionTitle;
  }

  /** Safe to call twice: startup opens the TUI early, the session starts it again later. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    active.add(this);
    if (!exitHooked) {
      exitHooked = true;
      process.once("exit", () => restoreTerminal());
    }
    this.hist.load();
    this.inp.setRawMode?.(true);
    this.inp.resume?.();
    this.inp.setEncoding?.("utf8");
    this.inp.on("data", this.onDataFn);
    this.out.on?.("resize", this.onResizeFn);
    let seq = ENTER;
    // Ask the terminal for its background colour (OSC 11), then for device
    // attributes: every terminal answers DA, so its reply ends the wait even
    // where OSC 11 is not supported. Both replies are swallowed by the key
    // decoder. Skipped on legacy consoles, which may echo unknown sequences.
    if (this.out.isTTY && this.inp.isTTY && !theme.opts.ascii && theme.opts.color) {
      seq += "\x1b]11;?\x07\x1b[c";
      this.themeQueryUntil = Date.now() + 200;
      this.holdUntil = Date.now() + 120;
    }
    this.write(seq);
    this.prev = null;
    this.render();
  }

  close(): void {
    if (this.closed || !this.started) return;
    this.closed = true;
    this.started = false;
    active.delete(this);
    for (const t of [this.frameTimer, this.escTimer, this.resizeTimer]) if (t) clearTimeout(t);
    this.frameTimer = this.escTimer = this.resizeTimer = null;
    this.stopTick();
    this.inp.removeListener?.("data", this.onDataFn);
    this.out.removeListener?.("resize", this.onResizeFn);
    this.write(LEAVE);
    this.prev = null;
    this.inp.setRawMode?.(false);
    this.inp.pause?.();
  }

  // ---- SessionUI: input ------------------------------------------------------

  readInput(): Promise<string> {
    this.endRun();
    this.histIdx = -1;
    this.menuIndex = 0;
    this.menuClosedFor = null;
    this.state = "idle";
    const p = new Promise<string>((res) => (this.submitResolve = res));
    if (this.queued !== null) {
      const q = this.queued;
      this.queued = null;
      this.submitText(q);
    } else this.render();
    return p;
  }

  select(title: string, options: SelectOption[], opts?: SelectOpts): Promise<number | null> {
    return this.openSelect(title, options, opts);
  }

  private openSelect(title: string, options: DialogOption[], opts?: SelectOpts): Promise<number | null> {
    this.state = "select";
    return new Promise((resolve) => {
      this.sel = { title, options, opts, filter: "", index: 0, top: 0, resolve };
      const cur = this.selItems().findIndex((oi) => options[oi]?.current);
      this.sel.index = Math.max(0, cur);
      this.render();
    });
  }

  prompt(title: string, placeholder = "", opts: PromptOptions = {}): Promise<string | null> {
    this.state = "prompt";
    return new Promise((resolve) => {
      this.promptState = { title, placeholder, secret: opts.secret, ed: new LineEditor(), resolve };
      this.render();
    });
  }

  confirmCommand(command: string, reason?: string): Promise<"yes" | "no" | "always"> {
    this.state = "confirm";
    return new Promise((resolve) => {
      this.confirmState = { command, reason, index: 0, resolve };
      this.render();
    });
  }

  /** A new prompt: the running turn is over. */
  private endRun(): void {
    this.finishStreams();
    this.spinLabel = null;
    this.busy = false;
  }

  // ---- key routing -------------------------------------------------------------

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
    if (this.closed) return;
    for (const key of keys) {
      if (key.type === "osc") {
        this.onOsc(key.text ?? "");
        continue;
      }
      if (key.type === "da") {
        this.themeQueryUntil = 0;
        if (this.holdUntil) {
          this.holdUntil = 0;
          this.render();
        }
        continue;
      }
      if (key.type === "ctrlo") {
        this.toggleDetail();
        continue;
      }
      if (key.type === "mouse") {
        this.onMouse(key.mouse!);
        continue;
      }
      if (key.type === "ctrll") {
        this.prev = null;
        this.write("\x1b[2J");
        this.render();
        continue;
      }
      // Any key ends a finished selection's highlight.
      if (this.selection && !this.selection.dragging) this.selection = null;
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
        case "hidden":
          this.keyBusy(key);
          break;
      }
    }
  }

  private onOsc(body: string): void {
    if (!body.startsWith("11;") || Date.now() > this.themeQueryUntil) return;
    this.themeQueryUntil = 0;
    const bg = oscColor(body.slice(3));
    if (bg === null) return;
    const light = luminance(bg) > 0.5;
    setTheme({ light, bg });
    this.themeVer++;
    this.prev = null;
    this.holdUntil = 0;
    this.render();
  }

  private toggleDetail(): void {
    this.verbose = !this.verbose;
    this.toast(this.verbose ? "Details shown: full reasoning, diffs and output" : "Details collapsed", "info");
    this.render();
  }

  private setNotice(text: string, ms = 1500): void {
    this.notice = { text, until: Date.now() + ms };
    this.startTick();
  }

  /** Editing keys shared by the idle prompt and type-ahead. True when used. */
  private editKey(key: Key): boolean {
    switch (key.type) {
      case "char":
      case "text":
        this.ed.insert(key.text!);
        return true;
      case "newline":
        this.ed.insert("\n");
        return true;
      case "backspace":
        this.ed.backspace();
        return true;
      case "wordbackspace":
      case "ctrlw":
        this.ed.deleteWordBack();
        return true;
      case "delete":
        this.ed.del();
        return true;
      case "worddelete":
        this.ed.deleteWordForward();
        return true;
      case "left":
        this.ed.left();
        return true;
      case "right":
        this.ed.right();
        return true;
      case "wordleft":
        this.ed.wordLeft();
        return true;
      case "wordright":
        this.ed.wordRight();
        return true;
      case "home":
      case "ctrla":
        this.ed.home();
        return true;
      case "end":
      case "ctrle":
        this.ed.end();
        return true;
      case "ctrlu":
        this.ed.killToLineStart();
        return true;
      case "ctrlk":
        this.ed.killToLineEnd();
        return true;
      case "up":
        if (!this.ed.upLine()) this.historyPrev();
        return true;
      case "down":
        if (!this.ed.downLine()) this.historyNext();
        return true;
      default:
        return false;
    }
  }

  /** Transcript scrolling keys. True when used. */
  private scrollKey(key: Key): boolean {
    const page = Math.max(1, (this.hit.msg?.h ?? 10) - 2);
    switch (key.type) {
      case "pageup":
        this.scrollBy(-page);
        return true;
      case "pagedown":
        this.scrollBy(page);
        return true;
      case "shiftup":
        this.scrollBy(-1);
        return true;
      case "shiftdown":
        this.scrollBy(1);
        return true;
      case "ctrlhome":
        this.stick = false;
        this.scrollTop = 0;
        return true;
      case "ctrlend":
        this.toBottom();
        return true;
      default:
        return false;
    }
  }

  private keyBusy(key: Key): void {
    if (key.type === "esc" || key.type === "ctrlc") {
      this.onCancel?.();
      return;
    }
    if (this.scrollKey(key)) return this.render();
    if (key.type === "enter") {
      const text = this.ed.buffer.trim();
      if (!text) return;
      this.queued = text;
      this.ed.clear();
      this.toast(this.busy ? "Queued: sent when this turn finishes" : "Queued: sent when the session is ready", "info");
      return this.render();
    }
    if (this.editKey(key)) return this.render();
  }

  private keyIdle(key: Key): void {
    // A second esc counts only right after the first.
    const escArmed = this.escArmed;
    this.escArmed = false;
    if (this.notice && key.type !== "esc" && key.type !== "ctrlc") this.notice = null;
    const menu = this.currentMenu();
    if (menu && this.keyMenu(key, menu)) return;
    if (this.editKey(key)) {
      if (key.type !== "up" && key.type !== "down") this.toBottomIfTyping();
      return this.render();
    }
    if (this.scrollKey(key)) return this.render();
    switch (key.type) {
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
      case "esc": {
        // Never wipe a draft on one keypress: the first esc only warns.
        if (!this.ed.buffer) {
          if (!this.stick) this.toBottom();
          break;
        }
        if (escArmed && Date.now() - this.lastEsc < 1000) {
          this.hist.entries.push(this.ed.buffer); // ↑ brings it back (not saved to disk)
          this.ed.clear();
          this.lastEsc = 0;
          this.setNotice("Draft cleared · ↑ restores it");
        } else {
          this.lastEsc = Date.now();
          this.escArmed = true;
          this.setNotice("Esc again to clear the draft", 1000);
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
          this.setNotice("Press ctrl+c again to exit");
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
      default:
        break;
    }
    this.render();
  }

  private toBottomIfTyping(): void {
    if (!this.stick) this.toBottom();
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
        // With no value typed yet, enter runs the bare command ("/models "
        // opens the picker) instead of the first suggested value.
        if (menu.kind === "args" && menu.sig.endsWith(":")) return false;
        if (this.complete(menu, pick(), "enter")) return true;
        break;
      default:
        return false;
    }
    this.render();
    return true;
  }

  /** Apply a menu choice. Returns true when it submitted the input. */
  private complete(menu: Menu, item: MenuItem, how: "tab" | "enter"): boolean {
    if (menu.kind === "slash" && item.cmd) {
      // Enter runs the command; tab completes it so a value can follow.
      if (how === "tab") {
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
      this.render();
      return;
    }
    // /help opens the help dialog right here; it never reaches the session.
    const slash = /^\/(\S+)\s*$/.exec(text);
    if (slash && this.slashCommands.length) {
      const cmd = findCommand(slash[1], this.slashCommands);
      if (cmd?.name === "help") {
        this.hist.add(text);
        this.ed.clear();
        void this.openHelp();
        return;
      }
    }
    this.hist.add(text);
    this.ed.clear();
    this.state = "hidden";
    this.notice = null;
    this.selection = null;
    if (!text.startsWith("/")) {
      const info = this.statusInfo();
      if (!this.sessionTitle) this.sessionTitle = text.replace(/\s+/g, " ").slice(0, 200);
      this.add({ kind: "user", text, mode: info.mode, id: 0, ver: 0 });
      this.busy = true;
      this.turnStart = Date.now();
      this.action = "Thinking";
      this.actionKind = "wait";
    }
    this.toBottom();
    this.render();
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

  /** ctrl+p: every slash command, grouped, with its shortcut on the right. */
  private async openPalette(): Promise<void> {
    const cmds = this.slashCommands;
    if (!cmds.length) return;
    const draft = { buffer: this.ed.buffer, cursor: this.ed.cursor };
    const options: DialogOption[] = cmds.map((cmd) => ({
      label: "/" + cmd.name,
      hint: cmd.desc,
      key: cmd.key,
      group: cmd.group,
      keywords: [cmd.name, ...(cmd.aliases ?? [])].join(" "),
    }));
    const i = await this.openSelect("Commands", options);
    this.backToIdle(draft);
    if (i === null) return this.render();
    this.runCommand(cmds[i]);
  }

  private runCommand(cmd: SlashCommand): void {
    if (cmd.args) {
      this.ed.set("/" + cmd.name + " ");
      this.render();
    } else this.submitText("/" + cmd.name);
  }

  /** /help: the commands by group, then the keys. Choosing a command runs it. */
  private async openHelp(): Promise<void> {
    const cmds = this.slashCommands;
    const order = (g?: string) => {
      const i = COMMAND_GROUPS.indexOf(g ?? "");
      return i < 0 ? COMMAND_GROUPS.length : i;
    };
    const sorted = [...cmds].sort((a, b) => order(a.group) - order(b.group));
    const options: DialogOption[] = sorted.map((cmd) => ({
      label: "/" + cmd.name,
      hint: cmd.desc,
      key: cmd.key,
      group: cmd.group ?? "Other",
      keywords: [cmd.name, ...(cmd.aliases ?? [])].join(" "),
    }));
    for (const k of KEYBOARD) options.push({ label: k.key, hint: k.desc, group: "Keys", noop: true });
    const draft = { buffer: this.ed.buffer, cursor: this.ed.cursor };
    const i = await this.openSelect("Help", options);
    this.backToIdle(draft);
    if (i === null || options[i].noop) return this.render();
    this.runCommand(sorted[i]);
  }

  /** ctrl+r: fuzzy search through the prompt history, newest first. */
  private async openHistorySearch(): Promise<void> {
    const entries = [...this.hist.entries].reverse();
    if (!entries.length) {
      this.toast("No prompt history yet", "info");
      return this.render();
    }
    const draft = { buffer: this.ed.buffer, cursor: this.ed.cursor };
    const options: SelectOption[] = entries.map((e) => {
      const lines = e.split("\n");
      return { label: clip(lines[0], 200), hint: lines.length > 1 ? `+${lines.length - 1} lines` : undefined, keywords: e };
    });
    const i = await this.openSelect("Search history", options);
    this.backToIdle(draft);
    if (i !== null) this.ed.set(entries[i]);
    this.render();
  }

  private backToIdle(draft: { buffer: string; cursor: number }): void {
    this.state = "idle";
    this.ed.buffer = draft.buffer;
    this.ed.cursor = draft.cursor;
    this.histIdx = -1;
  }

  // ---- pickers -------------------------------------------------------------------

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
      if (g) rows.push({ header: g, first: rows.length === 0 });
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
    const page = this.listRows();
    switch (key.type) {
      case "up":
        s.index = n ? (s.index - 1 + n) % n : 0;
        break;
      case "down":
      case "tab":
        s.index = n ? (s.index + 1) % n : 0;
        break;
      case "pageup":
        s.index = Math.max(0, s.index - page);
        break;
      case "pagedown":
        s.index = Math.max(0, Math.min(n - 1, s.index + page));
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
    this.render();
  }

  private endSelect(result: number | null): void {
    const s = this.sel!;
    this.sel = null;
    this.state = "hidden";
    this.render();
    s.resolve(result);
  }

  private keyPrompt(key: Key): void {
    const p = this.promptState!;
    const finish = (value: string | null) => {
      this.promptState = null;
      this.state = "hidden";
      this.add({ kind: "note", level: "status", text: `${p.title}: ${value === null ? "cancelled" : p.secret ? "(hidden)" : value}`, id: 0, ver: 0 });
      this.render();
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
    this.render();
  }

  private static CONFIRM: ("yes" | "always" | "no")[] = ["yes", "always", "no"];

  private keyConfirm(key: Key): void {
    const cs = this.confirmState!;
    let result: "yes" | "no" | "always" | null = null;
    if (key.type === "char") {
      const ch = key.text!.toLowerCase();
      if (ch === "y") result = "yes";
      else if (ch === "n") result = "no";
      else if (ch === "a") result = "always";
    } else if (key.type === "up" || key.type === "shifttab") cs.index = (cs.index + 2) % 3;
    else if (key.type === "down" || key.type === "tab") cs.index = (cs.index + 1) % 3;
    else if (key.type === "enter") result = Tui.CONFIRM[cs.index];
    else if (key.type === "esc" || key.type === "ctrlc") result = "no";
    if (result === null) return this.render();
    this.finishConfirm(result);
  }

  private finishConfirm(result: "yes" | "no" | "always"): void {
    const cs = this.confirmState!;
    this.confirmState = null;
    this.state = "hidden";
    const label = result === "always" ? "Always allowed" : result === "yes" ? "Allowed" : "Denied";
    this.add({ kind: "note", level: result === "no" ? "warn" : "status", text: `${label}: ${cs.command.replace(/\s+/g, " ")}`, id: 0, ver: 0 });
    this.render();
    cs.resolve(result);
  }

  // ---- mouse ---------------------------------------------------------------------

  private onMouse(m: MouseEvent): void {
    const wheel = m.button === 64 ? -1 : m.button === 65 ? 1 : 0;
    if (this.state === "select" && this.sel) {
      const d = this.hit.dialog;
      if (wheel) {
        const n = this.selItems().length;
        if (n) this.sel.index = Math.max(0, Math.min(n - 1, this.sel.index + wheel));
        return this.render();
      }
      if (m.action === "press" && m.button === 0) {
        const row = this.hit.dialogRows.find((r) => r.y === m.y);
        if (row) {
          this.sel.index = row.index;
          const items = this.selItems();
          return this.endSelect(items[row.index]);
        }
        if (d && !inside(d, m.x, m.y)) return this.endSelect(null);
      }
      return;
    }
    if (this.state === "confirm" && this.confirmState) {
      if (m.action === "press" && m.button === 0) {
        const row = this.hit.dialogRows.find((r) => r.y === m.y);
        if (row) return this.finishConfirm(Tui.CONFIRM[row.index]);
      }
      return;
    }
    if (this.state === "prompt") {
      if (m.action === "press" && m.button === 0 && this.hit.dialog && !inside(this.hit.dialog, m.x, m.y)) this.keyPrompt({ type: "esc" });
      return;
    }
    // The completion popup.
    if (this.state === "idle" && m.action === "press" && m.button === 0) {
      const row = this.hit.menuRows.find((r) => r.y === m.y);
      const menu = row ? this.currentMenu() : null;
      if (row && menu && menu.items[row.index]) {
        this.menuIndex = row.index;
        this.complete(menu, menu.items[row.index], menu.kind === "slash" && !menu.items[row.index].cmd?.args ? "enter" : "tab");
        return this.render();
      }
    }
    if (wheel) {
      this.scrollBy(wheel * 3);
      return this.render();
    }
    const area = this.hit.msg;
    if (!area) return;
    const pos = (): Pos => {
      const y = Math.max(area.y, Math.min(area.y + area.h - 1, m.y));
      return { line: this.viewTop() + (y - area.y), col: Math.max(area.x, Math.min(area.x + area.w - 1, m.x)) };
    };
    if (m.action === "press" && m.button === 0) {
      if (inside(area, m.x, m.y)) this.selection = { a: pos(), b: pos(), dragging: true };
      else this.selection = null;
      return this.render();
    }
    if (m.action === "drag" && this.selection?.dragging) {
      // Dragging past the edge scrolls.
      if (m.y < area.y) this.scrollBy(-1);
      else if (m.y >= area.y + area.h) this.scrollBy(1);
      this.selection.b = pos();
      return this.render();
    }
    if (m.action === "release" && this.selection?.dragging) {
      this.selection.dragging = false;
      const { a, b } = this.selection;
      if (a.line === b.line && a.col === b.col) this.selection = null;
      else this.copySelection();
      return this.render();
    }
  }

  private copySelection(): void {
    const s = this.selection;
    const area = this.hit.msg;
    if (!s || !area) return;
    let [a, b] = [s.a, s.b];
    if (b.line < a.line || (b.line === a.line && b.col < a.col)) [a, b] = [b, a];
    const lines: string[] = [];
    for (let li = a.line; li <= b.line; li++) {
      const row = this.flat[li];
      if (!row) {
        lines.push("");
        continue;
      }
      const g = new Grid(area.x + area.w + 1, 1);
      drawRow(g, area.x, 0, row, area.x + area.w, PLAIN);
      const x0 = li === a.line ? a.col : area.x;
      const x1 = li === b.line ? b.col + 1 : area.x + area.w;
      let text = g.rowText(0, x0, x1).replace(/\s+$/, "");
      if (li !== a.line || a.col <= area.x + INDENT) {
        text = text.replace(new RegExp(`^\\s{0,${INDENT}}`), "");
        if (text.startsWith(theme.g.bar) || text.startsWith(theme.g.vline)) text = text.slice(1).replace(/^\s{0,2}/, "");
      }
      lines.push(text);
    }
    const text = lines.join("\n").replace(/^\n+|\n+$/g, "");
    if (!text) return;
    this.copy(text);
    this.toast(`Copied ${Array.from(text).length} characters`, "success");
  }

  /** OSC 52 (most terminals), plus the system clipboard tool where there is one. */
  private copy(text: string): void {
    this.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
    if (this.out !== process.stdout) return;
    try {
      if (process.platform === "win32") {
        const p = spawn("clip", [], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        p.on("error", () => {});
        p.stdin?.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
      } else if (process.platform === "darwin") {
        const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
        p.on("error", () => {});
        p.stdin?.end(text);
      }
    } catch {
      /* OSC 52 is enough */
    }
  }

  // ---- scrolling -------------------------------------------------------------------

  private viewTop(): number {
    const h = this.hit.msg?.h ?? 0;
    const max = Math.max(0, this.flat.length - h);
    return this.stick ? max : Math.max(0, Math.min(this.scrollTop, max));
  }

  private scrollBy(n: number): void {
    const h = this.hit.msg?.h ?? 0;
    const max = Math.max(0, this.flat.length - h);
    const top = Math.max(0, Math.min(this.viewTop() + n, max));
    if (top >= max) return this.toBottom();
    this.stick = false;
    this.scrollTop = top;
  }

  private toBottom(): void {
    this.stick = true;
    this.newBelow = false;
  }

  // ---- the completion menu -----------------------------------------------------------

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

  /** The menu for the text being typed: slash commands, a command's
   * argument values, or workspace files after "@". */
  private currentMenu(): Menu | null {
    if (this.state !== "idle") return null;
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
        const cmd = a ? findCommand(a[1], this.slashCommands) : undefined;
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
          if (this.state === "idle") this.render();
        });
    }
    return this.argCache.get(cmd.name)!;
  }

  // ---- transcript ----------------------------------------------------------------------

  private add<B extends Block>(b: B): B {
    b.id = this.nextId++;
    b.ver = 0;
    this.blocks.push(b);
    return b;
  }

  private last(): Block | undefined {
    return this.blocks[this.blocks.length - 1];
  }

  private touch(b: Block): void {
    b.ver++;
  }

  /** Close the streaming reply and reasoning (something else comes next). */
  private finishStreams(): void {
    for (let i = this.blocks.length - 1; i >= 0 && i >= this.blocks.length - 4; i--) {
      const b = this.blocks[i];
      if (b.kind === "assistant" && !b.done) {
        b.done = true;
        this.touch(b);
      }
      if (b.kind === "reasoning" && b.end === undefined) {
        b.end = Date.now();
        this.touch(b);
      }
    }
  }

  private runningTool(): ToolBlock | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.kind === "tool" && b.end === undefined) return b;
      if (b.kind === "user") return undefined;
    }
    return undefined;
  }

  /** Whether the home screen shows: nothing but notices so far. */
  private isHome(): boolean {
    return !this.blocks.some((b) => b.kind !== "note");
  }

  // ---- rendering ---------------------------------------------------------------------------

  private size(): { W: number; H: number } {
    return { W: Math.max(20, this.out.columns || 80), H: Math.max(8, this.out.rows || 24) };
  }

  private toast(text: string, level: Toast["level"] = "info"): void {
    const ms = level === "warn" || level === "error" ? 6000 : 3000;
    this.toasts.push({ text: stripAnsi(text).replace(/^\s*[·•]\s*/, ""), level, until: Date.now() + ms });
    if (this.toasts.length > 3) this.toasts.shift();
    this.startTick();
    this.schedule();
  }

  /** Draw the next frame now. */
  private render(): void {
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.closed || !this.started) return;
    if (this.holdUntil) {
      const wait = this.holdUntil - Date.now();
      if (wait > 0) {
        this.frameTimer = setTimeout(() => this.render(), wait);
        this.frameTimer.unref?.();
        return;
      }
      this.holdUntil = 0;
    }
    this.lastFrame = Date.now();
    const now = this.lastFrame;
    this.toasts = this.toasts.filter((t) => t.until > now);
    if (this.notice && this.notice.until <= now) this.notice = null;
    const { W, H } = this.size();
    const g = new Grid(W, H);
    const info = this.statusInfo();
    let cursor: { x: number; y: number } | null = null;
    this.hit = { msg: null, dialog: null, dialogRows: [], menuRows: [] };

    const promptFocus = this.state === "idle" || this.state === "hidden";
    let promptRect: Rect;
    if (this.isHome()) promptRect = this.drawHome(g, W, H, info);
    else promptRect = this.drawSession(g, W, H, info);
    const pc = this.drawPrompt(g, promptRect, info, promptFocus);
    if (promptFocus) cursor = pc;

    const menu = this.currentMenu();
    if (menu) this.drawMenu(g, menu, promptRect, W);

    if (this.state === "select" || this.state === "prompt" || this.state === "confirm") {
      g.dim(theme.opts.light ? 0.42 : 0.55, theme.p.text, theme.p.bg, theme.opts.color);
      cursor = this.drawDialog(g, W, H);
    }
    this.drawToasts(g, W, H);

    let seq = SYNC_ON + HIDE_CURSOR + diffFrames(this.prev, g, theme.opts.truecolor);
    if (cursor) seq += `\x1b[${cursor.y + 1};${cursor.x + 1}H` + SHOW_CURSOR;
    this.cursorOn = !!cursor;
    seq += SYNC_OFF;
    this.prev = g;
    this.write(seq);
    if (this.needsTick()) this.startTick();
    else this.stopTick();
  }

  private needsTick(): boolean {
    return this.busy || this.spinLabel !== null || this.toasts.length > 0 || this.notice !== null || !!this.runningTool();
  }

  private schedule(): void {
    if (this.frameTimer || this.closed || !this.started) return;
    const wait = Math.max(0, FRAME_MS - (Date.now() - this.lastFrame));
    this.frameTimer = setTimeout(() => this.render(), wait);
    this.frameTimer.unref?.();
  }

  private startTick(): void {
    if (this.tick || this.closed) return;
    this.tick = setInterval(() => {
      this.spinIdx++;
      this.schedule();
    }, 80);
    this.tick.unref?.();
  }

  private stopTick(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  private onResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.prev = null;
      this.write("\x1b[2J");
      this.render();
    }, RESIZE_MS);
    this.resizeTimer.unref?.();
  }

  private write(s: string): void {
    if (s) this.out.write(s);
  }

  /** Redraw (status changes, model switches). */
  refresh(): void {
    this.schedule();
  }

  // ---- styles --------------------------------------------------------------------------

  private st(fgc: number, bgc: number = -2, attrs = 0): Style {
    return { fg: theme.cell(fgc), bg: bgc === -2 ? DEFAULT : theme.cell(bgc), attrs };
  }

  /** Without colours, a highlighted row is drawn in reverse video. */
  private invert(g: Grid, x: number, y: number, w: number): void {
    if (theme.opts.color) return;
    for (let i = Math.max(0, x); i < Math.min(g.w, x + w); i++) g.at[y * g.w + i] |= A_INVERSE;
  }

  private spin(): string {
    const s = theme.g.spinner;
    return s[this.spinIdx % s.length];
  }

  // ---- home --------------------------------------------------------------------------

  private drawHome(g: Grid, W: number, H: number, info: StatusInfo): Rect {
    const t = theme;
    const p = t.p;
    const pw = Math.min(76, W - 4);
    const px = Math.floor((W - pw) / 2);
    const ph = this.promptHeight(pw, H);
    const showLogo = W >= LOGO_WIDTH + 4 && H >= ph + 14;
    const notes = this.blocks.filter((b) => b.kind === "note").slice(-3) as Extract<Block, { kind: "note" }>[];
    const logoH = showLogo ? LOGO_ROWS.length + 1 : 1;
    const tipsH = H >= ph + 12 ? 2 : 0;
    const total = logoH + 2 + ph + tipsH + (notes.length ? notes.length + 1 : 0);
    let y = Math.max(0, Math.floor((H - 1 - total) / 2));
    if (showLogo) {
      const lx = Math.floor((W - LOGO_WIDTH) / 2);
      LOGO_ROWS.forEach((row, i) => {
        // Letters in the accent ramp, the box-drawing shadow a step darker.
        const c = p.logo[i] ?? p.accent;
        g.text(lx, y + i, row.replace(/[╗╔╝╚║═]/g, " ").replace(/\s+$/, ""), this.st(c));
        for (let k = 0, x = lx; k < row.length; k++, x++) if ("╗╔╝╚║═".includes(row[k])) g.set(x, y + i, row[k], this.st(t.opts.light ? p.border : p.borderActive));
      });
      y += LOGO_ROWS.length;
      const tail = `coder${this.version ? " v" + this.version : ""}`;
      g.text(lx + LOGO_WIDTH - stringWidth(tail) - 1, y, tail, this.st(p.muted));
      y += 1;
    } else {
      const brand = `smol${t.reset}${t.fgCode(p.muted)}coder${this.version ? " v" + this.version : ""}`;
      g.text(Math.floor((W - 10 - (this.version ? this.version.length + 2 : 0)) / 2), y, brand, this.st(p.accent, -2, A_BOLD));
      y += 1;
    }
    y += 2;
    const rect = { x: px, y, w: pw, h: ph };
    y += ph;
    if (tipsH) {
      y += 1;
      const tips: [string, string][] = [
        ["/", "commands"],
        ["@", "files"],
        ["ctrl+p", "palette"],
        ["shift+tab", "mode"],
        ["F2", "next model"],
      ];
      const parts = tips.map(([k, v]) => `${t.fgCode(p.text)}${k}${t.reset} ${v}`);
      let line = parts.join("   ");
      while (stringWidth(line) > pw && parts.length > 2) {
        parts.pop();
        line = parts.join("   ");
      }
      g.text(px + Math.floor((pw - stringWidth(line)) / 2), y, line, this.st(p.muted));
      y += 1;
    }
    if (notes.length) {
      y += 1;
      for (const n of notes) {
        const warn = n.level !== "status";
        const text = stripAnsi(n.text).replace(/^\s*[·•]\s*/, "").replace(/\s+/g, " ").trim();
        const icon = n.level === "error" ? t.g.fail : warn ? t.g.warn : t.g.dot;
        const line = truncateWidth(`${icon} ${text}`, pw, t.g.ellipsis);
        g.text(px + Math.floor((pw - stringWidth(line)) / 2), y++, line, this.st(n.level === "error" ? p.error : warn ? p.warning : p.muted));
      }
    }
    this.drawFooter(g, 2, W - 4, H - 1, info, true);
    return rect;
  }

  // ---- session -----------------------------------------------------------------------

  private drawSession(g: Grid, W: number, H: number, info: StatusInfo): Rect {
    const sidebar = W >= SIDEBAR_MIN_COLS && H >= 16;
    const colW = sidebar ? W - SIDEBAR_W : W;
    const x = 2;
    const w = colW - 4;
    const ph = this.promptHeight(w, H);
    const footerY = H - 1;
    const py = footerY - ph;
    let top = 0;
    if (!sidebar && H >= 14) {
      this.drawHeader(g, colW, info);
      top = 2;
    } else top = 1;
    const msgH = Math.max(1, py - 1 - top);
    const area = { x, y: top, w, h: msgH };
    this.drawMessages(g, area);
    if (sidebar) this.drawSidebar(g, colW, W, H, info);
    this.drawFooter(g, x, w, footerY, info, false);
    return { x, y: py, w, h: ph };
  }

  private drawHeader(g: Grid, colW: number, info: StatusInfo): void {
    const t = theme;
    const p = t.p;
    g.fill(0, 0, colW, 1, this.st(p.text, p.panel));
    const right: string[] = [];
    if (info.plan) right.push(`${t.fgCode(p.accent)}${t.g.icons.plan}${t.reset}${t.fgCode(p.muted)} plan ${info.plan}`);
    if (info.tasks) right.push(`${t.fgCode(p.success)}${t.g.icons.task}${t.reset}${t.fgCode(p.muted)} ${info.tasks} task${info.tasks === 1 ? "" : "s"}`);
    const r = right.join(`${t.reset}${t.fgCode(p.faint)}  ${t.g.dot}  ${t.reset}`);
    const rw = stringWidth(r);
    const title = this.sessionTitle || "New session";
    const room = colW - 4 - (rw ? rw + 3 : 0);
    g.text(2, 0, truncateWidth(title, Math.max(4, room), t.g.ellipsis), this.st(p.text, p.panel, A_BOLD));
    if (rw) g.text(colW - 2 - rw, 0, r, this.st(p.muted, p.panel));
  }

  private drawMessages(g: Grid, area: Rect): void {
    const t = theme;
    const p = t.p;
    const ctx: LayoutCtx = { detail: this.verbose, now: Date.now(), spin: this.spin(), themeVer: this.themeVer };
    const flat: Row[] = [];
    let prev: Block | undefined;
    for (const b of this.blocks) {
      const rows = layoutBlock(b, area.w, ctx);
      if (!rows.length) continue;
      const gap = gapBetween(prev, b);
      for (let i = 0; i < gap; i++) flat.push([]);
      for (const r of rows) flat.push(r);
      prev = b;
    }
    this.flat = flat;
    this.hit.msg = area;
    const total = flat.length;
    if (!this.stick && total > this.lastTotal) this.newBelow = true;
    this.lastTotal = total;
    const max = Math.max(0, total - area.h);
    if (!this.stick && this.scrollTop >= max) this.toBottom();
    const top = this.viewTop();
    const base = this.st(p.text);
    for (let i = 0; i < area.h; i++) {
      const row = flat[top + i];
      if (row) drawRow(g, area.x, area.y + i, row, area.x + area.w, base);
    }
    // Selection highlight.
    const s = this.selection;
    if (s) {
      let [a, b] = [s.a, s.b];
      if (b.line < a.line || (b.line === a.line && b.col < a.col)) [a, b] = [b, a];
      for (let li = Math.max(a.line, top); li <= Math.min(b.line, top + area.h - 1); li++) {
        const x0 = li === a.line ? a.col : area.x;
        const x1 = li === b.line ? b.col + 1 : area.x + area.w;
        if (t.opts.color) g.tint(x0, area.y + li - top, x1 - x0, 1, t.cell(p.selection));
        else this.invert(g, x0, area.y + li - top, x1 - x0);
      }
    }
    // Scrollbar thumb in the right margin.
    if (total > area.h) {
      const th = Math.max(1, Math.round((area.h * area.h) / total));
      const ty = area.y + Math.round(((area.h - th) * top) / Math.max(1, max));
      for (let i = 0; i < th; i++) g.set(area.x + area.w + 1, ty + i, t.g.vline, this.st(this.stick ? p.border : p.borderActive));
    }
    // "↓ new messages" while scrolled up.
    if (!this.stick) {
      const below = total - (top + area.h);
      const label = this.newBelow ? ` ${t.g.down} New messages ` : ` ${t.g.down} ${below} more line${below === 1 ? "" : "s"} `;
      const lw = stringWidth(label);
      const lx = area.x + Math.floor((area.w - lw) / 2);
      const ly = area.y + area.h - 1;
      g.text(lx, ly, label, this.newBelow ? this.st(p.onAccent, p.accent, A_BOLD) : this.st(p.muted, p.element));
      this.invert(g, lx, ly, lw);
    }
  }

  private drawSidebar(g: Grid, x0: number, W: number, H: number, info: StatusInfo): void {
    const t = theme;
    const p = t.p;
    const bg = p.panel;
    g.fill(x0, 0, W - x0, H, this.st(p.text, bg));
    const x = x0 + 2;
    const w = W - x0 - 4;
    let y = 1;
    const line = (text: string, fgc: number, attrs = 0) => {
      if (y >= H - 2) return;
      g.text(x, y++, truncateWidth(text, w, t.g.ellipsis), this.st(fgc, bg, attrs));
    };
    const title = this.sessionTitle || "New session";
    for (const r of wrapAnsi(title, w).slice(0, 3)) line(r, p.text, A_BOLD);
    y++;
    line("Context", p.text, A_BOLD);
    if (info.tokens) line(`${info.tokens} tokens`, p.muted);
    if (info.pct !== null) {
      line(`${info.pct}% used`, p.muted);
      const mw = Math.min(w, 24);
      const on = Math.round((Math.min(100, info.pct) / 100) * mw);
      const c = info.pct >= 85 ? p.error : info.pct >= 60 ? p.warning : p.accent;
      g.text(x, y, t.g.meterOn.repeat(on), this.st(c, bg));
      g.text(x + on, y, t.g.meterOff.repeat(mw - on), this.st(p.border, bg));
      y++;
    }
    y++;
    line("Model", p.text, A_BOLD);
    if (info.model) line(info.model, p.muted);
    if (info.backend) line(info.backend, p.faint);
    const modeLine = `${t.fgCode(modeColor(info.mode))}${info.modeLabel || "Edit"}${t.reset}${info.effort ? `${t.fgCode(p.faint)} ${t.g.dot} ${t.reset}${t.fgCode(p.warning)}${info.effort}` : ""}`;
    if (y < H - 2) g.text(x, y++, modeLine, this.st(p.muted, bg));
    const plan = this.lastPlan();
    if (plan && plan.steps.length) {
      y++;
      line(`Plan  ${t.fgCode(p.muted)}${plan.steps.filter((s) => s.done).length}/${plan.steps.length}`, p.text, A_BOLD);
      plan.steps.forEach((s, i) => {
        const now = i === plan.current;
        const mark = s.done ? t.g.stepDone : now ? t.g.stepNow : t.g.stepTodo;
        const c = s.done ? p.success : now ? p.accent : p.faint;
        if (y >= H - 3) return;
        g.text(x, y, mark, this.st(c, bg));
        g.text(x + 2, y++, truncateWidth(s.text.replace(/\s+/g, " "), w - 2, t.g.ellipsis), this.st(now ? p.text : p.muted, bg));
      });
    }
    if (info.tasks) {
      y++;
      line("Tasks", p.text, A_BOLD);
      line(`${info.tasks} running · /tasks`, p.muted);
    }
    const ws = this.hintLeft;
    if (ws) g.text(x, H - 2, middleTruncate(ws, w), this.st(p.faint, bg));
  }

  private lastPlan(): Extract<Block, { kind: "plan" }> | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.kind === "plan") return b;
    }
    return null;
  }

  private drawFooter(g: Grid, x: number, w: number, y: number, info: StatusInfo, home: boolean): void {
    const t = theme;
    const p = t.p;
    const now = Date.now();
    let left: string;
    let leftStyle = this.st(p.muted);
    if (this.notice) {
      left = this.notice.text;
      leftStyle = this.st(p.warning);
    } else if (this.busy || this.spinLabel !== null) {
      let action = this.spinLabel ?? this.action ?? "";
      if (this.actionKind === "stream" && this.spinLabel === null && now - this.lastStream > STALL_MS) action = "Working" + t.g.ellipsis;
      action = action.charAt(0).toUpperCase() + action.slice(1);
      const since = this.busy ? this.turnStart : this.spinStart;
      left =
        `${t.fgCode(p.accent)}${this.spin()}${t.reset} ${t.fgCode(p.text)}${action}${t.reset}` +
        `${t.fgCode(p.faint)} ${t.g.dot} ${t.reset}${t.fgCode(p.muted)}${fmtElapsed(now - since)}${t.reset}` +
        `${t.fgCode(p.faint)} ${t.g.dot} ${t.reset}${t.fgCode(p.muted)}esc ${t.reset}${t.fgCode(p.faint)}${this.busy ? "interrupt" : "cancel"}`;
    } else {
      left = this.hintLeft;
    }
    const keys: string[] = [];
    if (this.queued) keys.push(`${t.fgCode(p.accent)}1 queued`);
    if (info.tasks && home) keys.push(`${t.fgCode(p.success)}${info.tasks} task${info.tasks === 1 ? "" : "s"}`);
    if (!this.stick && !home) keys.push(`${t.fgCode(p.muted)}end ${t.reset}${t.fgCode(p.faint)}latest`);
    keys.push(`${t.fgCode(p.muted)}ctrl+p ${t.reset}${t.fgCode(p.faint)}commands`);
    if (home && this.version && w >= 70) keys.push(`${t.fgCode(p.faint)}v${this.version}`);
    let right = keys.join(`${t.reset}   `);
    let rw = stringWidth(right);
    if (rw > w / 2) {
      right = keys[keys.length - 1];
      rw = stringWidth(right);
    }
    const room = w - rw - 2;
    g.text(x, y, truncateWidth(left, Math.max(0, room), t.g.ellipsis), leftStyle);
    g.text(x + w - rw, y, right, this.st(p.muted));
  }

  // ---- the prompt box ----------------------------------------------------------------

  private promptLayout(w: number, H: number) {
    const inner = Math.max(4, w - 5);
    const lay = layoutBuffer(this.ed.buffer, this.ed.cursor, inner);
    const maxRows = Math.max(1, Math.min(10, Math.floor(H / 3) - 3));
    return { inner, lay, maxRows, rows: Math.min(lay.rows.length, maxRows) };
  }

  private promptHeight(w: number, H: number): number {
    return this.promptLayout(w, H).rows + 4;
  }

  /** The prompt box: a panel with a mode-coloured left border, the text,
   * and mode · model · effort · context on its last row. Returns the cursor. */
  private drawPrompt(g: Grid, r: Rect, info: StatusInfo, focus: boolean): { x: number; y: number } | null {
    const t = theme;
    const p = t.p;
    const bg = p.panel;
    const { inner, lay, rows } = this.promptLayout(r.w, this.size().H);
    const barColor = focus ? modeColor(info.mode) : p.border;
    const bodyH = r.h - 1;
    g.fill(r.x, r.y, r.w, bodyH, this.st(p.text, bg));
    for (let i = 0; i < bodyH; i++) g.set(r.x, r.y + i, t.g.bar, this.st(barColor, bg));
    // Half-cell bottom padding: the panel colour in the top half of the row.
    if (t.opts.color && !t.opts.ascii) {
      g.set(r.x, r.y + bodyH, t.g.barEnd, this.st(barColor));
      for (let i = 1; i < r.w; i++) g.set(r.x + i, r.y + bodyH, t.g.half, this.st(bg));
    }
    const tx = r.x + 3;
    const ty = r.y + 1;
    let cursor: { x: number; y: number } | null = null;
    if (!this.ed.buffer) {
      const ph = this.busy ? "Queue a follow-up…" : this.placeholder;
      g.text(tx, ty, truncateWidth(ph, inner, t.g.ellipsis), this.st(p.faint));
      cursor = { x: tx, y: ty };
    } else {
      let from = 0;
      if (lay.rows.length > rows) from = Math.max(0, Math.min(lay.curRow - Math.floor(rows / 2), lay.rows.length - rows));
      for (let i = 0; i < rows; i++) {
        const line = lay.rows[from + i] ?? "";
        this.drawInputLine(g, tx, ty + i, line, inner);
      }
      cursor = { x: tx + lay.curCol, y: ty + lay.curRow - from };
      if (from > 0) g.text(r.x + r.w - 3, ty, t.g.up, this.st(p.faint, bg));
      if (from + rows < lay.rows.length) g.text(r.x + r.w - 3, ty + rows - 1, t.g.down, this.st(p.faint, bg));
    }
    // mode · model backend · effort            context
    const my = r.y + bodyH - 1;
    const meta = this.metaRow(info, r.w - 5);
    g.text(tx, my, meta.left, this.st(p.muted, bg));
    if (meta.right) g.text(r.x + r.w - 2 - stringWidth(meta.right), my, meta.right, this.st(p.muted, bg));
    return focus ? cursor : null;
  }

  /** The prompt's last row, fitted to `room` cells: the backend goes first,
   * then the context meter, then the model is shortened in the middle. */
  private metaRow(info: StatusInfo, room: number): { left: string; right: string } {
    const t = theme;
    const p = t.p;
    const sep = `${t.fgCode(p.faint)} ${t.g.dot} ${t.reset}`;
    const left = (backend: boolean, model: string) => {
      let s = `${t.fgCode(modeColor(info.mode))}${info.modeLabel || "Edit"}${t.reset}`;
      if (model) s += `${sep}${t.fgCode(p.text)}${model}${t.reset}`;
      if (backend && info.backend) s += ` ${t.fgCode(p.muted)}${info.backend}${t.reset}`;
      if (info.effort) s += `${sep}${t.fgCode(p.warning)}${info.effort}${t.reset}`;
      return s;
    };
    const right = (meter: boolean, tokens: boolean) => {
      if (info.pct === null) return "";
      const c = info.pct >= 85 ? p.error : info.pct >= 60 ? p.warning : p.muted;
      let s = "";
      if (tokens && info.tokens) s += `${t.fgCode(p.muted)}${info.tokens}${t.reset} `;
      if (meter) {
        const mw = 8;
        const on = Math.max(0, Math.min(mw, Math.round((info.pct / 100) * mw)));
        s += `${t.fgCode(info.pct >= 60 ? c : p.accent)}${t.g.meterOn.repeat(on)}${t.reset}${t.fgCode(p.border)}${t.g.meterOff.repeat(mw - on)}${t.reset} `;
      }
      return s + `${t.fgCode(c)}${info.pct}%${t.reset}`;
    };
    const tries: [boolean, boolean, boolean][] = [
      [true, true, true],
      [false, true, true],
      [false, false, true],
      [false, false, false],
    ];
    for (const [backend, meter, tokens] of tries) {
      const l = left(backend, info.model);
      const r = right(meter, tokens);
      if (stringWidth(l) + (r ? stringWidth(r) + 3 : 0) <= room) return { left: l, right: r };
    }
    const r = right(false, false);
    const fixed = stringWidth(left(false, "")) + (info.model ? 3 : 0) + (r ? stringWidth(r) + 3 : 0);
    const model = info.model ? middleTruncate(info.model, Math.max(6, room - fixed), t.g.ellipsis) : "";
    return { left: truncateWidth(left(false, model), room - (r ? stringWidth(r) + 3 : 0), t.g.ellipsis), right: r };
  }

  /** An input line, with @path mentions tinted. */
  private drawInputLine(g: Grid, x: number, y: number, line: string, w: number): void {
    const t = theme;
    const p = t.p;
    const bg = p.panel;
    const parts = line.split(/(@[^\s@]+)/);
    let cx = x;
    for (const part of parts) {
      if (!part) continue;
      const mention = part.startsWith("@") && part.length > 1;
      cx = g.text(cx, y, part, this.st(mention ? p.accent : p.text, bg), x + w);
    }
  }

  // ---- the completion popup -------------------------------------------------------------

  private drawMenu(g: Grid, menu: Menu, prompt: Rect, W: number): void {
    const t = theme;
    const p = t.p;
    const items = menu.items;
    const x = prompt.x;
    const w = Math.min(prompt.w, Math.max(40, W - 4));
    const n = Math.min(MENU_ROWS, Math.max(1, items.length));
    const h = n + 2;
    const y = Math.max(0, prompt.y - h);
    const bg = p.panel;
    const border = this.st(p.borderActive, bg);
    g.fill(x, y, w, h, this.st(p.text, bg));
    g.set(x, y, t.g.tl, border);
    g.set(x + w - 1, y, t.g.tr, border);
    g.set(x, y + h - 1, t.g.bl, border);
    g.set(x + w - 1, y + h - 1, t.g.br, border);
    for (let i = 1; i < w - 1; i++) {
      g.set(x + i, y, t.g.hr, border);
      g.set(x + i, y + h - 1, t.g.hr, border);
    }
    for (let i = 1; i < h - 1; i++) {
      g.set(x, y + i, t.g.vline, border);
      g.set(x + w - 1, y + i, t.g.vline, border);
    }
    const title = menu.kind === "slash" ? "Commands" : menu.kind === "args" ? `/${menu.cmd!.name}` : "Files";
    g.text(x + 2, y, ` ${title} `, this.st(p.text, bg, A_BOLD));
    const hint =
      menu.kind === "files" ? "tab opens a folder · enter inserts" : menu.kind === "slash" ? "enter runs · tab completes" : "enter picks · tab completes";
    if (w > stringWidth(title) + stringWidth(hint) + 16) g.text(x + w - 3 - stringWidth(hint) - 2, y + h - 1, ` ${hint} `, this.st(p.faint, bg));
    if (menu.kind === "args" && menu.loading) {
      g.text(x + 2, y + 1, `Loading ${menu.cmd!.name} options${t.g.ellipsis}`, this.st(p.muted, bg));
      return;
    }
    if (!items.length) {
      g.text(x + 2, y + 1, menu.kind === "args" ? "No matching values · enter sends what you typed" : "No matching commands", this.st(p.muted, bg));
      return;
    }
    if (this.menuIndex < this.menuTop) this.menuTop = this.menuIndex;
    if (this.menuIndex >= this.menuTop + MENU_ROWS) this.menuTop = this.menuIndex - MENU_ROWS + 1;
    this.menuTop = Math.max(0, Math.min(this.menuTop, items.length - MENU_ROWS));
    const labelW = Math.min(24, Math.max(...items.map((i) => stringWidth(i.label))) + 2);
    for (let k = 0; k < n; k++) {
      const i = this.menuTop + k;
      const it = items[i];
      if (!it) break;
      const ry = y + 1 + k;
      const selRow = i === this.menuIndex;
      const rowBg = selRow ? p.accent : bg;
      const fgMain = selRow ? p.onAccent : p.text;
      const fgSub = selRow ? p.onAccent : p.muted;
      if (selRow) g.fill(x + 1, ry, w - 2, 1, this.st(fgMain, rowBg));
      this.hit.menuRows.push({ y: ry, index: i });
      let cx = x + 2;
      if (menu.kind === "args") {
        const mark = it.current ? t.g.current : it.starred ? t.g.star : " ";
        g.text(cx, ry, mark, this.st(selRow ? fgMain : it.current ? p.success : p.warning, rowBg));
        cx += 2;
      }
      const isDir = menu.kind === "files" && it.file?.dir;
      const lw = menu.kind === "files" ? w - 6 : labelW;
      g.text(cx, ry, truncateWidth(it.label, lw, t.g.ellipsis), this.st(selRow ? fgMain : isDir ? p.accent : p.text, rowBg, selRow ? A_BOLD : 0));
      const keyW = it.key ? stringWidth(it.key) + 2 : 0;
      if (it.hint && menu.kind !== "files") {
        const hx = cx + lw + (menu.kind === "args" ? 2 : 0);
        const room = x + w - 2 - keyW - hx;
        if (room > 6) g.text(hx, ry, truncateWidth(it.hint, room, t.g.ellipsis), this.st(fgSub, rowBg));
      }
      if (it.key) g.text(x + w - 2 - stringWidth(it.key), ry, it.key, this.st(selRow ? fgMain : p.faint, rowBg));
      if (selRow) this.invert(g, x + 1, ry, w - 2);
    }
    const above = this.menuTop;
    const below = items.length - this.menuTop - MENU_ROWS;
    if (above > 0 || below > 0) {
      const parts: string[] = [];
      if (above > 0) parts.push(`${t.g.up} ${above}`);
      if (below > 0) parts.push(`${t.g.down} ${below} more`);
      const s = ` ${parts.join("  ")} `;
      g.text(x + w - 2 - stringWidth(s), y, s, this.st(p.muted, bg));
    }
  }

  // ---- dialogs ------------------------------------------------------------------------

  /** How many list rows a select dialog shows on this screen. */
  private listRows(): number {
    const { H } = this.size();
    return Math.max(3, Math.min(LIST_ROWS, H - 14));
  }

  private dialogFrame(g: Grid, W: number, H: number, w: number, h: number): Rect {
    const t = theme;
    const p = t.p;
    const dw = Math.min(w, W - 4);
    const dh = Math.min(h, H - 2);
    const x = Math.floor((W - dw) / 2);
    const y = Math.max(1, Math.min(Math.floor(H / 4), Math.floor((H - dh) / 2)));
    g.fill(x, y, dw, dh, this.st(p.text, p.panel));
    if (!t.opts.color) {
      const b = this.st(DEFAULT);
      for (let i = 0; i < dw; i++) {
        g.set(x + i, y, t.g.hr, b);
        g.set(x + i, y + dh - 1, t.g.hr, b);
      }
      for (let i = 0; i < dh; i++) {
        g.set(x, y + i, t.g.vline, b);
        g.set(x + dw - 1, y + i, t.g.vline, b);
      }
      g.set(x, y, t.g.tl, b);
      g.set(x + dw - 1, y, t.g.tr, b);
      g.set(x, y + dh - 1, t.g.bl, b);
      g.set(x + dw - 1, y + dh - 1, t.g.br, b);
    }
    const r = { x, y, w: dw, h: dh };
    this.hit.dialog = r;
    return r;
  }

  private dialogTitle(g: Grid, r: Rect, title: string, icon?: { ch: string; fg: number }): void {
    const p = theme.p;
    let x = r.x + 3;
    if (icon) {
      g.text(x, r.y + 1, icon.ch, this.st(icon.fg, p.panel, A_BOLD));
      x += 2;
    }
    g.text(x, r.y + 1, truncateWidth(title, r.w - 12, theme.g.ellipsis), this.st(p.text, p.panel, A_BOLD));
    g.text(r.x + r.w - 6, r.y + 1, "esc", this.st(p.faint, p.panel));
  }

  /** Footer of a dialog: actions as "title key" pairs on the right, info on the left. */
  private dialogFooter(g: Grid, r: Rect, y: number, actions: [string, string][], left = ""): void {
    const t = theme;
    const p = t.p;
    const s = actions.map(([a, k]) => `${t.fgCode(p.text)}${a} ${t.reset}${t.fgCode(p.faint)}${k}`).join(`${t.reset}   `);
    const sw = stringWidth(s);
    g.text(r.x + r.w - 3 - sw, y, s, this.st(p.muted, p.panel));
    if (left && stringWidth(left) < r.w - sw - 10) g.text(r.x + 3, y, left, this.st(p.faint, p.panel));
  }

  private drawDialog(g: Grid, W: number, H: number): { x: number; y: number } | null {
    if (this.state === "select" && this.sel) return this.drawSelect(g, W, H);
    if (this.state === "prompt" && this.promptState) return this.drawPromptDialog(g, W, H);
    if (this.state === "confirm" && this.confirmState) return this.drawConfirm(g, W, H);
    return null;
  }

  private drawSelect(g: Grid, W: number, H: number): { x: number; y: number } {
    const t = theme;
    const p = t.p;
    const s = this.sel!;
    const rows = this.selRows();
    // Blank rows before every group header but the first.
    const disp: (SelRow | { gap: true })[] = [];
    for (const r of rows) {
      if ("header" in r && !r.first) disp.push({ gap: true });
      disp.push(r);
    }
    const items = disp.flatMap((r, ri) => ("oi" in r ? [ri] : []));
    s.index = Math.max(0, Math.min(s.index, items.length - 1));
    const longest = Math.max(20, ...s.options.map((o) => stringWidth(o.label) + (o.hint ? stringWidth(o.hint) + 4 : 0) + ((o as DialogOption).key ? stringWidth((o as DialogOption).key!) + 4 : 0)));
    const dw = Math.max(56, Math.min(86, longest + 12));
    const listN = Math.max(1, Math.min(this.listRows(), disp.length || 1, H - 10));
    const r = this.dialogFrame(g, W, H, dw, listN + 9);
    const n = Math.max(1, Math.min(listN, r.h - 9));
    this.dialogTitle(g, r, s.title);
    // search field
    const fy = r.y + 3;
    const fx = r.x + 3;
    const fw = r.w - 6;
    g.fill(fx, fy, fw, 1, this.st(p.text, p.element));
    let cursor: { x: number; y: number };
    if (s.filter) {
      const shown = truncateWidth(s.filter, fw - 3);
      g.text(fx + 1, fy, shown, this.st(p.text, p.element));
      cursor = { x: fx + 1 + stringWidth(shown), y: fy };
    } else {
      g.text(fx + 1, fy, "Search", this.st(p.faint, p.element));
      cursor = { x: fx + 1, y: fy };
    }
    // list
    const ly = r.y + 5;
    if (!items.length) g.text(r.x + 4, ly, s.filter ? "No matches" : "Nothing to choose from", this.st(p.muted, p.panel));
    const selRow = items[s.index] ?? 0;
    let want = selRow;
    if (selRow > 0 && "header" in disp[selRow - 1]) want = selRow - 1;
    if (want > 1 && "gap" in disp[want - 1] && want - 1 >= s.top - 1) want = want - 1;
    if (want < s.top) s.top = want;
    if (selRow >= s.top + n) s.top = selRow - n + 1;
    s.top = Math.max(0, Math.min(s.top, disp.length - n));
    const optsIn = (from: number, to: number) => disp.slice(from, to).filter((x) => "oi" in x).length;
    const starCol = s.opts?.onStar || s.options.some((o) => o.starred);
    for (let k = 0; k < n; k++) {
      const ri = s.top + k;
      const row = disp[ri];
      if (!row) break;
      const y = ly + k;
      if ("gap" in row) continue;
      if ("header" in row) {
        g.text(r.x + 3, y, truncateWidth(row.header, r.w - 6), this.st(p.accent, p.panel, A_BOLD));
        continue;
      }
      const o = s.options[row.oi] as DialogOption;
      const on = ri === selRow;
      const rowBg = on ? p.accent : p.panel;
      const main = on ? p.onAccent : p.text;
      const sub = on ? p.onAccent : p.muted;
      if (on) g.fill(r.x + 1, y, r.w - 2, 1, this.st(main, rowBg));
      this.hit.dialogRows.push({ y, index: items.indexOf(ri) });
      if (o.current) g.text(r.x + 3, y, t.g.current, this.st(on ? main : p.success, rowBg));
      const lx = r.x + 5;
      const keyW = o.key ? stringWidth(o.key) + 2 : 0;
      const starW = starCol ? 3 : 0;
      const right = r.x + r.w - 3 - keyW - starW;
      const label = truncateWidth(o.label, Math.max(4, right - lx), t.g.ellipsis);
      const lw = stringWidth(label);
      g.text(lx, y, label, this.st(o.noop && !on ? p.accent : main, rowBg, on ? A_BOLD : 0));
      if (o.hint && right - lx - lw > 8) g.text(lx + lw + 2, y, truncateWidth(o.hint, right - lx - lw - 2, t.g.ellipsis), this.st(sub, rowBg));
      if (o.key) g.text(r.x + r.w - 3 - stringWidth(o.key) - starW, y, o.key, this.st(on ? main : p.faint, rowBg));
      if (o.starred) g.text(r.x + r.w - 4, y, t.g.star, this.st(on ? main : p.warning, rowBg));
      if (on) this.invert(g, r.x + 1, y, r.w - 2);
    }
    const above = optsIn(0, s.top);
    const below = optsIn(s.top + n, disp.length);
    const info: string[] = [];
    if (above > 0) info.push(`${t.g.up} ${above} more`);
    if (below > 0) info.push(`${t.g.down} ${below} more`);
    const actions: [string, string][] = [];
    if (s.opts?.onStar) actions.push(["Favorite", "ctrl+f"]);
    actions.push(["Select", "enter"]);
    this.dialogFooter(g, r, r.y + r.h - 2, actions, info.join("  "));
    return cursor;
  }

  private drawPromptDialog(g: Grid, W: number, H: number): { x: number; y: number } {
    const t = theme;
    const p = t.p;
    const ps = this.promptState!;
    const r = this.dialogFrame(g, W, H, 64, 8);
    this.dialogTitle(g, r, ps.title);
    const fx = r.x + 3;
    const fy = r.y + 3;
    const fw = r.w - 6;
    g.fill(fx, fy, fw, 1, this.st(p.text, p.element));
    let cursor: { x: number; y: number };
    if (!ps.ed.buffer) {
      g.text(fx + 1, fy, truncateWidth(ps.placeholder, fw - 2, t.g.ellipsis), this.st(p.faint, p.element));
      cursor = { x: fx + 1, y: fy };
    } else {
      const dot = t.opts.ascii ? "*" : "•";
      const shown = ps.secret ? dot.repeat(Array.from(ps.ed.buffer).length) : ps.ed.buffer.replace(/\t/g, " ");
      const before = ps.secret ? dot.repeat(Array.from(ps.ed.buffer.slice(0, ps.ed.cursor)).length) : ps.ed.buffer.slice(0, ps.ed.cursor).replace(/\t/g, " ");
      const inner = fw - 2;
      const curW = stringWidth(before);
      let skip = Math.max(0, curW - inner + 1);
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
      g.text(fx + 1, fy, truncateWidth(view, inner), this.st(p.text, p.element));
      cursor = { x: fx + 1 + curW - seen, y: fy };
    }
    this.dialogFooter(g, r, r.y + r.h - 2, [["Confirm", "enter"]]);
    return cursor;
  }

  private drawConfirm(g: Grid, W: number, H: number): null {
    const t = theme;
    const p = t.p;
    const cs = this.confirmState!;
    const dw = Math.min(76, W - 4);
    const inner = dw - 10;
    const cmdLines = wrapAnsi(cs.command.replace(/\s+/g, " ").trim(), inner).slice(0, 5);
    const reason = cs.reason ? wrapAnsi(cs.reason, dw - 6).slice(0, 3) : [];
    const h = 3 + cmdLines.length + 2 + (reason.length ? reason.length + 1 : 0) + 3 + 3;
    const r = this.dialogFrame(g, W, H, dw, h);
    this.dialogTitle(g, r, "Allow this command?", { ch: t.g.warn, fg: p.warning });
    let y = r.y + 3;
    const px = r.x + 3;
    const pw = r.w - 6;
    g.fill(px, y, pw, cmdLines.length + 2, this.st(p.text, p.element));
    y++;
    cmdLines.forEach((l, i) => {
      if (i === 0) g.text(px + 2, y, "$", this.st(p.muted, p.element));
      g.text(px + 4, y++, l, this.st(p.text, p.element, A_BOLD));
    });
    y += 2;
    for (const l of reason) g.text(r.x + 3, y++, l, this.st(p.muted, p.panel, A_ITALIC));
    if (reason.length) y++;
    const program = cs.command.trim().split(/\s+/)[0] ?? "";
    const opts: [string, string][] = [
      ["Allow once", "y"],
      [`Always allow ${program} this session`, "a"],
      ["Deny", "n"],
    ];
    opts.forEach(([label, key], i) => {
      const on = i === cs.index;
      const rowBg = on ? (i === 2 ? p.error : p.accent) : p.panel;
      const main = on ? p.onAccent : i === 2 ? p.text : p.text;
      if (on) g.fill(r.x + 1, y, r.w - 2, 1, this.st(main, rowBg));
      this.hit.dialogRows.push({ y, index: i });
      g.text(r.x + 5, y, truncateWidth(label, r.w - 12, t.g.ellipsis), this.st(main, rowBg, on ? A_BOLD : 0));
      g.text(r.x + r.w - 4, y, key, this.st(on ? main : p.faint, rowBg));
      if (on) this.invert(g, r.x + 1, y, r.w - 2);
      y++;
    });
    return null;
  }

  // ---- toasts -------------------------------------------------------------------------

  private drawToasts(g: Grid, W: number, H: number): void {
    const t = theme;
    const p = t.p;
    let y = 1;
    for (const ts of this.toasts) {
      const tw = Math.min(52, W - 6);
      const color = ts.level === "error" ? p.error : ts.level === "warn" ? p.warning : ts.level === "success" ? p.success : p.accent;
      const icon = ts.level === "error" ? t.g.fail : ts.level === "warn" ? t.g.warn : ts.level === "success" ? t.g.ok : t.g.info;
      const lines = ts.text.split("\n").flatMap((l) => wrapAnsi(l, tw - 7)).slice(0, 4);
      const h = lines.length + 2;
      if (y + h >= H - 1) break;
      const x = W - tw - 2;
      g.fill(x, y, tw, h, this.st(p.text, p.element));
      for (let i = 0; i < h; i++) g.set(x, y + i, t.g.bar, this.st(color, p.element));
      g.text(x + 3, y + 1, icon, this.st(color, p.element, A_BOLD));
      lines.forEach((l, i) => g.text(x + 5, y + 1 + i, l, this.st(p.text, p.element)));
      y += h + 1;
    }
  }

  // ---- AgentUI (output while the agent runs) --------------------------------------------

  private stream(): void {
    this.spinLabel = null; // streaming started: the wait is over
    this.actionKind = "stream";
    this.lastStream = Date.now();
  }

  token(text: string): void {
    if (!text) return;
    let b = this.last();
    if (b?.kind === "reasoning" && b.end === undefined) {
      b.end = Date.now();
      this.touch(b);
    }
    b = this.last();
    if (!(b?.kind === "assistant" && !b.done)) b = this.add<AssistantBlock>({ kind: "assistant", text: "", done: false, id: 0, ver: 0 });
    (b as AssistantBlock).text += text;
    this.touch(b);
    this.stream();
    this.action = "Responding";
    this.schedule();
  }

  /** Reasoning streams into a collapsed "Thinking…" row with the latest
   * words (or in full, muted, after ctrl+o) and settles to "Thought for Ns". */
  thinking(text: string): void {
    if (!text) return;
    let b = this.last();
    if (!(b?.kind === "reasoning" && b.end === undefined)) {
      this.finishStreams();
      b = this.add<ReasoningBlock>({ kind: "reasoning", text: "", start: Date.now(), id: 0, ver: 0 });
    }
    const r = b as ReasoningBlock;
    r.text += text;
    if (r.text.length > 200_000) r.text = r.text.slice(-100_000);
    this.touch(r);
    this.stream();
    this.action = "Thinking";
    this.schedule();
  }

  toolArgsProgress(name: string, chars: number): void {
    this.stream();
    this.action = `${progressVerb(name)} ${theme.g.dot} ${fmtChars(chars)}`;
    this.schedule();
  }

  toolCall(name: string, args: Record<string, any>): void {
    this.finishStreams();
    this.spinLabel = null;
    this.add<ToolBlock>({ kind: "tool", name, args: args ?? {}, start: Date.now(), id: 0, ver: 0 });
    this.actionKind = "tool";
    this.action = describeTool(name, args);
    this.render();
  }

  toolResult(result: string, outcome?: ToolOutcome): void {
    this.finishStreams();
    let b = this.runningTool();
    if (!b) {
      // A result with no call on screen (a replayed transcript).
      b = this.add<ToolBlock>({ kind: "tool", name: "result", args: {}, start: Date.now(), id: 0, ver: 0 });
    }
    b.end = Date.now();
    b.ok = outcome ? outcome.ok : !result.startsWith("Error");
    b.durationMs = outcome ? outcome.durationMs : b.end - b.start;
    b.result = result;
    if (outcome?.diff) {
      b.diff = outcome.diff;
      if (b.name === "edit_file") b.firstLine = this.locate(outcome.diff.path, outcome.diff.after);
    }
    this.touch(b);
    this.action = "Thinking";
    this.actionKind = "wait";
    this.render();
  }

  /** Line number where an edit's new text starts, for the diff gutter. */
  private locate(p: string, after: string): number | undefined {
    if (!after) return undefined;
    try {
      const abs = path.resolve(this.fileRoot(), p);
      const st = fs.statSync(abs);
      if (st.size > 2_000_000) return undefined;
      const text = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
      const want = after.replace(/\r\n/g, "\n");
      const at = text.indexOf(want);
      if (at < 0 || text.indexOf(want, at + 1) >= 0) return undefined;
      return text.slice(0, at).split("\n").length;
    } catch {
      return undefined;
    }
  }

  resetResponse(): void {
    // The interrupted attempt is retried: drop what it streamed.
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if ((b.kind === "assistant" && !b.done) || (b.kind === "reasoning" && b.end === undefined)) this.blocks.splice(i, 1);
      else break;
    }
    this.schedule();
  }

  println(s = ""): void {
    this.finishStreams();
    const plain = stripAnsi(s);
    if (!plain.trim()) return this.schedule();
    // A replayed user message ("› text" from a resumed session).
    const m = /^› ([\s\S]*)$/.exec(plain);
    if (m && !this.busy) {
      if (!this.sessionTitle) this.sessionTitle = m[1].replace(/\s+/g, " ").slice(0, 200);
      this.add({ kind: "user", text: m[1], mode: this.statusInfo().mode, id: 0, ver: 0 });
      return this.schedule();
    }
    // One line between turns (a model switch, /plan, /tasks): a toast.
    if (!this.busy && !plain.trim().includes("\n") && plain.length < 160) {
      this.toast(plain.trim(), "info");
      return this.render();
    }
    this.add({ kind: "text", text: s, id: 0, ver: 0 });
    this.render();
  }

  status(s: string): void {
    const plain = stripAnsi(s).trim();
    // /clear: back to an empty session.
    if (plain === "· conversation cleared") {
      this.blocks = [];
      this.sessionTitle = "";
      this.toBottom();
      this.toast("New conversation", "info");
      return this.render();
    }
    if (this.busy) {
      this.add({ kind: "note", level: "status", text: s, id: 0, ver: 0 });
      return this.schedule();
    }
    this.toast(s, "info");
    this.render();
  }

  private statusInfo(): StatusInfo {
    let s = "";
    try {
      s = this.getStatus();
    } catch {
      s = "";
    }
    return parseStatus(s);
  }

  turnEnd(label: string): void {
    this.finishStreams();
    this.spinLabel = null;
    this.busy = false;
    const info = this.statusInfo();
    this.add({ kind: "turn", label, mode: info.mode, modeLabel: info.modeLabel, model: info.model, id: 0, ver: 0 });
    this.render();
  }

  planUpdated(plan: Plan): void {
    this.finishStreams();
    // A plan change arrives instead of a tool result: the plan block replaces its row.
    const row = this.runningTool();
    if (row && row.name === "plan") this.blocks.splice(this.blocks.indexOf(row), 1);
    // One plan per turn, at its latest position.
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.kind === "user") break;
      if (b.kind === "plan") {
        this.blocks.splice(i, 1);
        break;
      }
    }
    this.add({ kind: "plan", steps: plan.steps.map((s) => ({ ...s })), current: plan.currentIndex, id: 0, ver: 0 });
    this.render();
  }

  warn(s: string): void {
    this.finishStreams();
    this.add({ kind: "note", level: "warn", text: s, id: 0, ver: 0 });
    this.render();
  }

  error(s: string): void {
    this.finishStreams();
    this.add({ kind: "note", level: "error", text: s.replace(/^\n+/, ""), id: 0, ver: 0 });
    this.render();
  }

  /** The spinner sits in the footer; its label is the action. */
  startSpinner(label: string): void {
    if (this.closed) return;
    this.spinLabel = label;
    this.spinStart = Date.now();
    this.startTick();
    this.schedule();
  }

  stopSpinner(): void {
    if (this.spinLabel === null) return;
    this.spinLabel = null;
    this.schedule();
  }
}

function inside(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}
