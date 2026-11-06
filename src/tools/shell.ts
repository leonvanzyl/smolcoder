// run_command: one-shot foreground commands, cwd-locked to the workspace.
// Shell picking matters on Windows: local models emit POSIX commands, so we
// prefer Git Bash when it exists, skip WSL's System32 bash (different
// filesystem world), and fall back to PowerShell. The chosen shell is named in
// the system prompt so the model knows what dialect to write.

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { truncateMiddle } from "../util";

export interface ShellInfo {
  exe: string;
  argsFor: (cmd: string) => string[];
  label: string; // goes into the system prompt
}

let cached: ShellInfo | null = null;

export function pickShell(): ShellInfo {
  if (cached) return cached;
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
      path.join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Git", "bin", "bash.exe"),
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        cached = { exe: p, argsFor: (cmd) => ["-o", "pipefail", "-lc", cmd], label: "bash (Git Bash)" };
        return cached;
      }
    }
    // any bash on PATH that is not WSL's System32 shim
    const where = spawnSync("where.exe", ["bash"], { encoding: "utf8" });
    if (where.status === 0) {
      const found = where.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((p) => p && !p.toLowerCase().includes("system32"));
      if (found) {
        cached = { exe: found, argsFor: (cmd) => ["-o", "pipefail", "-lc", cmd], label: "bash (Git Bash)" };
        return cached;
      }
    }
    cached = {
      exe: "powershell.exe",
      argsFor: (cmd) => ["-NoProfile", "-NonInteractive", "-Command", cmd],
      label: "PowerShell",
    };
    return cached;
  }
  const sh = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  cached = { exe: sh, argsFor: (cmd) => sh.endsWith("/bash") ? ["-o", "pipefail", "-lc", cmd] : ["-lc", cmd], label: path.basename(sh) };
  return cached;
}

export function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

const OUTPUT_CAP = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Where truncated command output is kept in full, inside the workspace so
 * read_file can reach it without widening the sandbox. Its own .gitignore
 * keeps it out of git; search and list_files skip dot-folders. */
export const OUTPUT_LOG_DIR = ".smolcoder/out";
const FULL_LOG_CAP = 16 * 1024 * 1024;
const KEEP_LOGS = 20;

/** Save a full command log and return its workspace-relative path, or null. */
export function saveOutputLog(cwd: string, text: string): string | null {
  try {
    const dir = path.join(cwd, ...OUTPUT_LOG_DIR.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", "utf8");
    const numbered = fs.readdirSync(dir)
      .map((n) => /^(\d+)\.log$/.exec(n))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    const next = (numbered.at(-1) ?? 0) + 1;
    fs.writeFileSync(path.join(dir, `${next}.log`), text, "utf8");
    for (const old of numbered.slice(0, Math.max(0, numbered.length + 1 - KEEP_LOGS))) {
      try { fs.rmSync(path.join(dir, `${old}.log`), { force: true }); } catch { /* ignore */ }
    }
    return `${OUTPUT_LOG_DIR}/${next}.log`;
  } catch {
    return null;
  }
}

/** Keep bash alive while ordinary background jobs own its output pipes. On
 * Windows taskkill cannot find descendants after their shell has exited. */
export function managedCommand(shell: ShellInfo, command: string): string {
  return /(?:^|[\\/])bash(?:\.exe)?$/.test(shell.exe)
    ? `${command}\n__smol_command_status=$?\nwait\nexit "$__smol_command_status"`
    : command;
}

export interface RunOptions {
  /** The most characters the result may use (the agent's per-result cap). */
  maxChars?: number;
  /** Keep the full output in OUTPUT_LOG_DIR when the result has to be cut. */
  saveLog?: boolean;
}

export function runCommand(command: string, cwd: string, signal?: AbortSignal, opts: RunOptions = {}): Promise<string> {
  if (signal?.aborted) return Promise.resolve("Error: command cancelled before starting");
  // Leave room for the log path, exit line and any harness reminder.
  const cap = opts.maxChars === undefined ? OUTPUT_CAP : Math.max(400, Math.min(OUTPUT_CAP, opts.maxChars - 300));
  return new Promise((resolve) => {
    const shell = pickShell();
    let output = "";
    const full: string[] = [];
    let fullLen = 0;
    let fullCut = false;
    let finished = false;
    const started = Date.now();

    const proc = spawn(shell.exe, shell.argsFor(managedCommand(shell, command)), {
      cwd,
      env: process.env,
      detached: process.platform !== "win32", // process group for killTree
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (chunk: Buffer) => {
      // Keep the end of a long build/test log: failures usually appear there.
      // Dropping all output after 32k hid the actual failure from the model.
      const text = chunk.toString("utf8");
      output += text;
      if (output.length > OUTPUT_CAP * 4) output = truncateMiddle(output, OUTPUT_CAP * 4);
      if (opts.saveLog && !fullCut) {
        if (fullLen + text.length > FULL_LOG_CAP) fullCut = true;
        else { full.push(text); fullLen += text.length; }
      }
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);

    /** The model-facing body; a cut one points at the saved full log. */
    const body = (): string => {
      const trimmed = output.trim();
      if (!trimmed) return "(no output)";
      if (trimmed.length <= cap) return trimmed;
      const cut = truncateMiddle(trimmed, cap);
      const saved = opts.saveLog ? saveOutputLog(cwd, full.join("") + (fullCut ? "\n[log capped at 16 MB]\n" : "")) : null;
      return saved ? `${cut}\n[full output: ${saved}]` : cut;
    };

    // User interrupt (esc / ctrl+c / web stop button): kill the whole tree now.
    const onAbort = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      killTree(proc.pid!);
      proc.stdout.destroy();
      proc.stderr.destroy();
      resolve(
        (output.trim() ? truncateMiddle(output, cap) + "\n" : "") +
          "[command cancelled by the user before it finished]"
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      killTree(proc.pid!);
      proc.stdout.destroy();
      proc.stderr.destroy();
      resolve(
        "Error: " + (output.trim() ? body() : "") +
          `\n[command timed out after ${DEFAULT_TIMEOUT_MS / 1000}s and was killed. For tests/builds, isolate the stuck test or phase and inspect its loop or initialization before rerunning. For a persistent dev server, use task {"action": "start"}.]`
      );
    }, DEFAULT_TIMEOUT_MS);

    proc.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      resolve(`Error: could not start command: ${err.message}`);
    });

    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      resolve(`${code !== 0 ? `Error: command exited with code ${code ?? "?"}\n` : ""}${body()}\n[exit code ${code ?? "?"} in ${secs}s]`);
    });

    if (signal?.aborted) onAbort();
  });
}
