// Every colour and glyph the TUI draws comes from here, as semantic roles:
// background, panel, element, border, text, muted, accent, success, warning,
// error and the diff and syntax colours. Panels are derived from the
// terminal's own background (asked for with OSC 11), so the app sits on the
// user's background instead of painting over it. Colours are 24-bit where the
// terminal says it can (COLORTERM, Windows Terminal), else the nearest of the
// 256-colour cube. NO_COLOR turns colours off (bold, dim and inverse stay).
// Old Windows consoles get ASCII glyphs, because their fonts lack box and
// braille characters.

export interface Glyphs {
  /** Heavy left border of panels (user messages, the prompt box, toasts). */
  bar: string;
  /** Thin vertical rule (reasoning, quotes, code gutters). */
  vline: string;
  hr: string;
  /** Half block under the prompt box (its bottom padding). */
  half: string;
  /** Bottom end of the prompt's left border. */
  barEnd: string;
  tl: string;
  tr: string;
  bl: string;
  br: string;
  // square table corners and joints
  sq: { tl: string; tr: string; bl: string; br: string; t: string; b: string; l: string; r: string; x: string };
  bullet: string;
  ok: string;
  fail: string;
  warn: string;
  info: string;
  think: string;
  star: string;
  current: string;
  ellipsis: string;
  dot: string;
  up: string;
  down: string;
  meterOn: string;
  meterOff: string;
  stepDone: string;
  stepNow: string;
  stepTodo: string;
  /** Marks the footer line under a finished turn. */
  turn: string;
  spinner: string[];
  icons: Record<string, string>;
  /** Kept for older callers: the gutter of code blocks and quotes. */
  gutter: string;
  quote: string;
}

const UNICODE: Glyphs = {
  bar: "┃",
  vline: "│",
  hr: "─",
  half: "▀",
  barEnd: "╹",
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  sq: { tl: "┌", tr: "┐", bl: "└", br: "┘", t: "┬", b: "┴", l: "├", r: "┤", x: "┼" },
  bullet: "•",
  ok: "✓",
  fail: "✗",
  warn: "▲",
  info: "●",
  think: "✦",
  star: "★",
  current: "●",
  ellipsis: "…",
  dot: "·",
  up: "↑",
  down: "↓",
  meterOn: "━",
  meterOff: "─",
  stepDone: "✓",
  stepNow: "▸",
  stepTodo: "○",
  turn: "▣",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  icons: {
    read_file: "→",
    list_files: "≡",
    search: "✱",
    write_file: "←",
    edit_file: "←",
    run_command: "$",
    verification: "$",
    task: "&",
    plan: "☰",
    other: "◇",
  },
  gutter: "│",
  quote: "│",
};

const ASCII: Glyphs = {
  bar: "|",
  vline: "|",
  hr: "-",
  half: " ",
  barEnd: "|",
  tl: "+",
  tr: "+",
  bl: "+",
  br: "+",
  sq: { tl: "+", tr: "+", bl: "+", br: "+", t: "+", b: "+", l: "+", r: "+", x: "+" },
  bullet: "*",
  ok: "+",
  fail: "x",
  warn: "!",
  info: "*",
  think: "*",
  star: "*",
  current: ">",
  ellipsis: "...",
  dot: "-",
  up: "^",
  down: "v",
  meterOn: "#",
  meterOff: "-",
  stepDone: "+",
  stepNow: ">",
  stepTodo: "o",
  turn: "#",
  spinner: ["|", "/", "-", "\\"],
  icons: {
    read_file: ">",
    list_files: "=",
    search: "*",
    write_file: "<",
    edit_file: "<",
    run_command: "$",
    verification: "$",
    task: "&",
    plan: "#",
    other: "*",
  },
  gutter: "|",
  quote: "|",
};

export interface ThemeOptions {
  color: boolean;
  light: boolean;
  truecolor: boolean;
  ascii: boolean;
  /** The terminal's background (0xRRGGBB) when it told us; panels derive from it. */
  bg?: number;
}

