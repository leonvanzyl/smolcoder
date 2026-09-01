// The five file tools: read_file, write_file, edit_file, list_files, search.
// Design rules for small models: flat string params, generous coaching in every
// error message (an error IS a prompt — write it like one), and hard output
// caps so a single result can't flood a small context window.

import * as fs from "fs";
import * as path from "path";
import { resolveInWorkspace, relPath, SandboxError } from "../sandbox";
import { truncateEnd } from "../util";

const READ_LINE_LIMIT = 250;
const READ_CHAR_LIMIT = 12000;
const LIST_ENTRY_LIMIT = 200;
const SEARCH_MATCH_LIMIT = 50;
const SEARCH_FILE_SIZE_LIMIT = 512 * 1024;

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", ".next", ".nuxt", ".cache",
  "coverage", "__pycache__", ".venv", "venv", ".idea", ".vscode", "target",
  ".svelte-kit", ".turbo", "vendor",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf", ".zip",
  ".gz", ".tar", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".bin",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".avi",
  ".wasm", ".db", ".sqlite", ".jar", ".class", ".pyc",
]);

function isProbablyBinary(filePath: string): boolean {
  if (BINARY_EXTS.has(path.extname(filePath).toLowerCase())) return true;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  } catch {
    return true;
  }
  return false;
}

export function readFile(root: string, args: any): string {
  const abs = resolveInWorkspace(root, args.path);
  if (!fs.existsSync(abs)) {
    const dir = path.dirname(abs);
    let hint = "";
    if (fs.existsSync(dir)) {
      const near = fs.readdirSync(dir).slice(0, 15).join(", ");
      if (near) hint = ` Files that do exist in ${relPath(root, dir)}: ${near}`;
    }
    return `Error: file "${args.path}" does not exist.${hint}`;
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    return `Error: "${args.path}" is a folder, not a file. Use list_files with {"path": "${args.path}"} to see what is inside it.`;
  }
  if (isProbablyBinary(abs)) {
    return `Error: "${args.path}" looks like a binary file (${stat.size} bytes) and cannot be read as text.`;
  }

  const content = fs.readFileSync(abs, "utf8");
  const lines = content.split("\n");
  const total = lines.length;
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.min(Math.max(1, Number(args.limit) || READ_LINE_LIMIT), 1000);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  let body = slice.join("\n");
  let charCut = false;
  if (body.length > READ_CHAR_LIMIT) {
    body = body.slice(0, READ_CHAR_LIMIT);
    charCut = true;
  }
  const end = charCut ? offset - 1 + body.split("\n").length : offset - 1 + slice.length;
  if (offset === 1 && end >= total && !charCut) return body;
  return (
    body +
    `\n\n[showing lines ${offset}-${end} of ${total}. Call read_file with {"path": "${args.path}", "offset": ${end + 1}} to continue.]`
  );
}

export function writeFile(root: string, args: any): string {
  const abs = resolveInWorkspace(root, args.path);
  if (typeof args.content !== "string") {
    return 'Error: content is required and must be a string. Example: {"path": "notes.txt", "content": "hello"}';
  }
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return `Error: "${args.path}" is an existing folder; cannot write a file there.`;
  }
  const existed = fs.existsSync(abs);
  const prevLines = existed ? fs.readFileSync(abs, "utf8").split("\n").length : 0;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, args.content, "utf8");
  const newLines = args.content.split("\n").length;
  return existed
    ? `Overwrote ${args.path} (was ${prevLines} lines, now ${newLines} lines).`
    : `Created ${args.path} (${newLines} lines).`;
}

// ---------------------------------------------------------------------------
// edit_file: exact match first, then a line-trimmed (whitespace-forgiving)
// fallback, then a "closest match" coaching error. Small models paraphrase
// whitespace constantly; forgiving matching is the difference between a usable
// and unusable local edit tool.
// ---------------------------------------------------------------------------

function findTrimmedMatch(fileLines: string[], oldLines: string[]): number[] {
  const targets = oldLines.map((l) => l.trim());
  const matches: number[] = [];
  outer: for (let i = 0; i + targets.length <= fileLines.length; i++) {
    for (let j = 0; j < targets.length; j++) {
      if (fileLines[i + j].trim() !== targets[j]) continue outer;
    }
    matches.push(i);
  }
  return matches;
}

function closestSnippet(fileLines: string[], oldText: string): string {
  const firstLine = oldText.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  if (!firstLine) return "";
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(firstLine);
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < fileLines.length; i++) {
    const line = norm(fileLines[i]);
    if (!line) continue;
    let score = 0;
    if (line === target) score = 1000;
    else if (line.includes(target) || target.includes(line)) score = 500;
    else {
      const words = target.split(" ").filter((w) => w.length > 2);
      for (const w of words) if (line.includes(w)) score += w.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestScore < 6) return "";
  const start = Math.max(0, bestIdx - 2);
  const end = Math.min(fileLines.length, bestIdx + 3);
  return fileLines.slice(start, end).join("\n");
}

