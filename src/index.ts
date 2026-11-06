#!/usr/bin/env node
// smolcoder — a smol, zero-config CLI coding agent for local models.
//
// Interactive: an inline TUI. No upfront questions — the last
// (or first) detected model is picked automatically; switch with /models,
// cycle modes with shift+tab, set reasoning effort with /effort.
// Web: smol --web serves a browser UI with a workspace sidebar — many
// projects and sessions side by side, started from anywhere.
// Headless: smol -p "prompt" for people and automations.

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent } from "./agent";
import { commandHelp } from "./commands";
import { DATA_DIR, loadConfig } from "./config";
import { ContextManager } from "./context";
import { EventBus } from "./events";
import { Plan } from "./plan";
import { buildSystemPrompt, loadAgentsMd } from "./prompt";
import { Effort } from "./providers/types";
import {
  effortAdvice,
  makeProvider,
  modelNotes,
  noBackendsMessage,
  prepareModel,
  refreshModels,
  reportCompactions,
  Session,
  backendLabel,
  SessionPrefs,
  sessionLine,
  setupWithoutLocalModels,
} from "./session";
import { Mode, ToolContext } from "./tools/index";
import { pickShell } from "./tools/shell";
import { TaskManager } from "./tools/tasks";
import { Tui, restoreTerminal } from "./tui/tui";
import { UI } from "./ui";
import { c } from "./util";
import { askHubToOpen, pingHub, readHubRecord, RestartHandoff, WebHub } from "./web/hub";
import { SESSION_ID_RE, SessionStore } from "./web/store";
import { runUpdateFlow, watchForUpdates } from "./tui/updater";
import { relaunch, restartArgs, restartEntry } from "./update";

const VERSION = require("../package.json").version as string;
const DEFAULT_WEB_PORT = 7433;

// Set by a restart after /update for the new copy only: read once and kept
// out of everything this process starts (tasks, terminals, tools).
const UPDATED_FROM = process.env.SMOLCODER_UPDATED_FROM;
const WEB_HANDOFF = process.env.SMOLCODER_WEB_HANDOFF;
delete process.env.SMOLCODER_UPDATED_FROM;
delete process.env.SMOLCODER_WEB_HANDOFF;

