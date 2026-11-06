// Terminal cell widths, written in-house (zero deps). Wide CJK and emoji take
// two cells, combining marks and joiners none, and tabs are expanded before
// layout. Every function here understands SGR/OSC escape codes, so colored
// strings can be measured, cut and wrapped without splitting an escape.

/** Matches one escape sequence: CSI (colors, cursor moves) or OSC (links, titles). */
// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b\[[0-9;?:]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

// [from, to] code point ranges, sorted, for binary search.
const ZERO: [number, number][] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f],
  [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4], [0x0e31, 0x0e31], [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff],
  [0x1f3fb, 0x1f3ff], // skin-tone modifiers ride on the emoji before them
  [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];

const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: [number, number][]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Cells one code point takes: 0 (combining, joiners, controls), 1 or 2. */
export function cellWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (inRanges(cp, ZERO)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

const ZWJ = 0x200d;

/** Tabs become spaces up to the next stop, so widths are predictable. */
export function expandTabs(s: string, tab = 4): string {
  if (!s.includes("\t")) return s;
  let out = "";
  let col = 0;
  for (const part of s.split(/(\n)/)) {
    if (part === "\n") {
      out += part;
      col = 0;
      continue;
    }
    for (const ch of part) {
      if (ch === "\t") {
        const n = tab - (col % tab);
        out += " ".repeat(n);
        col += n;
      } else {
        out += ch;
        col += cellWidth(ch.codePointAt(0)!);
      }
    }
  }
  return out;
}

/** Remove escape sequences (colors, links). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?:]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/** Visible width in terminal cells. A character after a zero-width joiner
 * joins the emoji before it (👩‍💻 is one glyph), and tabs count as 4-stops. */
export function stringWidth(s: string): number {
  const plain = expandTabs(stripAnsi(s));
  let w = 0;
  let joined = false;
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!;
    if (cp === ZWJ) {
      joined = true;
      continue;
    }
    if (joined) {
      joined = false;
      continue;
    }
    w += cellWidth(cp);
  }
  return w;
}

interface Piece {
  /** An escape sequence (width 0) or one character with its width. */
  s: string;
  w: number;
  esc: boolean;
}

/** Split into escapes and characters. ZWJ-joined characters get width 0. */
function pieces(s: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  let joined = false;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      ESC_RE.lastIndex = i;
      const m = ESC_RE.exec(s);
      if (m) {
        out.push({ s: m[0], w: 0, esc: true });
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    let w: number = cellWidth(cp);
    if (cp === ZWJ) joined = true;
    else if (joined) {
      joined = false;
      w = 0;
    }
    out.push({ s: ch, w, esc: false });
  }
  return out;
}

/** Cut a (possibly colored) string to at most `max` cells, keeping every
 * escape code so colors still reset. `ellipsis` replaces the cut tail. */
export function truncateWidth(s: string, max: number, ellipsis = ""): string {
  if (max <= 0) return "";
  if (stringWidth(s) <= max) return s;
  const ew = stringWidth(ellipsis);
  const room = Math.max(0, max - ew);
  let out = "";
  let seen = 0;
  let cut = false;
  for (const p of pieces(expandTabs(s))) {
    if (p.esc) {
      out += p.s;
      continue;
    }
    if (cut) continue;
    if (seen + p.w > room) {
      out += ellipsis;
      cut = true;
      continue;
    }
    out += p.s;
    seen += p.w;
  }
  return out;
}

/** Pad with spaces to `w` cells (after truncating if longer). */
export function padEndWidth(s: string, w: number): string {
  const t = truncateWidth(s, w);
  return t + " ".repeat(Math.max(0, w - stringWidth(t)));
}

/** Shorten plain text to `max` cells with "…" in the middle: long model names
 * keep their family and their quant/size suffix. */
