// One session = one workspace + one agent + one UI, plus the input loop and
// slash commands that drive it. Extracted from the CLI entry point so the
// terminal TUI and the web hub (many sessions side by side, one per browser
// sidebar entry) run exactly the same loop.

import * as os from "os";
import { Agent } from "./agent";
import { Config, saveConfig } from "./config";
import { ContextManager } from "./context";
import { detectAll, DetectedModel, resolveContextWindow } from "./detect";
import { EventBus } from "./events";
import { Plan, PlanStep } from "./plan";
import { buildSystemPrompt, loadAgentsMd } from "./prompt";
import { LmStudioProvider } from "./providers/lmstudio";
import { OllamaProvider } from "./providers/ollama";
import { Effort, Msg, Provider } from "./providers/types";
import { Mode, MODE_LABELS, ToolContext } from "./tools/index";
import { pickShell } from "./tools/shell";
import { TaskManager } from "./tools/tasks";
import { SessionUI, SlashCommand } from "./ui";
import { c } from "./util";

/** Per-session preferences from the command line. `effort: null` means an
 * explicit "default"; undefined means "whatever the config remembers". */
export interface SessionPrefs {
  mode?: Mode;
  model?: string;
  ctx?: number;
  effort?: Effort | null;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "models", desc: "Switch model" },
  { name: "mode", desc: "Set mode (ro / edit / bypass)" },
  { name: "effort", desc: "Set reasoning effort" },
  { name: "plan", desc: "Show the agent's plan" },
  { name: "context", desc: "Show context usage" },
  { name: "compact", desc: "Compact the conversation now" },
  { name: "tasks", desc: "List background tasks" },
  { name: "logs", desc: "Show task output — /logs t1" },
  { name: "stop", desc: "Stop a background task — /stop t1" },
  { name: "clear", desc: "Reset the conversation" },
  { name: "help", desc: "Show help" },
  { name: "exit", desc: "Quit smolcoder (web: close this session)" },
];

export const MODE_ORDER: Mode[] = ["ro", "edit", "bypass"];

// ---- model selection helpers (shared with the headless path) --------------

/** Output budget scales with the window: big windows can afford whole-file
 * writes (a single write_file's JSON must fit in the output), tiny windows
 * must stay conservative. */
export function outputBudget(window: number): number {
  return Math.max(1024, Math.min(16384, Math.floor(window / 4)));
}

export function makeProvider(m: DetectedModel): Provider {
  const maxOut = outputBudget(m.contextWindow);
  return m.backend === "ollama"
    ? new OllamaProvider(m.baseUrl, m.id, m.contextWindow, m.numCtx, maxOut)
    : new LmStudioProvider(m.baseUrl, m.id, m.contextWindow, maxOut, m.reasoning);
}

/** One-line advice when the effective reasoning setting will be slow: LM
 * Studio applies the model's own default level when none is chosen, and for
 * current qwen builds that default is the maximum. */
export function effortAdvice(m: DetectedModel, effort: Effort | null): string | null {
  if (m.backend !== "lmstudio" || !m.reasoning?.default) return null;
  const d = m.reasoning.default;
  if (effort === null && /^(high|xhigh)$/.test(d)) {
    return `this model thinks at "${d}" by default on LM Studio — expect long pauses before each tool call. /effort off (or --effort off) is many times faster; /effort low or medium keeps some reasoning.`;
  }
  return null;
}

/** Tell the user what context management just did (both UIs; headless logs
 * it to stderr so a long run's log shows when and how hard compaction hit). */
export function reportCompactions(bus: EventBus, ui: { status: (s: string) => void; warn: (s: string) => void }): void {
  bus.on("post_compact", (report: any) => {
    const delta = `${report?.before} → ${report?.after} tokens est.`;
    if (report?.action === "evicted") ui.status(`· freed context by dropping old tool output (${delta})`);
    else if (report?.action === "compacted") ui.status(`· compacted the conversation into hand-over notes (${delta})`);
    else if (report?.action === "floor")
      ui.warn(`· context is at its floor: system prompt + tools + the working tail no longer fit comfortably (${delta}). Consider a bigger context window.`);
  });
}

export function autoPickModel(
  models: DetectedModel[],
  wanted: string | undefined,
  remembered: string | undefined
): DetectedModel {
  if (wanted) {
    const hit =
      models.find((m) => m.id === wanted) ??
      models.find((m) => m.id.toLowerCase().includes(wanted.toLowerCase()));
    if (hit) return hit;
  }
  return (
    models.find((m) => m.id === remembered) ??
    models.find((m) => m.backend === "ollama") ??
    models.find((m) => m.loaded) ??
    models[0]
  );
}

