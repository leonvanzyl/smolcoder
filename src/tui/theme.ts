// Every color and glyph the TUI draws comes from here. NO_COLOR turns colors
// off (bold, dim and inverse stay: they are not colors). Light terminals get
// their own palette — detected with an OSC 11 background query, else
// COLORFGBG. Diff tints use 24-bit color when COLORTERM says so, else the
// 256-color cube. Old Windows consoles (no Windows Terminal, no VS Code) get
// ASCII spinner and box glyphs, because their fonts lack braille and blocks.

export interface Glyphs {
  bar: string;
  bullet: string;
  ok: string;
  fail: string;
  think: string;
  star: string;
  current: string;
  ellipsis: string;
  dot: string;
  up: string;
  down: string;
  hr: string;
  gutter: string;
  fenceTop: string;
  fenceBottom: string;
  quote: string;
  spinner: string[];
}

const UNICODE: Glyphs = {
  bar: "▌",
  bullet: "•",
  ok: "✓",
  fail: "✗",
  think: "✦",
  star: "★",
  current: "●",
  ellipsis: "…",
  dot: "·",
  up: "↑",
  down: "↓",
  hr: "─",
  gutter: "│",
  fenceTop: "╭─",
  fenceBottom: "╰─",
  quote: "│",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const ASCII: Glyphs = {
  bar: "|",
  bullet: "*",
  ok: "+",
  fail: "x",
  think: "*",
  star: "*",
  current: ">",
  ellipsis: "...",
  dot: "-",
  up: "^",
  down: "v",
  hr: "-",
  gutter: "|",
  fenceTop: "+-",
  fenceBottom: "+-",
  quote: "|",
  spinner: ["|", "/", "-", "\\"],
};

export interface ThemeOptions {
  color: boolean;
  light: boolean;
  truecolor: boolean;
  ascii: boolean;
}

type Paint = (s: string) => string;

export interface Theme {
  opts: ThemeOptions;
  g: Glyphs;
  reset: string;
  /** Raw SGR prefixes, for rows that re-apply a background after resets. */
  accentCode: string;
  boxBg: string;
  selCode: string;
  addBg: string;
  delBg: string;
  accent: Paint;
  bold: Paint;
  dim: Paint;
  italic: Paint;
  underline: Paint;
  strike: Paint;
  muted: Paint;
  green: Paint;
  red: Paint;
  yellow: Paint;
  heading: Paint;
  code: Paint;
  // syntax
  kw: Paint;
  str: Paint;
  com: Paint;
  num: Paint;
  fn: Paint;
  // diff
  add: Paint;
  del: Paint;
}

function sgr(code: string): Paint {
  return (s: string) => (code ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export function makeTheme(o: ThemeOptions): Theme {
  const col = (code: string) => (o.color ? code : "");
  const g = o.ascii ? ASCII : UNICODE;
  const accentCode = o.color ? (o.light ? (o.truecolor ? "38;2;0;102;204" : "38;5;25") : "36") : "";
  const sel = o.color ? (o.light ? "48;5;25;38;5;231" : "48;5;31;38;5;231") : "7";
  const boxBg = o.color ? (o.light ? "48;5;254" : "48;5;235") : "";
  let addBg = "";
  let delBg = "";
  if (o.color) {
    if (o.truecolor) {
      addBg = o.light ? "48;2;218;251;225" : "48;2;18;54;30";
      delBg = o.light ? "48;2;255;235;233" : "48;2;66;22;26";
    } else {
      addBg = o.light ? "48;5;194" : "48;5;22";
      delBg = o.light ? "48;5;224" : "48;5;52";
    }
  }
  const addFg = o.light ? "38;5;28" : "32";
  const delFg = o.light ? "38;5;124" : "31";
  return {
    opts: o,
    g,
    reset: "\x1b[0m",
    accentCode: accentCode ? `\x1b[${accentCode}m` : "",
    boxBg: boxBg ? `\x1b[${boxBg}m` : "",
    selCode: `\x1b[${sel}m`,
    addBg: addBg ? `\x1b[${addBg}m` : "",
    delBg: delBg ? `\x1b[${delBg}m` : "",
    accent: sgr(accentCode),
    bold: sgr("1"),
    dim: sgr("2"),
    italic: sgr("3"),
    underline: sgr("4"),
    strike: sgr("9"),
    muted: sgr(col(o.light ? "38;5;244" : "90")),
    green: sgr(col(o.light ? "38;5;28" : "32")),
    red: sgr(col(o.light ? "38;5;124" : "31")),
    yellow: sgr(col(o.light ? "38;5;130" : "33")),
    heading: sgr(o.color ? `1;${accentCode}` : "1"),
    code: sgr(col(o.light ? "38;5;166" : "38;5;180")),
    kw: sgr(col(o.light ? "38;5;90" : "38;5;176")),
    str: sgr(col(o.light ? "38;5;28" : "38;5;114")),
    com: sgr(o.color ? (o.light ? "3;38;5;245" : "3;38;5;243") : "2"),
    num: sgr(col(o.light ? "38;5;130" : "38;5;215")),
    fn: sgr(col(o.light ? "38;5;25" : "38;5;75")),
    add: (s: string) => (o.color ? `${addBg ? `\x1b[${addBg}m` : ""}\x1b[${addFg}m${s}\x1b[0m` : s),
    del: (s: string) => (o.color ? `${delBg ? `\x1b[${delBg}m` : ""}\x1b[${delFg}m${s}\x1b[0m` : s),
  };
}

/** Light background from a COLORFGBG value like "0;15" (fg;bg). */
export function colorfgbgIsLight(v: string | undefined): boolean | null {
  if (!v) return null;
  const bg = Number(v.split(";").pop());
  if (!Number.isFinite(bg)) return null;
  return bg === 7 || bg === 15;
}

/** Light background from an OSC 11 reply body like "rgb:ffff/ffff/ffff". */
export function oscIsLight(reply: string): boolean | null {
  const m = /rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
  if (!m) return null;
  const ch = (h: string) => parseInt(h, 16) / (Math.pow(16, h.length) - 1);
  const lum = 0.2126 * ch(m[1]) + 0.7152 * ch(m[2]) + 0.0722 * ch(m[3]);
  return lum > 0.5;
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
  Object.assign(theme, makeTheme({ ...theme.opts, ...o }));
  return theme;
}
