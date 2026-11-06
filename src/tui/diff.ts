// Diffs for edit rows: a line diff (LCS on the changed middle, after
// trimming the common head and tail), laid out as rows with line numbers and
// red/green background tints — unified, or side by side when there is room —
// capped at a few rows with "… N more lines". UI only: nothing here reaches
// the model.

import { Row, span } from "./rows";
import { highlightLine, HlState, langOf } from "./highlight";
import { theme } from "./theme";
import { expandTabs, truncateWidth } from "./width";

export interface DiffOp {
  op: " " | "-" | "+";
  text: string;
  /** Line number in the old (for -) or new (for + and context) text, 1-based. */
  no: number;
}

const splitLines = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

export function lineDiff(before: string, after: string, firstLine = 1): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const ops: DiffOp[] = [];
  for (let i = 0; i < head; i++) ops.push({ op: " ", text: a[i], no: firstLine + i });
  let ai = head;
  let bi = head;
  const push = (op: " " | "-" | "+") => {
    if (op === "-") ops.push({ op, text: a[ai], no: firstLine + ai++ });
    else if (op === "+") ops.push({ op, text: b[bi], no: firstLine + bi++ });
    else {
      ops.push({ op, text: b[bi], no: firstLine + bi });
      ai++;
      bi++;
    }
  };
  if (am.length * bm.length <= 250_000 && am.length && bm.length) {
    // LCS table from the end, then walk forward.
    const n = am.length;
    const m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        push(" ");
        i++;
        j++;
      } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
        push("-"); // removals before additions, as in a unified diff
        i++;
      } else {
        push("+");
        j++;
      }
    }
  } else {
    for (let i = 0; i < am.length; i++) push("-");
    for (let j = 0; j < bm.length; j++) push("+");
  }
  for (let i = 0; i < tail; i++) push(" ");
  return ops;
}

export function diffCounts(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of lineDiff(before, after)) {
    if (o.op === "+") added++;
    else if (o.op === "-") removed++;
  }
  return { added, removed };
}

export interface DiffRenderOptions {
  width: number;
  /** Rows shown before the rest is cut (the caller says how many were cut). */
  maxRows?: number;
  /** Line number of the snippet's first line in the file, if known. */
  firstLine?: number;
  /** Context lines kept around each change. */
  context?: number;
  /** Side by side (old left, new right). */
  split?: boolean;
  /** The file, for syntax colours. */
  path?: string;
}

export interface DiffRows {
  rows: Row[];
  /** Rows cut by maxRows. */
  hidden: number;
  added: number;
  removed: number;
}

interface Numbered extends DiffOp {
  oldNo: number;
  newNo: number;
}

/** The diff as display rows with line numbers and tinted backgrounds. */
export function renderDiffRows(before: string, after: string, o: DiffRenderOptions): DiffRows {
  const t = theme;
  const p = t.p;
  const ctx = o.context ?? 2;
  const first = o.firstLine ?? 1;
  const ops = lineDiff(before, after, first);
  let a = first;
  let b = first;
  const num: Numbered[] = ops.map((x) => {
    const r = { ...x, oldNo: a, newNo: b };
    if (x.op === " ") {
      a++;
      b++;
    } else if (x.op === "-") a++;
    else b++;
    return r;
  });
  const changed = num.map((x) => x.op !== " ");
  const added = num.filter((x) => x.op === "+").length;
  const removed = num.filter((x) => x.op === "-").length;
  if (!changed.some(Boolean)) return { rows: [], hidden: 0, added, removed };
  const keep = num.map((_, i) => {
    for (let d = -ctx; d <= ctx; d++) if (changed[i + d]) return true;
    return false;
  });
  const shown: (Numbered | null)[] = [];
  num.forEach((x, i) => {
    if (keep[i]) shown.push(x);
    else if (shown.length && shown[shown.length - 1] !== null) shown.push(null);
  });
  while (shown.length && shown[shown.length - 1] === null) shown.pop();

  const ext = (o.path ?? "").split(".").pop() ?? "";
  const lang = langOf(ext);
  const hlOld: HlState = {};
  const hlNew: HlState = {};
  const code = (s: string, st: HlState) => highlightLine(expandTabs(s), lang, st);
  const numbered = o.firstLine !== undefined;
  const numW = numbered ? Math.max(2, String(Math.max(a, b)).length) : 0;
  const gutW = numbered ? numW + 2 : 1;

  const bgFor = (op: string) => (op === "+" ? p.diffAddBg : op === "-" ? p.diffDelBg : p.panel);
  const lnFor = (op: string) => (op === "+" ? p.diffAddLnBg : op === "-" ? p.diffDelLnBg : p.panel);

  /** One side's cells for an op; `x` and `w` are its column range. */
  const side = (x: number, w: number, d: Numbered | null | undefined, which: "old" | "new" | "uni"): Row => {
    if (d === undefined) return [{ x, fill: w, style: { bg: t.cell(p.panel) } }];
    if (d === null)
      return [{ x, fill: w, style: { bg: t.cell(p.panel), fg: t.cell(p.faint) }, text: " ".repeat(Math.max(0, gutW - 1)) + t.g.ellipsis }];
    const op = d.op;
    const no = which === "old" || op === "-" ? d.oldNo : d.newNo;
    const sign = op === "+" ? "+" : op === "-" ? "-" : " ";
    const signFg = op === "+" ? p.diffAddFg : op === "-" ? p.diffDelFg : p.faint;
    const room = Math.max(1, w - gutW - 2);
    const st = op === "-" || which === "old" ? hlOld : hlNew;
    const body = truncateWidth(code(d.text, st), room, t.g.ellipsis);
    if (op === " " && which === "uni") code(d.text, hlOld);
    const bg = t.cell(bgFor(op));
    const fg = t.cell(op === " " ? p.muted : p.text);
    const row: Row = [];
    if (numbered)
      row.push({ x, fill: gutW, style: { bg: t.cell(lnFor(op)), fg: t.cell(op === " " ? p.lineNo : signFg) }, text: " " + String(no).padStart(numW) });
    else row.push({ x, fill: gutW, style: { bg: t.cell(lnFor(op)) } });
    row.push({ x: x + gutW, fill: w - gutW, style: { bg, fg } });
    row.push(span(x + gutW, sign, { bg, fg: t.cell(signFg) }));
    row.push(span(x + gutW + 2, body, { bg, fg }));
    return row;
  };

  const rows: Row[] = [];
  const W = o.width;
  if (o.split && W >= 60) {
    const lw = Math.floor((W - 1) / 2);
    const rw = W - 1 - lw;
    const rx = lw + 1;
    for (let i = 0; i < shown.length; ) {
      const d = shown[i];
      if (d === null || d.op === " ") {
        rows.push([...side(0, lw, d, "old"), ...side(rx, rw, d, "new")]);
        i++;
        continue;
      }
      const dels: Numbered[] = [];
      const adds: Numbered[] = [];
      while (i < shown.length && shown[i] && shown[i]!.op === "-") dels.push(shown[i++]!);
      while (i < shown.length && shown[i] && shown[i]!.op === "+") adds.push(shown[i++]!);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++)
        rows.push([...side(0, lw, dels[k], "old"), ...side(rx, rw, adds[k], "new")]);
    }
  } else {
    for (const d of shown) rows.push(side(0, W, d, "uni"));
  }
  const max = o.maxRows ?? Infinity;
  if (rows.length > max) return { rows: rows.slice(0, max), hidden: rows.length - max, added, removed };
  return { rows, hidden: 0, added, removed };
}