/** 0xRRGGBB colours of every role. */
export interface Palette {
  bg: number;
  panel: number;
  element: number;
  elementHi: number;
  border: number;
  borderActive: number;
  text: number;
  muted: number;
  faint: number;
  accent: number;
  /** Text drawn on an accent background. */
  onAccent: number;
  secondary: number;
  success: number;
  warning: number;
  error: number;
  info: number;
  /** The SMOL logo, top row to bottom row. */
  logo: number[];
  code: number;
  diffAddBg: number;
  diffDelBg: number;
  diffAddLnBg: number;
  diffDelLnBg: number;
  diffAddFg: number;
  diffDelFg: number;
  lineNo: number;
  kw: number;
  str: number;
  com: number;
  num: number;
  fn: number;
  type: number;
  selection: number;
}

// ---- colour arithmetic -------------------------------------------------------

export const rgb = (r: number, g: number, b: number) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
export const rOf = (c: number) => (c >> 16) & 255;
export const gOf = (c: number) => (c >> 8) & 255;
export const bOf = (c: number) => c & 255;

/** Blend a toward b by t (0..1). */
export function mix(a: number, b: number, t: number): number {
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return rgb(m(rOf(a), rOf(b)), m(gOf(a), gOf(b)), m(bOf(a), bOf(b)));
}

const hex = (s: string) => parseInt(s.replace("#", ""), 16);

