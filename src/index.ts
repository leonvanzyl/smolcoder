#!/usr/bin/env node
// tiny-coder — a tiny, zero-config CLI coding agent for local models.
//
// Interactive: an opencode-style inline TUI. No upfront questions — the last
// (or first) detected model is picked automatically; switch with /models,
// cycle modes with shift+tab, set reasoning effort with /effort.
// Headless: tiny-coder -p "prompt" for people and automations.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent } from "./agent";
import { ContextManager } from "./context";
import { detectAll, DetectedModel, resolveContextWindow } from "./detect";
import { EventBus } from "./events";
import { Plan } from "./plan";
import { buildSystemPrompt, loadAgentsMd } from "./prompt";
import { LmStudioProvider } from "./providers/lmstudio";
import { OllamaProvider } from "./providers/ollama";
import { Effort, Provider } from "./providers/types";
import { Mode, MODE_LABELS, ToolContext } from "./tools/index";
import { pickShell } from "./tools/shell";
import { TaskManager } from "./tools/tasks";
import { Tui } from "./tui/tui";
import { SessionUI, UI } from "./ui";
import { WebUI } from "./web/webui";
import { c } from "./util";

const VERSION = require("../package.json").version as string;
const CONFIG_PATH = path.join(os.homedir(), ".tiny-coder.json");

interface CliArgs {
  workspace: string;
  mode?: Mode;
  model?: string;
  ctx?: number;
  print?: string;
  effort?: Effort | null; // null = explicit "default"
  web?: boolean;
  webPort?: number;
  help?: boolean;
  version?: boolean;
}

interface Config {
  lastModel?: string;
  lastMode?: Mode;
  effort?: Effort | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { workspace: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--mode" || a === "-m") {
      const v = argv[++i];
      if (v === "ro" || v === "read-only" || v === "readonly") args.mode = "ro";
      else if (v === "write" || v === "w") args.mode = "write";
      else if (v === "yolo" || v === "y") args.mode = "yolo";
      else {
        console.error(`Unknown mode "${v}". Use ro, write, or yolo.`);
        process.exit(1);
      }
    } else if (a === "--yolo") args.mode = "yolo";
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--ctx") args.ctx = Number(argv[++i]) || undefined;
    else if (a === "--effort") {
      const v = argv[++i];
      if (v === "off" || v === "low" || v === "medium" || v === "high") args.effort = v;
      else if (v === "default") args.effort = null;
      else {
        console.error(`Unknown effort "${v}". Use off, low, medium, high, or default.`);
        process.exit(1);
      }
    } else if (a === "--print" || a === "-p") args.print = argv[++i];
    else if (a === "--web") {
      args.web = true;
      if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) args.webPort = Number(argv[++i]);
    } else if (!a.startsWith("-")) args.workspace = path.resolve(a);
    else {
      console.error(`Unknown option "${a}". Try tiny-coder --help.`);
      process.exit(1);
    }
  }
  return args;
}

const HELP = `
${c.bold("tiny-coder")} v${VERSION} — a tiny, zero-config coding agent for local models.

Detects Ollama and LM Studio automatically. No configuration.

${c.bold("Usage:")}
  tiny-coder [workspace] [options]

${c.bold("Options:")}
  -m, --mode <ro|write|yolo>   ro: read files only. write: read/write files,
                               commands need a y/n approval. yolo: no approvals.
  --model <name>               pick a model by (partial) name
  --ctx <tokens>               force a context window (Ollama: sends num_ctx)
  --effort <level>             reasoning effort: off, low, medium, high, default
  --web [port]                 serve the session as a local web UI (default port 7433)
  -p, --print "<prompt>"       headless: run a single prompt and exit
  -h, --help                   this help
  -v, --version                version

${c.bold("Keys:")}
  shift+tab   cycle mode (read-only → write → yolo)
  /           slash commands (autocomplete menu)
  esc         cancel a running turn · clear the input
  ctrl+c ×2   quit

${c.bold("Slash commands:")}
  /models     switch model         /tasks        background tasks
  /mode       set mode             /logs <id>    task output
  /effort     reasoning effort     /stop <id>    kill a task
  /context    context usage        /clear        reset conversation
  /compact    compact now          /exit         quit
`;

