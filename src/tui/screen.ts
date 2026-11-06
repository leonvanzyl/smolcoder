// The screen as a grid of cells (character, width, colours, attributes), and
// the diff that turns one frame into the next: only cells that changed are
// written, grouped into runs with one cursor move and one style change each.
// Text with SGR escapes can be drawn into the grid — a reset returns to the
// style the text was drawn with, so panels keep their background.

import { DEFAULT, RGB_FLAG, colorParams, isRgb, mix, rgbOf256 } from "./theme";
import { cellWidth, expandTabs } from "./width";

export const A_BOLD = 1;
export const A_DIM = 2;
export const A_ITALIC = 4;
export const A_UNDER = 8;
export const A_INVERSE = 16;
export const A_STRIKE = 32;

export interface Style {
  fg: number;
  bg: number;
  attrs: number;
}

export const PLAIN: Style = { fg: DEFAULT, bg: DEFAULT, attrs: 0 };

// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b\[([0-9;:?]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

/** Apply SGR parameters to a style; `base` is what a reset returns to. */
export function applySgr(st: Style, params: string, base: Style): void {
  const ps = params === "" ? [0] : params.split(/[;:]/).map((x) => (x === "" ? 0 : Number(x)));
  for (let i = 0; i < ps.length; i++) {
    const n = ps[i];
    if (n === 0) {
      st.fg = base.fg;
      st.bg = base.bg;
      st.attrs = base.attrs;
    } else if (n === 1) st.attrs |= A_BOLD;
    else if (n === 2) st.attrs |= A_DIM;
    else if (n === 3) st.attrs |= A_ITALIC;
    else if (n === 4) st.attrs |= A_UNDER;
    else if (n === 7) st.attrs |= A_INVERSE;
    else if (n === 9) st.attrs |= A_STRIKE;
    else if (n === 22) st.attrs &= ~(A_BOLD | A_DIM);
    else if (n === 23) st.attrs &= ~A_ITALIC;
    else if (n === 24) st.attrs &= ~A_UNDER;
    else if (n === 27) st.attrs &= ~A_INVERSE;
    else if (n === 29) st.attrs &= ~A_STRIKE;
    else if (n >= 30 && n <= 37) st.fg = n - 30;
    else if (n >= 90 && n <= 97) st.fg = n - 90 + 8;
    else if (n >= 40 && n <= 47) st.bg = n - 40;
    else if (n >= 100 && n <= 107) st.bg = n - 100 + 8;
    else if (n === 39) st.fg = base.fg;
    else if (n === 49) st.bg = base.bg;
    else if (n === 38 || n === 48) {
      let c = DEFAULT;
      if (ps[i + 1] === 5) {
        c = ps[i + 2] ?? 0;
        i += 2;
      } else if (ps[i + 1] === 2) {
        c = RGB_FLAG | (((ps[i + 2] ?? 0) & 255) << 16) | (((ps[i + 3] ?? 0) & 255) << 8) | ((ps[i + 4] ?? 0) & 255);
        i += 4;
      }
      if (n === 38) st.fg = c;
      else st.bg = c;
    }
  }
}

export class Grid {
  readonly w: number;
  readonly h: number;
  ch: string[];
  /** 1 or 2 for a glyph's first cell, 0 for the cell a wide glyph covers. */
  wd: Uint8Array;
  fg: Int32Array;
  bg: Int32Array;
  at: Uint8Array;

  constructor(w: number, h: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    const n = this.w * this.h;
    this.ch = new Array(n).fill(" ");
    this.wd = new Uint8Array(n).fill(1);
    this.fg = new Int32Array(n).fill(DEFAULT);
    this.bg = new Int32Array(n).fill(DEFAULT);
    this.at = new Uint8Array(n);
  }

  private put(i: number, ch: string, wd: number, st: Style): void {
    this.ch[i] = ch;
    this.wd[i] = wd;
    this.fg[i] = st.fg;
    this.bg[i] = st.bg;
    this.at[i] = st.attrs;
  }

  /** Make cell (x,y) safe to overwrite: break a wide glyph it belongs to. */
  private unpair(x: number, y: number): void {
    const i = y * this.w + x;
    if (this.wd[i] === 0 && x > 0) {
      this.ch[i - 1] = " ";
      this.wd[i - 1] = 1;
    }
    if (this.wd[i] === 2 && x + 1 < this.w) {
      this.ch[i + 1] = " ";
      this.wd[i + 1] = 1;
    }
  }

  /** Put one glyph; returns its width (0 when it does not fit). */
  set(x: number, y: number, ch: string, st: Style, maxX = this.w): number {
    if (y < 0 || y >= this.h || x < 0 || x >= this.w) return 0;
    const cw = ch.length === 1 && ch.charCodeAt(0) < 0x300 ? 1 : cellWidth(ch.codePointAt(0)!);
    const w = cw === 0 ? 1 : cw;
    if (x + w > Math.min(maxX, this.w)) return 0;
    this.unpair(x, y);
    const i = y * this.w + x;
    if (w === 2) {
      this.unpair(x + 1, y);
      this.put(i, ch, 2, st);
      this.put(i + 1, "", 0, st);
    } else this.put(i, ch, 1, st);
    return w;
  }

  /** Fill a rectangle with spaces in `st` (usually just a background). */
  fill(x: number, y: number, w: number, h: number, st: Style): void {
    const x0 = Math.max(0, x);
    const x1 = Math.min(this.w, x + w);
    const y0 = Math.max(0, y);
    const y1 = Math.min(this.h, y + h);
    for (let yy = y0; yy < y1; yy++) {
      if (x0 < x1) {
        this.unpair(x0, yy);
        this.unpair(x1 - 1, yy);
      }
      for (let xx = x0; xx < x1; xx++) this.put(yy * this.w + xx, " ", 1, st);
    }
  }

