// The transcript as blocks — a user message, a reply, reasoning, a tool call,
// the plan, a turn footer, a notice — and how each one lays out into rows
// for a given width. Finished blocks cache their rows; the TUI only draws the
// rows that are on screen.

import { PlanStep } from "../plan";
import { summarizeArgs } from "../ui";
import { renderDiffRows } from "./diff";
import { MarkdownStream } from "./markdown";
import { Row, span } from "./rows";
import { A_BOLD, A_ITALIC } from "./screen";
import { theme } from "./theme";
import { expandTabs, stringWidth, stripAnsi, truncateWidth, wrapAnsi } from "./width";

/** Columns between the transcript's left edge and the text of replies, tools and footers. */
export const INDENT = 3;

export type ModeKey = "ro" | "edit" | "bypass" | "";

interface Cached {
  key: string;
  rows: Row[];
}

interface BaseBlock {
  id: number;
  /** Bumped on every change; part of the cache key. */
  ver: number;
  cache?: Cached;
}

export interface UserBlock extends BaseBlock {
  kind: "user";
  text: string;
  mode: ModeKey;
}

export interface AssistantBlock extends BaseBlock {
  kind: "assistant";
  text: string;
  done: boolean;
  md?: MarkdownStream;
  mdKey?: string;
  fed?: number;
  rows?: Row[];
  ended?: boolean;
}

export interface ReasoningBlock extends BaseBlock {
  kind: "reasoning";
  text: string;
  start: number;
  end?: number;
}

export interface ToolBlock extends BaseBlock {
  kind: "tool";
  name: string;
  args: Record<string, any>;
  start: number;
  end?: number;
  ok?: boolean;
  durationMs?: number;
  result?: string;
  diff?: { path: string; before: string; after: string };
  firstLine?: number;
}

export interface PlanBlock extends BaseBlock {
  kind: "plan";
  steps: PlanStep[];
  current: number;
}

export interface TurnBlock extends BaseBlock {
  kind: "turn";
  label: string;
  mode: ModeKey;
  modeLabel: string;
  model: string;
}

export interface NoteBlock extends BaseBlock {
  kind: "note";
  level: "status" | "warn" | "error";
  text: string;
}

export interface TextBlock extends BaseBlock {
  kind: "text";
  text: string;
}

export type Block = UserBlock | AssistantBlock | ReasoningBlock | ToolBlock | PlanBlock | TurnBlock | NoteBlock | TextBlock;

export interface LayoutCtx {
  /** ctrl+o: full reasoning, longer diffs and output. */
  detail: boolean;
  now: number;
  /** The spinner glyph of this frame. */
  spin: string;
  /** Changes whenever colours do (light/dark), so cached rows are redrawn. */
  themeVer: number;
}

const fg = (c: number) => ({ fg: theme.cell(c) });

export function modeColor(mode: ModeKey): number {
  const p = theme.p;
  return mode === "ro" ? p.secondary : mode === "bypass" ? p.error : p.accent;
}

export function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Whether a block's rows can be cached: it will not change on its own. */
function settled(b: Block): boolean {
  if (b.kind === "tool") return b.end !== undefined;
  if (b.kind === "reasoning") return b.end !== undefined;
  if (b.kind === "assistant") return b.done;
  return true;
}

/** The rows of a block for content width w. */
export function layoutBlock(b: Block, w: number, ctx: LayoutCtx): Row[] {
  if (b.kind === "assistant") return layoutAssistant(b, w, ctx);
  const key = `${w}|${ctx.detail ? 1 : 0}|${ctx.themeVer}|${b.ver}`;
  if (b.cache && b.cache.key === key) return b.cache.rows;
  const rows = layoutOther(b, w, ctx);
  if (settled(b)) b.cache = { key, rows };
  return rows;
}

function shift(rows: Row[], dx: number): Row[] {
  return rows.map((r) => r.map((s) => ({ ...s, x: s.x + dx })));
}