function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg: Config): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {
    /* non-fatal */
  }
}

/** Output budget scales with the window: big windows can afford whole-file
 * writes (a single write_file's JSON must fit in the output), tiny windows
 * must stay conservative. */
function outputBudget(window: number): number {
  return Math.max(1024, Math.min(16384, Math.floor(window / 4)));
}

function makeProvider(m: DetectedModel): Provider {
  const maxOut = outputBudget(m.contextWindow);
  return m.backend === "ollama"
    ? new OllamaProvider(m.baseUrl, m.id, m.contextWindow, m.numCtx, maxOut)
    : new LmStudioProvider(m.baseUrl, m.id, m.contextWindow, maxOut);
}

function autoPickModel(
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

function noBackendsMessage(): string {
  return (
    c.red("No local model backend found.") +
    `\n\ntiny-coder looks for:\n` +
    `  · ${c.bold("Ollama")} at http://127.0.0.1:11434 ${c.dim("(or $OLLAMA_HOST)")} — install: https://ollama.com, then: ollama pull qwen3\n` +
    `  · ${c.bold("LM Studio")} at http://127.0.0.1:1234 — start its local server (Developer tab → Start Server)\n\n` +
    `Start one of them and run tiny-coder again. No configuration needed.`
  );
}

function sessionLine(m: DetectedModel, mode: Mode): string {
  return `${c.green("●")} ${m.backend} · ${c.bold(m.id)} · ctx ${m.contextWindow.toLocaleString()} · ${MODE_LABELS[mode]} mode`;
}

const MODE_ORDER: Mode[] = ["ro", "write", "yolo"];

const LOGO_ROWS = [
  "████████╗ ██╗ ███╗   ██╗ ██╗   ██╗",
  "╚══██╔══╝ ██║ ████╗  ██║ ╚██╗ ██╔╝",
  "   ██║    ██║ ██╔██╗ ██║  ╚████╔╝ ",
  "   ██║    ██║ ██║╚██╗██║   ╚██╔╝  ",
  "   ██║    ██║ ██║ ╚████║    ██║   ",
  "   ╚═╝    ╚═╝ ╚═╝  ╚═══╝    ╚═╝   ",
];

function printLogo(): void {
  const cols = process.stdout.columns || 80;
  if (cols >= 46) {
    console.log();
    LOGO_ROWS.forEach((row, i) => {
      const tail = i === LOGO_ROWS.length - 1 ? "  " + c.dim(c.bold("coder") + " v" + VERSION) : "";
      console.log(" " + c.cyan(row) + tail);
    });
    console.log();
  } else {
    console.log(`${c.bold("tiny")}${c.dim(c.bold("coder"))} ${c.dim("v" + VERSION)}`);
  }
}

function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : (n / 1000).toFixed(1) + "k";
}

function modeColored(mode: Mode): string {
  const label = MODE_LABELS[mode];
  if (mode === "yolo") return c.red(c.bold(label));
  if (mode === "ro") return c.magenta(c.bold(label));
  return c.cyan(c.bold(label));
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }
  if (!fs.existsSync(args.workspace) || !fs.statSync(args.workspace).isDirectory()) {
    console.error(`Workspace folder does not exist: ${args.workspace}`);
    process.exit(1);
  }

  if (args.print !== undefined) {
    await runHeadless(args);
  } else {
    await runInteractive(args);
  }
}

// ---- headless (-p) ---------------------------------------------------------

