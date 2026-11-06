// Line-buffered markdown for streamed replies. Each finished line is
// formatted once and committed to scrollback (headings, bold/italic, inline
// code, • bullets, quotes, rules, fenced code with a dim gutter and syntax
// colors); only the unfinished tail is redrawn while tokens arrive. Tables are
// held until the block ends so their columns can be aligned. Rows are
// word-wrapped to the terminal width here, so the terminal never wraps them.

import { HlState, highlightLine, langOf } from "./highlight";
import { theme } from "./theme";
import { expandTabs, stringWidth, truncateWidth, wrapAnsi } from "./width";

/** Inline markdown → ANSI: `code`, **bold**, *italic*, ~~strike~~, [links](url). */
export function renderInline(s: string): string {
  const t = theme;
  let out = "";
  // Split out code spans first: nothing inside them is markdown.
  const parts = s.split(/(`+[^`]*`+)/);
  for (const part of parts) {
    if (/^`+[^`]*`+$/.test(part) && part.length >= 2) {
      const inner = part.replace(/^`+/, "").replace(/`+$/, "");
      out += t.code(inner);
      continue;
    }
    let p = part;
    p = p.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) =>
      text === url ? t.underline(text) : t.underline(text) + t.dim(` (${url})`)
    );
    p = p.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (_m, _d, inner: string) => t.bold(inner));
    p = p.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_m, inner: string) => t.strike(inner));
    p = p.replace(/(^|[^\w*])\*(?=[^\s*])([^*]+?)(?<=\S)\*(?!\w)/g, (_m, pre: string, inner: string) => pre + t.italic(inner));
    p = p.replace(/(^|[^\w])_(?=[^\s_])([^_]+?)(?<=\S)_(?!\w)/g, (_m, pre: string, inner: string) => pre + t.italic(inner));
    p = p.replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, "$1");
    out += p;
  }
  return out;
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

interface Fence {
  marker: string;
  lang: string | null;
  hl: HlState;
}

export interface MarkdownOptions {
  /** No markdown: plain dim text (full reasoning view). */
  plain?: boolean;
}

export class MarkdownStream {
  private buf = "";
  private fence: Fence | null = null;
  private table: string[] = [];

  constructor(private width: () => number, private opts: MarkdownOptions = {}) {}

  /** True when nothing is waiting to be committed. */
  get idle(): boolean {
    return this.buf === "" && this.table.length === 0;
  }

