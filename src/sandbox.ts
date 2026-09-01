// Workspace containment for file tools. Every path a tool touches must resolve
// inside the workspace root — including through symlinks, which is why we
// realpath the deepest EXISTING ancestor before comparing.
//
// Commands (run_command / task) cannot be contained this way; that is exactly
// why they sit behind the approval gate in write mode and only run freely in yolo.

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