/** Relative luminance, 0..1. */
export function luminance(c: number): number {
  return (0.2126 * rOf(c) + 0.7152 * gOf(c) + 0.0722 * bOf(c)) / 255;
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** RGB of an xterm 256-colour index (the 16 system colours use common defaults). */
export function rgbOf256(i: number): number {
  const SYS = [
    "#0c0c0c", "#c50f1f", "#13a10e", "#c19c00", "#0037da", "#881798", "#3a96dd", "#cccccc",
    "#767676", "#e74856", "#16c60c", "#f9f1a5", "#3b78ff", "#b4009e", "#61d6d6", "#f2f2f2",
  ];
  if (i < 16) return hex(SYS[Math.max(0, i)]);
  if (i >= 232) {
    const v = 8 + (i - 232) * 10;
    return rgb(v, v, v);
  }
  const n = i - 16;
  return rgb(CUBE[Math.floor(n / 36)], CUBE[Math.floor(n / 6) % 6], CUBE[n % 6]);
}

/** Nearest xterm 256-colour index (cube or grey ramp) for an RGB colour. */
export function nearest256(c: number): number {
  const r = rOf(c);
  const g = gOf(c);
  const b = bOf(c);
  const step = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const ci = 16 + 36 * step(r) + 6 * step(g) + step(b);
  const cr = rgbOf256(ci);
  const avg = Math.round((r + g + b) / 3);
  const gi = avg > 238 ? 255 : avg < 8 ? 232 : 232 + Math.round((avg - 8) / 10);
  const gr = rgbOf256(gi);
  const dist = (x: number) => (rOf(x) - r) ** 2 + (gOf(x) - g) ** 2 + (bOf(x) - b) ** 2;
  return dist(gr) < dist(cr) ? gi : ci;
}

// ---- cell colours --------------------------------------------------------------
// A cell colour is -1 (the terminal's default), 0..255 (a palette index) or
// RGB_FLAG | 0xRRGGBB. Escape strings carry the same three forms.

export const DEFAULT = -1;
export const RGB_FLAG = 0x1000000;

export function isRgb(c: number): boolean {
  return c >= RGB_FLAG;
}

/** SGR parameters for a cell colour as foreground (fg) or background. */
export function colorParams(c: number, fg: boolean, truecolor: boolean): string {
  if (c < 0) return "";
  if (c >= RGB_FLAG) {
    const v = c - RGB_FLAG;
    if (truecolor) return `${fg ? 38 : 48};2;${rOf(v)};${gOf(v)};${bOf(v)}`;
    return `${fg ? 38 : 48};5;${nearest256(v)}`;
  }
  if (c < 8) return String((fg ? 30 : 40) + c);
  if (c < 16) return String((fg ? 90 : 100) + c - 8);
  return `${fg ? 38 : 48};5;${c}`;
}

type Paint = (s: string) => string;

export interface Theme {
  opts: ThemeOptions;
  g: Glyphs;
  p: Palette;
  reset: string;
  /** Cell colour of a palette value under the current colour mode. */
  cell: (c: number) => number;
  /** Escape that sets a foreground / background (empty without colour). */
  fgCode: (c: number) => string;
  bgCode: (c: number) => string;
  accent: Paint;
  bold: Paint;
  dim: Paint;
  italic: Paint;
  underline: Paint;
  strike: Paint;
  text: Paint;
  muted: Paint;
  faint: Paint;
  green: Paint;
  red: Paint;
  yellow: Paint;
  violet: Paint;
  heading: Paint;
  /** Inline `code`: warm text on an element background. */
  code: Paint;
  // syntax
  kw: Paint;
  str: Paint;
  com: Paint;
  num: Paint;
  fn: Paint;
  type: Paint;
  // diff text
  add: Paint;
  del: Paint;
}

function darkPalette(bg: number): Palette {
  const w = 0xffffff;
  const success = hex("#5fd38d");
  const error = hex("#f47067");
  const accent = hex("#38bdf8");
  return {
    bg,
    panel: mix(bg, w, 0.045),
    element: mix(bg, w, 0.085),
    elementHi: mix(bg, w, 0.13),
    border: mix(bg, w, 0.2),
    borderActive: mix(bg, w, 0.34),
    text: hex("#e6e8ec"),
    muted: hex("#8d95a3"),
    faint: hex("#5d6470"),
    accent,
    onAccent: hex("#05131c"),
    secondary: hex("#b197fc"),
    success,
    warning: hex("#f2b94b"),
    error,
    info: accent,
    logo: ["#7be3f6", "#5fd5f8", "#46c6f8", "#3bb5f5", "#4aa2f1", "#5d8fec"].map(hex),
    code: hex("#f0b37e"),
    diffAddBg: mix(bg, success, 0.13),
    diffDelBg: mix(bg, error, 0.13),
    diffAddLnBg: mix(bg, success, 0.2),
    diffDelLnBg: mix(bg, error, 0.2),
    diffAddFg: success,
    diffDelFg: error,
    lineNo: hex("#6b7280"),
    kw: hex("#c792ea"),
    str: hex("#a5d68a"),
    com: hex("#6b7280"),
    num: hex("#f2a65a"),
    fn: hex("#7cc7ff"),
    type: hex("#e7c477"),
    selection: mix(bg, accent, 0.32),
  };
}

function lightPalette(bg: number): Palette {
  const k = 0x000000;
  const success = hex("#1f883d");
  const error = hex("#cf222e");
  const accent = hex("#0066cc");
  return {
    bg,
    panel: mix(bg, k, 0.035),
    element: mix(bg, k, 0.07),
    elementHi: mix(bg, k, 0.11),
    border: mix(bg, k, 0.16),
    borderActive: mix(bg, k, 0.3),
    text: hex("#1d1d1f"),
    muted: hex("#6e6e73"),
    faint: hex("#a1a1a6"),
    accent,
    onAccent: hex("#ffffff"),
    secondary: hex("#7c3aed"),
    success,
    warning: hex("#b25e00"),
    error,
    info: accent,
    logo: ["#1aa3d9", "#1592d1", "#0f81c9", "#0a71c1", "#0866c0", "#0b5ab5"].map(hex),
    code: hex("#b4501a"),
    diffAddBg: mix(bg, hex("#2da44e"), 0.13),
    diffDelBg: mix(bg, hex("#e5534b"), 0.13),
    diffAddLnBg: mix(bg, hex("#2da44e"), 0.22),
    diffDelLnBg: mix(bg, hex("#e5534b"), 0.22),
    diffAddFg: success,
    diffDelFg: error,
    lineNo: hex("#8c8c91"),
    kw: hex("#a626a4"),
    str: hex("#3f8f3a"),
    com: hex("#9a9aa0"),
    num: hex("#b76b01"),
    fn: hex("#2f6fd6"),
    type: hex("#9a6700"),
    selection: mix(bg, accent, 0.2),
  };
}

/** The background assumed until the terminal reports its own. */
export const DEFAULT_DARK_BG = 0x101216;
export const DEFAULT_LIGHT_BG = 0xffffff;

export function makeTheme(o: ThemeOptions): Theme {
  const g = o.ascii ? ASCII : UNICODE;
  const bg = o.bg ?? (o.light ? DEFAULT_LIGHT_BG : DEFAULT_DARK_BG);
  const p = o.light ? lightPalette(bg) : darkPalette(bg);
  const cell = (c: number) => (o.color ? RGB_FLAG | c : DEFAULT);
  const fgCode = (c: number) => (o.color ? `\x1b[${colorParams(RGB_FLAG | c, true, o.truecolor)}m` : "");
  const bgCode = (c: number) => (o.color ? `\x1b[${colorParams(RGB_FLAG | c, false, o.truecolor)}m` : "");
  const sgr = (code: string): Paint => (s: string) => (code ? `\x1b[${code}m${s}\x1b[0m` : s);
  const col = (c: number, extra = ""): Paint => {
    if (!o.color) return extra ? sgr(extra) : (s: string) => s;
    return sgr((extra ? extra + ";" : "") + colorParams(RGB_FLAG | c, true, o.truecolor));
  };
  const both = (fg: number, bgc: number): Paint =>
    o.color
      ? sgr(`${colorParams(RGB_FLAG | fg, true, o.truecolor)};${colorParams(RGB_FLAG | bgc, false, o.truecolor)}`)
      : (s: string) => s;
  return {
    opts: { ...o },
    g,
    p,
    reset: "\x1b[0m",
    cell,
    fgCode,
    bgCode,
    accent: col(p.accent),
    bold: sgr("1"),
    dim: o.color ? col(p.muted) : sgr("2"),
    italic: sgr("3"),
    underline: sgr("4"),
    strike: sgr("9"),
    text: col(p.text),
    muted: o.color ? col(p.muted) : sgr("2"),
    faint: o.color ? col(p.faint) : sgr("2"),
    green: col(p.success),
    red: col(p.error),
    yellow: col(p.warning),
    violet: col(p.secondary),
    heading: col(p.accent, "1"),
    code: both(p.code, p.element),
    kw: col(p.kw),
    str: col(p.str),
    com: o.color ? col(p.com, "3") : sgr("2"),
    num: col(p.num),
    fn: col(p.fn),
    type: col(p.type),
    add: col(p.diffAddFg),
    del: col(p.diffDelFg),
  };
}

/** Light background from a COLORFGBG value like "0;15" (fg;bg). */
export function colorfgbgIsLight(v: string | undefined): boolean | null {
  if (!v) return null;
  const bg = Number(v.split(";").pop());
  if (!Number.isFinite(bg)) return null;
  return bg === 7 || bg === 15;
}

/** The colour in an OSC 11 reply body like "rgb:ffff/ffff/ffff", or null. */
export function oscColor(reply: string): number | null {
  const m = /rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
  if (!m) return null;
  const ch = (h: string) => Math.round((parseInt(h, 16) / (Math.pow(16, h.length) - 1)) * 255);
  return rgb(ch(m[1]), ch(m[2]), ch(m[3]));
}

/** Light background from an OSC 11 reply body like "rgb:ffff/ffff/ffff". */
export function oscIsLight(reply: string): boolean | null {
  const c = oscColor(reply);
  return c === null ? null : luminance(c) > 0.5;
}

/** Consoles that cannot draw braille or block glyphs: plain conhost on
 * Windows. Windows Terminal sets WT_SESSION; VS Code, mintty and others set
 * TERM_PROGRAM; ConEmu sets ConEmuANSI. */
export function needsAscii(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  if (platform !== "win32") return false;
  return !(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON" || env.ALACRITTY_LOG || env.WEZTERM_PANE);
}

export function detectOptions(env: NodeJS.ProcessEnv = process.env): ThemeOptions {
  return {
    color: !("NO_COLOR" in env && env.NO_COLOR !== ""),
    light: colorfgbgIsLight(env.COLORFGBG) ?? false,
    truecolor: /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") || !!env.WT_SESSION,
    ascii: needsAscii(env),
  };
}

/** The active theme. Swapped in place when the background is detected, so
 * modules holding `theme` see the change. */
export const theme: Theme = makeTheme(detectOptions());

export function setTheme(o: Partial<ThemeOptions>): Theme {
  const next: ThemeOptions = { ...theme.opts, ...o };
  // A new light/dark choice without a colour drops the old background.
  if (o.light !== undefined && o.bg === undefined && o.light !== theme.opts.light) delete next.bg;
  Object.assign(theme, makeTheme(next));
  return theme;
}
