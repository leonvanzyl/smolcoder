// Line editor state: a buffer + cursor index, with logical-line navigation
// for multi-line input, word motions, and a wrap-aware layout used by the
// renderer. Positions step over whole characters (surrogate pairs, combining
// marks), and the layout measures terminal cells, so CJK and emoji line up.

import { cellWidth, nextCharIndex, prevCharIndex } from "./width";

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

export class LineEditor {
  buffer = "";
  cursor = 0;

  insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    const p = prevCharIndex(this.buffer, this.cursor);
    this.buffer = this.buffer.slice(0, p) + this.buffer.slice(this.cursor);
    this.cursor = p;
  }

  del(): void {
    if (this.cursor >= this.buffer.length) return;
    const n = nextCharIndex(this.buffer, this.cursor);
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(n);
  }

  left(): void {
    this.cursor = prevCharIndex(this.buffer, this.cursor);
  }

  right(): void {
    this.cursor = nextCharIndex(this.buffer, this.cursor);
  }

  /** Start of the word before the cursor (skipping spaces/punctuation first). */
  private wordStartBefore(): number {
    let i = this.cursor;
    while (i > 0 && !isWordChar(this.buffer[i - 1]) && this.buffer[i - 1] !== "\n") i--;
    if (i > 0 && this.buffer[i - 1] === "\n" && i === this.cursor) return i - 1;
    while (i > 0 && isWordChar(this.buffer[i - 1])) i--;
    return i;
  }

  private wordEndAfter(): number {
    let i = this.cursor;
    const n = this.buffer.length;
    while (i < n && !isWordChar(this.buffer[i]) && this.buffer[i] !== "\n") i++;
    if (i < n && this.buffer[i] === "\n" && i === this.cursor) return i + 1;
    while (i < n && isWordChar(this.buffer[i])) i++;
    return i;
  }

  wordLeft(): void {
    this.cursor = this.wordStartBefore();
  }

  wordRight(): void {
    this.cursor = this.wordEndAfter();
  }

  private lineStartIdx(): number {
    return this.buffer.lastIndexOf("\n", this.cursor - 1) + 1;
  }

  private lineEndIdx(): number {
    const nl = this.buffer.indexOf("\n", this.cursor);
    return nl < 0 ? this.buffer.length : nl;
  }

  home(): void {
    this.cursor = this.lineStartIdx();
  }

  end(): void {
    this.cursor = this.lineEndIdx();
  }

  /** Line the cursor is on (0-based) and column within it. */
  lineCol(): { line: number; col: number } {
    const before = this.buffer.slice(0, this.cursor);
    const line = (before.match(/\n/g) ?? []).length;
    const col = this.cursor - this.lineStartIdx();
    return { line, col };
  }

  lineCount(): number {
    return (this.buffer.match(/\n/g) ?? []).length + 1;
  }

  /** Move cursor up one logical line; returns false if already on the first. */
  upLine(): boolean {
    const { line, col } = this.lineCol();
    if (line === 0) return false;
    const lines = this.buffer.split("\n");
    let idx = 0;
    for (let i = 0; i < line - 1; i++) idx += lines[i].length + 1;
    this.cursor = idx + Math.min(col, lines[line - 1].length);
    return true;
  }

  downLine(): boolean {
    const { line, col } = this.lineCol();
    const lines = this.buffer.split("\n");
    if (line >= lines.length - 1) return false;
    let idx = 0;
    for (let i = 0; i <= line; i++) idx += lines[i].length + 1;
    this.cursor = idx + Math.min(col, lines[line + 1].length);
    return true;
  }

  killToLineStart(): void {
    const start = this.lineStartIdx();
    this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor);
    this.cursor = start;
  }

  /** ctrl+k: delete to the end of the line (or the newline itself at the end). */
  killToLineEnd(): void {
    let end = this.lineEndIdx();
    if (end === this.cursor && end < this.buffer.length) end++;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(end);
  }

  deleteWordBack(): void {
    if (this.cursor === 0) return;
    const i = this.wordStartBefore();
    this.buffer = this.buffer.slice(0, i) + this.buffer.slice(this.cursor);
    this.cursor = i;
  }

  deleteWordForward(): void {
    const j = this.wordEndAfter();
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(j);
  }

  clear(): void {
    this.buffer = "";
    this.cursor = 0;
  }

  set(text: string): void {
    this.buffer = text;
    this.cursor = text.length;
  }
}

export interface Layout {
  rows: string[];
  curRow: number;
  curCol: number;
}

/** Wrap the buffer into display rows of at most `width` cells, tracking
 * where the cursor lands (curCol is in cells). Explicit newlines always break
 * a row; a wide character that would straddle the edge moves to the next row.
 * Tabs show as 4 spaces. */
export function layoutBuffer(buffer: string, cursor: number, width: number): Layout {
  const rows: string[] = [];
  let row = "";
  let rowW = 0;
  let curRow = 0;
  let curCol = 0;
  let i = 0;
  const atCursor = () => {
    curRow = rows.length;
    curCol = rowW;
  };
  while (i <= buffer.length) {
    if (i === cursor) atCursor();
    if (i === buffer.length) break;
    const cp = buffer.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (ch === "\n") {
      rows.push(row);
      row = "";
      rowW = 0;
      i++;
      continue;
    }
    const shown = ch === "\t" ? "    " : ch;
    const w = ch === "\t" ? 4 : cellWidth(cp);
    if (rowW + w > width && rowW > 0) {
      rows.push(row);
      row = "";
      rowW = 0;
      if (i === cursor) atCursor();
    }
    row += shown;
    rowW += w;
    i += ch.length;
    if (rowW >= width && i < buffer.length && buffer[i] !== "\n") {
      rows.push(row);
      row = "";
      rowW = 0;
    }
  }
  rows.push(row);
  return { rows, curRow, curCol };
}
