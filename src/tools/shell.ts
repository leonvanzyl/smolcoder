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
        cached = { exe: p, argsFor: (cmd) => ["-lc", cmd], label: "bash (Git Bash)" };
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
        cached = { exe: found, argsFor: (cmd) => ["-lc", cmd], label: "bash (Git Bash)" };
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
  cached = { exe: sh, argsFor: (cmd) => ["-lc", cmd], label: path.basename(sh) };
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

export function runCommand(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const shell = pickShell();
    let output = "";
    let finished = false;
    const started = Date.now();

    const proc = spawn(shell.exe, shell.argsFor(command), {
      cwd,
      env: process.env,
      detached: process.platform !== "win32", // process group for killTree
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (chunk: Buffer) => {
      if (output.length < OUTPUT_CAP * 4) output += chunk.toString("utf8");
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);

    // User interrupt (esc / ctrl+c / web stop button): kill the whole tree now.
    const onAbort = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killTree(proc.pid!);
      resolve(
        (output.trim() ? truncateMiddle(output, OUTPUT_CAP) + "\n" : "") +
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
      resolve(
        truncateMiddle(output, OUTPUT_CAP) +
          `\n[command timed out after ${DEFAULT_TIMEOUT_MS / 1000}s and was killed. For long-running commands like dev servers, use the task tool with {"action": "start"} instead.]`
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
      const body = output.trim() ? truncateMiddle(output, OUTPUT_CAP) : "(no output)";
      resolve(`${body}\n[exit code ${code ?? "?"} in ${secs}s]`);
    });

    if (signal?.aborted) onAbort();
  });
}
