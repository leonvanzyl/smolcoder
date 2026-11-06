// The five file tools: read_file, write_file, edit_file, list_files, search.
// Design rules for small models: flat string params, generous coaching in every
// error message (an error IS a prompt — write it like one), and hard output
// caps so a single result can't flood a small context window.

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { resolveInWorkspace, relPath, SandboxError } from "../sandbox";
import { truncateEnd } from "../util";
import { isHistoryPlaceholder } from "../history";

const READ_LINE_LIMIT = 250;
// Must stay under TOOL_RESULT_CAP (10000) so the registry's outer truncateMiddle
// never silently middle-cuts a read chunk while the trailer claims lines X-Y
// were shown contiguously.
const READ_CHAR_LIMIT = 9000;
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

export function readFile(root: string, args: any, maxChars = READ_CHAR_LIMIT): string {
  const charLimit = Math.max(128, Math.min(READ_CHAR_LIMIT, Math.floor(maxChars)));
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
  if (stat.size > 8 * 1024 * 1024) return `Error: "${args.path}" exceeds the 8 MB text-file limit. Use a command to extract a small relevant section into a workspace file, then read that file.`;
  if (isProbablyBinary(abs)) {
    return `Error: "${args.path}" looks like a binary file (${stat.size} bytes) and cannot be read as text.`;
  }

  const content = fs.readFileSync(abs, "utf8");
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const offset = Math.max(1, Number(args.offset) || 1);
  if (offset > total) {
    return `The file "${args.path}" has only ${total} line${total === 1 ? "" : "s"}; you have already read all of it.`;
  }
  const limit = Math.min(Math.max(1, Number(args.limit) || READ_LINE_LIMIT), 1000);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  let body = slice.join("\n");
  let end = offset - 1 + slice.length;
  let charCut = false;
  if (body.length > charLimit) {
    const kept = body.slice(0, charLimit).split("\n");
    if (kept.length > 1) {
      // Cut on a line boundary so the trailer never claims a partially-shown
      // line was read.
      kept.pop();
      body = kept.join("\n");
      end = offset - 1 + kept.length;
      charCut = true;
    } else {
      // A single line longer than the limit: there is no line boundary to
      // advance to, so a line-based "continue" would loop forever. Serve the
      // head and say so, without a continuation offset.
      body = body.slice(0, charLimit);
      return (
        body +
        `\n\n[line ${offset} of ${total} is very long; showing its first ${charLimit} characters only.]`
      );
    }
  }
  if (offset === 1 && end >= total && !charCut) return body;
  return (
    body +
    `\n\n[showing lines ${offset}-${end} of ${total}. Call read_file with {"path": "${args.path}", "offset": ${end + 1}} to continue.]`
  );
}

/** UI-only details of a successful write/edit (never sent to the model). */
export interface FileDiff {
  path: string;
  before: string;
  after: string;
}

const DIFF_CAP = 200 * 1024;
const capDiff = (s: string) => (s.length > DIFF_CAP ? s.slice(0, DIFF_CAP) : s);

export function writeFile(root: string, args: any, change?: { diff?: FileDiff }): string {
  const abs = resolveInWorkspace(root, args.path);
  if (typeof args.content !== "string") {
    return 'Error: content is required and must be a string. Example: {"path": "notes.txt", "content": "hello"}';
  }
  if (isHistoryPlaceholder(args.content)) {
    return "Error: this is a history placeholder, not source code. No file was changed. Read the current file and provide the actual complete contents.";
  }
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return `Error: "${args.path}" is an existing folder; cannot write a file there.`;
  }
  const existed = fs.existsSync(abs);
  const previous = existed ? fs.readFileSync(abs, "utf8") : "";
  const prevLines = existed ? previous.split("\n").length : 0;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, args.content, "utf8");
  if (change) change.diff = { path: String(args.path), before: capDiff(previous), after: capDiff(args.content) };
  const newLines = args.content.split("\n").length;
  return existed
    ? `Overwrote ${args.path} (was ${prevLines} lines, now ${newLines} lines).`
    : `Created ${args.path} (${newLines} lines).`;
}

