// Line-buffered markdown for streamed replies. Each finished line is laid
// out once (headings, bold/italic, inline code, bullets, quotes, rules,
// fenced code in a shaded panel with syntax colours); only the unfinished
// tail is laid out again while tokens arrive. Tables are held until the block
// ends, then drawn as a grid. Rows are wrapped to the width here.

import { HlState, highlightLine, langOf } from "./highlight";
import { Row, span } from "./rows";
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
      text === url ? t.underline(t.accent(text)) : t.underline(t.accent(text)) + t.faint(` (${url})`)
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
  tag: string;
  hl: HlState;
}

export interface MarkdownOptions {
  /** No markdown: plain muted text (the full reasoning view). */
  plain?: boolean;
}

const fgOf = (c: number) => ({ fg: theme.cell(c) });

/** A row of plain text in the default text colour. */
function textRow(x: number, s: string): Row {
  return [span(x, s, fgOf(theme.p.text))];
}

/** One row of a shaded code panel. */
function panelRow(w: number, text = "", x = 2): Row {
  const st = { bg: theme.cell(theme.p.element), fg: theme.cell(theme.p.text) };
  return [{ x: 0, fill: w, style: st, text: "" }, ...(text ? [{ x, text, style: st }] : [])];
}

export class MarkdownStream {
  private buf = "";
  private fence: Fence | null = null;
  private table: string[] = [];
  private blank = true;

  constructor(private width: () => number, private opts: MarkdownOptions = {}) {}

  /** True when nothing is waiting to be laid out. */
  get idle(): boolean {
    return this.buf === "" && this.table.length === 0;
  }

  /** Feed streamed text; returns the finished rows. */
  push(text: string): Row[] {
    this.buf += text;
    const rows: Row[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      rows.push(...this.feedLine(line));
    }
    return rows;
  }

  /** Rows for the unfinished tail: held table rows and the partial last
   * line. Nothing here is final. */
  tail(): Row[] {
    const rows: Row[] = [];
    const w = this.width();
    if (this.table.length) {
      const lines = this.buf && /^\s*\|/.test(this.buf) ? [...this.table, this.buf] : this.table;
      rows.push(...renderTable(lines, w));
      if (this.buf && !/^\s*\|/.test(this.buf)) rows.push(textRow(0, truncateWidth(expandTabs(this.buf), w)));
      return rows;
    }
    if (this.buf) {
      if (this.opts.plain) rows.push(...this.plainRows(this.buf));
      else if (this.fence) rows.push(...this.codeRows(this.buf, { ...this.fence.hl }, this.fence.lang));
      else if (/^\s*\|/.test(this.buf)) rows.push(textRow(0, truncateWidth(expandTabs(this.buf), w)));
      else rows.push(...this.blockRows(this.buf, true));
    }
    // A code panel still streaming gets its bottom edge.
    if (this.fence && !this.opts.plain) rows.push(panelRow(w));
    return rows;
  }

  /** End of the reply: everything left becomes final rows. */
  end(): Row[] {
    const rows: Row[] = [];
    if (this.buf) {
      const line = this.buf;
      this.buf = "";
      rows.push(...this.feedLine(line));
    }
    rows.push(...this.flushTable());
    if (this.fence && !this.opts.plain) rows.push(panelRow(this.width()));
    this.fence = null;
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    return rows;
  }

  /** Drop the unfinished tail (an interrupted reply that will be retried). */
  reset(): void {
    this.buf = "";
    this.table = [];
    this.fence = null;
  }

  private feedLine(line: string): Row[] {
    if (this.opts.plain) return this.plainRows(line);
    if (!this.fence && /^\s*\|/.test(line)) {
      this.table.push(line);
      return [];
    }
    const rows = this.flushTable();
    rows.push(...this.blockRows(line, false));
    return rows;
  }

  private plainRows(line: string): Row[] {
    const w = this.width();
    if (!line.trim()) {
      if (this.blank) return [];
      this.blank = true;
      return [[]];
    }
    this.blank = false;
    return wrapAnsi(expandTabs(line), w).map((r) => [span(0, r, { ...fgOf(theme.p.muted), attrs: 4 })]);
  }

  private codeRows(line: string, hl: HlState, lang: string | null): Row[] {
    const w = this.width();
    const code = highlightLine(expandTabs(line), lang, hl);
    return wrapAnsi(code, Math.max(4, w - 4)).map((r) => panelRow(w, r));
  }