interface CliArgs {
  workspace: string;
  /** A folder was given on the command line (vs. defaulting to the cwd). */
  workspaceGiven?: boolean;
  mode?: Mode;
  model?: string;
  ctx?: number;
  print?: string;
  verify?: string;
  verifyAttempts?: number;
  effort?: Effort | null; // null = explicit "default"
  web?: boolean;
  webPort?: number;
  help?: boolean;
  version?: boolean;
  /** Internal (the restart after /update): reopen this saved session. */
  resume?: string;
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
    else if (a === "--ctx") {
      args.ctx = Number(argv[++i]);
      if (!Number.isSafeInteger(args.ctx) || args.ctx < 1024) {
        console.error("--ctx must be a whole number of at least 1024 tokens.");
        process.exit(1);
      }
    }
    else if (a === "--effort") {
      const v = argv[++i];
      if (v === "off" || v === "low" || v === "medium" || v === "high") args.effort = v;
      else if (v === "default") args.effort = null;
      else {
        console.error(`Unknown effort "${v}". Use off, low, medium, high, or default.`);
        process.exit(1);
      }
    } else if (a === "--verify") {
      args.verify = argv[++i];
      if (!args.verify?.trim()) throw new Error('--verify needs an acceptance command');
    } else if (a === "--verify-attempts") {
      args.verifyAttempts = Number(argv[++i]);
      if (!Number.isSafeInteger(args.verifyAttempts) || args.verifyAttempts < 1) throw new Error('--verify-attempts must be a positive whole number');
    } else if (a === "--print" || a === "-p") args.print = argv[++i];
    else if (a === "--resume") {
      const id = argv[++i] ?? "";
      if (SESSION_ID_RE.test(id)) args.resume = id;
    }
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

Detects Ollama, LM Studio, oMLX and MTPLX on this computer automatically — any
port, Docker containers included. Models on other machines: /models → "Find models on
another machine" searches your network or takes an address, and remembers it.

${c.bold("Usage:")}
  smol [workspace] [options]

${c.bold("Options:")}
  -m, --mode <ro|edit|bypass>  ro: read files only. edit: read/write files and run
                               commands inside the workspace; anything reaching
                               outside it asks y/n. bypass: no approvals at all.
  --model <name>               pick a model by (partial) name
  --ctx <tokens>               force a context window (Ollama: sends num_ctx)
  --verify <command>           headless acceptance gate; automatically repair failures
  --verify-attempts <count>     maximum acceptance checks (default 6; requires --verify)
  --effort <level>             reasoning effort: off, low, medium, high, default
  --web [port]                 browser UI (default port ${DEFAULT_WEB_PORT}): a sidebar of your
                               workspaces and sessions, an embedded browser and
                               terminal panel. Run it from anywhere; a second
                               smol --web adds its folder to the running UI.
  -p, --print "<prompt>"       headless: run a single prompt and exit
  -h, --help                   this help
  -v, --version                version

${commandHelp()}

Custom commands: /commands new saves a prompt template you then run as /name
(this workspace or all of them). Sessions are saved; /sessions resumes one.
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

/** Printed on the normal screen after the TUI closes: what the session was,
 * how to get back to it, and the model. */
function printExitSummary(session: Session): void {
  const first = session.agent.messages.find((m) => m.role === "user" && !m.compactNote && !m.historyNote && m.content.trim());
  const title = first ? first.content.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  const model = `${session.chosen.id} ${c.dim(backendLabel(session.chosen))}`;
  const lines = [""];
  lines.push(`  ${c.cyan(c.bold("smol"))}${c.dim("coder")}  ${c.dim("v" + VERSION)}`);
  if (title) {
    lines.push(`  ${c.dim("Session")}  ${c.bold(title)}`);
    lines.push(`  ${c.dim("Resume ")}  run ${c.bold("smol")} here, then ${c.cyan("/sessions")}`);
  } else lines.push(`  ${c.dim("Session")}  nothing sent, nothing saved`);
  lines.push(`  ${c.dim("Model  ")}  ${model}`);
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
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
  if (args.verify && (!args.print || args.web)) throw new Error('--verify requires a headless -p run');
  if (args.verifyAttempts !== undefined && !args.verify) throw new Error('--verify-attempts requires --verify');
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
  const systemPrompt = buildSystemPrompt({
    workspace: args.workspace,
    mode,
    shellLabel: shell.label,
    agentsMd,
    chatOnly: chosen.toolsSupported === false,
  });
  const agent = new Agent(provider, mode, systemPrompt, toolCtx, ctxMgr, bus, ui, false, 1000,
    args.verify ? { command: args.verify, maxAttempts: args.verifyAttempts } : undefined);
  reportCompactions(bus, ui);
  process.on("exit", () => taskManager.killAll());
  installSignalCleanup(() => taskManager.killAll());

  ui.println(sessionLine(chosen, mode));
  for (const note of modelNotes(chosen)) ui.warn(`  ${note}`);
  const effortSetting = args.effort !== undefined ? args.effort : (cfg.effort ?? null);
  ui.status(`  effort ${provider.effortLabel() ?? effortSetting ?? "default"}`);
  const advice = effortAdvice(chosen, effortSetting);
  if (advice) ui.warn(`  ${advice}`);
  if (args.verify && chosen.toolsSupported === false) {
    // A model that can only chat cannot repair anything: every acceptance
    // attempt would fail the same way. Stop before the first model call.
    ui.error(`--verify needs a model that can use tools, and ${chosen.id} can only chat. Pick a tool-capable model with --model.`);
    process.exitCode = 1;
    taskManager.killAll();
    ui.close();
    return;
  }
  try {
    await agent.runTurn(args.print!);
    if (agent.outcome !== "completed") process.exitCode = 1;
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
        outcome: agent.outcome,
        verification: agent.verificationResult ? { attempts: agent.verificationResult.attempts, passed: agent.verificationResult.passed } : null,
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

  // The full-screen TUI opens at once on its home screen (the SMOL logo);
  // finding a model shows as its spinner. Until a session exists, esc or
  // ctrl+c quits.
  const tui = new Tui();
  tui.version = VERSION;
  tui.hintLeft = args.workspace.replace(os.homedir(), "~");
  tui.onCancel = () => {
    tui.close();
    process.exit(130);
  };
  // A crash must not leave the terminal on the alternate screen.
  const crash = (err: unknown) => {
    restoreTerminal();
    console.error(err);
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  tui.start();
  // Restarted by /update: say so once, and keep it out of child processes.
  if (UPDATED_FROM && UPDATED_FROM !== VERSION) tui.notify(`Updated smolcoder ${UPDATED_FROM} → ${VERSION}`, "success", 6000);
  // Is there a newer version? In the background, never in the way.
  void watchForUpdates(tui);
  const cfg = loadConfig();
  tui.startSpinner("Looking for model servers");
  let chosen = await prepareModel(prefsOf(args), cfg, (label) => tui.startSpinner(label.charAt(0).toUpperCase() + label.slice(1)));
  tui.stopSpinner();

  if (!chosen) {
    // Nothing on this computer: offer to look on the network.
    chosen = await setupWithoutLocalModels(tui, prefsOf(args));
    if (!chosen) {
      tui.close();
      console.log(noBackendsMessage());
      process.exit(1);
    }
  }

  const session = new Session(tui, { workspace: args.workspace, chosen, prefs: prefsOf(args), cfg, help: HELP });
  // Saved where the web UI keeps its sessions: /sessions (and the web
  // sidebar) list them per workspace.
  let store: SessionStore | null = null;
  try {
    store = new SessionStore(DATA_DIR);
    session.persistTo(store);
  } catch {
    /* no writable data folder: the session just is not saved */
  }
  session.onExit = () => {
    tui.close();
    printExitSummary(session);
    process.exit(0);
  };
  // After /update, "Restart now" hands the terminal to the updated copy;
  // from then on this process only waits for it.
  let handedOver = false;
  session.updateHost = {
    run: () =>
      runUpdateFlow(tui, {
        runningTasks: () => session.taskManager.runningSummary().length,
        restart: (install) => {
          session.saveNow();
          const id = session.sessionId;
          const saved = !!id && !!store?.listMetas().some((m) => m.id === id);
          session.taskManager.killAll();
          tui.close();
          handedOver = true;
          relaunch(restartEntry(install), restartArgs(process.argv.slice(2), saved ? id : null));
          return new Promise<void>(() => {});
        },
      }),
    noticesChanged: (on) => {
      if (on) void watchForUpdates(tui);
      else tui.setUpdateAvailable(null);
    },
  };
  process.on("exit", () => session.taskManager.killAll());
  installSignalCleanup(() => {
    if (handedOver) return; // the new copy saves and cleans up after itself
    try {
      session.saveNow();
    } catch {
      /* best effort */
    }
    session.taskManager.killAll();
    try {
      tui.close(); // restore the raw-mode terminal on signal death
    } catch {
      /* best effort */
    }
  });

  tui.start();
  session.announce();
  // Restarted after /update: back to the session that was open.
  if (args.resume && store) {
    const meta = store.listMetas().find((m) => m.id === args.resume);
    if (meta) session.resumeStored(meta);
  }
  // Scan this computer and added machines once in the background, so the
  // model picker and F2 open on a full list without waiting.
  void refreshModels();
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

/** The hub before this one (after "Restart server"), or null. */
function readHandoff(): RestartHandoff | null {
  if (!WEB_HANDOFF) return null;
  try {
    const h = JSON.parse(WEB_HANDOFF);
    if (h && typeof h.token === "string" && Number.isSafeInteger(h.port) && Array.isArray(h.sessions)) return h;
  } catch {
    /* not ours */
  }
  return null;
}

async function runWeb(args: CliArgs): Promise<void> {
  const handoff = readHandoff();
  console.log(`${c.bold("smol")}${c.dim(c.bold("coder"))} ${c.dim("v" + VERSION + " · web")}${handoff ? c.dim(` · restarted from v${handoff.from}`) : ""}`);
  const port = handoff ? handoff.port : (args.webPort ?? DEFAULT_WEB_PORT);
  const workspace = args.workspace;
  // A restart reopens the sessions that were open instead.
  const autoStart = !handoff && (!!args.workspaceGiven || !isHomeOrRoot(workspace));

  // A hub is already running: hand it this folder instead of starting another.
  const rec = handoff ? null : readHubRecord();
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

  let handedOver = false;
  const hub = new WebHub({
    port,
    prefs: prefsOf(args),
    help: HELP,
    version: VERSION,
    token: handoff?.token,
    updates: { auto: true },
    // "Restart server" after an update: the same command line again on the
    // same port with the same key, in this terminal; this process waits.
    onRestart: (h) => {
      handedOver = true;
      console.log(`\n  restarting the web UI on the new version…\n`);
      relaunch(h.entry, process.argv.slice(2), { env: { ...process.env, SMOLCODER_WEB_HANDOFF: JSON.stringify(h) } });
    },
  });
  // The hub before this one may take a moment to let go of the port.
  for (let tries = 0; ; tries++) {
    try {
      await hub.start();
      break;
    } catch (err: any) {
      if (err?.code === "EADDRINUSE" && handoff && tries < 40) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      if (err?.code === "EADDRINUSE") {
        console.error(`\nPort ${port} is already in use. Pick another with: smol --web ${port + 1}`);
        process.exit(1);
      }
      throw err;
    }
  }
  process.on("exit", () => hub.shutdownSync());
  installSignalCleanup(() => {
    if (!handedOver) hub.shutdownSync();
  });

  if (handoff) hub.restoreSessions(handoff.sessions);
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