// ---------------------------------------------------------------------------
// edit_file: exact match first, then a line-trimmed (whitespace-forgiving)
// match that re-indents the replacement, then the same two with typographic
// quotes/dashes/spaces normalised, then a "closest match" coaching error.
// Small models paraphrase whitespace constantly; forgiving matching is the
// difference between a usable and unusable local edit tool.
// ---------------------------------------------------------------------------

/** Typographic look-alikes local models (and copied docs) substitute for
 * ASCII. Every replacement is one UTF-16 unit for one, so offsets into the
 * normalised text are offsets into the original. */
export function normalizeTypography(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ");
}

function findLineMatches(fileLines: string[], oldLines: string[], key: (l: string) => string): number[] {
  const targets = oldLines.map(key);
  const keyed = fileLines.map(key);
  const matches: number[] = [];
  outer: for (let i = 0; i + targets.length <= keyed.length; i++) {
    for (let j = 0; j < targets.length; j++) {
      if (keyed[i + j] !== targets[j]) continue outer;
    }
    matches.push(i);
  }
  return matches;
}

const leadingWs = (l: string) => /^[ \t]*/.exec(l)![0];

/** Shift `line` from indentation `from` to `to`. Lines indented less than
 * `from` (a dedented closing brace) move by the same amount where possible. */
