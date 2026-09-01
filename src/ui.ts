// Terminal UI: one readline interface for everything (prompt, pickers,
// approval), a spinner for the silent gap before the first streamed token,
// and small helpers for status lines. No dependencies.

import * as readline from "readline";
import { Plan } from "./plan";
import { c } from "./util";

/** What the agent loop needs from a UI — implemented by the plain UI (used in
 * -p / non-TTY mode) and by the interactive Tui. */
export interface AgentUI {
  token(text: string): void;
  thinking(text: string): void;
  toolCall(name: string, args: Record<string, any>): void;
  toolResult(result: string): void;
  println(s?: string): void;
  status(s: string): void;
  warn(s: string): void;
  error(s: string): void;
  startSpinner(label: string): void;
  stopSpinner(): void;
  confirmCommand(command: string): Promise<"yes" | "no" | "always">;
  /** Called when a user turn finishes normally, with a short summary label. */
  turnEnd(label: string): void;
  /** Called whenever the agent changes its plan — render the checklist. */
  planUpdated(plan: Plan): void;
}

export interface SlashCommand {
  name: string;
  desc: string;
}

export interface SelectOption {
  label: string;
  hint?: string;
  current?: boolean;
}

/** The full surface the interactive session loop drives — implemented by the
 * terminal Tui and by the WebUI (--web). */
export interface SessionUI extends AgentUI {
  slashCommands: SlashCommand[];
  getStatus: () => string;
  hintLeft: string;
  onModeCycle: (() => void) | null;
  onCancel: (() => void) | null;
  onExit: (() => void) | null;
  start(): void;
  close(): void;
  readInput(): Promise<string>;
  select(title: string, options: SelectOption[]): Promise<number | null>;
  refresh(): void;
}

/** Shared checklist renderer: ✔ done (dim) · ▶ current (cyan) · ○ pending. */
export function renderPlan(plan: Plan, indent = "  "): string {
  const cur = plan.currentIndex;
  const header = `${indent}${c.bold("Plan")} ${c.dim(`${plan.doneCount}/${plan.steps.length}`)}`;
  const rows = plan.steps.map((s, i) => {
    if (s.done) return `${indent}${c.dim("✔ " + s.text)}`;
    if (i === cur) return `${indent}${c.cyan("▶ " + s.text)}`;
    return `${indent}${c.gray("○ " + s.text)}`;
  });
  return [header, ...rows].join("\n");
}

export class UI implements AgentUI {
  private rl: readline.Interface;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerActive = false;
  private atLineStart = true;
  onInterrupt: (() => void) | null = null;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: 100,
    });
    this.rl.on("SIGINT", () => {
      if (this.onInterrupt) {
        this.onInterrupt();
      } else {
        this.println("");
        process.exit(0);
      }
    });
  }

  ask(prompt: string): Promise<string> {
    return new Promise((resolve) => this.rl.question(prompt, (a) => resolve(a)));
  }

  /** y / n / a(lways allow this program for the session) */
  async confirmCommand(command: string): Promise<"yes" | "no" | "always"> {
    this.stopSpinner();
    const answer = await this.ask(
      `${c.yellow("run?")} ${c.bold(command)}\n  ${c.dim("[y]es / [n]o / [a]lways allow this program this session:")} `
    );
    const ch = answer.trim().toLowerCase();
    if (ch === "a" || ch === "always") return "always";
    if (ch === "y" || ch === "yes" || ch === "") return "yes";
    return "no";
  }

  startSpinner(label: string): void {
    if (!process.stdout.isTTY) {
      // Headless liveness heartbeat: a working local model can generate for
      // minutes with nothing visible — tick on stderr so a log-follower can
      // tell "working" from "hung".
      this.stopSpinner();
      const started = Date.now();
      this.spinnerTimer = setInterval(() => {
        const secs = Math.round((Date.now() - started) / 1000);
        process.stderr.write(c.gray(`· ${label}… ${secs}s\n`));
      }, 15000);
      return;
    }
    this.stopSpinner();
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    const started = Date.now();
    this.spinnerActive = true;
    this.spinnerTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      process.stdout.write(
        `\r${c.cyan(frames[i++ % frames.length])} ${c.dim(label + (secs > 2 ? ` ${secs}s` : ""))}   `
      );
    }, 100);
  }

  stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.spinnerActive) {
      process.stdout.write("\r" + " ".repeat(60) + "\r");
      this.spinnerActive = false;
    }
  }

  private ensureLine(): void {
    if (!this.atLineStart) {
      process.stdout.write("\n");
      this.atLineStart = true;
    }
  }

  /** Meta output (tool lines, status, warnings) goes to stderr so headless
   * consumers get a clean stdout with just the model's answer. */
  private meta(s: string): void {
    this.stopSpinner();
    this.ensureLine();
    process.stderr.write(s + "\n");
  }

  /** Streamed model text goes straight to stdout. */
  token(text: string): void {
    this.stopSpinner();
    process.stdout.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  /** Headless mode: reasoning noise is suppressed — automations want the answer. */
  thinking(_text: string): void {}

  toolCall(name: string, args: Record<string, any>): void {
    const summary = summarizeArgs(name, args);
    this.meta(`${c.cyan("→")} ${c.bold(name)} ${c.dim(summary)}`);
  }

  toolResult(result: string): void {
    const firstLine = result.split("\n")[0] ?? "";
    const isError = firstLine.startsWith("Error");
    const lines = result.split("\n").length;
    const label = isError
      ? c.red(firstLine.slice(0, 120))
      : c.dim(firstLine.slice(0, 100) + (lines > 1 ? ` (+${lines - 1} lines)` : ""));
    this.meta(`  ${isError ? c.red("✗") : c.green("✓")} ${label}`);
  }

  println(s = ""): void {
    this.stopSpinner();
    this.ensureLine();
    process.stdout.write(s + "\n");
    this.atLineStart = true;
  }

  status(s: string): void {
    this.meta(c.gray(s));
  }

  turnEnd(label: string): void {
    this.meta(c.dim(`■ ${label}`));
  }

  planUpdated(plan: Plan): void {
    this.meta(renderPlan(plan));
  }

  warn(s: string): void {
    this.meta(c.yellow(s));
  }

  error(s: string): void {
    this.meta(c.red(s));
  }

  close(): void {
    this.stopSpinner();
    this.rl.close();
  }
}

export function summarizeArgs(name: string, args: Record<string, any>): string {
  try {
    switch (name) {
      case "read_file":
        return String(args.path ?? "") + (args.offset ? ` from line ${args.offset}` : "");
      case "write_file":
        return `${args.path} (${String(args.content ?? "").split("\n").length} lines)`;
      case "edit_file":
        return String(args.path ?? "");
      case "list_files":
        return String(args.path ?? ".");
      case "search":
        return `"${args.pattern}"${args.path ? ` in ${args.path}` : ""}`;
      case "run_command":
        return String(args.command ?? "");
      case "task":
        return [args.action, args.command ?? args.task_id ?? ""].filter(Boolean).join(" ");
      case "plan": {
        if (args.action === "set")
          return `set (${String(args.steps ?? "").split("\n").filter(Boolean).length} steps)`;
        if (args.action === "done") return `done${args.step ? " " + args.step : ""}`;
        if (args.action === "add") return `add: ${String(args.text ?? "").slice(0, 60)}`;
        return String(args.action ?? "");
      }
      default:
        return JSON.stringify(args).slice(0, 80);
    }
  } catch {
    return "";
  }
}
