// Post-write syntax check — a harness hook that fires after every write_file /
// edit_file. A local model that writes a 300-line game.js with one stray
// brace gets a blank page and no idea why; catching the parse error in the
// tool result (with the line number) turns that into a one-step fix. Only
// parsers we can trust are used: node's own for JS (and inline <script> in
// HTML), JSON.parse, python's compiler when python is on PATH, and for
// TypeScript the project's own node_modules/typescript (syntax only, run in a
// child node under run_command's trust rules, skipped when the project has
// none). Nothing runs the written code.

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commandEscapesWorkspace } from "../sandbox";

const CHECK_TIMEOUT_MS = 8000;
const MAX_CHECK_BYTES = 2 * 1024 * 1024;

let pythonExe: string | null | undefined; // undefined = not probed yet

function findPython(): string | null {
  if (pythonExe !== undefined) return pythonExe;
  pythonExe = null;
  for (const exe of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const r = spawnSync(exe, ["-I", "-c", "print(1)"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status === 0 && r.stdout.trim() === "1") {
      pythonExe = exe;
      break;
    }
  }
  return pythonExe;
}

interface JsError {
  line: number | null;
  message: string;
}

function parseNodeError(stderr: string, tmpFile: string): JsError | null {
  const lines = stderr.split(/\r?\n/);
  let line: number | null = null;
  const loc = lines.find((l) => l.includes(tmpFile));
  if (loc) {
    const m = /:(\d+)\s*$/.exec(loc.trim());
    if (m) line = Number(m[1]);
  }
  const err = lines.find((l) => /^\w*Error: /.test(l));
  if (!err) return null;
  return { line, message: err.replace(/^SyntaxError: /, "") };
}

/** Run `node --check` on a snippet, as a classic script first (non-strict,
 * matches a browser <script>), then as a module if it needs import/export. */
function checkJs(source: string, forceModule = false): JsError | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smolcoder-check-"));
  try {
    const tryAs = (ext: string): JsError | null => {
      const tmp = path.join(dir, `snippet${ext}`);
      fs.writeFileSync(tmp, source, "utf8");
      const r = spawnSync(process.execPath, ["--check", tmp], {
        encoding: "utf8",
        timeout: CHECK_TIMEOUT_MS,
        windowsHide: true,
      });
      if (r.status === 0) return null;
      if (r.error) return null; // could not run the check — stay silent
      return parseNodeError(r.stderr ?? "", tmp) ?? { line: null, message: "syntax error" };
    };
    if (forceModule) return tryAs(".mjs");
    const classic = tryAs(".cjs");
    if (!classic) return null;
    if (/import|export|module|await/i.test(classic.message)) return tryAs(".mjs");
    return classic;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function checkHtml(source: string): string | null {
  // Inline scripts only (no src=), skipping non-JS types (importmap, JSON, templates).
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !["module", "text/javascript", "application/javascript"].includes(type)) continue;
    const body = m[2];
    if (!body.trim()) continue;
    const err = checkJs(body, type === "module");
    if (err) {
      const startLine = source.slice(0, m.index + m[0].indexOf(body)).split("\n").length;
      const at = err.line ? ` at line ${startLine + err.line - 1}` : "";
      return `an inline <script> has a JavaScript syntax error${at}: ${err.message}`;
    }
  }
  return null;
}

function checkPython(abs: string): string | null {
  const py = findPython();
  if (!py) return null;
  const r = spawnSync(py, ["-I", "-c", "import sys; compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec')", abs], {
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    windowsHide: true,
  });
  if (r.status === 0 || r.error) return null;
  const text = (r.stderr || r.stdout || "").trim().split(/\r?\n/);
  const line = text.map((l) => /line (\d+)/.exec(l)?.[1]).find(Boolean);
  const last = text[text.length - 1] ?? "syntax error";
  return `Python syntax error${line ? ` at line ${line}` : ""}: ${last.replace(/^.*?Error: ?/, "")}`;
}

/** Compilers that turned out unusable (no transpileModule), by path, until
 * the file changes. A missing compiler is not remembered: one existsSync per
 * folder level is cheap, and the project may install TypeScript later. */
const unusableTs = new Map<string, number>();

function findTypeScript(fromDir: string, workspace: string): string | null {
  const root = path.resolve(workspace);
  for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
    const lib = path.join(dir, "node_modules", "typescript", "lib", "typescript.js");
    try {
      const mtime = fs.statSync(lib).mtimeMs;
      if (unusableTs.get(lib) !== mtime) return lib;
    } catch {
      /* not here */
    }
    const rel = path.relative(root, dir);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || path.dirname(dir) === dir) return null;
  }
}