  /** Feed streamed text; returns finished display rows to commit. */
  push(text: string): string[] {
    this.buf += text;
    const rows: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      rows.push(...this.feedLine(line));
    }
    return rows;
  }

  /** Display rows for the unfinished tail: buffered table rows and the
   * partial last line. Nothing here is committed. */
  tail(): string[] {
    const rows: string[] = [];
    const w = this.width();
    for (const l of this.table) rows.push(truncateWidth(renderInline(expandTabs(l)), w));
    if (this.buf) {
      if (this.opts.plain) rows.push(...this.plainRows(this.buf));
      else if (this.fence) rows.push(...this.codeRows(this.buf, { ...this.fence.hl }, this.fence.lang));
      else if (this.table.length || /^\s*\|/.test(this.buf)) rows.push(truncateWidth(expandTabs(this.buf), w));
      else rows.push(...this.blockRows(this.buf, true));
    }
    return rows;
  }

  /** End of the reply: everything left becomes final rows. */
  end(): string[] {
    const rows: string[] = [];
    if (this.buf) {
      const line = this.buf;
      this.buf = "";
      rows.push(...this.feedLine(line));
    }
    rows.push(...this.flushTable());
    this.fence = null;
    return rows;
  }

  /** Drop the unfinished tail (an interrupted reply that will be retried). */
  reset(): void {
    this.buf = "";
    this.table = [];
    this.fence = null;
  }

  private feedLine(line: string): string[] {
    if (this.opts.plain) return this.plainRows(line);
    if (!this.fence && /^\s*\|/.test(line)) {
      this.table.push(line);
      return [];
    }
    const rows = this.flushTable();
    rows.push(...this.blockRows(line, false));
    return rows;
  }

  private plainRows(line: string): string[] {
    const w = this.width();
    return wrapAnsi(expandTabs(line), w).map((r) => theme.dim(r));
  }

  private codeRows(line: string, hl: HlState, lang: string | null): string[] {
    const t = theme;
    const gutter = t.dim(t.g.gutter + " ");
    const code = highlightLine(expandTabs(line), lang, hl);
    return wrapAnsi(code, this.width() - 2, gutter).map((r, i) => (i === 0 ? gutter + r : r));
  }

  /** Format one complete (or, with peek, partial) line outside tables. */
  private blockRows(line: string, peek: boolean): string[] {
    const t = theme;
    const w = this.width();
    if (this.fence) {
      const close = line.trim();
      if (close.startsWith(this.fence.marker) && /^[`~]+$/.test(close)) {
        if (!peek) this.fence = null;
        return [t.dim(t.g.fenceBottom)];
      }
      return this.codeRows(line, peek ? { ...this.fence.hl } : this.fence.hl, this.fence.lang);
    }
    const f = FENCE.exec(line);
    if (f) {
      if (!peek) this.fence = { marker: f[2][0].repeat(3), lang: langOf(f[3]), hl: {} };
      return [t.dim(t.g.fenceTop + (f[3] ? " " + f[3] : ""))];
    }
    line = expandTabs(line);
    if (!line.trim()) return [""];
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const text = renderInline(h[2]);
      const styled = h[1].length === 1 ? t.heading(text) : h[1].length === 2 ? t.heading(text) : t.bold(text);
      return wrapAnsi(styled, w);
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return [t.dim(t.g.hr.repeat(Math.min(w, 40)))];
    const q = /^(\s*)>\s?(.*)$/.exec(line);
    if (q) {
      const bar = t.dim(t.g.quote + " ");
      return wrapAnsi(t.italic(renderInline(q[2])), w - 2, bar).map((r, i) => (i === 0 ? bar + r : r));
    }
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (b) {
      const pre = b[1] + t.g.bullet + " ";
      const ind = " ".repeat(stringWidth(pre));
      return wrapAnsi(b[1] + t.accent(t.g.bullet) + " " + renderInline(b[2]), w, ind);
    }
    const o = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
    if (o) {
      const pre = o[1] + o[2] + " ";
      return wrapAnsi(o[1] + t.accent(o[2]) + " " + renderInline(o[3]), w, " ".repeat(stringWidth(pre)));
    }
    return wrapAnsi(renderInline(line), w);
  }

  /** Render the held table: aligned columns when it fits, else plain rows. */
  private flushTable(): string[] {
    if (!this.table.length) return [];
    const lines = this.table;
    this.table = [];
    return renderTable(lines, this.width());
  }
}

export function renderTable(lines: string[], width: number): string[] {
  const t = theme;
  const asText = () => lines.flatMap((l) => wrapAnsi(renderInline(expandTabs(l)), width));
  if (lines.length < 2 || !TABLE_SEP.test(lines[1])) return asText();
  const head = splitRow(lines[0]).map(renderInline);
  const aligns = splitRow(lines[1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "c" : "r") : "l"));
  const body = lines.slice(2).map((l) => splitRow(l).map(renderInline));
  const cols = Math.max(head.length, ...body.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(1, stringWidth(head[i] ?? ""), ...body.map((r) => stringWidth(r[i] ?? "")))
  );
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (cols - 1);
  if (total > width) return asText();
  const cell = (s: string, i: number) => {
    const pad = widths[i] - stringWidth(s);
    const a = aligns[i] ?? "l";
    if (a === "r") return " ".repeat(pad) + s;
    if (a === "c") return " ".repeat(Math.floor(pad / 2)) + s + " ".repeat(Math.ceil(pad / 2));
    return s + " ".repeat(pad);
  };
  const sep = t.dim(" " + t.g.gutter + " ");
  const row = (cells: string[]) => widths.map((_, i) => cell(cells[i] ?? "", i)).join(sep).replace(/\s+$/, "");
  const rule = t.dim(widths.map((w) => t.g.hr.repeat(w)).join(t.g.hr + (t.opts.ascii ? "+" : "┼") + t.g.hr));
  return [row(head.map((h) => t.bold(h))), rule, ...body.map(row)];
}
