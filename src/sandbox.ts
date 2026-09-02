// Workspace containment for file tools. Every path a tool touches must resolve
// inside the workspace root — including through symlinks, which is why we
// realpath the deepest EXISTING ancestor before comparing.
//
// Commands (run_command / task) cannot be contained this way. Edit mode scans
// the command text instead (commandEscapesWorkspace, below) and asks the user
// only when something reaches outside; bypass mode never asks.

import * as fs from "fs";
import * as path from "path";

export class SandboxError extends Error {}

const isWin = process.platform === "win32";

function normalizeForCompare(p: string): string {
  return isWin ? p.toLowerCase() : p;
}

export function resolveInWorkspace(root: string, userPath: string): string {
  if (typeof userPath !== "string" || userPath.trim() === "") {
    throw new SandboxError("path is required (relative to the workspace, e.g. \"src/app.js\").");
  }
  const abs = path.resolve(root, userPath);

  // realpath the deepest existing ancestor to defeat symlink escapes
  let existing = abs;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let realExisting: string;
  let realRoot: string;
  try {
    realExisting = fs.realpathSync(existing);
    realRoot = fs.realpathSync(root);
  } catch {
    throw new SandboxError(`cannot resolve path "${userPath}".`);
  }

  const rel = path.relative(normalizeForCompare(realRoot), normalizeForCompare(realExisting));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SandboxError(
      `"${userPath}" is outside the workspace. Only files inside ${root} can be accessed. Use a relative path like "src/app.js".`
    );
  }
  return abs;
}

export function relPath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/") || ".";
}

// ---------------------------------------------------------------------------
// Command containment (edit mode). A shell command cannot be sandboxed the way
// a file path can, so this is a best-effort scan of the command text for
// anything that reaches outside the workspace: absolute paths that resolve
// elsewhere, `..` climbing past the root, home-directory shortcuts, temp-dir
// variables, and package-manager global installs. A clean in-tree command
// (`npm install`, `node script.mjs`, `a && b`) runs without asking; a flagged
// one goes to the y/n prompt with the reason shown. False positives cost one
// prompt, false negatives are the accepted limit of a text scan.

const HOME_TOKENS = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%)([\\/]|$)/i;
const TEMP_TOKENS = /^(\$TMPDIR|\$\{TMPDIR\}|\$TEMP|\$TMP|%TEMP%|%TMP%|\$\{TEMP\}|\$\{TMP\})([\\/]|$)/i;
const GLOBAL_INSTALL = /\b(npm|pnpm|yarn|bun)\b[^;&|]*\s(-g|--global|global)(\s|$)/;
/** MSYS roots Git Bash maps to real places; any other one-segment `/word` on
 * Windows is a command switch (`taskkill /pid`, `dir /s`), not a path. */
const MSYS_ROOTS = /^\/(tmp|usr|etc|bin|home|mnt|dev|proc|var|opt|root)(\/|$)/i;

/** Split a command into candidate path tokens: whitespace-separated words with
 * quotes stripped, the value side of `--flag=value` and `VAR=value`, and the
 * target of `>`/`<` redirections written without a space. */
function pathCandidates(command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/\s+/)) {
    if (!raw) continue;
    let tok = raw.replace(/^[<>]+|^[\d]?[<>]+&?/, "").replace(/^["'`]+|["'`,;)]+$/g, "");
    if (!tok) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) continue; // URLs
    const eq = tok.indexOf("=");
    if (eq > 0 && /^[-\w.]+$/.test(tok.slice(0, eq))) tok = tok.slice(eq + 1);
    if (tok) out.push(tok);
  }
  return out;
}

/** Git Bash writes C:\x as /c/x; map that back so it compares like a Windows
 * path. A bare `/f` with nothing after it is left alone — that is a command
 * switch far more often than the root of drive F:. */
function fromMsys(tok: string): string {
  const m = /^\/([a-zA-Z])(\/.*)$/.exec(tok);
  if (m && isWin) return `${m[1].toUpperCase()}:${m[2].replace(/\//g, "\\")}`;
  return tok;
}

function isAbsoluteLike(tok: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(tok)) return true; // C:\ or C:/
  if (/^\\\\/.test(tok)) return true; // UNC
  return tok.startsWith("/");
}

function insideWorkspace(root: string, abs: string): boolean {
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    /* compare against the given root */
  }
  const rel = path.relative(normalizeForCompare(realRoot), normalizeForCompare(path.resolve(abs)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Why a command would reach outside the workspace, or null when every path it
 * mentions stays inside it. Only the reason text is returned; the caller
 * decides whether that means "ask" or "refuse".
 */
export function commandEscapesWorkspace(command: string, root: string): string | null {
  if (GLOBAL_INSTALL.test(command)) return "installs a package globally, outside the workspace";
  for (const tok of pathCandidates(command)) {
    if (HOME_TOKENS.test(tok)) return `uses the home directory (${tok})`;
    if (TEMP_TOKENS.test(tok)) return `uses the system temp directory (${tok})`;
    const t = fromMsys(tok);
    if (isAbsoluteLike(t)) {
      // On Windows under Git Bash, a bare POSIX path like /tmp or /usr/bin is
      // an MSYS path — never inside a Windows workspace.
      const posixOnWin = isWin && t.startsWith("/");
      if (posixOnWin && !MSYS_ROOTS.test(t)) continue; // a /switch, not a path
      if (posixOnWin || !insideWorkspace(root, t)) return `reaches outside the workspace (${tok})`;
      continue;
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(t) && !insideWorkspace(root, path.resolve(root, t))) {
      return `climbs above the workspace (${tok})`;
    }
  }
  return null;
}
