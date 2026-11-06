// A small VT emulator for driving the TUI in tests and for screenshots:
// the main and alternate screens, cursor addressing and movement, erase in
// display / line, SGR (16, 256 and 24-bit colour, bold, dim, italic,
// underline, inverse, strike), wide characters and autowrap. Escapes it does
// not model (OSC, mouse modes, synchronized output) are consumed silently.
"use strict";
const { cellWidth } = require("../dist/tui/width");

const BLANK = () => ({ ch: " ", w: 1, fg: -1, bg: -1, at: 0 });

class Screen {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, BLANK));
  }
}

const A = { bold: 1, dim: 2, italic: 4, under: 8, inverse: 16, strike: 32 };

class VT {
  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    this.main = new Screen(cols, rows);
    this.alt = new Screen(cols, rows);
    this.scr = this.main;
    this.altActive = false;
    this.x = 0;
    this.y = 0;
    this.saved = { x: 0, y: 0 };
    this.st = { fg: -1, bg: -1, at: 0 };
    this.cursorVisible = true;
    this.autowrap = true;
    this.pendingWrap = false;
    this.buf = "";
    this.modes = new Set();
    this.osc = [];
  }

  /** A fake stdout for the Tui: write() feeds the emulator. */
  stdout() {
    const vt = this;
    const listeners = [];
    return {
      isTTY: true,
      get columns() { return vt.cols; },
      get rows() { return vt.rows; },
      write(s) { vt.feed(String(s)); return true; },
      on(ev, fn) { if (ev === "resize") listeners.push(fn); },
      removeListener(ev, fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      resize(c, r) { vt.resize(c, r); for (const f of listeners) f(); },
    };
  }

  resize(cols, rows) {
    const fit = (s) => {
      const n = new Screen(cols, rows);
      for (let y = 0; y < Math.min(rows, s.rows); y++) for (let x = 0; x < Math.min(cols, s.cols); x++) n.cells[y][x] = s.cells[y][x];
      return n;
    };
    this.main = fit(this.main);
    this.alt = fit(this.alt);
    this.scr = this.altActive ? this.alt : this.main;
    this.cols = cols;
    this.rows = rows;
    this.x = Math.min(this.x, cols - 1);
    this.y = Math.min(this.y, rows - 1);
  }

  feed(s) {
    s = this.buf + s;
    this.buf = "";
    let i = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 0x1b) {
        const r = this.escape(s, i);
        if (r < 0) {
          this.buf = s.slice(i);
          return;
        }
        i = r;
        continue;
      }
      if (c === 13) { this.x = 0; this.pendingWrap = false; i++; continue; }
      if (c === 10) { this.lf(); i++; continue; }
      if (c === 8) { this.x = Math.max(0, this.x - 1); this.pendingWrap = false; i++; continue; }
      if (c === 7) { i++; continue; }
      if (c < 32) { i++; continue; }
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      this.print(ch, cp);
    }
  }

  lf() {
    this.pendingWrap = false;
    if (this.y === this.rows - 1) this.scrollUp();
    else this.y++;
  }

  scrollUp() {
    const sc = this.scr.cells;
    sc.shift();
    sc.push(Array.from({ length: this.cols }, BLANK));
  }

  print(ch, cp) {
    let w = cellWidth(cp);
    const row = this.scr.cells[this.y];
    if (w === 0) {
      // combining: attach to the previous cell
      const px = this.pendingWrap ? this.x : this.x - 1;
      if (px >= 0 && row[px]) row[px].ch += ch;
      return;
    }
    if (this.pendingWrap) {
      if (this.autowrap) {
        this.x = 0;
        this.lf();
      }
      this.pendingWrap = false;
    }
    if (this.x + w > this.cols) {
      if (this.autowrap) {
        this.x = 0;
        this.lf();
      } else {
        this.x = this.cols - w;
      }
    }
    const r = this.scr.cells[this.y];
    const put = (x, cell) => {
      if (x < 0 || x >= this.cols) return;
      // break wide glyphs we overwrite half of
      if (r[x].w === 0 && x > 0) r[x - 1] = { ...BLANK(), fg: r[x - 1].fg, bg: r[x - 1].bg };
      if (r[x].w === 2 && x + 1 < this.cols) r[x + 1] = { ...BLANK(), fg: r[x + 1].fg, bg: r[x + 1].bg };
      r[x] = cell;
    };
    put(this.x, { ch, w, fg: this.st.fg, bg: this.st.bg, at: this.st.at });
    if (w === 2) put(this.x + 1, { ch: "", w: 0, fg: this.st.fg, bg: this.st.bg, at: this.st.at });
    if (this.x + w >= this.cols) {
      this.x = this.cols - 1;
      this.pendingWrap = true;
    } else this.x += w;
  }

  escape(s, i) {
    if (i + 1 >= s.length) return -1;
    const n = s[i + 1];
    if (n === "[") {
      let j = i + 2;
      while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
      if (j >= s.length) return -1;
      this.csi(s.slice(i + 2, j), s[j]);
      return j + 1;
    }
    if (n === "]" || n === "P" || n === "_" || n === "^") {
      let j = i + 2;
      while (j < s.length) {
        if (s[j] === "\x07") { this.osc.push(s.slice(i + 2, j)); return j + 1; }
        if (s[j] === "\x1b" && s[j + 1] === "\\") { this.osc.push(s.slice(i + 2, j)); return j + 2; }
        j++;
      }
      return -1;
    }
    if (n === "7") { this.saved = { x: this.x, y: this.y }; return i + 2; }
    if (n === "8") { this.x = this.saved.x; this.y = this.saved.y; return i + 2; }
    if (n === "(" || n === ")") return i + 3;
    return i + 2;
  }

  csi(body, f) {
    const priv = body.startsWith("?");
    const ps = (priv ? body.slice(1) : body).split(";").map((x) => (x === "" ? NaN : Number(x)));
    const p1 = (d) => (Number.isFinite(ps[0]) && ps[0] > 0 ? ps[0] : d);
    this.pendingWrap = false;
    if (priv && (f === "h" || f === "l")) {
      for (const m of ps) {
        const on = f === "h";
        if (on) this.modes.add(m);
        else this.modes.delete(m);
        if (m === 1049 || m === 47 || m === 1047) {
          if (on && !this.altActive) {
            this.saved = { x: this.x, y: this.y };
            this.alt = new Screen(this.cols, this.rows);
            this.scr = this.alt;
            this.altActive = true;
          } else if (!on && this.altActive) {
            this.scr = this.main;
            this.altActive = false;
            this.x = this.saved.x;
            this.y = this.saved.y;
          }
        }
        if (m === 25) this.cursorVisible = on;
        if (m === 7) this.autowrap = on;
      }
      return;
    }
    if (priv) return;
    switch (f) {
      case "H":
      case "f":
        this.y = Math.min(this.rows - 1, (Number.isFinite(ps[0]) && ps[0] > 0 ? ps[0] : 1) - 1);
        this.x = Math.min(this.cols - 1, (Number.isFinite(ps[1]) && ps[1] > 0 ? ps[1] : 1) - 1);
        break;
      case "A": this.y = Math.max(0, this.y - p1(1)); break;
      case "B": this.y = Math.min(this.rows - 1, this.y + p1(1)); break;
      case "C": this.x = Math.min(this.cols - 1, this.x + p1(1)); break;
      case "D": this.x = Math.max(0, this.x - p1(1)); break;
      case "G": this.x = Math.min(this.cols - 1, p1(1) - 1); break;
      case "d": this.y = Math.min(this.rows - 1, p1(1) - 1); break;
      case "J": this.eraseDisplay(Number.isFinite(ps[0]) ? ps[0] : 0); break;
      case "K": this.eraseLine(Number.isFinite(ps[0]) ? ps[0] : 0); break;
      case "m": this.sgr(ps); break;
      default: break;
    }
  }

  blankCell() {
    return { ch: " ", w: 1, fg: -1, bg: this.st.bg, at: 0 };
  }

  eraseLine(mode) {
    const r = this.scr.cells[this.y];
    const [a, b] = mode === 0 ? [this.x, this.cols] : mode === 1 ? [0, this.x + 1] : [0, this.cols];
    for (let x = a; x < b; x++) r[x] = this.blankCell();
  }

  eraseDisplay(mode) {
    const sc = this.scr.cells;
    if (mode === 2 || mode === 3) {
      for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) sc[y][x] = this.blankCell();
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      for (let y = this.y + 1; y < this.rows; y++) for (let x = 0; x < this.cols; x++) sc[y][x] = this.blankCell();
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let y = 0; y < this.y; y++) for (let x = 0; x < this.cols; x++) sc[y][x] = this.blankCell();
    }
  }

  sgr(ps) {
    if (!ps.length || (ps.length === 1 && !Number.isFinite(ps[0]))) ps = [0];
    for (let i = 0; i < ps.length; i++) {
      const n = Number.isFinite(ps[i]) ? ps[i] : 0;
      const st = this.st;
      if (n === 0) { st.fg = -1; st.bg = -1; st.at = 0; }
      else if (n === 1) st.at |= A.bold;
      else if (n === 2) st.at |= A.dim;
      else if (n === 3) st.at |= A.italic;
      else if (n === 4) st.at |= A.under;
      else if (n === 7) st.at |= A.inverse;
      else if (n === 9) st.at |= A.strike;
      else if (n === 22) st.at &= ~(A.bold | A.dim);
      else if (n === 23) st.at &= ~A.italic;
      else if (n === 24) st.at &= ~A.under;
      else if (n === 27) st.at &= ~A.inverse;
      else if (n === 29) st.at &= ~A.strike;
      else if (n >= 30 && n <= 37) st.fg = { i: n - 30 };
      else if (n >= 90 && n <= 97) st.fg = { i: n - 90 + 8 };
      else if (n >= 40 && n <= 47) st.bg = { i: n - 40 };
      else if (n >= 100 && n <= 107) st.bg = { i: n - 100 + 8 };
      else if (n === 39) st.fg = -1;
      else if (n === 49) st.bg = -1;
      else if (n === 38 || n === 48) {
        let c = -1;
        if (ps[i + 1] === 5) { c = { i: ps[i + 2] }; i += 2; }
        else if (ps[i + 1] === 2) { c = { r: ps[i + 2], g: ps[i + 3], b: ps[i + 4] }; i += 4; }
        if (n === 38) st.fg = c; else st.bg = c;
      }
    }
  }

  /** Plain text of every row of the visible screen. */
  lines() {
    return this.scr.cells.map((r) => r.map((c) => (c.w === 0 ? "" : c.ch)).join("").replace(/\s+$/, ""));
  }

  text() {
    return this.lines().join("\n");
  }

  cell(x, y) {
    return this.scr.cells[y][x];
  }

  /** Whether `s` is on screen (a row contains it). */
  has(s) {
    return this.lines().some((l) => l.includes(s));
  }

  /** The row index containing `s`, or -1. */
  find(s) {
    return this.lines().findIndex((l) => l.includes(s));
  }
}