/** Runs in a short-lived node: the workspace's typescript.js is project code,
 * so it never loads inside smolcoder itself. Reads the job from stdin and
 * prints one marked JSON line. */
const TS_CHILD = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  const say = (o) => process.stdout.write("\\n@@smol-ts@@" + JSON.stringify(o) + "\\n");
  const job = JSON.parse(input);
  let ts;
  try { ts = require(job.lib); } catch { return say({ unusable: true }); }
  if (!ts || typeof ts.transpileModule !== "function") return say({ unusable: true });
  const out = ts.transpileModule(job.source, {
    fileName: job.fileName,
    reportDiagnostics: true,
    compilerOptions: Object.assign(job.tsx ? { jsx: (ts.JsxEmit && ts.JsxEmit.Preserve) || 1 } : {}, { noResolve: true, isolatedModules: false }),
  });
  const error = (ts.DiagnosticCategory && ts.DiagnosticCategory.Error) ?? 1;
  const d = (out.diagnostics || []).find((x) => x.file && typeof x.start === "number" && x.category === error);
  if (!d) return say({ ok: true });
  say({ line: d.file.getLineAndCharacterOfPosition(d.start).line + 1, message: ts.flattenDiagnosticMessageText(d.messageText, " ") });
});`;

/** Syntax diagnostics only (transpileModule does no type checking): the
 * first one, with its line. `mayRun` applies run_command's trust rules to
 * running the compiler; when they would ask the user, the check is skipped.
 * Exported for tests. */
export function checkTypeScript(source: string, absPath: string, workspace: string, mayRun?: (command: string) => boolean): string | null {
  const lib = findTypeScript(path.dirname(absPath), workspace);
  if (!lib) return null;
  const command = `node "${lib}"`;
  if (!(mayRun ? mayRun(command) : commandEscapesWorkspace(command, workspace) === null)) return null;
  const r = spawnSync(process.execPath, ["-e", TS_CHILD], {
    input: JSON.stringify({ lib, source, fileName: path.basename(absPath), tsx: path.extname(absPath).toLowerCase() === ".tsx" }),
    cwd: workspace,
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  const marked = String(r.stdout ?? "").split("\n").reverse().find((l) => l.startsWith("@@smol-ts@@"));
  if (!marked) return null;
  let res: any;
  try { res = JSON.parse(marked.slice("@@smol-ts@@".length)); } catch { return null; }
  if (res?.unusable) {
    try { unusableTs.set(lib, fs.statSync(lib).mtimeMs); } catch { /* gone */ }
    return null;
  }
  if (typeof res?.line !== "number" || typeof res?.message !== "string") return null;
  return `line ${res.line}: ${res.message.slice(0, 300)}`;
}

/**
 * Check a just-written file. Returns a short warning sentence, or null when
 * the file parses (or when we have no parser for it). Never throws.
 */
export function syntaxCheck(absPath: string, relPath: string, workspace?: string, mayRun?: (command: string) => boolean): string | null {
  try {
    const ext = path.extname(absPath).toLowerCase();
    const isTs = [".ts", ".tsx", ".mts", ".cts"].includes(ext) && !absPath.toLowerCase().endsWith(".d.ts");
    if (!isTs && ![".js", ".mjs", ".cjs", ".json", ".html", ".htm", ".py"].includes(ext)) return null;
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_CHECK_BYTES) return null;
    if (ext === ".py") return checkPython(absPath);
    const source = fs.readFileSync(absPath, "utf8");
    if (isTs) {
      if (!workspace) return null;
      const msg = checkTypeScript(source, absPath, workspace, mayRun);
      return msg ? `${relPath} has a TypeScript syntax error at ${msg}` : null;
    }
    if (ext === ".json") {
      try {
        JSON.parse(source);
        return null;
      } catch (e: any) {
        return `${relPath} is not valid JSON: ${e.message}`;
      }
    }
    if (ext === ".html" || ext === ".htm") {
      const msg = checkHtml(source);
      return msg ? `${relPath}: ${msg}` : null;
    }
    const err = checkJs(source, ext === ".mjs");
    if (!err) return null;
    return `${relPath} has a JavaScript syntax error${err.line ? ` at line ${err.line}` : ""}: ${err.message}`;
  } catch {
    return null;
  }
}
