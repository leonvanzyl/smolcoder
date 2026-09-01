// The inline TUI, styled after opencode: an accent-bar input block with the
// session status (mode · model · effort · ctx) inside it, a slash-command menu
// that opens above the input as you type "/", arrow-key pickers with
// type-to-filter, and shift+tab mode cycling. Hand-rolled ANSI, zero deps.
//
// The frame (input block + menus) exists only while waiting for input; while
// the agent runs, output streams plainly and scrolls naturally.

import { Plan } from "../plan";
import { renderPlan, SelectOption, SessionUI, SlashCommand, summarizeArgs } from "../ui";
import { c } from "../util";
import { LineEditor, layoutBuffer } from "./editor";
import { Key, KeyDecoder } from "./keys";

type State = "hidden" | "idle" | "select" | "confirm";

const ACCENT = "\x1b[36m"; // cyan accent bar
const RESET = "\x1b[0m";
const SEL = "\x1b[48;5;31m\x1b[38;5;231m"; // cyan selection bar, white text — one blue theme
const BAR = `${ACCENT}▌${RESET} `;
const BOX_BG = "\x1b[48;5;235m"; // subtle shading for the input block

function visLen(s: string): string["length"] {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Cut a colored string to a visible length without splitting escape codes. */
function truncateVisible(s: string, max: number): string {
  let out = "";
  let seen = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (seen >= max) continue;
    out += s[i];
    seen++;
  }
  return out;
}

/** One shaded row of the input block: accent bar + content padded to width,
 * with the block background re-applied after any color reset inside. */
function boxRow(content: string, w: number): string {
  const inner = Math.max(1, w - 2);
  if (visLen(content) > inner) content = truncateVisible(content, inner);
  const pad = Math.max(0, inner - visLen(content));
  const body = (content + " ".repeat(pad)).split(RESET).join(RESET + BOX_BG);
  return `${BOX_BG}${ACCENT}▌\x1b[39m ${body}${RESET}`;
}

export class Tui implements SessionUI {
  slashCommands: SlashCommand[] = [];
  getStatus: () => string = () => "";
  onModeCycle: (() => void) | null = null;
  onCancel: (() => void) | null = null;
  onExit: (() => void) | null = null;
  placeholder = 'Ask anything… "add a dark mode toggle"';
  /** Shown dim on the left of the hint row (the workspace path). */
  hintLeft = "";

  private ed = new LineEditor();
  private decoder = new KeyDecoder();
  private state: State = "hidden";
  private prevLines = 0;
  private offsetFromBottom = 0;
  private history: string[] = [];
  private histIdx = -1;
  private histStash = "";
  private menuIndex = 0;
  private lastMenuFilter: string | null = null;
  private notice: string | null = null;
  private lastCtrlC = 0;
  private submitResolve: ((s: string) => void) | null = null;
  private sel: {
    title: string;
    options: SelectOption[];
    filter: string;
    index: number;
    resolve: (i: number | null) => void;
  } | null = null;
  private confirmState: { command: string; resolve: (r: "yes" | "no" | "always") => void } | null =
    null;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerActive = false;
  private atLineStart = true;
  private lastKind: "content" | "thinking" | null = null;

