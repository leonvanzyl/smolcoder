// Compact unified diffs for tool rows: a line diff (LCS on the changed middle,
// after trimming the common head and tail), rendered with line numbers and
// red/green tints, capped at a few rows with "… +N more". UI only — nothing
// here reaches the model.

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
  maxRows?: number;
  /** Line number of the snippet's first line in the file, if known. */
  firstLine?: number;
  /** Context lines kept around each change. */
  context?: number;
  indent?: string;
}

/** Rows of a compact unified diff. */
export function renderDiff(before: string, after: string, o: DiffRenderOptions): string[] {
  const t = theme;
  const maxRows = o.maxRows ?? 12;
  const ctx = o.context ?? 1;
  const indent = o.indent ?? "  ";
  const ops = lineDiff(before, after, o.firstLine ?? 1);
  const changed = ops.map((x) => x.op !== " ");
  if (!changed.some(Boolean)) return [];
  // Keep context lines within `ctx` of a change; mark gaps.
  const keep = ops.map((_, i) => {
    for (let d = -ctx; d <= ctx; d++) if (changed[i + d]) return true;
    return false;
  });
  const shown: (DiffOp | null)[] = [];
  ops.forEach((x, i) => {
    if (keep[i]) shown.push(x);
    else if (shown.length && shown[shown.length - 1] !== null) shown.push(null);
  });
  while (shown.length && shown[shown.length - 1] === null) shown.pop();
  const numbered = o.firstLine !== undefined;
  const numW = numbered ? String(Math.max(...ops.map((x) => x.no))).length : 0;
  const rows: string[] = [];
  const room = Math.max(10, o.width - indent.length - numW - 3);
  for (const x of shown) {
    if (rows.length >= maxRows) break;
    if (x === null) {
      rows.push(indent + t.dim(" ".repeat(numW) + (numW ? " " : "") + t.g.ellipsis));
      continue;
    }
    const num = numbered ? t.dim(String(x.no).padStart(numW)) + " " : "";
    const text = truncateWidth(expandTabs(x.text), room, t.g.ellipsis);
    if (x.op === " ") rows.push(indent + num + t.dim("  " + text));
    else if (x.op === "-") rows.push(indent + num + t.del("- " + text));
    else rows.push(indent + num + t.add("+ " + text));
  }
  const total = shown.length;
  if (total > rows.length) rows.push(indent + t.dim(`${t.g.ellipsis} +${total - rows.length} more`));
  return rows;
}