export function noBackendsMessage(): string {
  return (
    c.red("No local model backend found.") +
    `\n\nsmolcoder looks for:\n` +
    `  · ${c.bold("Ollama")} at http://127.0.0.1:11434 ${c.dim("(or $OLLAMA_HOST)")} — install: https://ollama.com, then: ollama pull qwen3\n` +
    `  · ${c.bold("LM Studio")} at http://127.0.0.1:1234 — start its local server (Developer tab → Start Server)\n\n` +
    `Start one of them and run smol again. No configuration needed.`
  );
}

export function sessionLine(m: DetectedModel, mode: Mode): string {
  return `${c.green("●")} ${m.backend} · ${c.bold(m.id)} · ctx ${m.contextWindow.toLocaleString()} · ${MODE_LABELS[mode]} mode`;
}

export function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : (n / 1000).toFixed(1) + "k";
}

function modeColored(mode: Mode): string {
  const label = MODE_LABELS[mode];
  if (mode === "bypass") return c.red(c.bold(label));
  if (mode === "ro") return c.magenta(c.bold(label));
  return c.cyan(c.bold(label));
}

/** Detect backends, pick a model and resolve its context window. Returns null
 * when no backend answers. `progress` gets a short label for each slow step. */
export async function prepareModel(
  prefs: SessionPrefs,
  cfg: Config,
  progress?: (label: string) => void
): Promise<DetectedModel | null> {
  progress?.("looking for Ollama and LM Studio");
  const models = await detectAll();
  if (models.length === 0) return null;
  const chosen = autoPickModel(models, prefs.model, cfg.lastModel);
  progress?.(`loading ${chosen.id}`);
  return resolveContextWindow(chosen, prefs.ctx);
}

// ---- the session -----------------------------------------------------------

/** Everything needed to bring a session back after a restart. */
export interface SessionSnapshot {
  messages: Msg[]; // without the system message — rebuilt on restore
  plan: PlanStep[];
  filesTouched: string[];
  commandsRun: string[];
  originalRequest: string;
  currentRequest: string;
  mode: Mode;
  effort: Effort | null;
  model: string;
  backend: string;
}

export interface SessionOptions {
  workspace: string;
  chosen: DetectedModel;
  prefs: SessionPrefs;
  cfg: Config;
  /** Text printed by /help. */
  help: string;
}

export class Session {
  readonly workspace: string;
  chosen: DetectedModel;
  effort: Effort | null;
  readonly agent: Agent;
  readonly toolCtx: ToolContext;
  readonly taskManager: TaskManager;
  readonly ctxMgr: ContextManager;
  readonly bus = new EventBus();
  readonly shell = pickShell();
  /** Host hook: fired once when the session has shut down (/exit, ctrl+c). */
  onExit: (() => void) | null = null;

  private readonly agentsMd: string | null;
  private readonly prefs: SessionPrefs;
  private readonly help: string;
  private ended = false;