  start(): void {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d: string) => this.onData(d));
    process.stdout.on("resize", () => {
      if (this.state !== "hidden") this.redraw();
    });
    process.stdout.write("\x1b[?2004h"); // bracketed paste on
  }

  close(): void {
    this.stopSpinner();
    this.hideFrame();
    process.stdout.write("\x1b[?2004l\x1b[?25h");
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }

  // ---- input ---------------------------------------------------------------

  readInput(): Promise<string> {
    this.ed.clear();
    this.histIdx = -1;
    this.menuIndex = 0;
    this.state = "idle";
    this.redraw();
    return new Promise((res) => (this.submitResolve = res));
  }

  select(title: string, options: SelectOption[]): Promise<number | null> {
    this.stopSpinner();
    this.hideFrame();
    process.stdout.write("\x1b[?25l");
    this.state = "select";
    return new Promise((resolve) => {
      this.sel = { title, options, filter: "", index: 0, resolve };
      this.redraw();
    });
  }

  confirmCommand(command: string): Promise<"yes" | "no" | "always"> {
    this.stopSpinner();
    this.hideFrame();
    this.state = "confirm";
    return new Promise((resolve) => {
      this.confirmState = { command, resolve };
      this.redraw();
    });
  }

  // ---- key routing ---------------------------------------------------------

  private onData(data: string): void {
    for (const key of this.decoder.decode(data)) {
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
        case "hidden": // agent running
          if (key.type === "esc" || key.type === "ctrlc") this.onCancel?.();
          break;
      }
    }
  }

  private keyIdle(key: Key): void {
    this.notice = null;
    const menu = this.menuEntries();
    switch (key.type) {
      case "char":
      case "text":
        this.ed.insert(key.text!);
        break;
      case "enter":
        this.submit(menu);
        return;
      case "tab":
        if (menu.length > 0) {
          this.ed.set("/" + menu[Math.min(this.menuIndex, menu.length - 1)].name + " ");
        }
        break;
      case "shifttab":
        this.onModeCycle?.();
        break;
      case "backspace":
        this.ed.backspace();
        break;
      case "delete":
        this.ed.del();
        break;
      case "left":
        this.ed.left();
        break;
      case "right":
        this.ed.right();
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
      case "ctrlw":
        this.ed.deleteWordBack();
        break;
      case "up":
        if (menu.length > 0) {
          this.menuIndex = (this.menuIndex - 1 + menu.length) % menu.length;
        } else if (!this.ed.upLine()) {
          this.historyPrev();
        }
        break;
      case "down":
        if (menu.length > 0) {
          this.menuIndex = (this.menuIndex + 1) % menu.length;
        } else if (!this.ed.downLine()) {
          this.historyNext();
        }
        break;
      case "esc":
        this.ed.clear();
        break;
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
    }
    this.redraw();
  }

  private submit(menu: SlashCommand[]): void {
    let text = this.ed.buffer;
    if (menu.length > 0) {
      text = "/" + menu[Math.min(this.menuIndex, menu.length - 1)].name;
    }
    text = text.trim();
    if (!text) return;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    this.hideFrame();
    this.state = "hidden";
    // Echo the user's message as an accent-barred block, opencode-style.
    const block = text
      .split("\n")
      .map((l) => `${ACCENT}▌${RESET} ${c.bold(l)}`)
      .join("\n");
    process.stdout.write(`\n${block}\n\n`);
    this.atLineStart = true;
    this.lastKind = null;
    const resolve = this.submitResolve;
    this.submitResolve = null;
    resolve?.(text);
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.histIdx === -1) {
      this.histStash = this.ed.buffer;
      this.histIdx = this.history.length - 1;
    } else if (this.histIdx > 0) {
      this.histIdx--;
    } else return;
    this.ed.set(this.history[this.histIdx]);
  }

  private historyNext(): void {
    if (this.histIdx === -1) return;
    if (this.histIdx < this.history.length - 1) {
      this.histIdx++;
      this.ed.set(this.history[this.histIdx]);
    } else {
      this.histIdx = -1;
      this.ed.set(this.histStash);
    }
  }

  private keySelect(key: Key): void {
    const s = this.sel!;
    const filtered = this.filteredOptions();
    switch (key.type) {
      case "up":
        s.index = filtered.length ? (s.index - 1 + filtered.length) % filtered.length : 0;
        break;
      case "down":
      case "tab":
        s.index = filtered.length ? (s.index + 1) % filtered.length : 0;
        break;
      case "char":
      case "text":
        s.filter += key.text!;
        s.index = 0;
        break;
      case "backspace":
        s.filter = s.filter.slice(0, -1);
        s.index = 0;
        break;
      case "enter": {
        if (!filtered.length) break;
        const original = s.options.indexOf(filtered[Math.min(s.index, filtered.length - 1)]);
        this.endSelect(original);
        return;
      }
      case "esc":
      case "ctrlc":
        this.endSelect(null);
        return;
      default:
        break;
    }
    this.redraw();
  }

  private endSelect(result: number | null): void {
    const s = this.sel!;
    this.hideFrame();
    process.stdout.write("\x1b[?25h");
    this.sel = null;
    this.state = "hidden";
    s.resolve(result);
  }

  private filteredOptions(): SelectOption[] {
    const s = this.sel!;
    if (!s.filter) return s.options;
    const f = s.filter.toLowerCase();
    return s.options.filter((o) => o.label.toLowerCase().includes(f));
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
    this.hideFrame();
    this.confirmState = null;
    this.state = "hidden";
    process.stdout.write(
      c.dim(`  ${result === "always" ? "always allowed" : result} — ${cs.command}\n`)
    );
    cs.resolve(result);
  }

  // ---- rendering -----------------------------------------------------------

  private menuEntries(): SlashCommand[] {
    const b = this.ed.buffer;
    if (!b.startsWith("/") || b.includes(" ") || b.includes("\n")) return [];
    const filter = b.slice(1).toLowerCase();
    const list = this.slashCommands.filter((cmd) => cmd.name.startsWith(filter)).slice(0, 8);
    if (filter !== this.lastMenuFilter) {
      this.menuIndex = 0;
      this.lastMenuFilter = filter;
    }
    if (this.menuIndex >= list.length) this.menuIndex = 0;
    return list;
  }

  private width(): number {
    return Math.max(30, (process.stdout.columns || 80) - 1);
  }

  private redraw(): void {
    const lines: string[] = [];
    let cursorRow = -1;
    let cursorCol = 0;

    if (this.state === "idle") {
      const w = this.width();
      const menu = this.menuEntries();
      const menuW = Math.min(w, 64);
      for (let i = 0; i < menu.length; i++) {
        const row = ` /${menu[i].name.padEnd(12)} ${menu[i].desc}`.slice(0, menuW).padEnd(menuW);
        lines.push(
          i === this.menuIndex
            ? `${SEL}${row}${RESET}`
            : ` ${c.bold("/" + menu[i].name.padEnd(12))} ${c.dim(menu[i].desc)}`
        );
      }
      const inputW = w - 2;
      lines.push(boxRow("", w)); // top padding
      if (this.ed.buffer.length === 0) {
        cursorRow = lines.length;
        cursorCol = 2;
        lines.push(boxRow(c.dim(this.placeholder.slice(0, inputW)), w));
      } else {
        const lay = layoutBuffer(this.ed.buffer, this.ed.cursor, inputW);
        cursorRow = lines.length + lay.curRow;
        cursorCol = 2 + lay.curCol;
        for (const row of lay.rows) lines.push(boxRow(row, w));
      }
      lines.push(boxRow("", w)); // spacer
      lines.push(boxRow(this.getStatus(), w));
      lines.push(boxRow("", w)); // bottom padding
      if (this.notice) {
        lines.push(" " + c.yellow(this.notice));
      } else {
        const keys = "/ commands · shift+tab mode";
        const left = this.hintLeft
          ? this.hintLeft.length + keys.length + 5 > w
            ? "…" + this.hintLeft.slice(-(w - keys.length - 6))
            : this.hintLeft
          : "";
        lines.push(c.dim(` ${left}${left ? "   " : ""}${keys}`));
      }
    } else if (this.state === "select" && this.sel) {
      const s = this.sel;
      const w = Math.min(this.width(), 64);
      lines.push(BAR + c.bold(s.title) + "   " + c.dim("esc cancel"));
      lines.push(BAR + (s.filter ? s.filter : c.dim("type to filter")));
      const filtered = this.filteredOptions();
      if (!filtered.length) lines.push(c.dim("   no matches"));
      for (let i = 0; i < Math.min(filtered.length, 10); i++) {
        const o = filtered[i];
        const marker = o.current ? "● " : "  ";
        const plain = ` ${marker}${o.label}${o.hint ? "  " + o.hint : ""}`.slice(0, w).padEnd(w);
        lines.push(
          i === s.index
            ? `${SEL}${plain}${RESET}`
            : ` ${o.current ? c.green(marker) : marker}${o.label}${o.hint ? "  " + c.dim(o.hint) : ""}`
        );
      }
      if (filtered.length > 10) lines.push(c.dim(`   … ${filtered.length - 10} more (type to filter)`));
    } else if (this.state === "confirm" && this.confirmState) {
      lines.push(BAR + c.yellow("run? ") + c.bold(this.confirmState.command.slice(0, this.width() - 8)));
      const program = this.confirmState.command.trim().split(/\s+/)[0];
      lines.push(
        "  " + c.dim(`[y]es · [n]o · [a]lways allow '${program}' this session`)
      );
    } else {
      return;
    }

    this.writeFrame(lines, cursorRow, cursorCol);
  }

  private writeFrame(lines: string[], cursorRow: number, cursorCol: number): void {
    let seq = "";
    if (this.prevLines > 0) {
      if (this.offsetFromBottom > 0) seq += `\x1b[${this.offsetFromBottom}B`;
      seq += "\r";
      if (this.prevLines > 1) seq += `\x1b[${this.prevLines - 1}A`;
      seq += "\x1b[J";
    }
    seq += lines.join("\n");
    // park the cursor
    if (cursorRow >= 0 && cursorRow < lines.length) {
      const up = lines.length - 1 - cursorRow;
      if (up > 0) seq += `\x1b[${up}A`;
      seq += "\r";
      if (cursorCol > 0) seq += `\x1b[${cursorCol}C`;
      this.offsetFromBottom = up;
    } else {
      this.offsetFromBottom = 0;
    }
    process.stdout.write(seq);
    this.prevLines = lines.length;
  }

  private hideFrame(): void {
    if (this.prevLines === 0) return;
    let seq = "";
    if (this.offsetFromBottom > 0) seq += `\x1b[${this.offsetFromBottom}B`;
    seq += "\r";
    if (this.prevLines > 1) seq += `\x1b[${this.prevLines - 1}A`;
    seq += "\x1b[J";
    process.stdout.write(seq);
    this.prevLines = 0;
    this.offsetFromBottom = 0;
  }

  /** Redraw the frame if one is on screen (status bar refresh, etc.). */
  refresh(): void {
    if (this.state !== "hidden") this.redraw();
  }

  // ---- AgentUI (output while the agent runs) -------------------------------

  private out(s: string): void {
    if (this.tickerOn) this.endTicker();
    if (this.state !== "hidden") {
      this.hideFrame();
      process.stdout.write(s);
      this.redraw();
    } else {
      process.stdout.write(s);
    }
  }

  private thinkBuf = "";
  private thinkStart = 0;
  private tickerOn = false;

  private ensureLine(): void {
    if (this.tickerOn) {
      this.endTicker();
      return;
    }
    if (!this.atLineStart) {
      this.out("\n");
      this.atLineStart = true;
    }
  }

  token(text: string): void {
    this.stopSpinner();
    this.lastKind = "content";
    this.out(text);
    this.atLineStart = text.endsWith("\n");
  }

  /** Reasoning streams as ONE grey line, cropped to the latest tail and
   * overwritten in place — a live pulse, not a wall of text. It collapses to
   * "✦ thought for Ns" the moment real output starts. */
  thinking(text: string): void {
    this.stopSpinner();
    if (this.state !== "hidden") return;
    if (!this.tickerOn) {
      if (!this.atLineStart) this.out("\n");
      this.tickerOn = true;
      this.thinkStart = Date.now();
      this.thinkBuf = "";
    }
    this.thinkBuf += text;
    if (this.thinkBuf.length > 4000) this.thinkBuf = this.thinkBuf.slice(-2000);
    const w = Math.max(20, (process.stdout.columns || 80) - 4);
    const clean = this.thinkBuf.replace(/\s+/g, " ").trim();
    const tail = clean.length > w ? "…" + clean.slice(-(w - 1)) : clean;
    process.stdout.write("\r\x1b[2K" + c.gray("✦ " + tail));
    this.atLineStart = false;
  }

  private endTicker(): void {
    if (!this.tickerOn) return;
    this.tickerOn = false;
    const secs = ((Date.now() - this.thinkStart) / 1000).toFixed(1);
    process.stdout.write("\r\x1b[2K" + c.gray(`✦ thought for ${secs}s`) + "\n");
    this.thinkBuf = "";
    this.atLineStart = true;
  }

  toolCall(name: string, args: Record<string, any>): void {
    this.stopSpinner();
    this.ensureLine();
    this.lastKind = null;
    this.out(`${c.cyan("→")} ${c.bold(name)} ${c.dim(summarizeArgs(name, args))}\n`);
  }

  toolResult(result: string): void {
    this.ensureLine();
    const firstLine = result.split("\n")[0] ?? "";
    const isError = firstLine.startsWith("Error");
    const lineCount = result.split("\n").length;
    const label = isError
      ? c.red(firstLine.slice(0, 120))
      : c.dim(firstLine.slice(0, 100) + (lineCount > 1 ? ` (+${lineCount - 1} lines)` : ""));
    this.out(`  ${isError ? c.red("✗") : c.green("✓")} ${label}\n`);
  }

  println(s = ""): void {
    this.stopSpinner();
    this.ensureLine();
    this.lastKind = null;
    this.out(s + "\n");
    this.atLineStart = true;
  }

  status(s: string): void {
    this.println(c.gray(s));
  }

  turnEnd(label: string): void {
    this.ensureLine();
    this.lastKind = null;
    this.out(`${c.dim("■ " + label)}\n\n`);
    this.atLineStart = true;
  }

  planUpdated(plan: Plan): void {
    this.stopSpinner();
    this.ensureLine();
    this.lastKind = null;
    this.out(renderPlan(plan) + "\n");
    this.atLineStart = true;
  }

  warn(s: string): void {
    this.println(c.yellow(s));
  }

  error(s: string): void {
    this.println(c.red(s));
  }

  startSpinner(label: string): void {
    if (!process.stdout.isTTY || this.state !== "hidden") return;
    this.stopSpinner();
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    const started = Date.now();
    this.spinnerActive = true;
    this.spinnerTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      process.stdout.write(
        `\r${c.cyan(frames[i++ % frames.length])} ${c.dim(label + (secs > 2 ? ` ${secs}s` : "") + " · esc to cancel")}   `
      );
    }, 100);
  }

  stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.spinnerActive) {
      process.stdout.write("\r" + " ".repeat(70) + "\r");
      this.spinnerActive = false;
    }
  }
}