export function editFile(root: string, args: any): string {
  const abs = resolveInWorkspace(root, args.path);
  if (!fs.existsSync(abs)) {
    return `Error: file "${args.path}" does not exist. Use write_file to create a new file.`;
  }
  const oldText = args.old_text;
  const newText = args.new_text ?? "";
  if (typeof oldText !== "string" || oldText.length === 0) {
    return 'Error: old_text is required — copy the exact text from the file that you want to replace. To create a new file use write_file instead.';
  }
  if (typeof newText !== "string") {
    return "Error: new_text must be a string (use an empty string to delete the old text).";
  }

  const content = fs.readFileSync(abs, "utf8");

  // Tier 1: exact match.
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 1) {
    fs.writeFileSync(abs, content.replace(oldText, newText), "utf8");
    return `Edited ${args.path}: replaced 1 occurrence.`;
  }
  if (occurrences > 1) {
    return `Error: old_text appears ${occurrences} times in ${args.path}. Include a few more surrounding lines in old_text so it matches exactly one place.`;
  }

  // Tier 2: line-trimmed match (forgives leading/trailing whitespace per line).
  const fileLines = content.split("\n");
  const oldLines = oldText.split("\n");
  const matches = findTrimmedMatch(fileLines, oldLines);
  if (matches.length === 1) {
    const start = matches[0];
    const replaced = [
      ...fileLines.slice(0, start),
      ...newText.split("\n"),
      ...fileLines.slice(start + oldLines.length),
    ].join("\n");
    fs.writeFileSync(abs, replaced, "utf8");
    return `Edited ${args.path}: replaced 1 occurrence (whitespace differences in old_text were ignored).`;
  }
  if (matches.length > 1) {
    return `Error: old_text matches ${matches.length} places in ${args.path} (ignoring whitespace). Include more surrounding lines to make it unique.`;
  }

  // Tier 3: coach with the closest real snippet.
  const snippet = closestSnippet(fileLines, oldText);
  if (snippet) {
    return (
      `Error: old_text was not found in ${args.path}. The closest matching part of the file is below — copy it EXACTLY (including spaces) as old_text and try again:\n---\n${truncateEnd(snippet, 1500)}\n---`
    );
  }
  return `Error: old_text was not found in ${args.path}. Call read_file on it first and copy the exact text you want to change.`;
}

export function listFiles(root: string, args: any): string {
  const startRel = typeof args.path === "string" && args.path.trim() ? args.path : ".";
  const start = resolveInWorkspace(root, startRel);
  if (!fs.existsSync(start)) return `Error: folder "${startRel}" does not exist.`;
  if (!fs.statSync(start).isDirectory()) {
    return `Error: "${startRel}" is a file, not a folder. Use read_file to read it.`;
  }

  const entries: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (truncated || depth > 6) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of names) {
      if (truncated) return;
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = relPath(root, abs);
      if (e.isDirectory()) {
        entries.push(rel + "/");
        if (entries.length >= LIST_ENTRY_LIMIT) { truncated = true; return; }
        walk(abs, depth + 1);
      } else {
        entries.push(rel);
        if (entries.length >= LIST_ENTRY_LIMIT) { truncated = true; return; }
      }
    }
  };
  walk(start, 0);

  if (entries.length === 0) return `The folder "${startRel}" is empty.`;
  let out = entries.join("\n");
  if (truncated) {
    out += `\n\n[listing capped at ${LIST_ENTRY_LIMIT} entries. Call list_files with {"path": "<subfolder>"} to explore deeper.]`;
  }
  return out;
}

export function searchFiles(root: string, args: any): string {
  const pattern = args.pattern;
  if (typeof pattern !== "string" || !pattern) {
    return 'Error: pattern is required. Example: {"pattern": "function main"}';
  }
  const startRel = typeof args.path === "string" && args.path.trim() ? args.path : ".";
  const start = resolveInWorkspace(root, startRel);
  if (!fs.existsSync(start)) return `Error: folder "${startRel}" does not exist.`;

  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  const matches: string[] = [];
  let filesScanned = 0;
  let done = false;

  const walk = (dir: string, depth: number) => {
    if (done || depth > 8) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (done) return;
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (filesScanned++ > 5000) { done = true; return; }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > SEARCH_FILE_SIZE_LIMIT || isProbablyBinary(abs)) continue;
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${relPath(root, abs)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (matches.length >= SEARCH_MATCH_LIMIT) { done = true; break; }
        }
      }
    }
  };

  const startIsFile = fs.statSync(start).isFile();
  if (startIsFile) {
    walk(path.dirname(start), 8); // degenerate case; just scan that dir shallowly
  } else {
    walk(start, 0);
  }

  if (matches.length === 0) {
    return `No matches for "${pattern}" in ${startRel}. (Searched ${filesScanned} files. Tip: try a shorter or simpler pattern.)`;
  }
  let out = matches.join("\n");
  if (matches.length >= SEARCH_MATCH_LIMIT) {
    out += `\n\n[stopped at ${SEARCH_MATCH_LIMIT} matches — narrow the pattern or search a subfolder with {"path": "..."}]`;
  }
  return out;
}

export { SandboxError };