function layoutAssistant(b: AssistantBlock, w: number, ctx: LayoutCtx): Row[] {
  const mw = Math.max(10, w - INDENT);
  const key = `${mw}|${ctx.themeVer}`;
  if (b.mdKey !== key || !b.md) {
    b.md = new MarkdownStream(() => mw);
    b.mdKey = key;
    b.fed = 0;
    b.rows = [];
    b.ended = false;
  }
  if ((b.fed ?? 0) < b.text.length) {
    b.rows!.push(...shift(b.md.push(b.text.slice(b.fed ?? 0)), INDENT));
    b.fed = b.text.length;
  }
  if (b.done) {
    if (!b.ended) {
      b.rows!.push(...shift(b.md.end(), INDENT));
      b.ended = true;
      while (b.rows!.length && b.rows![b.rows!.length - 1].length === 0) b.rows!.pop();
    }
    return b.rows!;
  }
  const tail = shift(b.md.tail(), INDENT);
  const rows = [...b.rows!, ...tail];
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

function layoutOther(b: Block, w: number, ctx: LayoutCtx): Row[] {
  switch (b.kind) {
    case "user":
      return layoutUser(b, w);
    case "reasoning":
      return layoutReasoning(b, w, ctx);
    case "tool":
      return layoutTool(b, w, ctx);
    case "plan":
      return layoutPlan(b, w);
    case "turn":
      return layoutTurn(b, w);
    case "note":
      return layoutNote(b, w);
    case "text":
      return layoutText(b, w);
    default:
      return [];
  }
}

function layoutUser(b: UserBlock, w: number): Row[] {
  const p = theme.p;
  const bg = theme.cell(p.panel);
  const bar = { x: 0, text: theme.g.bar, style: { bg, fg: theme.cell(modeColor(b.mode)) } };
  const fillRow = (): Row => [{ x: 0, fill: w, style: { bg } }, bar];
  const rows: Row[] = [fillRow()];
  const lines = b.text.replace(/\r\n/g, "\n").split("\n");
  const shown = lines.length > 40 ? [...lines.slice(0, 38), `${theme.g.ellipsis} ${lines.length - 38} more lines`] : lines;
  for (const line of shown) {
    for (const r of wrapAnsi(expandTabs(line), Math.max(4, w - 5))) {
      rows.push([...fillRow(), { x: 3, text: r, style: { bg, fg: theme.cell(p.text) } }]);
    }
  }
  rows.push(fillRow());
  return rows;
}

function layoutReasoning(b: ReasoningBlock, w: number, ctx: LayoutCtx): Row[] {
  const t = theme;
  const p = t.p;
  const done = b.end !== undefined;
  const secs = ((done ? b.end! : ctx.now) - b.start) / 1000;
  const iw = w - INDENT;
  const rows: Row[] = [];
  const clean = b.text.replace(/\s+/g, " ").trim();
  if (!done) {
    const head = `Thinking${t.g.ellipsis}`;
    const room = iw - 2 - stringWidth(head) - 2;
    let tail = "";
    if (!ctx.detail && clean && room > 8) {
      tail = stringWidth(clean) > room ? t.g.ellipsis + Array.from(clean).slice(-(room - 1)).join("") : clean;
    }
    rows.push([
      span(INDENT, ctx.spin, fg(p.warning)),
      span(INDENT + 2, head, fg(p.warning)),
      ...(tail ? [span(INDENT + 2 + stringWidth(head) + 1, tail, { ...fg(p.faint), attrs: A_ITALIC })] : []),
    ]);
  } else {
    rows.push([
      span(INDENT, t.g.think, fg(p.warning)),
      span(INDENT + 2, `Thought for ${secs.toFixed(1)}s`, fg(p.muted)),
      ...(ctx.detail || !clean ? [] : [span(INDENT + 2 + stringWidth(`Thought for ${secs.toFixed(1)}s`) + 2, "ctrl+o to show", fg(p.faint))]),
    ]);
  }
  if (ctx.detail && b.text.trim()) {
    const lines = b.text.trim().split("\n");
    let blank = false;
    for (const line of lines) {
      if (!line.trim()) {
        if (!blank) rows.push([span(INDENT, t.g.vline, fg(p.border))]);
        blank = true;
        continue;
      }
      blank = false;
      for (const r of wrapAnsi(expandTabs(line), Math.max(4, iw - 3)))
        rows.push([span(INDENT, t.g.vline, fg(p.border)), span(INDENT + 2, r, { ...fg(p.muted), attrs: A_ITALIC })]);
    }
  }
  return rows;
}

/** Verb and target of a tool row, e.g. ["Read", "src/app.ts"]. */
export function toolTitle(name: string, args: Record<string, any>): [string, string] {
  const a = args ?? {};
  if (a && typeof a.__raw === "string") return [name, summarizeArgs(name, a)];
  switch (name) {
    case "read_file":
      return ["Read", String(a.path ?? "") + (a.offset ? `:${a.offset}` : "")];
    case "list_files":
      return ["List", String(a.path ?? ".")];
    case "search":
      return ["Search", `"${a.pattern ?? ""}"${a.path ? ` in ${a.path}` : ""}`];
    case "write_file":
      return ["Write", String(a.path ?? "")];
    case "edit_file":
      return ["Edit", String(a.path ?? "")];
    case "run_command":
      return ["Run", String(a.command ?? "")];
    case "verification":
      return ["Check", String(a.command ?? "")];
    case "task":
      return ["Task", [a.action, a.command ?? a.task_id ?? ""].filter(Boolean).join(" ")];
    case "plan":
      return ["Plan", summarizeArgs(name, a)];
    default:
      return [name, summarizeArgs(name, a)];
  }
}

function toolIcon(name: string): string {
  return theme.g.icons[name] ?? theme.g.icons.other;
}

/** The right-hand status of a tool row: spinner and time, or ✓/✗ and duration. */
function toolStatus(b: ToolBlock, ctx: LayoutCtx): { text: string; w: number } {
  const t = theme;
  const p = t.p;
  if (b.end === undefined) {
    const secs = Math.floor((ctx.now - b.start) / 1000);
    const s = secs >= 1 ? `${secs}s` : "";
    return { text: t.muted(s), w: stringWidth(s) };
  }
  const exit = /\[exit code (\S+) in [\d.]+s\]/.exec(b.result ?? "");
  const parts: string[] = [];
  if ((b.name === "run_command" || b.name === "verification") && exit && exit[1] !== "0") parts.push(`exit ${exit[1]}`);
  if (b.durationMs !== undefined) parts.push(fmtDur(b.durationMs));
  const mark = b.ok ? t.fgCode(p.success) + t.g.ok + t.reset : t.fgCode(p.error) + t.g.fail + t.reset;
  const tail = parts.length ? " " + t.muted(parts.join(` ${t.g.dot} `)) : "";
  return { text: (t.opts.color ? mark : b.ok ? t.g.ok : t.g.fail) + tail, w: 1 + (parts.length ? 1 + stringWidth(parts.join(` ${t.g.dot} `)) : 0) };
}

/** One compact tool row: icon, verb, muted target, right-aligned status. */
function toolHead(b: ToolBlock, w: number, ctx: LayoutCtx, extra = ""): Row {
  const t = theme;
  const p = t.p;
  const running = b.end === undefined;
  const failed = b.end !== undefined && !b.ok;
  const [verb, target] = toolTitle(b.name, b.args);
  const status = toolStatus(b, ctx);
  const icon = running ? ctx.spin : toolIcon(b.name);
  const iconFg = running ? p.accent : failed ? p.error : p.muted;
  const x0 = INDENT;
  const statusX = w - status.w;
  const vx = x0 + 2;
  const tx = vx + stringWidth(verb) + 1;
  const extraW = stringWidth(extra);
  const room = Math.max(0, statusX - 2 - tx - (extraW ? extraW + 2 : 0));
  const tgt = truncateWidth(target.replace(/\s+/g, " "), room, t.g.ellipsis);
  const row: Row = [
    span(x0, icon, fg(iconFg)),
    span(vx, verb, fg(failed ? p.error : p.text)),
    span(tx, tgt, fg(p.muted)),
  ];
  if (extra) row.push(span(tx + stringWidth(tgt) + 2, extra));
  if (status.w) row.push(span(statusX, status.text, fg(p.muted)));
  return row;
}

function errorRows(text: string, x: number, w: number, max = 3): Row[] {
  const p = theme.p;
  const lines = text.split("\n").filter((l) => l.trim());
  const rows: Row[] = [];
  for (const l of lines) {
    for (const r of wrapAnsi(expandTabs(stripAnsi(l)), Math.max(8, w - x))) {
      if (rows.length >= max) return rows;
      rows.push([span(x, r, fg(p.error))]);
    }
  }
  return rows;
}

function layoutTool(b: ToolBlock, w: number, ctx: LayoutCtx): Row[] {
  if (b.name === "run_command" || b.name === "verification") return layoutCommand(b, w, ctx);
  const t = theme;
  const p = t.p;
  const rows: Row[] = [];
  const done = b.end !== undefined;
  let extra = "";
  let diffRows: Row[] = [];
  let hidden = 0;
  if (done && b.ok && b.diff && (b.name === "edit_file" || b.name === "write_file")) {
    const d = b.diff;
    const isNew = b.name === "write_file" && d.before === "";
    const dw = w - INDENT;
    const r = renderDiffRows(d.before, d.after, {
      width: dw,
      firstLine: b.name === "write_file" ? 1 : b.firstLine,
      maxRows: ctx.detail ? 80 : b.name === "write_file" ? 8 : 14,
      split: !isNew && dw >= 110,
      path: d.path,
      context: 2,
    });
    diffRows = shift(r.rows, INDENT);
    hidden = r.hidden;
    const counts = isNew
      ? `${t.green("+" + r.added)} ${t.faint("new file")}`
      : r.added || r.removed
        ? `${t.green("+" + r.added)} ${t.red("-" + r.removed)}`
        : t.faint("unchanged");
    extra = counts;
  }
  rows.push(toolHead(b, w, ctx, extra));
  if (done && !b.ok) rows.push(...errorRows(b.result ?? "", INDENT + 2, w));
  if (diffRows.length) {
    rows.push(...diffRows);
    if (hidden) rows.push([span(INDENT + 1, `${t.g.ellipsis} ${hidden} more line${hidden === 1 ? "" : "s"}  ${t.faint("ctrl+o expands")}`, fg(p.muted))]);
  }
  if (done && b.ok && b.result && b.result.includes("Warning:")) {
    const warn = b.result.slice(b.result.indexOf("Warning:")).split("\n")[0];
    rows.push([span(INDENT + 2, truncateWidth(`${t.g.warn} ${warn}`, w - INDENT - 2, t.g.ellipsis), fg(p.warning))]);
  }
  return rows;
}

/** A command: a shaded panel with the command line and the tail of its output. */
function layoutCommand(b: ToolBlock, w: number, ctx: LayoutCtx): Row[] {
  const t = theme;
  const p = t.p;
  const running = b.end === undefined;
  const failed = !running && !b.ok;
  const x0 = INDENT;
  const pw = w - x0;
  const bg = t.cell(p.panel);
  const barFg = t.cell(running ? p.accent : failed ? p.error : p.border);
  const base = (): Row => [{ x: x0, fill: pw, style: { bg } }, { x: x0, text: t.g.bar, style: { bg, fg: barFg } }];
  const rows: Row[] = [];
  const status = toolStatus(b, ctx);
  const label = b.name === "verification" ? "check" : "";
  const cmd = String(b.args?.command ?? "").replace(/\s+/g, " ").trim();
  const prompt = running ? ctx.spin : "$";
  const sx = x0 + pw - 2 - status.w;
  const head = base();
  head.push({ x: x0 + 3, text: prompt, style: { bg, fg: t.cell(running ? p.accent : p.muted) } });
  const cx = x0 + 5;
  const labelW = label ? stringWidth(label) + 1 : 0;
  if (label) head.push({ x: cx, text: label, style: { bg, fg: t.cell(p.secondary) } });
  head.push({ x: cx + labelW, text: truncateWidth(cmd, Math.max(1, sx - 2 - cx - labelW), t.g.ellipsis), style: { bg, fg: t.cell(p.text), attrs: A_BOLD } });
  if (status.w) head.push({ x: sx, text: status.text, style: { bg, fg: t.cell(p.muted) } });
  rows.push(base(), head);
  if (!running && b.result !== undefined) {
    let lines = b.result.replace(/\r\n/g, "\n").split("\n");
    if (lines[0]?.startsWith("Error: command exited")) lines.shift();
    while (lines.length && /^\s*$|^\[exit code .*\]$/.test(lines[lines.length - 1])) lines.pop();
    lines = lines.filter((l) => !/^\[exit code .*\]$/.test(l.trim()));
    while (lines.length && !lines[0].trim()) lines.shift();
    const max = ctx.detail ? 40 : 6;
    const cut = Math.max(0, lines.length - max);
    if (lines.length) rows.push(base());
    if (cut) {
      const r = base();
      r.push({ x: x0 + 3, text: `${t.g.ellipsis} ${cut} earlier line${cut === 1 ? "" : "s"}`, style: { bg, fg: t.cell(p.faint) } });
      rows.push(r);
    }
    for (const l of lines.slice(cut)) {
      const r = base();
      r.push({ x: x0 + 3, text: truncateWidth(expandTabs(stripAnsi(l)), pw - 5, t.g.ellipsis), style: { bg, fg: t.cell(failed ? p.text : p.muted) } });
      rows.push(r);
    }
  }
  rows.push(base());
  return rows;
}

function layoutPlan(b: PlanBlock, w: number): Row[] {
  const t = theme;
  const p = t.p;
  const x0 = INDENT;
  const pw = w - x0;
  const bg = t.cell(p.panel);
  const base = (): Row => [{ x: x0, fill: pw, style: { bg } }];
  const done = b.steps.filter((s) => s.done).length;
  const rows: Row[] = [base()];
  const head = base();
  head.push({ x: x0 + 2, text: t.g.icons.plan, style: { bg, fg: t.cell(p.accent) } });
  head.push({ x: x0 + 4, text: "Plan", style: { bg, fg: t.cell(p.text), attrs: A_BOLD } });
  head.push({ x: x0 + 9, text: `${done}/${b.steps.length}`, style: { bg, fg: t.cell(p.muted) } });
  rows.push(head, base());
  b.steps.forEach((s, i) => {
    const now = i === b.current;
    const mark = s.done ? t.g.stepDone : now ? t.g.stepNow : t.g.stepTodo;
    const markFg = s.done ? p.success : now ? p.accent : p.faint;
    const textFg = s.done ? p.muted : now ? p.text : p.muted;
    const wrapped = wrapAnsi(expandTabs(s.text.replace(/\s+/g, " ")), Math.max(8, pw - 7));
    wrapped.forEach((line, j) => {
      const r = base();
      if (j === 0) r.push({ x: x0 + 2, text: mark, style: { bg, fg: t.cell(markFg) } });
      r.push({ x: x0 + 4, text: line, style: { bg, fg: t.cell(textFg), attrs: now ? A_BOLD : s.done ? 0 : 0 } });
      rows.push(r);
    });
  });
  rows.push(base());
  return rows;
}

function layoutTurn(b: TurnBlock, w: number): Row[] {
  const t = theme;
  const p = t.p;
  const mode = b.modeLabel || "Done";
  const rest = [b.model, b.label].filter(Boolean).join(` ${t.g.dot} `);
  const mw = stringWidth(mode);
  return [
    [
      span(INDENT, t.g.turn, fg(modeColor(b.mode))),
      span(INDENT + 2, mode, fg(modeColor(b.mode))),
      span(INDENT + 2 + mw, truncateWidth(` ${t.g.dot} ${rest}`, Math.max(0, w - INDENT - 3 - mw), t.g.ellipsis), fg(p.muted)),
    ],
  ];
}

function layoutNote(b: NoteBlock, w: number): Row[] {
  const t = theme;
  const p = t.p;
  const text = stripAnsi(b.text).replace(/^\s*[·•]\s*/, "").trimEnd();
  if (b.level === "error") {
    const bg = t.cell(p.panel);
    const x0 = INDENT;
    const pw = w - x0;
    const base = (): Row => [{ x: x0, fill: pw, style: { bg } }, { x: x0, text: t.g.bar, style: { bg, fg: t.cell(p.error) } }];
    const rows: Row[] = [base()];
    const lines = text.split("\n").filter((l, i) => l.trim() || i > 0);
    let first = true;
    for (const l of lines) {
      for (const r of wrapAnsi(expandTabs(l), Math.max(8, pw - 7))) {
        const row = base();
        if (first) row.push({ x: x0 + 3, text: t.g.fail, style: { bg, fg: t.cell(p.error), attrs: A_BOLD } });
        row.push({ x: x0 + 5, text: r, style: { bg, fg: t.cell(first ? p.error : p.text) } });
        rows.push(row);
        first = false;
      }
    }
    rows.push(base());
    return rows;
  }
  const warn = b.level === "warn";
  const icon = warn ? t.g.warn : t.g.dot;
  const rows: Row[] = [];
  text.split("\n").forEach((l, li) => {
    wrapAnsi(expandTabs(l), Math.max(8, w - INDENT - 3)).forEach((r, i) => {
      const row: Row = [];
      if (li === 0 && i === 0) row.push(span(INDENT, icon, fg(warn ? p.warning : p.faint)));
      row.push(span(INDENT + 2, r, fg(warn ? p.warning : p.muted)));
      rows.push(row);
    });
  });
  return rows;
}

function layoutText(b: TextBlock, w: number): Row[] {
  const lines = b.text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && !stripAnsi(lines[0]).trim()) lines.shift();
  while (lines.length && !stripAnsi(lines[lines.length - 1]).trim()) lines.pop();
  const rows: Row[] = [];
  for (const l of lines) {
    if (!stripAnsi(l).trim()) {
      rows.push([]);
      continue;
    }
    for (const r of wrapAnsi(expandTabs(l), Math.max(8, w - INDENT - 1))) rows.push([span(INDENT, r, fg(theme.p.text))]);
  }
  return rows;
}

/** Blank rows between two neighbouring blocks. */
export function gapBetween(prev: Block | undefined, cur: Block): number {
  if (!prev) return 0;
  const inline = (b: Block) =>
    (b.kind === "tool" && b.name !== "run_command" && b.name !== "verification" && !(b.ok && b.diff)) ||
    (b.kind === "note" && b.level !== "error");
  if (inline(prev) && inline(cur)) return 0;
  return 1;
}