async function runHeadless(args: CliArgs): Promise<void> {
  const ui = new UI();
  const bus = new EventBus();
  const models = await detectAll();
  if (models.length === 0) {
    ui.println(noBackendsMessage());
    ui.close();
    process.exit(1);
  }
  const cfg = loadConfig();
  let chosen = autoPickModel(models, args.model, cfg.lastModel);
  chosen = await resolveContextWindow(chosen, args.ctx);
  const mode = args.mode ?? cfg.lastMode ?? "write";

  const shell = pickShell();
  const provider = makeProvider(chosen);
  provider.setEffort(args.effort !== undefined ? args.effort : (cfg.effort ?? null));
  const taskManager = new TaskManager(args.workspace);
  const toolCtx: ToolContext = {
    workspace: args.workspace,
    taskManager,
    plan: new Plan(),
    filesTouched: new Set(),
    commandsRun: [],
  };
  const ctxMgr = new ContextManager(chosen.contextWindow, provider.maxOutputTokens);
  const agentsMd = loadAgentsMd(args.workspace);
  if (agentsMd) ui.status(`· AGENTS.md loaded (${agentsMd.split("\n").length} lines)`);
  const systemPrompt = buildSystemPrompt({ workspace: args.workspace, mode, shellLabel: shell.label, agentsMd });
  const agent = new Agent(provider, mode, systemPrompt, toolCtx, ctxMgr, bus, ui, false, 200);
  process.on("exit", () => taskManager.killAll());

  ui.println(sessionLine(chosen, mode));
  if (chosen.note) ui.warn(`  ${chosen.note}`);
  try {
    await agent.runTurn(args.print!);
  } catch (err: any) {
    ui.error(`\n${err?.message ?? err}`);
    process.exitCode = 1;
  }
  taskManager.killAll();
  ui.close();
}

// ---- interactive TUI -------------------------------------------------------

const SLASH_COMMANDS = [
  { name: "models", desc: "Switch model" },
  { name: "mode", desc: "Set mode (ro / write / yolo)" },
  { name: "effort", desc: "Set reasoning effort" },
  { name: "plan", desc: "Show the agent's plan" },
  { name: "context", desc: "Show context usage" },
  { name: "compact", desc: "Compact the conversation now" },
  { name: "tasks", desc: "List background tasks" },
  { name: "logs", desc: "Show task output — /logs t1" },
  { name: "stop", desc: "Stop a background task — /stop t1" },
  { name: "clear", desc: "Reset the conversation" },
  { name: "help", desc: "Show help" },
  { name: "exit", desc: "Quit tiny-coder" },
];

