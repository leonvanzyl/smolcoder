#!/usr/bin/env node
// smolcoder — a smol, zero-config CLI coding agent for local models.
//
// Interactive: an opencode-style inline TUI. No upfront questions — the last
// (or first) detected model is picked automatically; switch with /models,
// cycle modes with shift+tab, set reasoning effort with /effort.
// Web: smol --web serves a browser UI with a workspace sidebar — many
// projects and sessions side by side, started from anywhere.
// Headless: smol -p "prompt" for people and automations.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent } from "./agent";
import { loadConfig } from "./config";
import { ContextManager } from "./context";
import { EventBus } from "./events";
import { Plan } from "./plan";
import { buildSystemPrompt, loadAgentsMd } from "./prompt";
import { Effort } from "./providers/types";
import {
  effortAdvice,
  makeProvider,
  noBackendsMessage,
  prepareModel,
  reportCompactions,
  Session,
  SessionPrefs,
  sessionLine,
} from "./session";
import { Mode, ToolContext } from "./tools/index";
import { pickShell } from "./tools/shell";
import { TaskManager } from "./tools/tasks";
import { Tui } from "./tui/tui";
import { UI } from "./ui";
import { c } from "./util";
import { askHubToOpen, pingHub, readHubRecord, WebHub } from "./web/hub";

const VERSION = require("../package.json").version as string;
const DEFAULT_WEB_PORT = 7433;

interface CliArgs {
  workspace: string;
  /** A folder was given on the command line (vs. defaulting to the cwd). */
  workspaceGiven?: boolean;
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

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { workspace: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--mode" || a === "-m") {
      const v = argv[++i];
      if (v === "ro" || v === "read-only" || v === "readonly") args.mode = "ro";
      else if (v === "edit" || v === "e" || v === "write" || v === "w") args.mode = "edit";
      else if (v === "bypass" || v === "bypass-permissions" || v === "b" || v === "yolo" || v === "y")
        args.mode = "bypass";
      else {
        console.error(`Unknown mode "${v}". Use ro, edit, or bypass.`);
        process.exit(1);
      }
    } else if (a === "--bypass" || a === "--bypass-permissions" || a === "--yolo") args.mode = "bypass";
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
    } else if (!a.startsWith("-")) {
      args.workspace = path.resolve(a);
      args.workspaceGiven = true;
    } else {
      console.error(`Unknown option "${a}". Try smol --help.`);
      process.exit(1);
    }
  }
  return args;
}

