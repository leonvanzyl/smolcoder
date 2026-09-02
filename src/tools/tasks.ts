// Background tasks: one `task` tool with an action enum instead of four
// separate tools — one schema costs fewer context tokens, and small models
// handle enum dispatch on a single tool fine. Each task keeps a ring buffer of
// recent output so the agent (and the user, via /tasks and /logs) has
// visibility. All tasks are killed when smolcoder exits.

import { ChildProcess, spawn } from "child_process";
import { pickShell, killTree } from "./shell";

interface Task {
  id: string;
  command: string;
  proc: ChildProcess;
  lines: string[];
  status: "running" | "exited" | "stopped";
  exitCode: number | null;
  startedAt: number;
}

const RING_SIZE = 300;

export class TaskManager {
  private tasks = new Map<string, Task>();
  private counter = 0;

  constructor(private cwd: string) {}

  start(command: string): string {
    const shell = pickShell();
    const id = `t${++this.counter}`;
    const proc = spawn(shell.exe, shell.argsFor(command), {
      cwd: this.cwd,
      env: process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const task: Task = {
      id,
      command,
      proc,
      lines: [],
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
    };
    const push = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line === "") continue;
        task.lines.push(line);
        if (task.lines.length > RING_SIZE) task.lines.shift();
      }
    };
    proc.stdout?.on("data", push);
    proc.stderr?.on("data", push);
    proc.on("error", (err) => {
      task.lines.push(`[failed to start: ${err.message}]`);
      task.status = "exited";
      task.exitCode = -1;
    });
    proc.on("close", (code) => {
      if (task.status === "running") {
        task.status = "exited";
        task.exitCode = code;
      }
    });
    this.tasks.set(id, task);
    return id;
  }

  /** Wait briefly after start so early output (or an instant crash) is visible. */
  async startWithEarlyOutput(command: string): Promise<string> {
    const id = this.start(command);
    await new Promise((r) => setTimeout(r, 1500));
    const task = this.tasks.get(id)!;
    const early = task.lines.slice(-15).join("\n");
    const status =
      task.status === "running"
        ? `Task ${id} is running in the background.`
        : `Task ${id} exited almost immediately (exit code ${task.exitCode}).`;
    return `${status} Command: ${command}\n${early ? `Early output:\n${early}\n` : ""}Use task {"action": "logs", "task_id": "${id}"} to check on it, {"action": "stop"} to kill it.`;
  }

  logs(taskId: string, lineCount = 50): string {
    const task = this.tasks.get(taskId);
    if (!task) return this.unknownTask(taskId);
    const tail = task.lines.slice(-Math.min(Math.max(lineCount, 1), RING_SIZE));
    const header = `Task ${task.id} [${task.status}${task.exitCode !== null ? ` code ${task.exitCode}` : ""}] ${task.command}`;
    return `${header}\n${tail.length ? tail.join("\n") : "(no output yet)"}`;
  }

  stop(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task) return this.unknownTask(taskId);
    if (task.status !== "running") return `Task ${taskId} already ${task.status}.`;
    task.status = "stopped";
    killTree(task.proc.pid!);
    return `Task ${taskId} stopped. (${task.command})`;
  }

  list(): string {
    if (this.tasks.size === 0) return "No background tasks. Start one with task {\"action\": \"start\", \"command\": \"...\"}.";
    const rows = [...this.tasks.values()].map((t) => {
      const age = Math.round((Date.now() - t.startedAt) / 1000);
      const status = t.status === "running" ? "running" : `${t.status}${t.exitCode !== null ? `(${t.exitCode})` : ""}`;
      return `${t.id}  ${status}  ${age}s  ${t.command}`;
    });
    return "id  status  age  command\n" + rows.join("\n");
  }

  hasRunning(): boolean {
    return [...this.tasks.values()].some((t) => t.status === "running");
  }

  runningSummary(): string[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === "running")
      .map((t) => `${t.id}: ${t.command}`);
  }

  killAll(): void {
    for (const t of this.tasks.values()) {
      if (t.status === "running") {
        t.status = "stopped";
        try {
          killTree(t.proc.pid!);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private unknownTask(taskId: string): string {
    const known = [...this.tasks.keys()].join(", ") || "none";
    return `Error: no task with id "${taskId}". Known tasks: ${known}. Use task {"action": "list"} to see them.`;
  }
}