  /** Lay out one complete (or, with peek, partial) line outside tables. */
  private blockRows(line: string, peek: boolean): Row[] {
    const t = theme;
    const w = this.width();
    if (this.fence) {
      const close = line.trim();
      if (close.startsWith(this.fence.marker) && /^[`~]+$/.test(close)) {
        if (!peek) {
          this.fence = null;
          this.blank = false;
        }
        return [panelRow(w)];
      }
      return this.codeRows(line, peek ? { ...this.fence.hl } : this.fence.hl, this.fence.lang);
    }
    const f = FENCE.exec(line);
    if (f) {
      const tag = f[3] ?? "";
      if (!peek) this.fence = { marker: f[2][0].repeat(3), lang: langOf(tag), tag, hl: {} };
      const head = panelRow(w);
      if (tag) head.push({ x: Math.max(2, w - 2 - stringWidth(tag)), text: tag, style: { bg: t.cell(t.p.element), fg: t.cell(t.p.faint) } });
      return [head];
    }
    line = expandTabs(line);
    if (!line.trim()) {
      if (this.blank) return [];
      if (!peek) this.blank = true;
      return [[]];
    }
    if (!peek) this.blank = false;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const text = renderInline(h[2]);
      const styled = h[1].length <= 2 ? t.heading(text) : t.bold(t.text(text));
      return wrapAnsi(styled, w).map((r) => textRow(0, r));
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return [[span(0, t.g.hr.repeat(w), fgOf(t.p.border))]];
    const q = /^(\s*)>\s?(.*)$/.exec(line);
    if (q) {
      return wrapAnsi(t.italic(renderInline(q[2])), w - 2).map((r) => [
        span(0, t.g.vline, fgOf(t.p.borderActive)),
        span(2, r, fgOf(t.p.muted)),
      ]);
    }
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      const done = task[2] !== " ";
      const ind = stringWidth(task[1]);
      const box = done ? t.green(t.g.stepDone) : t.muted(t.g.stepTodo);
      const body = done ? t.muted(renderInline(task[3])) : renderInline(task[3]);
      return wrapAnsi(body, w - ind - 2).map((r, i) => (i === 0 ? [span(ind, box), span(ind + 2, r, fgOf(t.p.text))] : textRow(ind + 2, r)));
    }
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (b) {
      const ind = stringWidth(b[1]);
      return wrapAnsi(renderInline(b[2]), w - ind - 2).map((r, i) =>
        i === 0 ? [span(ind, t.g.bullet, fgOf(t.p.accent)), span(ind + 2, r, fgOf(t.p.text))] : textRow(ind + 2, r)
      );
    }
    const o = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
    if (o) {
      const ind = stringWidth(o[1]);
      const nw = stringWidth(o[2]) + 1;
      return wrapAnsi(renderInline(o[3]), w - ind - nw).map((r, i) =>
        i === 0 ? [span(ind, o[2], fgOf(t.p.accent)), span(ind + nw, r, fgOf(t.p.text))] : textRow(ind + nw, r)
      );
    }
    return wrapAnsi(renderInline(line), w).map((r) => textRow(0, r));
  }

  /** Lay out the held table. */
  private flushTable(): Row[] {
    if (!this.table.length) return [];
    const lines = this.table;
    this.table = [];
    this.blank = false;
    return renderTable(lines, this.width());
  }
}

/** A grid table that fits `width`: columns shrink (cells cut with …) when
 * needed; rows that are not a table are plain text. */
export function renderTable(lines: string[], width: number): Row[] {
  const t = theme;
  const asText = () => lines.flatMap((l) => wrapAnsi(renderInline(expandTabs(l)), width).map((r) => textRow(0, r)));
  if (lines.length < 2 || !TABLE_SEP.test(lines[1])) return asText();
  const head = splitRow(lines[0]).map(renderInline);
  const aligns = splitRow(lines[1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "c" : "r") : "l"));
  const body = lines.slice(2).map((l) => splitRow(l).map(renderInline));
  const cols = Math.max(head.length, ...body.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(1, stringWidth(head[i] ?? ""), ...body.map((r) => stringWidth(r[i] ?? "")))
  );
  const total = () => widths.reduce((a, b) => a + b, 0) + 3 * cols + 1;
  while (total() > width) {
    let wi = 0;
    for (let i = 1; i < cols; i++) if (widths[i] > widths[wi]) wi = i;
    if (widths[wi] <= 3) return asText();
    widths[wi]--;
  }
  const g = t.g.sq;
  const bc = fgOf(t.p.border);
  const cell = (s: string, i: number) => {
    const cut = truncateWidth(s, widths[i], t.g.ellipsis);
    const pad = widths[i] - stringWidth(cut);
    const a = aligns[i] ?? "l";
    if (a === "r") return " ".repeat(pad) + cut;
    if (a === "c") return " ".repeat(Math.floor(pad / 2)) + cut + " ".repeat(Math.ceil(pad / 2));
    return cut + " ".repeat(pad);
  };
  const rule = (l: string, m: string, r: string): Row => [span(0, l + widths.map((w) => t.g.hr.repeat(w + 2)).join(m) + r, bc)];
  const row = (cells: string[], bold: boolean): Row => {
    const out: Row = [span(0, t.g.vline, bc)];
    let x = 1;
    widths.forEach((w, i) => {
      const c = cell(cells[i] ?? "", i);
      out.push(span(x + 1, bold ? t.bold(c) : c, fgOf(t.p.text)));
      x += w + 3;
      out.push(span(x - 1, t.g.vline, bc));
    });
    return out;
  };
  return [
    rule(g.tl, g.t, g.tr),
    row(head, true),
    rule(g.l, g.x, g.r),
    ...body.map((r) => row(r, false)),
    rule(g.bl, g.b, g.br),
  ];
}