async function runInteractive(args: CliArgs): Promise<void> {
  const isWeb = !!args.web;
  if (!isWeb && (!process.stdout.isTTY || !process.stdin.isTTY)) {
    console.error(
      'Interactive mode needs a terminal. For headless use, run: tiny-coder -p "your prompt" — or serve a browser UI with --web'
    );
    process.exit(1);
  }

  if (isWeb) console.log(`${c.bold("tiny")}${c.dim(c.bold("coder"))} ${c.dim("v" + VERSION + " · web")}`);
  else printLogo();
  process.stdout.write(c.dim("· looking for Ollama and LM Studio…"));
  const models = await detectAll();
  process.stdout.write("\r\x1b[2K");
  if (models.length === 0) {
    console.log(noBackendsMessage());
    process.exit(1);
  }

  const cfg = loadConfig();
  let chosen = autoPickModel(models, args.model, cfg.lastModel);
  process.stdout.write(c.dim(`· loading ${chosen.id}…`));
  chosen = await resolveContextWindow(chosen, args.ctx);
  process.stdout.write("\r\x1b[2K");

  const mode0 = args.mode ?? cfg.lastMode ?? "write";
  let effort: Effort | null = args.effort !== undefined ? args.effort : (cfg.effort ?? null);

  const shell = pickShell();
  const bus = new EventBus();
  const provider = makeProvider(chosen);
  provider.setEffort(effort);
  const taskManager = new TaskManager(args.workspace);
  const toolCtx: ToolContext = {
    workspace: args.workspace,
    taskManager,
    plan: new Plan(),
    filesTouched: new Set(),
    commandsRun: [],
  };
  const ctxMgr = new ContextManager(chosen.contextWindow, provider.maxOutputTokens);
  const agentsMd = loadAgentsMd(args.workspace);
  const sysPrompt = (m: Mode) =>
    buildSystemPrompt({ workspace: args.workspace, mode: m, shellLabel: shell.label, agentsMd });

  const tui: SessionUI = isWeb ? new WebUI(args.webPort ?? 7433) : new Tui();
  const agent = new Agent(provider, mode0, sysPrompt(mode0), toolCtx, ctxMgr, bus, tui, true, 30);

  const persist = () => saveConfig({ lastModel: chosen.id, lastMode: agent.mode, effort });

  tui.slashCommands = SLASH_COMMANDS;
  tui.hintLeft = args.workspace.replace(os.homedir(), "~");
  tui.getStatus = () => {
    const tasks = taskManager.runningSummary().length;
    return (
      `${modeColored(agent.mode)} ${c.dim("·")} ${chosen.id} ${c.dim(chosen.backend)}` +
      (effort ? ` ${c.dim("·")} ${c.yellow(effort)}` : "") +
      ` ${c.dim("·")} ${c.dim(`${fmtTokens(agent.contextTokens())} (${agent.contextPercent()}%)`)}` +
      (toolCtx.plan.exists
        ? ` ${c.dim("·")} ${
            toolCtx.plan.currentIndex < 0
              ? c.green(`plan ${toolCtx.plan.doneCount}/${toolCtx.plan.steps.length}`)
              : c.cyan(`plan ${toolCtx.plan.doneCount}/${toolCtx.plan.steps.length}`)
          }`
        : "") +
      (tasks ? ` ${c.dim("·")} ${c.green(`${tasks} task${tasks > 1 ? "s" : ""}`)}` : "")
    );
  };
  tui.onModeCycle = () => {
    const next = MODE_ORDER[(MODE_ORDER.indexOf(agent.mode) + 1) % MODE_ORDER.length];
    agent.setMode(next, sysPrompt(next));
    persist();
  };
  tui.onCancel = () => agent.cancel();

  const shutdown = async () => {
    await bus.emit("session_end");
    taskManager.killAll();
    tui.close();
    process.exit(0);
  };
  tui.onExit = () => void shutdown();
  process.on("exit", () => taskManager.killAll());

  bus.on("post_compact", (report: any) => {
    if (report?.action === "evicted")
      tui.status(`· freed context by dropping old tool output (${report.before} → ${report.after} tokens est.)`);
    if (report?.action === "compacted")
      tui.status(`· compacted conversation (${report.before} → ${report.after} tokens est.)`);
  });

  if (tui instanceof WebUI) {
    tui.getState = () => ({
      mode: agent.mode,
      model: chosen.id,
      backend: chosen.backend,
      effort,
      ctxTokens: agent.contextTokens(),
      ctxPct: agent.contextPercent(),
      plan: toolCtx.plan.exists
        ? { steps: toolCtx.plan.steps, current: toolCtx.plan.currentIndex }
        : null,
      tasks: taskManager.runningSummary().length,
      workspace: args.workspace,
      commands: SLASH_COMMANDS,
    });
  }

  tui.start();
  tui.println(sessionLine(chosen, agent.mode));
  if (chosen.note) tui.warn(`  ${chosen.note}`);
  tui.status(`  workspace ${args.workspace} · shell ${shell.label}`);
  if (agentsMd) tui.status(`  AGENTS.md loaded (${agentsMd.split("\n").length} lines)`);
  if (!isWeb) tui.println("");
  persist();
  await bus.emit("session_start");

  const switchModel = async (filter?: string): Promise<void> => {
    const fresh = await detectAll();
    if (!fresh.length) {
      tui.error("No backends reachable right now.");
      return;
    }
    const options = fresh.map((m) => ({
      label: m.id,
      hint:
        m.backend === "ollama"
          ? "ollama"
          : `lm studio${m.loaded ? ` · ctx ${m.contextWindow.toLocaleString()}` : " · not loaded"}`,
      current: m.id === chosen.id && m.backend === chosen.backend,
    }));
    const idx = await tui.select("Select model", options);
    if (idx === null) return;
    tui.startSpinner(`loading ${fresh[idx].id}`);
    const next = await resolveContextWindow(fresh[idx], args.ctx);
    tui.stopSpinner();
    chosen = next;
    const p = makeProvider(next);
    p.setEffort(effort);
    agent.setProvider(p);
    ctxMgr.setWindow(next.contextWindow, p.maxOutputTokens);
    persist();
    tui.println(sessionLine(next, agent.mode));
    if (next.note) tui.warn(`  ${next.note}`);
    void filter;
  };

  const setMode = async (arg?: string): Promise<void> => {
    let next: Mode | undefined =
      arg === "ro" ? "ro" : arg === "write" ? "write" : arg === "yolo" ? "yolo" : undefined;
    if (!next) {
      const idx = await tui.select("Select mode", [
        { label: "read-only", hint: "read and search files only", current: agent.mode === "ro" },
        { label: "write", hint: "edit files; commands ask y/n", current: agent.mode === "write" },
        { label: "yolo", hint: "full access, no approvals", current: agent.mode === "yolo" },
      ]);
      if (idx === null) return;
      next = MODE_ORDER[idx];
    }
    agent.setMode(next, sysPrompt(next));
    persist();
  };

  const setEffort = async (arg?: string): Promise<void> => {
    const levels: (Effort | "default")[] = ["default", "off", "low", "medium", "high"];
    let next: Effort | null | undefined;
    if (arg && (levels as string[]).includes(arg)) {
      next = arg === "default" ? null : (arg as Effort);
    } else {
      const idx = await tui.select("Reasoning effort", [
        { label: "default", hint: "leave it to the model", current: effort === null },
        { label: "off", hint: "no thinking — fastest", current: effort === "off" },
        { label: "low", hint: "", current: effort === "low" },
        { label: "medium", hint: "", current: effort === "medium" },
        { label: "high", hint: "most thorough", current: effort === "high" },
      ]);
      if (idx === null) return;
      next = idx === 0 ? null : (levels[idx] as Effort);
    }
    effort = next;
    agent.provider.setEffort(effort);
    persist();
  };

  for (;;) {
    const input = await tui.readInput();

    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.slice(1).split(/\s+/);
      const arg = rest[0];
      switch (cmd) {
        case "exit":
        case "quit":
        case "q":
          await shutdown();
          return;
        case "help":
          tui.println(HELP);
          break;
        case "models":
        case "model":
          await switchModel(arg);
          break;
        case "mode":
          await setMode(arg);
          break;
        case "effort":
          await setEffort(arg);
          break;
        case "plan":
          if (toolCtx.plan.exists) tui.planUpdated(toolCtx.plan);
          else tui.status("· no plan yet — the agent creates one when it starts a multi-step task");
          break;
        case "tasks":
          tui.println(taskManager.list());
          break;
        case "logs":
          tui.println(taskManager.logs(arg ?? "", Number(rest[1]) || 50));
          break;
        case "stop":
          tui.println(taskManager.stop(arg ?? ""));
          break;
        case "compact":
          tui.startSpinner("compacting");
          await agent.compactNow();
          tui.stopSpinner();
          tui.status(`· compacted — ctx now ${agent.contextPercent()}%`);
          break;
        case "context":
          tui.status(
            `· ctx ${agent.contextPercent()}% of ${chosen.contextWindow.toLocaleString()} tokens · ${agent.messages.length} messages`
          );
          break;
        case "clear":
          agent.resetTranscript();
          toolCtx.plan.reset();
          tui.status("· conversation cleared");
          break;
        default:
          tui.warn(`Unknown command /${cmd} — try /help`);
      }
      continue;
    }

    try {
      await agent.runTurn(input);
    } catch (err: any) {
      tui.error(`\n${err?.message ?? err}`);
      if (String(err?.message ?? "").toLowerCase().includes("does not support tools")) {
        tui.warn(
          "This model does not support tool calling. Pick a tool-capable model with /models (e.g. qwen3, llama3.1, mistral-nemo)."
        );
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