  /** Change only the background of a rectangle, keeping what is drawn. */
  tint(x: number, y: number, w: number, h: number, bg: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) this.bg[yy * this.w + xx] = bg;
  }

  /**
   * Draw text that may contain SGR escapes, starting in style `base`. Stops
   * at maxX (exclusive). Zero-width marks join the glyph before them.
   * Returns the column after the last glyph drawn.
   */
  text(x: number, y: number, s: string, base: Style, maxX = this.w): number {
    if (y < 0 || y >= this.h) return x;
    const st: Style = { ...base };
    const lim = Math.min(maxX, this.w);
    if (s.includes("\t")) s = expandTabs(s);
    let i = 0;
    let col = x;
    let joined = false;
    while (i < s.length) {
      const c0 = s.charCodeAt(i);
      if (c0 === 0x1b) {
        ESC_RE.lastIndex = i;
        const m = ESC_RE.exec(s);
        if (m) {
          if (m[3] === "m") applySgr(st, m[1], base);
          i += m[0].length;
          continue;
        }
        i++;
        continue;
      }
      const cp = s.codePointAt(i)!;
      const chr = String.fromCodePoint(cp);
      i += chr.length;
      if (cp === 0x200d) {
        joined = true;
        continue;
      }
      if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
      const w = cp < 0x300 ? 1 : cellWidth(cp);
      if (w === 0 || joined) {
        // A combining mark or a joined glyph rides on the previous cell.
        joined = false;
        if (col > x && col - 1 < this.w) {
          let j = y * this.w + col - 1;
          if (this.wd[j] === 0 && col - 2 >= 0) j--;
          this.ch[j] += chr;
        }
        continue;
      }
      if (col + w > lim) break;
      if (col >= 0) this.set(col, y, chr, st, lim);
      col += w;
    }
    return col;
  }

  /** The plain characters of row y between x0 and x1. */
  rowText(y: number, x0 = 0, x1 = this.w): string {
    let out = "";
    for (let x = Math.max(0, x0); x < Math.min(this.w, x1); x++) {
      const i = y * this.w + x;
      if (this.wd[i] === 0) continue;
      out += this.ch[i];
    }
    return out;
  }

  /** Every row as plain text (tests, the screenshot harness). */
  lines(): string[] {
    return Array.from({ length: this.h }, (_, y) => this.rowText(y));
  }

  /** Darken everything (the backdrop behind a dialog). `fg0`/`bg0` are the
   * colours the terminal's defaults stand for. */
  dim(amount: number, fg0: number, bg0: number, color: boolean): void {
    const n = this.w * this.h;
    if (!color) {
      for (let i = 0; i < n; i++) this.at[i] = (this.at[i] | A_DIM) & ~A_BOLD;
      return;
    }
    const toRgb = (c: number, dflt: number) => (c < 0 ? dflt : isRgb(c) ? c - RGB_FLAG : rgbOf256(c));
    for (let i = 0; i < n; i++) {
      const inv = (this.at[i] & A_INVERSE) !== 0;
      let f = toRgb(this.fg[i], fg0);
      let b = toRgb(this.bg[i], bg0);
      if (inv) [f, b] = [b, f];
      this.fg[i] = RGB_FLAG | mix(f, 0, amount);
      this.bg[i] = RGB_FLAG | mix(b, 0, amount);
      this.at[i] &= ~(A_INVERSE | A_BOLD);
    }
  }
}

function styleCode(fg: number, bg: number, at: number, truecolor: boolean): string {
  const p = ["0"];
  if (at & A_BOLD) p.push("1");
  if (at & A_DIM) p.push("2");
  if (at & A_ITALIC) p.push("3");
  if (at & A_UNDER) p.push("4");
  if (at & A_INVERSE) p.push("7");
  if (at & A_STRIKE) p.push("9");
  const f = colorParams(fg, true, truecolor);
  if (f) p.push(f);
  const b = colorParams(bg, false, truecolor);
  if (b) p.push(b);
  return `\x1b[${p.join(";")}m`;
}

/**
 * The escapes that turn the screen showing `prev` (null: unknown, so
 * everything) into `next`. Leaves the style reset at the end.
 */
export function diffFrames(prev: Grid | null, next: Grid, truecolor: boolean): string {
  const same = prev && prev.w === next.w && prev.h === next.h ? prev : null;
  let out = "";
  let cx = -1;
  let cy = -1;
  let curF = NaN;
  let curB = NaN;
  let curA = -1;
  const W = next.w;
  for (let y = 0; y < next.h; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const wd = next.wd[i];
      if (wd === 0) continue;
      if (
        same &&
        same.ch[i] === next.ch[i] &&
        same.wd[i] === wd &&
        same.fg[i] === next.fg[i] &&
        same.bg[i] === next.bg[i] &&
        same.at[i] === next.at[i] &&
        (wd === 1 || same.wd[i + 1] === 0)
      )
        continue;
      if (cx !== x || cy !== y) {
        out += `\x1b[${y + 1};${x + 1}H`;
      }
      const f = next.fg[i];
      const b = next.bg[i];
      const a = next.at[i];
      if (f !== curF || b !== curB || a !== curA) {
        out += styleCode(f, b, a, truecolor);
        curF = f;
        curB = b;
        curA = a;
      }
      out += next.ch[i] || " ";
      cx = x + wd;
      cy = y;
      // With autowrap off the cursor sticks at the last column: re-address.
      if (cx >= W) cx = -1;
    }
  }
  if (curA !== -1) out += "\x1b[0m";
  return out;
}
