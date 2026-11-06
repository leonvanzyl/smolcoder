// A laid-out display row: spans placed at columns relative to the block's
// left edge. A span can first fill a run of cells with its style (a panel
// background), then draw text (which may carry SGR escapes) on top.

import { Grid, PLAIN, Style } from "./screen";
import { stringWidth, stripAnsi } from "./width";

export interface Span {
  x: number;
  text?: string;
  style?: Partial<Style>;
  /** Cells to fill with the style before drawing the text. */
  fill?: number;
}

export type Row = Span[];

export function span(x: number, text: string, style?: Partial<Style>): Span {
  return { x, text, style };
}

/** Draw a row at (ox, y), clipped to maxX; spans start from `base`. */
export function drawRow(g: Grid, ox: number, y: number, row: Row, maxX: number, base: Style = PLAIN): void {
  for (const s of row) {
    const st: Style = { ...base, ...s.style };
    const x = ox + s.x;
    if (s.fill) g.fill(x, y, Math.min(s.fill, maxX - x), 1, st);
    if (s.text) g.text(x, y, s.text, st, s.fill ? Math.min(maxX, x + s.fill) : maxX);
  }
}

/** A row's visible text (spans laid out left to right, gaps as spaces). */
export function rowText(row: Row): string {
  const cells: string[] = [];
  for (const s of row) {
    if (s.fill) for (let i = 0; i < s.fill; i++) if (cells[s.x + i] === undefined) cells[s.x + i] = " ";
    if (!s.text) continue;
    let x = s.x;
    for (const ch of Array.from(stripAnsi(s.text))) {
      const w = stringWidth(ch);
      if (w === 0) continue;
      cells[x] = ch;
      if (w === 2) cells[x + 1] = "";
      x += w;
    }
  }
  let out = "";
  for (let i = 0; i < cells.length; i++) out += cells[i] ?? " ";
  return out.replace(/\s+$/, "");
}
