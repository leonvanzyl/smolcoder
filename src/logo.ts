// The SMOL block-letter logo. One source for both surfaces — the banner
// printed when an interactive terminal session starts, and the web UI's
// welcome screen and fresh-session view — so the branding cannot drift or
// quietly disappear from one of them again.

import { c } from "./util";

export const LOGO_ROWS: readonly string[] = [
  "███████╗ ███╗   ███╗  ██████╗  ██╗     ",
  "██╔════╝ ████╗ ████║ ██╔═══██╗ ██║     ",
  "███████╗ ██╔████╔██║ ██║   ██║ ██║     ",
  "╚════██║ ██║╚██╔╝██║ ██║   ██║ ██║     ",
  "███████║ ██║ ╚═╝ ██║ ╚██████╔╝ ███████╗",
  "╚══════╝ ╚═╝     ╚═╝  ╚═════╝  ╚══════╝",
];

/** Every row is padded to this many cells. */
export const LOGO_WIDTH = LOGO_ROWS[0].length;

/** The logo as one block of text (trailing padding removed) for the web page. */
export const LOGO_TEXT = LOGO_ROWS.map((r) => r.trimEnd()).join("\n");

/** One-line fallback for wherever the art does not fit. */
export function plainBrand(version: string): string {
  return `${c.bold("smol")}${c.dim(c.bold("coder"))} ${c.dim("v" + version)}`;
}

/**
 * Lines of the terminal banner for a terminal `cols` wide: the block logo in
 * the accent colour with "coder vX" beside its last row, or the plain
 * one-liner when the terminal is too narrow for the art.
 */
export function terminalLogo(cols: number, version: string): string[] {
  const indent = " ";
  if (cols < indent.length + LOGO_WIDTH) return [plainBrand(version)];
  const tailText = `coder v${version}`;
  const tail = c.dim(c.bold("coder") + " v" + version);
  const tailFits = cols >= indent.length + LOGO_WIDTH + 2 + tailText.length;
  const lines = [""];
  LOGO_ROWS.forEach((row, i) => {
    const last = i === LOGO_ROWS.length - 1;
    lines.push(indent + c.cyan(row) + (last && tailFits ? "  " + tail : ""));
  });
  if (!tailFits) lines.push(indent + tail);
  lines.push("");
  return lines;
}