function shiftIndent(line: string, from: string, to: string): string {
  if (!line.trim()) return line;
  if (line.startsWith(from)) return to + line.slice(from.length);
  if (to.startsWith(from)) return to.slice(from.length) + line;
  if (from.startsWith(to)) {
    const lead = leadingWs(line);
    return line.slice(Math.min(lead.length, from.length - to.length));
  }
  return line;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** The file indents with tabs and old_text with spaces (or the reverse):
 * a function that rewrites a line's leading indent into the file's unit,
 * or null when both use the same one. The width of one tab in spaces comes
 * from the matched pairs, else from the spaces themselves, else 4. */
function indentTranslation(oldLines: string[], matched: string[]): ((l: string) => string) | null {
  const pairs = oldLines.map((l, i) => [leadingWs(l), leadingWs(matched[i] ?? "")]).filter((_, i) => oldLines[i].trim());
  const only = (s: string, c: string) => [...s].every((x) => x === c);
  const spacesToTabs = pairs.every(([o, f]) => only(o, " ") && only(f, "\t")) && pairs.some(([o, f]) => o && f);
  const tabsToSpaces = !spacesToTabs && pairs.every(([o, f]) => only(o, "\t") && only(f, " ")) && pairs.some(([o, f]) => o && f);
  if (!spacesToTabs && !tabsToSpaces) return null;
  const spaces = (p: string[]) => (spacesToTabs ? p[0] : p[1]).length;
  const tabs = (p: string[]) => (spacesToTabs ? p[1] : p[0]).length;
  const ratio = pairs.find((p) => tabs(p) > 0 && spaces(p) > 0 && spaces(p) % tabs(p) === 0);
  const width = ratio ? spaces(ratio) / tabs(ratio) : pairs.map(spaces).filter(Boolean).reduce(gcd, 0) || 4;
  return (l) => {
    const lead = leadingWs(l);
    if (!lead || !l.trim()) return l;
    if (spacesToTabs) {
      if (!only(lead, " ")) return l;
      return "\t".repeat(Math.floor(lead.length / width)) + " ".repeat(lead.length % width) + l.slice(lead.length);
    }
    if (!only(lead, "\t")) return l;
    return " ".repeat(lead.length * width) + l.slice(lead.length);
  };
}

/**
 * The model's old_text matched with different indentation. Re-indent
 * new_text by the delta of the first non-blank matched line, so a block
 * copied at the wrong depth is written at the depth it replaces (Python
 * breaks silently otherwise). When the old lines were not shifted evenly
 * (often only the first line's indentation was dropped), unchanged context
 * lines keep the file's own text and the first line takes the file's indent.
 */
function reindent(newLines: string[], oldLines: string[], matched: string[]): string[] {
  const k = oldLines.findIndex((l) => l.trim());
  if (k < 0) return newLines;
  const unit = indentTranslation(oldLines, matched);
  if (unit) {
    oldLines = oldLines.map(unit);
    newLines = newLines.map(unit);
  }
  const from = leadingWs(oldLines[k]);
  const to = leadingWs(matched[k]);
  // new_text already written at the file's depth (only old_text was not).
  const firstNew = newLines.find((l) => l.trim());
  if (from !== to && firstNew !== undefined && leadingWs(firstNew) === to) return newLines;
  const consistent = oldLines.every((l, i) => !l.trim() || leadingWs(shiftIndent(l, from, to)) === leadingWs(matched[i]));
  if (consistent) return from === to ? newLines : newLines.map((l) => shiftIndent(l, from, to));
  const fileFor = new Map<string, string>();
  oldLines.forEach((l, i) => { if (l.trim() && oldLines.indexOf(l) === oldLines.lastIndexOf(l)) fileFor.set(l, matched[i]); });
  const out = newLines.map((l) => fileFor.get(l) ?? l);
  const first = newLines.findIndex((l) => l.trim());
  if (first >= 0 && from !== to && !fileFor.has(newLines[first]) && leadingWs(newLines[first]) === from) {
    out[first] = to + newLines[first].slice(from.length);
  }
  return out;
}

const countOf = (haystack: string, needle: string) => (needle ? haystack.split(needle).length - 1 : 0);

/** Edits that succeeded this session, so a repeat is known to be one. */
export type AppliedEdits = Set<string>;

export function editFile(root: string, args: any, change?: { diff?: FileDiff }, applied?: AppliedEdits): string {
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
  if (isHistoryPlaceholder(newText)) {
    return "Error: this is a history placeholder, not source code. No file was changed. Read the current file and provide the actual replacement text.";
  }

  const rawContent = fs.readFileSync(abs, "utf8");
  // Normalize to LF for all matching, re-serialize with the file's dominant EOL.
  // Otherwise a model that sends "\n"-separated old_text can never exact-match a
  // CRLF file, and the fallback rebuild leaves the file with mixed line endings.
  const crlf = rawContent.includes("\r\n");
  const content = crlf ? rawContent.replace(/\r\n/g, "\n") : rawContent;
  const oldNorm = oldText.replace(/\r\n/g, "\n");
  const newNorm = newText.replace(/\r\n/g, "\n");
  const serialize = (s: string) => (crlf ? s.replace(/\n/g, "\r\n") : s);
  if (oldNorm === newNorm) {
    return `Error: old_text and new_text are identical, so there is nothing to change in ${args.path}. Put the text you want in new_text.`;
  }
  const editKey = JSON.stringify([abs, oldNorm, newNorm]);
  const write = (next: string, before: string, after: string) => {
    fs.writeFileSync(abs, serialize(next), "utf8");
    if (change) change.diff = { path: String(args.path), before: capDiff(before), after: capDiff(after) };
    applied?.add(editKey);
  };
  // Typographic characters old_text used where the file has plain ones get
  // the same substitution in new_text, or curly quotes land in code.
  const plainNew = (matchedText: string) => {
    let out = newNorm;
    for (const ch of new Set(oldNorm)) {
      const plain = normalizeTypography(ch);
      if (plain !== ch && !matchedText.includes(ch)) out = out.split(ch).join(plain);
    }
    return out;
  };

  // Tier 1: exact match.
  const occurrences = countOf(content, oldNorm);
  // An append-style edit (new_text extends old_text) that was already made
  // still matches old_text inside its own result. Re-applying it would
  // duplicate the appended part.
  if (occurrences >= 1 && newNorm.includes(oldNorm) && newNorm.trim().length > oldNorm.trim().length) {
    const applied = countOf(content, newNorm);
    if (applied >= 1 && occurrences === applied * countOf(newNorm, oldNorm)) return alreadyApplied(args.path);
  }
  if (occurrences === 1) {
    write(content.replace(oldNorm, () => newNorm), oldNorm, newNorm);
    return `Edited ${args.path}: replaced 1 occurrence.`;
  }
  if (occurrences > 1) {
    return `Error: old_text appears ${occurrences} times in ${args.path}. Include a few more surrounding lines in old_text so it matches exactly one place.`;
  }

  // Line tiers compare whole lines. One trailing newline on old_text would
  // otherwise demand an extra empty line in the file.
  const fileLines = content.split("\n");
  const oldLines = oldNorm.replace(/\n$/, "").split("\n");
  const newLines = newNorm.replace(/\n$/, "").split("\n");
  const lineTier = (key: (l: string) => string, note: string, typographic = false): string | null => {
    const matches = findLineMatches(fileLines, oldLines, key);
    if (matches.length > 1) {
      return `Error: old_text matches ${matches.length} places in ${args.path} (ignoring ${note}). Include more surrounding lines to make it unique.`;
    }
    if (matches.length !== 1) return null;
    const start = matches[0];
    const matched = fileLines.slice(start, start + oldLines.length);
    const lines = typographic ? plainNew(matched.join("\n")).replace(/\n$/, "").split("\n") : newLines;
    const replacement = newNorm === "" ? [] : reindent(lines, oldLines, matched);
    write([...fileLines.slice(0, start), ...replacement, ...fileLines.slice(start + oldLines.length)].join("\n"), matched.join("\n"), replacement.join("\n"));
    return `Edited ${args.path}: replaced 1 occurrence (${note} in old_text were ignored).`;
  };

  // Tier 2: line-trimmed match (forgives leading/trailing whitespace per line).
  const trimmed = lineTier((l) => l.trim(), "whitespace differences");
  if (trimmed) return trimmed;

  // Tier 3: typographic quotes, dashes and spaces.
  const normContent = normalizeTypography(content);
  const normOld = normalizeTypography(oldNorm);
  const normCount = countOf(normContent, normOld);
  if (normCount === 1) {
    const at = normContent.indexOf(normOld);
    const before = content.slice(at, at + normOld.length);
    const replacement = plainNew(before);
    write(content.slice(0, at) + replacement + content.slice(at + normOld.length), before, replacement);
    return `Edited ${args.path}: replaced 1 occurrence (typographic quote, dash or space differences were ignored).`;
  }
  if (normCount > 1) {
    return `Error: old_text matches ${normCount} places in ${args.path} (ignoring quote and dash styles). Include more surrounding lines to make it unique.`;
  }
  const typographic = lineTier((l) => normalizeTypography(l).trim(), "whitespace and quote/dash differences", true);
  if (typographic) return typographic;

  // old_text is gone and new_text is there: this edit was already made (a
  // repeated call, or a retry after a cut-off reply). Only when this exact
  // edit succeeded earlier, or new_text sits where old_text's closest match
  // points: a line of new_text elsewhere in the file says nothing.
  const normNew = normalizeTypography(newNorm);
  const starts = new Set(findLineMatches(fileLines, newLines, (l) => normalizeTypography(l).trim()));
  for (let at = normNew ? normContent.indexOf(normNew) : -1; at >= 0; at = normContent.indexOf(normNew, at + 1)) {
    starts.add(normContent.slice(0, at).split("\n").length - 1);
  }
  if (applied?.has(editKey) && (starts.size || !newNorm.trim())) return alreadyApplied(args.path);
  if (newNorm.trim().length >= 12 && starts.size) {
    const near = closestLines(fileLines, oldText);
    const span = newLines.length;
    if (near?.lines.some((i) => [...starts].some((b) => i >= b - 1 && i <= b + span))) return alreadyApplied(args.path);
  }

  // Tier 4: coach with the closest real snippet.
  const snippet = closestSnippet(fileLines, oldText);
  if (snippet) {
    return (
      `Error: old_text was not found in ${args.path}. Closest source starts at line ${snippet.offset}. Read this range: ${JSON.stringify({path:args.path,offset:snippet.offset,limit:snippet.limit})}. Use a small exact replacement; this snippet is only a location hint, not the whole block you tried to replace.\n---\n${truncateEnd(snippet.text, 1500)}\n---`
    );
  }
  return `Error: old_text was not found in ${args.path}. Call read_file on it first and copy the exact text you want to change.`;
}

function alreadyApplied(p: string): string {
  return `No change: ${p} already contains new_text, so this edit was already applied.`;
}

/** The file lines that best match old_text's first real line (all ties). */
function closestLines(fileLines: string[], oldText: string): { lines: number[]; oldLineCount: number } | null {
  const candidates = oldText.split("\n").map((l) => l.trim());
  // A bare closing brace is not a useful anchor for a failed method edit.
  const firstLine = candidates.find((l) => /[a-zA-Z_$]/.test(l) && l.length > 6) ?? "";
  if (!firstLine) return null;
  const norm = (s: string) => normalizeTypography(s).replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(firstLine);
  let best: number[] = [];
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
      best = [i];
    } else if (score > 0 && score === bestScore) best.push(i);
  }
  if (!best.length || bestScore < 6) return null;
  return { lines: best, oldLineCount: candidates.length };
}