  constructor(
    readonly ui: SessionUI,
    opts: SessionOptions
  ) {
    const { workspace, chosen, prefs, cfg } = opts;
    this.workspace = workspace;
    this.chosen = chosen;
    this.prefs = prefs;
    this.help = opts.help;
    const mode0 = prefs.mode ?? cfg.lastMode ?? "edit";
    this.effort = prefs.effort !== undefined ? prefs.effort : (cfg.effort ?? null);

    const provider = makeProvider(chosen);
    provider.setEffort(this.effort);
    this.taskManager = new TaskManager(workspace);
    this.toolCtx = {
      workspace,
      taskManager: this.taskManager,
      plan: new Plan(),
      filesTouched: new Set(),
      commandsRun: [],
    };
    this.ctxMgr = new ContextManager(chosen.contextWindow, provider.maxOutputTokens);
    this.agentsMd = loadAgentsMd(workspace);
    // The step cap is a runaway-loop backstop, not a work limit — esc/ctrl+c
    // is the user's real kill switch, so set it far above any legitimate task.
    this.agent = new Agent(provider, mode0, this.sysPrompt(mode0), this.toolCtx, this.ctxMgr, this.bus, ui, true, 1000);

    ui.slashCommands = SLASH_COMMANDS;
    ui.hintLeft = workspace.replace(os.homedir(), "~");
    ui.getStatus = () => this.statusLine();
    ui.onModeCycle = () => {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(this.agent.mode) + 1) % MODE_ORDER.length];
      this.agent.setMode(next, this.sysPrompt(next));
      this.persist();
    };
    ui.onCancel = () => this.agent.cancel();
    ui.onExit = () => void this.shutdown();
    reportCompactions(this.bus, ui);
    this.persist();
  }

  private sysPrompt(mode: Mode): string {
    return buildSystemPrompt({ workspace: this.workspace, mode, shellLabel: this.shell.label, agentsMd: this.agentsMd });
  }

  private persist(): void {
    saveConfig({ lastModel: this.chosen.id, lastMode: this.agent.mode, effort: this.effort });
  }

  /** The TUI's status row: mode · model · effort · context · plan · tasks. */
  statusLine(): string {
    const agent = this.agent;
    const tasks = this.taskManager.runningSummary().length;
    const plan = this.toolCtx.plan;
    return (
      `${modeColored(agent.mode)} ${c.dim("·")} ${this.chosen.id} ${c.dim(this.chosen.backend)}` +
      (this.effort || agent.provider.effortLabel()
        ? ` ${c.dim("·")} ${c.yellow(agent.provider.effortLabel() ?? this.effort ?? "")}`
        : "") +
      ` ${c.dim("·")} ${c.dim(`${fmtTokens(agent.contextTokens())} (${agent.contextPercent()}%)`)}` +
      (plan.exists
        ? ` ${c.dim("·")} ${
            plan.currentIndex < 0
              ? c.green(`plan ${plan.doneCount}/${plan.steps.length}`)
              : c.cyan(`plan ${plan.doneCount}/${plan.steps.length}`)
          }`
        : "") +
      (tasks ? ` ${c.dim("·")} ${c.green(`${tasks} task${tasks > 1 ? "s" : ""}`)}` : "")
    );
  }

  /** Structured status for the web page's status bar. */
  state(): Record<string, any> {
    const plan = this.toolCtx.plan;
    return {
      mode: this.agent.mode,
      model: this.chosen.id,
      backend: this.chosen.backend,
      effort: this.agent.provider.effortLabel() ?? this.effort,
      ctxTokens: this.agent.contextTokens(),
      ctxPct: this.agent.contextPercent(),
      plan: plan.exists ? { steps: plan.steps, current: plan.currentIndex } : null,
      tasks: this.taskManager.runningSummary().length,
      workspace: this.workspace,
      commands: SLASH_COMMANDS,
      urls: this.taskManager.recentUrls(),
    };
  }

  /** The opening lines: backend · model · mode, workspace, AGENTS.md, advice. */
  announce(): void {
    const ui = this.ui;
    ui.println(sessionLine(this.chosen, this.agent.mode));
    if (this.chosen.note) ui.warn(`  ${this.chosen.note}`);
    ui.status(`  workspace ${this.workspace} · shell ${this.shell.label}`);
    if (this.agentsMd) ui.status(`  AGENTS.md loaded (${this.agentsMd.split("\n").length} lines)`);
    const advice = effortAdvice(this.chosen, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }

  snapshot(): SessionSnapshot {
    return {
      messages: this.agent.messages.slice(1),
      plan: this.toolCtx.plan.steps.map((s) => ({ ...s })),
      filesTouched: [...this.toolCtx.filesTouched],
      commandsRun: [...this.toolCtx.commandsRun],
      originalRequest: this.agent.originalRequest,
      currentRequest: this.agent.currentRequest,
      mode: this.agent.mode,
      effort: this.effort,
      model: this.chosen.id,
      backend: this.chosen.backend,
    };
  }

  /** Bring a saved transcript back (the system message is rebuilt for the
   * current mode/workspace; approvals are deliberately not restored). */
  restore(s: SessionSnapshot): void {
    this.agent.restoreTranscript(s.messages ?? [], s.originalRequest ?? "", s.currentRequest ?? "");
    this.toolCtx.plan.steps = (s.plan ?? []).map((p) => ({ text: String(p.text), done: !!p.done }));
    for (const f of s.filesTouched ?? []) this.toolCtx.filesTouched.add(f);
    this.toolCtx.commandsRun.push(...(s.commandsRun ?? []));
  }

  /** The input loop. Returns after /exit (or after the host asked the UI to
   * hand back "/exit"). */
  async run(): Promise<void> {
    const { ui, agent, toolCtx, taskManager } = this;
    await this.bus.emit("session_start");
    for (;;) {
      const input = await ui.readInput();

      if (input.startsWith("/")) {
        const [cmd, ...rest] = input.slice(1).split(/\s+/);
        const arg = rest[0];
        switch (cmd) {
          case "exit":
          case "quit":
          case "q":
            await this.shutdown();
            return;
          case "help":
            ui.println(this.help);
            break;
          case "models":
          case "model":
            await this.switchModel();
            break;
          case "mode":
            await this.setMode(arg);
            break;
          case "effort":
            await this.setEffort(arg);
            break;
          case "plan":
            if (toolCtx.plan.exists) ui.planUpdated(toolCtx.plan);
            else ui.status("· no plan yet — the agent creates one when it starts a multi-step task");
            break;
          case "tasks":
            ui.println(taskManager.list());
            break;
          case "logs":
            ui.println(taskManager.logs(arg ?? "", Number(rest[1]) || 50));
            break;
          case "stop":
            ui.println(taskManager.stop(arg ?? ""));
            break;
          case "compact":
            ui.startSpinner("compacting");
            await agent.compactNow();
            ui.stopSpinner();
            ui.status(`· compacted — ctx now ${agent.contextPercent()}%`);
            break;
          case "context":
            ui.status(
              `· ctx ${agent.contextPercent()}% of ${this.chosen.contextWindow.toLocaleString()} tokens · ${agent.messages.length} messages`
            );
            break;
          case "clear":
            agent.resetTranscript();
            toolCtx.plan.reset();
            ui.status("· conversation cleared");
            break;
          default:
            ui.warn(`Unknown command /${cmd} — try /help`);
        }
        ui.refresh();
        continue;
      }

      try {
        await agent.runTurn(input);
      } catch (err: any) {
        ui.error(`\n${err?.message ?? err}`);
        if (String(err?.message ?? "").toLowerCase().includes("does not support tools")) {
          ui.warn(
            "This model does not support tool calling. Pick a tool-capable model with /models (e.g. qwen3, llama3.1, mistral-nemo)."
          );
        }
      }
    }
  }

  /** Idempotent: end-of-session hook, kill background tasks, close the UI,
   * then tell the host. */
  async shutdown(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    try {
      await this.bus.emit("session_end");
    } catch {
      /* best effort */
    }
    this.taskManager.killAll();
    this.ui.close();
    this.onExit?.();
  }

  private async switchModel(): Promise<void> {
    const { ui, agent } = this;
    const fresh = await detectAll();
    if (!fresh.length) {
      ui.error("No backends reachable right now.");
      return;
    }
    const options = fresh.map((m) => ({
      label: m.id,
      hint:
        m.backend === "ollama"
          ? "ollama"
          : `lm studio${m.loaded ? ` · ctx ${m.contextWindow.toLocaleString()}` : " · not loaded"}`,
      current: m.id === this.chosen.id && m.backend === this.chosen.backend,
    }));
    const idx = await ui.select("Select model", options);
    if (idx === null) return;
    ui.startSpinner(`loading ${fresh[idx].id}`);
    const next = await resolveContextWindow(fresh[idx], this.prefs.ctx);
    ui.stopSpinner();
    this.chosen = next;
    const p = makeProvider(next);
    p.setEffort(this.effort);
    agent.setProvider(p);
    this.ctxMgr.setWindow(next.contextWindow, p.maxOutputTokens);
    this.persist();
    ui.println(sessionLine(next, agent.mode));
    if (next.note) ui.warn(`  ${next.note}`);
    const advice = effortAdvice(next, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }

  private async setMode(arg?: string): Promise<void> {
    const { ui, agent } = this;
    let next: Mode | undefined =
      arg === "ro"
        ? "ro"
        : arg === "edit" || arg === "write"
          ? "edit"
          : arg === "bypass" || arg === "yolo"
            ? "bypass"
            : undefined;
    if (!next) {
      const idx = await ui.select("Select mode", [
        { label: "read-only", hint: "read and search files only", current: agent.mode === "ro" },
        {
          label: "edit",
          hint: "edit files; run commands inside the workspace, ask y/n for anything outside it",
          current: agent.mode === "edit",
        },
        {
          label: "bypass permissions",
          hint: "full access, never asks for approval",
          current: agent.mode === "bypass",
        },
      ]);
      if (idx === null) return;
      next = MODE_ORDER[idx];
    }
    agent.setMode(next, this.sysPrompt(next));
    this.persist();
  }

  private async setEffort(arg?: string): Promise<void> {
    const { ui, agent } = this;
    const levels: (Effort | "default")[] = ["default", "off", "low", "medium", "high"];
    let next: Effort | null | undefined;
    if (arg && (levels as string[]).includes(arg)) {
      next = arg === "default" ? null : (arg as Effort);
    } else {
      const idx = await ui.select("Reasoning effort", [
        {
          label: "default",
          hint: this.chosen.reasoning?.default
            ? `the model's own default (${this.chosen.reasoning.default})`
            : "leave it to the model",
          current: this.effort === null,
        },
        { label: "off", hint: "no thinking — fastest, best for long tool loops", current: this.effort === "off" },
        { label: "low", hint: "brief reasoning", current: this.effort === "low" },
        { label: "medium", hint: "", current: this.effort === "medium" },
        { label: "high", hint: "most thorough — slow on local models", current: this.effort === "high" },
      ]);
      if (idx === null) return;
      next = idx === 0 ? null : (levels[idx] as Effort);
    }
    this.effort = next;
    agent.provider.setEffort(this.effort);
    this.persist();
    const label = agent.provider.effortLabel();
    ui.status(`· effort ${label ?? this.effort ?? "default"}`);
    const advice = effortAdvice(this.chosen, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }
}