// ---- HTML rendering ----------------------------------------------------------

const SYS = ["#0c0c0c", "#c50f1f", "#13a10e", "#c19c00", "#0037da", "#881798", "#3a96dd", "#cccccc",
  "#767676", "#e74856", "#16c60c", "#f9f1a5", "#3b78ff", "#b4009e", "#61d6d6", "#f2f2f2"];
const CUBE = [0, 95, 135, 175, 215, 255];
function idxRgb(i) {
  if (i < 16) return SYS[i];
  if (i >= 232) { const v = 8 + (i - 232) * 10; return `rgb(${v},${v},${v})`; }
  const n = i - 16;
  return `rgb(${CUBE[Math.floor(n / 36)]},${CUBE[Math.floor(n / 6) % 6]},${CUBE[n % 6]})`;
}
function css(c, dflt) {
  if (c === -1 || c === undefined) return dflt;
  if (c.i !== undefined) return idxRgb(c.i);
  return `rgb(${c.r},${c.g},${c.b})`;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Box-drawing and block glyphs drawn with CSS so they join seamlessly, as
// terminals draw them.
function glyphCss(ch, fg) {
  const line = (dir, heavy) => {
    const t = heavy ? 2 : 1;
    if (dir === "v") return `linear-gradient(${fg},${fg}) no-repeat calc(50% - ${t / 2}px) 0/${t}px 100%`;
    return `linear-gradient(${fg},${fg}) no-repeat 0 calc(50% - ${t / 2}px)/100% ${t}px`;
  };
  const half = (side, heavy) => {
    const t = heavy ? 2 : 1;
    if (side === "up") return `linear-gradient(${fg},${fg}) no-repeat calc(50% - ${t / 2}px) 0/${t}px 50%`;
    if (side === "down") return `linear-gradient(${fg},${fg}) no-repeat calc(50% - ${t / 2}px) 100%/${t}px 50%`;
    if (side === "left") return `linear-gradient(${fg},${fg}) no-repeat 0 calc(50% - ${t / 2}px)/50% ${t}px`;
    return `linear-gradient(${fg},${fg}) no-repeat 100% calc(50% - ${t / 2}px)/50% ${t}px`;
  };
  switch (ch) {
    case "│": return line("v");
    case "┃": return line("v", true);
    case "─": return line("h");
    case "━": return line("h", true);
    case "╹": return half("up", true);
    case "┌": case "╭": return [half("down"), half("right")].join(",");
    case "┐": case "╮": return [half("down"), half("left")].join(",");
    case "└": case "╰": return [half("up"), half("right")].join(",");
    case "┘": case "╯": return [half("up"), half("left")].join(",");
    case "├": return [line("v"), half("right")].join(",");
    case "┤": return [line("v"), half("left")].join(",");
    case "┬": return [line("h"), half("down")].join(",");
    case "┴": return [line("h"), half("up")].join(",");
    case "┼": return [line("v"), line("h")].join(",");
    case "▀": return `linear-gradient(${fg},${fg}) no-repeat 0 0/100% 50%`;
    case "▄": return `linear-gradient(${fg},${fg}) no-repeat 0 100%/100% 50%`;
    case "█": return `linear-gradient(${fg},${fg})`;
    case "▌": return `linear-gradient(${fg},${fg}) no-repeat 0 0/50% 100%`;
    case "▐": return `linear-gradient(${fg},${fg}) no-repeat 100% 0/50% 100%`;
    default: return null;
  }
}

/** The screen as a standalone HTML page with exact colours. */
function toHTML(vt, opts = {}) {
  const fg0 = opts.fg || "#e6e8ec";
  const bg0 = opts.bg || "#101216";
  const cw = opts.cellW || 9;
  const ch = opts.cellH || 19;
  const font = opts.font || "Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', monospace";
  const fontSize = opts.fontSize || 15;
  const cursor = opts.cursor !== false && vt.cursorVisible ? { x: vt.x, y: vt.y } : null;
  let rows = "";
  vt.scr.cells.forEach((row, y) => {
    let html = "";
    row.forEach((c, x) => {
      if (c.w === 0) return;
      let f = css(c.fg, fg0);
      let b = css(c.bg, bg0);
      if (c.at & A.inverse) [f, b] = [b, f];
      const styles = [`left:${x * cw}px`, `width:${c.w * cw}px`];
      if (b !== bg0) styles.push(`background-color:${b}`);
      let color = f;
      if (c.at & A.dim) styles.push("opacity:0.6");
      if (c.at & A.bold) styles.push("font-weight:700");
      if (c.at & A.italic) styles.push("font-style:italic");
      const deco = [];
      if (c.at & A.under) deco.push("underline");
      if (c.at & A.strike) deco.push("line-through");
      if (deco.length) styles.push(`text-decoration:${deco.join(" ")}`);
      const g = glyphCss(c.ch, color);
      if (g) {
        styles.push(`background:${g}${b !== bg0 ? "," + b : ""}`);
        html += `<i style="${styles.join(";")}"></i>`;
        return;
      }
      if (c.ch === " " && b === bg0 && !deco.length) return;
      styles.push(`color:${color}`);
      if (cursor && cursor.x === x && cursor.y === y) styles.push(`box-shadow:inset 0 0 0 1px ${fg0}`);
      html += `<i style="${styles.join(";")}">${esc(c.ch === " " ? " " : c.ch)}</i>`;
    });
    if (cursor && cursor.y === y && row[cursor.x] && row[cursor.x].ch === " ") {
      html += `<i style="left:${cursor.x * cw}px;width:${cw}px;background:${fg0};opacity:.85"></i>`;
    }
    rows += `<div class="r" style="top:${y * ch}px">${html}</div>`;
  });
  const W = vt.cols * cw;
  const H = vt.rows * ch;
  const pad = opts.pad ?? 14;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:${opts.frame || "#1b1d22"}}
.t{position:relative;width:${W}px;height:${H}px;background:${bg0};font:${fontSize}px/${ch}px ${font};color:${fg0};overflow:hidden;margin:${pad * 2}px;border-radius:6px;box-shadow:0 0 0 ${pad}px ${bg0}}
.r{position:absolute;left:0;height:${ch}px;width:${W}px}
.r i{position:absolute;top:0;height:${ch}px;font-style:normal;text-align:center;white-space:pre;overflow:visible}
</style></head><body><div class="t">${rows}</div></body></html>`;
}

module.exports = { VT, toHTML };