function closestSnippet(fileLines: string[], oldText: string): { text: string; offset: number; limit: number } | null {
  const near = closestLines(fileLines, oldText);
  if (!near) return null;
  const start = Math.max(0, near.lines[0] - 2);
  const end = Math.min(fileLines.length, start + Math.min(20, Math.max(8, near.oldLineCount + 4)));
  return { text: fileLines.slice(start, end).join("\n"), offset: start + 1, limit: end - start };
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
      if (e.isSymbolicLink()) continue; // never follow links out of the workspace
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

/** Lines longer than this are generated or minified code: noise, not evidence. */
const SEARCH_LINE_MAX = 400;

interface SearchHit { file: string; line: number; text: string }

/** One match per line as `path:line: text`; a file with several matches gets
 * its path once as a header. Never longer than the ungrouped form. */
export function formatSearchHits(hits: SearchHit[]): string {
  const out: string[] = [];
  for (let i = 0; i < hits.length; ) {
    let j = i;
    while (j < hits.length && hits[j].file === hits[i].file) j++;
    if (j - i === 1) out.push(`${hits[i].file}:${hits[i].line}: ${hits[i].text}`);
    else {
      out.push(`${hits[i].file}:`);
      for (let k = i; k < j; k++) out.push(`  ${hits[k].line}: ${hits[k].text}`);
    }
    i = j;
  }
  return out.join("\n");
}

function globToRegExp(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return re;
}

/** Simple patterns from the workspace's top-level .gitignore (no negations,
 * no nested ignore files). Exported for tests. */
export function topLevelIgnore(root: string): (rel: string, isDir: boolean) => boolean {
  let text = "";
  try { text = fs.readFileSync(path.join(root, ".gitignore"), "utf8"); } catch { return () => false; }
  const rules: { re: RegExp; dirOnly: boolean; anchored: boolean }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const dirOnly = line.endsWith("/");
    line = line.replace(/\/+$/, "");
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    if (!line) continue;
    try { rules.push({ re: new RegExp(`^${globToRegExp(line)}$`), dirOnly, anchored }); } catch { /* skip */ }
  }
  if (!rules.length) return () => false;
  return (rel, isDir) => {
    const norm = rel.replace(/\\/g, "/");
    const base = norm.slice(norm.lastIndexOf("/") + 1);
    return rules.some((r) => (!r.dirOnly || isDir) && r.re.test(r.anchored ? norm : base));
  };
}