export function middleTruncate(s: string, max: number, ellipsis = "…"): string {
  if (stringWidth(s) <= max) return s;
  if (max <= stringWidth(ellipsis)) return truncateWidth(s, max);
  const chars = Array.from(stripAnsi(s));
  const room = max - stringWidth(ellipsis);
  const headRoom = Math.ceil(room / 2);
  let head = "";
  let hw = 0;
  let i = 0;
  for (; i < chars.length; i++) {
    const w = stringWidth(chars[i]);
    if (hw + w > headRoom) break;
    head += chars[i];
    hw += w;
  }
  let tail = "";
  let tw = 0;
  for (let j = chars.length - 1; j >= i; j--) {
    const w = stringWidth(chars[j]);
    if (hw + tw + w > room) break;
    tail = chars[j] + tail;
    tw += w;
  }
  return head + ellipsis + tail;
}

/**
 * Word-wrap a (possibly colored) line to `width` cells. Breaks at spaces;
 * a word longer than a row is split. `indent` (plain or colored) prefixes
 * every continuation row, e.g. to keep a bullet's text aligned. Active SGR
 * state is carried across rows so a bold run that wraps stays bold.
 */
export function wrapAnsi(line: string, width: number, indent = ""): string[] {
  line = expandTabs(line);
  width = Math.max(4, width);
  if (stringWidth(line) <= width) return [line];
  const indentW = stringWidth(indent);
  const ps = pieces(line);
  const rows: string[] = [];
  let row = "";
  let rowW = 0;
  let sgr = ""; // escapes seen since the last reset, re-applied on new rows
  // Last break opportunity in the current row: string index after a space.
  let breakAt = -1;
  let breakW = 0;
  let breakSgr = "";
  const limit = () => (rows.length === 0 ? width : width - indentW);
  const newRow = (carry: string, carryW: number, state: string) => {
    rows.push(row.replace(/ +$/, "") + (state ? "\x1b[0m" : ""));
    row = (state ? state : "") + carry;
    rowW = carryW;
    breakAt = -1;
  };
  for (const p of ps) {
    if (p.esc) {
      row += p.s;
      if (/^\x1b\[0?m$/.test(p.s)) sgr = "";
      else if (p.s.endsWith("m")) sgr += p.s;
      continue;
    }
    if (rowW + p.w > limit() && p.s !== " ") {
      if (breakAt >= 0) {
        const carry = row.slice(breakAt);
        const carryW = rowW - breakW;
        row = row.slice(0, breakAt);
        newRow(carry, carryW, breakSgr);
      } else {
        newRow("", 0, sgr);
      }
    }
    if (p.s === " " && rowW + 1 > limit()) {
      // A space at the edge: break here and drop it.
      newRow("", 0, sgr);
      continue;
    }
    row += p.s;
    rowW += p.w;
    if (p.s === " ") {
      breakAt = row.length;
      breakW = rowW;
      breakSgr = sgr;
    }
  }
  rows.push(row);
  return rows.map((r, i) => (i === 0 ? r : indent + r.replace(/^((?:\x1b\[[0-9;]*m)*) +/, "$1")));
}

/** Index of the character before `i` (steps over surrogate pairs and
 * zero-width marks so the cursor never lands inside a glyph). */
export function prevCharIndex(s: string, i: number): number {
  if (i <= 0) return 0;
  let j = i - 1;
  if (j > 0 && /[\udc00-\udfff]/.test(s[j]) && /[\ud800-\udbff]/.test(s[j - 1])) j--;
  // Zero-width marks belong to the character before them.
  while (j > 0) {
    const cp = s.codePointAt(j)!;
    if (cellWidth(cp) !== 0 || cp < 0x20) break;
    j--;
    if (j > 0 && /[\udc00-\udfff]/.test(s[j]) && /[\ud800-\udbff]/.test(s[j - 1])) j--;
  }
  return j;
}

/** Index after the character at `i` (and any zero-width marks that follow). */
export function nextCharIndex(s: string, i: number): number {
  if (i >= s.length) return s.length;
  let j = i + String.fromCodePoint(s.codePointAt(i)!).length;
  while (j < s.length) {
    const cp = s.codePointAt(j)!;
    if (cp < 0x20 || cellWidth(cp) !== 0) break;
    j += String.fromCodePoint(cp).length;
  }
  return j;
}
