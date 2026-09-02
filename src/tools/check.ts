// Post-write syntax check — a harness hook that fires after every write_file /
// edit_file. A local model that writes a 300-line game.js with one stray
// brace gets a blank page and no idea why; catching the parse error in the
// tool result (with the line number) turns that into a one-step fix. Only
// parsers we can trust are used: node's own for JS (and inline <script> in
// HTML), JSON.parse, python's compiler when python is on PATH. Nothing runs
// the code.

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CHECK_TIMEOUT_MS = 8000;
const MAX_CHECK_BYTES = 2 * 1024 * 1024;

let pythonExe: string | null | undefined; // undefined = not probed yet

function findPython(): string | null {
  if (pythonExe !== undefined) return pythonExe;
  pythonExe = null;
  for (const exe of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const r = spawnSync(exe, ["-c", "print(1)"], { encoding: "utf8", timeout: 5000, windowsHide: true });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-coder-check-"));
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
  const r = spawnSync(py, ["-m", "py_compile", abs], {
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

/**
 * Check a just-written file. Returns a short warning sentence, or null when
 * the file parses (or when we have no parser for it). Never throws.
 */
export function syntaxCheck(absPath: string, relPath: string): string | null {
  try {
    const ext = path.extname(absPath).toLowerCase();
    if (![".js", ".mjs", ".cjs", ".json", ".html", ".htm", ".py"].includes(ext)) return null;
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_CHECK_BYTES) return null;
    if (ext === ".py") return checkPython(absPath);
    const source = fs.readFileSync(absPath, "utf8");
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