const isMinifiedName = (name: string) => /\.min\.(js|mjs|cjs|css)$|\.map$/i.test(name);

let rgProbe: boolean | undefined;
/** Whether ripgrep is on PATH (probed once per process). */
export function ripgrepAvailable(): boolean {
  if (rgProbe !== undefined) return rgProbe;
  try {
    const r = spawnSync("rg", ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
    rgProbe = r.status === 0 && /ripgrep/i.test(r.stdout ?? "");
  } catch {
    rgProbe = false;
  }
  return rgProbe;
}

/** ripgrep, when present: it honours every .gitignore and is much faster on
 * large trees. Returns null to fall back to the JS walk. */
function searchWithRipgrep(root: string, target: string, pattern: string, literal: boolean): { hits: SearchHit[]; more: boolean } | null {
  const args = [
    "--no-config", "--null", "--line-number", "--with-filename", "--no-heading", "--color", "never",
    "--path-separator", "/", "--ignore-case", "--max-columns", String(SEARCH_LINE_MAX), "--max-filesize", "512K",
    "--no-require-git", "--no-ignore-parent", "--hidden", "--sort", "path", "--max-count", String(SEARCH_MATCH_LIMIT),
    "-g", "!.*/", ...[...IGNORED_DIRS].flatMap((d) => ["-g", `!${d}/`]),
    "-g", "!*.min.js", "-g", "!*.min.mjs", "-g", "!*.min.cjs", "-g", "!*.min.css", "-g", "!*.map",
    ...(literal ? ["--fixed-strings"] : []), "-e", pattern, "--", target,
  ];
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync("rg", args, { cwd: root, encoding: "utf8", timeout: 4000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  } catch {
    return null;
  }
  const stdout = String(r.stdout ?? "");
  if (r.status === 1 && !stdout) return { hits: [], more: false };
  if (!stdout) return null; // error (bad regex for rg's dialect, timeout): use the JS walk
  const hits: SearchHit[] = [];
  let more = false;
  for (const line of stdout.split("\n")) {
    const nul = line.indexOf("\0");
    if (nul < 0) continue;
    const m = /^(\d+):([\s\S]*)$/.exec(line.slice(nul + 1));
    if (!m) continue;
    const text = m[2].replace(/\r$/, "");
    if (text.length > SEARCH_LINE_MAX || /^\[Omitted long /.test(text)) continue;
    if (hits.length >= SEARCH_MATCH_LIMIT) { more = true; break; }
    hits.push({ file: line.slice(0, nul).replace(/^\.\//, ""), line: Number(m[1]), text: text.trim().slice(0, 200) });
  }
  return { hits, more };
}

export function searchFiles(root: string, args: any, opts: { rg?: boolean } = {}): string {
  const pattern = args.pattern;
  if (typeof pattern !== "string" || !pattern) {
    return 'Error: pattern is required. Example: {"pattern": "function main"}';
  }
  const startRel = typeof args.path === "string" && args.path.trim() ? args.path : ".";
  const start = resolveInWorkspace(root, startRel);
  if (!fs.existsSync(start)) return `Error: folder "${startRel}" does not exist.`;

  const startIsFile = fs.statSync(start).isFile();

  let re: RegExp;
  let literal = false;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    literal = true;
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  const finish = (hits: SearchHit[], more: boolean, scanned?: number) => {
    if (hits.length === 0) {
      return `No matches for "${pattern}" in ${startRel}. (${scanned !== undefined ? `Searched ${scanned} files. ` : ""}Tip: try a shorter or simpler pattern.)`;
    }
    let out = formatSearchHits(hits);
    if (more || hits.length >= SEARCH_MATCH_LIMIT) {
      out += `\n\n[stopped at ${SEARCH_MATCH_LIMIT} matches — narrow the pattern or search a subfolder with {"path": "..."}]`;
    }
    return out;
  };

  if (opts.rg ?? ripgrepAvailable()) {
    const target = relPath(root, start) || ".";
    const found = searchWithRipgrep(root, target, pattern, literal);
    if (found) return finish(found.hits, found.more);
  }

  const ignored = topLevelIgnore(root);
  const hits: SearchHit[] = [];
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
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of names) {
      if (done) return;
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      // A symlink's Dirent.isDirectory() is false, so a file symlink would
      // otherwise fall straight into readFileSync and leak its target's
      // contents (e.g. creds -> ~/.ssh/id_rsa) into model context. Skip all.
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (startIsFile && abs !== start) continue;
      const rel = relPath(root, abs);
      if (!startIsFile && ignored(rel, e.isDirectory())) continue;
      if (e.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (isMinifiedName(e.name) && !startIsFile) continue;
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
      const lines = text.split(/\r?\n/);
      // Minified bundles: a few enormous lines. Every match would be noise.
      if (!startIsFile && text.length > 2000 && text.length / lines.length > 300) continue;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > SEARCH_LINE_MAX) continue;
        if (re.test(lines[i])) {
          hits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (hits.length >= SEARCH_MATCH_LIMIT) { done = true; break; }
        }
      }
    }
  };

  if (startIsFile) {
    walk(path.dirname(start), 8); // degenerate case; just scan that dir shallowly
  } else {
    walk(start, 0);
  }
  return finish(hits, false, filesScanned);
}

export { SandboxError };
