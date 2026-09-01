// Line editor state: a buffer + cursor index, with logical-line navigation
// for multi-line input, and a wrap-aware layout used by the renderer.

export class LineEditor {
  buffer = "";
  cursor = 0;

  insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor--;
  }

  del(): void {
    if (this.cursor >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
  }

  left(): void {
    if (this.cursor > 0) this.cursor--;
  }

  right(): void {
    if (this.cursor < this.buffer.length) this.cursor++;
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

  deleteWordBack(): void {
    if (this.cursor === 0) return;
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.buffer[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.buffer[i - 1])) i--;
    this.buffer = this.buffer.slice(0, i) + this.buffer.slice(this.cursor);
    this.cursor = i;
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

/** Wrap the buffer into display rows of at most `width` chars, tracking where
 * the cursor lands. Explicit newlines always break a row. */
export function layoutBuffer(buffer: string, cursor: number, width: number): Layout {
  const rows: string[] = [];
  let row = "";
  let curRow = 0;
  let curCol = 0;
  for (let i = 0; i <= buffer.length; i++) {
    if (i === cursor) {
      curRow = rows.length;
      curCol = row.length;
    }
    if (i === buffer.length) break;
    const ch = buffer[i];
    if (ch === "\n") {
      rows.push(row);
      row = "";
    } else {
      row += ch;
      if (row.length >= width) {
        rows.push(row);
        row = "";
      }
    }
  }
  rows.push(row);
  return { rows, curRow, curCol };
}