const HELP = `
${c.bold("smolcoder")} v${VERSION} — a smol, zero-config coding agent for local models.

Detects Ollama and LM Studio automatically. No configuration.

${c.bold("Usage:")}
  smol [workspace] [options]

${c.bold("Options:")}
  -m, --mode <ro|edit|bypass>  ro: read files only. edit: read/write files and run
                               commands inside the workspace; anything reaching
                               outside it asks y/n. bypass: no approvals at all.
  --model <name>               pick a model by (partial) name
  --ctx <tokens>               force a context window (Ollama: sends num_ctx)
  --effort <level>             reasoning effort: off, low, medium, high, default
  --web [port]                 browser UI (default port ${DEFAULT_WEB_PORT}): a sidebar of your
                               workspaces and sessions, an embedded browser and
                               terminal panel. Run it from anywhere; a second
                               smol --web adds its folder to the running UI.
  -p, --print "<prompt>"       headless: run a single prompt and exit
  -h, --help                   this help
  -v, --version                version

${c.bold("Keys:")}
  shift+tab   cycle mode (read-only → edit → bypass permissions)
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

/** Node fires 'exit' on normal termination but NOT on a killing signal, so
 * background tasks (dev servers) survive a closed terminal (SIGHUP) or `kill`
 * (SIGTERM) unless we handle those explicitly. Runs synchronous cleanup then
 * re-exits so the 'exit' path is still reached. */
function installSignalCleanup(cleanup: () => void): void {
  let done = false;
  const run = (code: number) => {
    if (done) return;
    done = true;
    try {
      cleanup();
    } catch {
      /* best effort */
    }
    process.exit(code);
  };
  process.on("SIGTERM", () => run(143));
  process.on("SIGHUP", () => run(129));
  process.on("SIGINT", () => run(130));
}

const LOGO_ROWS = [
  "███████╗ ███╗   ███╗  ██████╗  ██╗     ",
  "██╔════╝ ████╗ ████║ ██╔═══██╗ ██║     ",
  "███████╗ ██╔████╔██║ ██║   ██║ ██║     ",
  "╚════██║ ██║╚██╔╝██║ ██║   ██║ ██║     ",
  "███████║ ██║ ╚═╝ ██║ ╚██████╔╝ ███████╗",
  "╚══════╝ ╚═╝     ╚═╝  ╚═════╝  ╚══════╝",
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
    console.log(`${c.bold("smol")}${c.dim(c.bold("coder"))} ${c.dim("v" + VERSION)}`);
  }
}

function prefsOf(args: CliArgs): SessionPrefs {
  return { mode: args.mode, model: args.model, ctx: args.ctx, effort: args.effort };
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

  if (args.print !== undefined) await runHeadless(args);
  else if (args.web) await runWeb(args);
  else await runInteractive(args);
}

// ---- headless (-p) ---------------------------------------------------------

async function runHeadless(args: CliArgs): Promise<void> {
  const ui = new UI();
  const bus = new EventBus();
  const cfg = loadConfig();
  const chosen = await prepareModel(prefsOf(args), cfg);
  if (!chosen) {
    ui.println(noBackendsMessage());
    ui.close();
    process.exit(1);
  }
  const mode = args.mode ?? cfg.lastMode ?? "edit";

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
  const agent = new Agent(provider, mode, systemPrompt, toolCtx, ctxMgr, bus, ui, false, 1000);
  reportCompactions(bus, ui);
  process.on("exit", () => taskManager.killAll());
  installSignalCleanup(() => taskManager.killAll());

  ui.println(sessionLine(chosen, mode));
  if (chosen.note) ui.warn(`  ${chosen.note}`);
  const effortSetting = args.effort !== undefined ? args.effort : (cfg.effort ?? null);
  ui.status(`  effort ${provider.effortLabel() ?? effortSetting ?? "default"}`);
  const advice = effortAdvice(chosen, effortSetting);
  if (advice) ui.warn(`  ${advice}`);
  try {
    await agent.runTurn(args.print!);
  } catch (err: any) {
    ui.error(`\n${err?.message ?? err}`);
    process.exitCode = 1;
  }
  const st = agent.lastTurnStats;
  if (st) {
    // Machine-readable summary for scripts/benchmarks comparing backends.
    process.stderr.write(
      `[stats] ${JSON.stringify({
        backend: chosen.backend,
        model: chosen.id,
        durationMs: st.durationMs,
        modelCalls: st.modelCalls,
        toolCalls: st.toolCalls,
        generatedTokens: st.generatedTokens,
        thinkingTokensEst: Math.round(st.thinkingChars / 4),
        genTokPerSec: st.genSeconds > 0 ? Math.round(st.generatedTokens / st.genSeconds) : null,
        promptTokensLast: st.promptTokensLast,
        contextWindow: chosen.contextWindow,
        planDone: toolCtx.plan.exists ? `${toolCtx.plan.doneCount}/${toolCtx.plan.steps.length}` : null,
      })}\n`
    );
  }
  taskManager.killAll();
  ui.close();
}

// ---- interactive TUI -------------------------------------------------------

async function runInteractive(args: CliArgs): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(
      'Interactive mode needs a terminal. For headless use, run: smol -p "your prompt" — or serve a browser UI with --web'
    );
    process.exit(1);
  }

  printLogo();
  const cfg = loadConfig();
  process.stdout.write(c.dim("· looking for Ollama and LM Studio…"));
  const chosen = await prepareModel(prefsOf(args), cfg, (label) => {
    process.stdout.write("\r\x1b[2K" + c.dim(`· ${label}…`));
  });
  process.stdout.write("\r\x1b[2K");
  if (!chosen) {
    console.log(noBackendsMessage());
    process.exit(1);
  }

  const tui = new Tui();
  const session = new Session(tui, { workspace: args.workspace, chosen, prefs: prefsOf(args), cfg, help: HELP });
  session.onExit = () => process.exit(0);
  process.on("exit", () => session.taskManager.killAll());
  installSignalCleanup(() => {
    session.taskManager.killAll();
    try {
      tui.close(); // restore the raw-mode terminal on signal death
    } catch {
      /* best effort */
    }
  });

  tui.start();
  session.announce();
  tui.println("");
  await session.run();
}

// ---- web hub (--web) -------------------------------------------------------

/** The home folder or a drive root is not a project: launching there opens
 * the hub with the sidebar and lets the user pick a workspace. */
function isHomeOrRoot(p: string): boolean {
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const r = path.resolve(p);
  return norm(r) === norm(os.homedir()) || path.dirname(r) === r;
}

async function runWeb(args: CliArgs): Promise<void> {
  console.log(`${c.bold("smol")}${c.dim(c.bold("coder"))} ${c.dim("v" + VERSION + " · web")}`);
  const port = args.webPort ?? DEFAULT_WEB_PORT;
  const workspace = args.workspace;
  const autoStart = !!args.workspaceGiven || !isHomeOrRoot(workspace);

  // A hub is already running: hand it this folder instead of starting another.
  const rec = readHubRecord();
  if (rec && (args.webPort === undefined || rec.port === port) && (await pingHub(rec))) {
    const r = await askHubToOpen(rec, workspace, autoStart);
    if (r) {
      const url = `http://127.0.0.1:${rec.port}/?k=${rec.token}${r.id ? "#" + r.id : ""}`;
      console.log(
        `\n  ${autoStart ? "started a session for" : "added"} ${workspace} in the running web UI:\n  ${url}\n`
      );
      return;
    }
  }

  const hub = new WebHub({ port, prefs: prefsOf(args), help: HELP, version: VERSION });
  try {
    await hub.start();
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      console.error(`\nPort ${port} is already in use. Pick another with: smol --web ${port + 1}`);
      process.exit(1);
    }
    throw err;
  }
  process.on("exit", () => hub.shutdownSync());
  installSignalCleanup(() => hub.shutdownSync());

  if (autoStart) hub.openSession(workspace);
  console.log(
    `\n  smolcoder web UI:  ${hub.url()}\n  ${
      autoStart ? `workspace ${workspace}` : "pick a workspace in the sidebar"
    } · ctrl+c stops the server\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
