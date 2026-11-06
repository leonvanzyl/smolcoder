// One session = one workspace + one agent + one UI, plus the input loop and
// slash commands that drive it. Extracted from the CLI entry point so the
// terminal TUI and the web hub (many sessions side by side, one per browser
// sidebar entry) run exactly the same loop.

import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import { Agent } from "./agent";
import {
  BUILTIN_COMMANDS,
  COMMAND_ALIASES,
  COMMANDS_ARGS,
  commandHelp,
  EFFORT_LEVELS,
  effortArgs,
  findCommand,
  MODE_HINTS,
  modeArgs,
  MODELS_ARGS,
  taskArgs,
} from "./commands";
import {
  Config,
  DATA_DIR,
  loadConfig,
  ModelRef,
  recordRecentModel,
  sameModel,
  saveModelEffort,
  toggleFavoriteModel,
  updateConfig,
} from "./config";
import { ContextManager } from "./context";
import {
  CustomCommand,
  customSlashCommands,
  expandTemplate,
  globalCommandsDir,
  isValidCommandName,
  loadCustomCommands,
  workspaceCommandsDir,
  writeCustomCommand,
} from "./custom-commands";
import { detectAll, DetectedModel, resolveContextWindow, withCapabilities } from "./detect";
import { countMessages, eventsFromMessages, replayTranscript, sessionOptions } from "./transcript";
import { SessionMeta, SessionStore, WorkspaceStore } from "./web/store";
import * as fs from "fs";
import { EventBus } from "./events";
import { findModelsOnNetwork, FlowUI, manageHosts } from "./network";
import { Plan, PlanStep } from "./plan";
import { buildSystemPrompt, loadAgentsMd } from "./prompt";
import { LmStudioProvider } from "./providers/lmstudio";
import { mtplxApiKey } from "./mtplx";
import { omlxApiKey } from "./omlx";
import { OllamaProvider } from "./providers/ollama";
import { Effort, Msg, Provider } from "./providers/types";
import { Mode, MODE_LABELS, ToolContext } from "./tools/index";
import { pickShell } from "./tools/shell";
import { TaskManager } from "./tools/tasks";
import { renderPlan, SelectOption, SessionUI, SlashCommand } from "./ui";
import { c, truncateEnd } from "./util";

/** Per-session preferences from the command line. `effort: null` means an
 * explicit "default"; undefined means "whatever the config remembers". */
export interface SessionPrefs {
  mode?: Mode;
  model?: string;
  backend?: string;
  /** Server the wanted model lives on, when the same id exists on several machines. */
  baseUrl?: string;
  ctx?: number;
  effort?: Effort | null;
  /** A resumed session: model and backend are what it used last, a wish
   * rather than a requirement. When that server is gone, any other will do. */
  resumed?: boolean;
}

/** The built-in commands (see src/commands.ts, the registry). A session's own
 * list, with its argument values and custom commands, is Session.commandList(). */
export const SLASH_COMMANDS: SlashCommand[] = BUILTIN_COMMANDS;

export const MODE_ORDER: Mode[] = ["ro", "edit", "bypass"];

// ---- model selection helpers (shared with the headless path) --------------

/** Output budget scales with the window: big windows can afford whole-file
 * writes (a single write_file's JSON must fit in the output), tiny windows
 * must stay conservative. */
export function outputBudget(window: number): number {
  return Math.max(128, Math.min(8192, Math.floor(window / 4)));
}

export function makeProvider(m: DetectedModel): Provider {
  const maxOut = outputBudget(m.contextWindow);
  if (m.backend === "ollama") return new OllamaProvider(m.baseUrl, m.id, m.contextWindow, m.numCtx, maxOut, m.vision, m.toolsSupported);
  if (m.backend === "omlx") return new LmStudioProvider(m.baseUrl, m.id, m.contextWindow, maxOut, undefined, m.vision, omlxApiKey(m.baseUrl), "oMLX");
  if (m.backend === "mtplx") return new LmStudioProvider(m.baseUrl, m.id, m.contextWindow, maxOut, undefined, m.vision, mtplxApiKey(m.baseUrl), "MTPLX");
  return new LmStudioProvider(m.baseUrl, m.id, m.contextWindow, maxOut, m.reasoning, m.vision);
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
    if (report?.action === "evicted") ui.status(`· pruned context (${delta})`);
    else if (report?.action === "compacted") ui.status(`· compacted the conversation into hand-over notes (${delta})`);
    else if (report?.action === "floor")
      ui.warn(`· context is at its floor: system prompt + tools + the working tail no longer fit comfortably (${delta}). Consider a bigger context window.`);
  });
}

/** `url` says which server the wanted (or else the remembered) model was on;
 * it only breaks ties between machines that serve the same model id. */
export function autoPickModel(
  models: DetectedModel[],
  wanted: string | undefined,
  remembered: string | undefined,
  url?: string
): DetectedModel {
  if (wanted) {
    const hit =
      models.find((m) => m.id === wanted && m.baseUrl === url) ??
      models.find((m) => m.id === wanted) ??
      models.find((m) => m.id.toLowerCase().includes(wanted.toLowerCase()));
    if (hit) return hit;
    throw new Error(`Model "${wanted}" was not found on the selected backend. Use /models to choose an available model.`);
  }
  // With nothing remembered, a model on this computer beats one across the network.
  const local = models.filter((m) => !m.host);
  const pool = local.length ? local : models;
  return (
    models.find((m) => m.id === remembered && m.baseUrl === url) ??
    models.find((m) => m.id === remembered) ??
    pool.find((m) => m.backend === "ollama") ??
    pool.find((m) => m.loaded) ??
    pool[0]
  );
}

export function noBackendsMessage(): string {
  return (
    c.red("No usable model found.") +
    `\n\nsmolcoder connects to a running model server; it does not scan installed apps or drives.\n` +
    `  · ${c.bold("Ollama")}: start the app (or run: ollama serve), then check: ollama list\n` +
    `    Found on this computer, at ${c.dim("$OLLAMA_HOST")}, and in Docker containers that publish its port.\n` +
    `    If the list is empty, run: ollama pull qwen3\n` +
    `  · ${c.bold("LM Studio")}: load a model and start Local Server in the Developer tab (any port).\n` +
    `  · ${c.bold("oMLX")}: start its server (menu bar app). The API key is read from its settings; set ${c.dim("OMLX_API_KEY")} for one on another machine.\n` +
    `  · ${c.bold("MTPLX")}: start its server (app play button, or: mtplx start). Set ${c.dim("MTPLX_API_KEY")} if it runs with --api-key.\n` +
    `  · ${c.bold("Another machine")}: start smol in a terminal or with --web and choose "Find models on another machine".\n\n` +
    `Then run smol again.`
  );
}

/** "ollama" on this computer, "ollama @ gpu-box" across the network. */
export function backendLabel(m: DetectedModel): string {
  return m.host ? `${m.backend} @ ${m.host}` : m.backend;
}

export function sessionLine(m: DetectedModel, mode: Mode): string {
  return `${c.green("●")} ${backendLabel(m)} · ${c.bold(m.id)} · ctx ${m.contextWindow.toLocaleString()} · ${MODE_LABELS[mode]} mode`;
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

/** Models on the wanted backend. A resumed session falls back to every
 * backend when its own has nothing: it must not strand the user. */
function onBackend(models: DetectedModel[], prefs: SessionPrefs): DetectedModel[] {
  const same = models.filter((m) => !prefs.backend || m.backend === prefs.backend);
  return same.length || !prefs.resumed ? same : models;
}

/** Exported for tests: the model a session starts with, or null when no
 * server has one. A resumed session whose model is gone gets another, with a
 * note saying so; an explicit --model that is missing is still an error. */
export function pickModel(detected: DetectedModel[], prefs: SessionPrefs, cfg: Config): DetectedModel | null {
  const models = onBackend(detected, prefs);
  if (models.length === 0) return null;
  const url = prefs.model ? prefs.baseUrl : cfg.lastModelUrl;
  const gone = prefs.resumed && prefs.model && !models.some((m) => m.id === prefs.model);
  if (!gone) return autoPickModel(models, prefs.model, cfg.lastModel, url);
  const other = autoPickModel(models, undefined, undefined);
  return { ...other, fallbackNote: `${prefs.model} is not available any more — continuing with ${other.id}.` };
}

/** The warnings a chosen model starts with: why it stands in for another,
 * what its backend said about it, then whether it can only chat. */
export function modelNotes(m: DetectedModel): string[] {
  const chatOnly = m.toolsSupported === false ? `${m.id} can't use tools: it can chat, but can't read, edit or run anything here.` : undefined;
  return [m.fallbackNote, m.note, chatOnly].filter((n): n is string => !!n);
}

/** Detect backends, pick a model and resolve its context window. Returns null
 * when no backend answers. `progress` gets a short label for each slow step. */
export async function prepareModel(
  prefs: SessionPrefs,
  cfg: Config,
  progress?: (label: string) => void
): Promise<DetectedModel | null> {
  progress?.("looking for model servers");
  const url = prefs.model ? prefs.baseUrl : cfg.lastModelUrl;
  // Without --model the remembered one wins anyway, so stop looking the moment
  // it shows up instead of waiting out a network host that is switched off.
  const until =
    !prefs.model && cfg.lastModel
      ? (m: DetectedModel) => m.id === cfg.lastModel && (!url || m.baseUrl === url) && (!prefs.backend || m.backend === prefs.backend)
      : undefined;
  const chosen = pickModel(await detectAll({ hosts: cfg.hosts, until }), prefs, cfg);
  if (!chosen) return null;
  progress?.(`loading ${chosen.id}`);
  return resolveContextWindow(chosen, prefs.ctx);
}

/** Favorites and recents that shape the model picker (both from the config). */
export interface ModelPrefs {
  favoriteModels?: ModelRef[];
  recentModels?: ModelRef[];
}

export const LOCAL_GROUP = "This computer";
export const FAVORITES_GROUP = "Favorites";
export const RECENT_GROUP = "Recent";

function modelHint(m: DetectedModel): string {
  return (
    (m.backend === "ollama" ? "ollama" : m.backend === "omlx" || m.backend === "mtplx" ? `${m.backend} · ctx ${m.contextWindow.toLocaleString()}` : `lm studio${m.loaded ? ` · ctx ${m.contextWindow.toLocaleString()}` : " · not loaded"}`) +
    (m.host ? ` · ${m.host}` : "") +
    (m.toolsSupported === false ? " · chat only" : "")
  );
}

export function modelRef(m: DetectedModel): ModelRef {
  return { id: m.id, baseUrl: m.baseUrl, backend: m.backend };
}

/** Picker rows and the model each row stands for. With `prefs`, the rows are
 * grouped "Favorites", "Recent", then one group per machine (this computer
 * first); a model is listed once, in the first group it belongs to. Without
 * `prefs`, rows follow `models` one to one (each tagged with its machine). */
export function modelRows(
  models: DetectedModel[],
  current?: DetectedModel,
  prefs?: ModelPrefs
): { options: SelectOption[]; models: DetectedModel[] } {
  const favs = prefs?.favoriteModels ?? [];
  const isCurrent = (m: DetectedModel) => !!current && m.id === current.id && m.backend === current.backend && m.baseUrl === current.baseUrl;
  const options: SelectOption[] = [];
  const targets: DetectedModel[] = [];
  const push = (m: DetectedModel, group: string) => {
    const starred = favs.some((f) => sameModel(f, m));
    options.push({
      label: m.id,
      hint: modelHint(m),
      current: isCurrent(m),
      group,
      keywords: [m.backend, m.host ?? "this computer"].join(" "),
      ...(starred ? { starred } : {}),
    });
    targets.push(m);
  };
  const hostGroup = (m: DetectedModel) => m.host ?? LOCAL_GROUP;
  if (!prefs) {
    for (const m of models) push(m, hostGroup(m));
    return { options, models: targets };
  }
  const used = new Set<DetectedModel>();
  const take = (refs: ModelRef[], group: string) => {
    for (const r of refs) {
      const m = models.find((x) => sameModel(x, r) && !used.has(x));
      if (!m) continue;
      used.add(m);
      push(m, group);
    }
  };
  take(favs, FAVORITES_GROUP);
  take(prefs.recentModels ?? [], RECENT_GROUP);
  const groups = [LOCAL_GROUP, ...new Set(models.filter((m) => m.host).map(hostGroup))];
  for (const g of groups) for (const m of models) if (!used.has(m) && hostGroup(m) === g) push(m, g);
  return { options, models: targets };
}

/** Picker rows for a model list (see modelRows; rows match `models` one to
 * one unless `prefs` is given). */
export function modelOptions(models: DetectedModel[], current?: DetectedModel, prefs?: ModelPrefs): SelectOption[] {
  return modelRows(models, current, prefs).options;
}

export const REFRESH_ROW: SelectOption = { label: "↻ Refresh / find on network", hint: "look again here and on added machines", group: "Network" };
export const FIND_ROW: SelectOption = { label: "+ Find models on another machine…", hint: "search my network or enter an address", group: "Network" };
export const HOSTS_ROW: SelectOption = { label: "Network hosts…", hint: "rename, remove or re-find added machines", group: "Network" };

// ---- the model list cache ------------------------------------------------------
// The model picker opens at once on the last full scan (shared by every
// session in this process) and rescans in the background for next time.

let modelCache: DetectedModel[] | null = null;
let modelRefresh: Promise<DetectedModel[]> | null = null;

/** The last full scan (this computer and added machines), or null. */
export function cachedModels(): DetectedModel[] | null {
  return modelCache;
}

/** Forget the cached scan (tests; a model that failed to load). */
export function resetModelCache(): void {
  modelCache = null;
}

/** Scan this computer and every added machine; concurrent calls share one scan. */
export function refreshModels(): Promise<DetectedModel[]> {
  if (!modelRefresh) {
    const run = (async () => withCapabilities(await detectAll({ hosts: loadConfig().hosts ?? [] })))();
    modelRefresh = run
      .then((list) => (modelCache = list))
      .finally(() => {
        modelRefresh = null;
      });
  }
  return modelRefresh;
}

/** Only this computer: fast, never waits on a machine that is switched off. */
async function localModels(): Promise<DetectedModel[]> {
  return withCapabilities(await detectAll({}));
}

/** Nothing answered on this computer. Rather than giving up, offer to look on
 * the network — with both UIs' own pickers, before a session exists. Returns
 * a ready model, or null when the user backs out. */
export async function setupWithoutLocalModels(ui: FlowUI, prefs: SessionPrefs): Promise<DetectedModel | null> {
  for (;;) {
    const pick = await ui.select("No model server found on this computer", [
      { label: "Find models on another machine", hint: "search my network or enter an address" },
      { label: "Look again", hint: "after starting Ollama, LM Studio, oMLX or MTPLX here" },
    ]);
    if (pick === null) return null;
    if (pick === 0 && !(await findModelsOnNetwork(ui))) continue;
    ui.startSpinner("looking for model servers");
    const cfg = loadConfig();
    const models = await withCapabilities(onBackend(await detectAll({ hosts: cfg.hosts }), prefs));
    ui.stopSpinner();
    if (!models.length) {
      ui.warn("Still no model server answering.");
      continue;
    }
    // A machine was just added by hand: let the user say which of its models
    // to load instead of pulling the first one into its memory.
    const idx = models.length === 1 ? 0 : await ui.select("Select model", modelOptions(models));
    if (idx === null) continue;
    ui.startSpinner(`loading ${models[idx].id}`);
    try {
      return await resolveContextWindow(models[idx], prefs.ctx);
    } finally {
      ui.stopSpinner();
    }
  }
}

// ---- session titles ---------------------------------------------------------

/** Ask the model for a short session name from the first exchange. One cheap
 * call with thinking off and a tiny output cap; null when the reply is not
 * usable, in which case the caller keeps its fallback (the first message). */
export async function suggestTitle(messages: Msg[], provider: Provider): Promise<string | null> {
  const first = messages.find((m) => m.role === "user" && !m.compactNote);
  if (!first) return null;
  const reply = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
  try {
    const res = await provider.chat(
      [
        {
          role: "system",
          content:
            "You name coding sessions. Reply with only the title: three to six words, plain text, no quotes, no trailing period.",
        },
        {
          role: "user",
          content:
            `First request:\n${truncateEnd(first.content, 600)}\n\n` +
            (reply ? `Reply excerpt:\n${truncateEnd(reply.content, 400)}\n\n` : "") +
            "Title:",
        },
      ],
      [],
      { effortOverride: "off", maxTokens: 30, timeoutMs: 15_000, background: true }
    );
    return cleanTitle(res.content);
  } catch {
    return null;
  }
}

/** Exported for tests: normalize a model-written title. */
export function cleanTitle(raw: string): string | null {
  let t = String(raw ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
  t = t.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t
    .replace(/^(title|session( name)?)\s*:\s*/i, "")
    .replace(/^["'`“”*#\s]+|["'`“”*.\s]+$/g, "")
    .replace(/\s+/g, " ");
  if (t.length < 3 || /[<>{}]/.test(t)) return null;
  if (t.length > 60) {
    t = t.slice(0, 60);
    const cut = t.lastIndexOf(" ");
    if (cut > 20) t = t.slice(0, cut);
    t = t.replace(/[\s,;:.-]+$/, "");
  }
  return t || null;
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
  /** Server the model ran on (absent in sessions saved before network hosts). */
  baseUrl?: string;
}

export interface SessionOptions {
  workspace: string;
  chosen: DetectedModel;
  prefs: SessionPrefs;
  cfg: Config;
  /** Kept for compatibility: /help is generated from the command registry. */
  help?: string;
  /** Where ~/.smolcoder lives (global custom commands); defaults to DATA_DIR. */
  dataDir?: string;
}

/** A TUI session saving itself to the same store the web hub uses. */
interface Persistence {
  store: SessionStore;
  meta: SessionMeta;
  /** Web replay events, so the web sidebar can open this session too. */
  events: Record<string, any>[];
  /** Messages already turned into events. */
  seen: WeakSet<Msg>;
  /** events.length when each undoable turn started, newest last: /undo cuts
   * the replay back to it. */
  turnMarks?: number[];
  saveFailed?: boolean;
  workspaceAdded?: boolean;
}

const EVENTS_CAP = 2000;

/** What a typed slash line asks for: the command word and the rest verbatim. */
export function parseSlash(input: string): { name: string; rest: string; args: string[] } | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(input);
  if (!m) return null;
  const rest = m[2].trim();
  return { name: m[1].toLowerCase(), rest, args: rest ? rest.split(/\s+/) : [] };
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
  /** Host hook: fired after each completed user turn (the web hub names the
   * session after the first one). */
  onTurnDone: (() => void) | null = null;
  /** Custom commands found at the last look (.smolcoder/commands/*.md). */
  customCommands: CustomCommand[] = [];

  private readonly agentsMd: string | null;
  private readonly prefs: SessionPrefs;
  private readonly dataDir: string;
  private persistence: Persistence | null = null;
  private ended = false;

  constructor(
    readonly ui: SessionUI,
    opts: SessionOptions
  ) {
    const { workspace, chosen, prefs, cfg } = opts;
    this.workspace = workspace;
    this.chosen = chosen;
    this.prefs = prefs;
    this.dataDir = opts.dataDir ?? DATA_DIR;
    const mode0 = prefs.mode ?? cfg.lastMode ?? "edit";
    const remembered = cfg.effortByModel?.[chosen.id];
    this.effort = prefs.effort !== undefined ? prefs.effort : remembered !== undefined ? remembered : (cfg.effort ?? null);

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

    this.reloadCommands();
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
    this.bus.on("context_update", () => ui.refresh());
    this.persist();
    recordRecentModel(modelRef(chosen));
  }

  private sysPrompt(mode: Mode): string {
    return buildSystemPrompt({
      workspace: this.workspace,
      mode,
      shellLabel: this.shell.label,
      agentsMd: this.agentsMd,
      chatOnly: this.chosen.toolsSupported === false,
    });
  }

  private persist(): void {
    updateConfig({ lastModel: this.chosen.id, lastModelUrl: this.chosen.baseUrl, lastMode: this.agent.mode, effort: this.effort });
  }

  // ---- commands ---------------------------------------------------------------

  /** Every command this session knows, with its argument values bound to the
   * session (running tasks, current mode and effort), then the custom ones. */
  commandList(): SlashCommand[] {
    const bound = BUILTIN_COMMANDS.map((cmd): SlashCommand => {
      switch (cmd.name) {
        case "mode":
          return { ...cmd, args: () => modeArgs(this.agent.mode) };
        case "effort":
          return { ...cmd, args: () => effortArgs(this.effort, this.chosen.reasoning?.default) };
        case "logs":
        case "stop":
          return { ...cmd, args: () => taskArgs(this.taskManager.runningSummary()) };
        case "models":
          return { ...cmd, args: () => MODELS_ARGS };
        case "commands":
          return { ...cmd, args: () => COMMANDS_ARGS };
        default:
          return cmd;
      }
    });
    return [...bound, ...customSlashCommands(this.customCommands)];
  }

  /** The commands as plain data for the web page (argument values resolved). */
  commandData(): Record<string, any>[] {
    return this.commandList().map((cmd) => {
      let args: SelectOption[] | undefined;
      try {
        const v = cmd.args?.();
        if (Array.isArray(v)) args = v;
      } catch {
        /* no values */
      }
      return {
        name: cmd.name,
        desc: cmd.desc,
        ...(cmd.aliases ? { aliases: cmd.aliases } : {}),
        ...(cmd.group ? { group: cmd.group } : {}),
        ...(cmd.key ? { key: cmd.key } : {}),
        ...(args ? { args } : {}),
      };
    });
  }

  /** Look for custom command files again and refresh the UI's slash list. */
  reloadCommands(): void {
    const reserved = [...BUILTIN_COMMANDS.map((cmd) => cmd.name), ...Object.keys(COMMAND_ALIASES)];
    this.customCommands = loadCustomCommands(this.workspace, this.dataDir, reserved);
    this.ui.slashCommands = this.commandList();
  }

  /** /help: generated from the registry, custom commands included. */
  helpText(): string {
    return commandHelp(this.commandList());
  }

  // ---- status -----------------------------------------------------------------

  /** The TUI's status row: mode · model · effort · context · plan · tasks,
   * joined by " · ". The context segment is always present. */
  statusLine(): string {
    const agent = this.agent;
    const tasks = this.taskManager.runningSummary().length;
    const plan = this.toolCtx.plan;
    const effort = agent.provider.effortLabel() ?? this.effort;
    const segments = [
      modeColored(agent.mode),
      `${this.chosen.id} ${c.dim(backendLabel(this.chosen))}`,
      ...(effort ? [c.yellow(effort)] : []),
      c.dim(`${fmtTokens(agent.contextTokens())} (${agent.contextPercent()}%)`),
      ...(plan.exists
        ? [(plan.currentIndex < 0 ? c.green : c.cyan)(`plan ${plan.doneCount}/${plan.steps.length}`)]
        : []),
      ...(tasks ? [c.green(`${tasks} task${tasks > 1 ? "s" : ""}`)] : []),
    ];
    return segments.join(" · ");
  }

  /** Structured status for the web page's status bar. */
  state(): Record<string, any> {
    const plan = this.toolCtx.plan;
    return {
      mode: this.agent.mode,
      model: this.chosen.id,
      backend: this.chosen.backend,
      host: this.chosen.host,
      vision: this.chosen.vision,
      effort: this.agent.provider.effortLabel() ?? this.effort,
      ctxTokens: this.agent.contextTokens(),
      ctxPct: this.agent.contextPercent(),
      context: this.agent.contextBudget(),
      outcome: this.agent.outcome,
      lastError: this.agent.lastError,
      plan: plan.exists ? { steps: plan.steps, current: plan.currentIndex } : null,
      tasks: this.taskManager.runningSummary().length,
      workspace: this.workspace,
      commands: this.commandData(),
      urls: this.taskManager.recentUrls(),
    };
  }

  /** The opening lines: backend · model · mode, workspace, AGENTS.md, advice. */
  announce(): void {
    const ui = this.ui;
    for (const note of modelNotes(this.chosen)) ui.warn(`  ${note}`);
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
      baseUrl: this.chosen.baseUrl,
    };
  }

  /** A model-written name for this session, or null to keep the fallback. */
  suggestTitle(): Promise<string | null> {
    return suggestTitle(this.agent.messages, this.agent.provider);
  }

  /** Bring a saved transcript back (the system message is rebuilt for the
   * current mode/workspace; approvals are deliberately not restored). */
  restore(s: SessionSnapshot): void {
    this.agent.restoreTranscript(s.messages ?? [], s.originalRequest ?? "", s.currentRequest ?? "");
    this.toolCtx.plan.steps = (s.plan ?? []).map((p) => ({ text: String(p.text), done: !!p.done,
      ...(typeof p.note === "string" ? { note: p.note.slice(0, 1000) } : {}) }));
    for (const f of s.filesTouched ?? []) this.toolCtx.filesTouched.add(f);
    this.toolCtx.commandsRun.push(...(s.commandsRun ?? []));
  }

  // ---- saving (the TUI; the web hub saves its own sessions) ---------------------

  /** Save this session to `store` after every turn and when it ends, under
   * `id` (new when omitted). Returns the id. The web hub lists it too. */
  persistTo(store: SessionStore, id?: string): string {
    const now = Date.now();
    const sid = id ?? crypto.randomBytes(4).toString("hex");
    this.persistence = {
      store,
      meta: { id: sid, workspace: this.workspace, title: "", createdAt: now, updatedAt: now },
      events: [],
      seen: new WeakSet(this.agent.messages),
    };
    return sid;
  }

  /** The id this session is saved under, when it saves itself. */
  get sessionId(): string | null {
    return this.persistence?.meta.id ?? null;
  }

  /** Turn the messages not seen yet into replay events (one batch, so tool
   * results pair with their calls by id). */
  private flushEvents(p: Persistence): void {
    const fresh = this.agent.messages.filter((m) => !p.seen.has(m));
    for (const m of fresh) p.seen.add(m);
    p.events.push(...eventsFromMessages(fresh));
    if (p.events.length > EVENTS_CAP) {
      const cut = p.events.length - EVENTS_CAP;
      p.events.splice(0, cut);
      if (p.turnMarks) p.turnMarks = p.turnMarks.map((n) => Math.max(0, n - cut));
    }
  }

  /** Before a turn: remember where its replay events will start. */
  private markTurnStart(): void {
    this.ui.turnStarted?.();
    const p = this.persistence;
    if (!p) return;
    this.flushEvents(p);
    (p.turnMarks ??= []).push(p.events.length);
    if (p.turnMarks.length > 20) p.turnMarks.shift();
  }

  /** After a successful /undo: drop the undone turn's replay events. The
   * restored messages are copies whose events are already before the mark. */
  private dropUndoneEvents(): void {
    this.ui.turnUndone?.();
    const p = this.persistence;
    if (!p) return;
    const mark = p.turnMarks?.pop();
    if (mark !== undefined) p.events.length = Math.min(p.events.length, mark);
    p.seen = new WeakSet(this.agent.messages);
  }

  /** Bring the persistence record up to date; false when there is nothing
   * worth a file yet (no request sent). */
  private prepareSave(p: Persistence): boolean {
    this.flushEvents(p);
    if (!p.meta.title) {
      const first = this.agent.messages.find((m) => m.role === "user" && !m.compactNote && !m.historyNote && m.content.trim());
      if (first) p.meta.title = first.content.replace(/\s+/g, " ").trim().slice(0, 60);
    }
    if (!p.meta.title) return false;
    p.meta.updatedAt = Date.now();
    p.meta.model = this.chosen.id;
    p.meta.backend = this.chosen.backend;
    p.meta.messages = countMessages(this.agent.messages);
    if (!p.workspaceAdded) {
      p.workspaceAdded = true;
      try {
        new WorkspaceStore(path.dirname(p.store.dir)).add(this.workspace);
      } catch {
        /* the sidebar entry is a nicety */
      }
    }
    return true;
  }

  private saveFailed(p: Persistence, err: any): void {
    if (p.saveFailed) return;
    p.saveFailed = true;
    this.ui.warn(`Session could not be saved: ${err?.message ?? err}. Check free disk space and permissions.`);
  }

  /** Save now, asynchronously (after a turn). */
  async save(): Promise<void> {
    const p = this.persistence;
    if (!p || !this.prepareSave(p)) return;
    try {
      p.store.saveMeta(p.meta);
      await p.store.saveBody(p.meta.id, { snapshot: this.snapshot(), events: p.events });
      p.saveFailed = false;
    } catch (err) {
      this.saveFailed(p, err);
    }
  }

  /** Save now, synchronously (exit paths). */
  saveNow(): void {
    const p = this.persistence;
    if (!p || !this.prepareSave(p)) return;
    try {
      p.store.saveMeta(p.meta);
      p.store.saveBodySync(p.meta.id, { snapshot: this.snapshot(), events: p.events });
    } catch (err) {
      this.saveFailed(p, err);
    }
  }

  // ---- the loop -------------------------------------------------------------

  /** The input loop. Returns after /exit (or after the host asked the UI to
   * hand back "/exit"). */
  async run(): Promise<void> {
    const { ui } = this;
    await this.bus.emit("session_start");
    for (;;) {
      this.reloadCommands();
      const raw = await ui.readInput();
      let input = typeof raw === "string" ? raw : raw.text;
      const attachments = typeof raw === "string" ? [] : raw.attachments;

      const slash = !attachments.length && input.startsWith("/") ? (parseSlash(input) ?? { name: "", rest: "", args: [] }) : null;
      if (slash) {
        const cmd = findCommand(slash.name, this.commandList());
        const custom = cmd?.group === "Custom" ? this.customCommands.find((x) => x.name === cmd.name) : undefined;
        if (custom) {
          input = expandTemplate(custom.template, slash.rest);
          ui.status(`· /${custom.name} → ${truncateEnd(input.replace(/\s+/g, " "), 100)}`);
        } else {
          if ((await this.runCommand(cmd?.name ?? slash.name, slash)) === "exit") return;
          ui.refresh();
          continue;
        }
      }

      try {
        this.markTurnStart();
        await this.agent.runTurn(input, attachments);
        this.onTurnDone?.();
      } catch (err: any) {
        ui.error(`\n${err?.message ?? err}`);
        if (String(err?.message ?? "").toLowerCase().includes("does not support tools")) {
          ui.warn(
            "This model does not support tool calling. Pick a tool-capable model with /models (e.g. qwen3, llama3.1, mistral-nemo)."
          );
        }
      }
      await this.save();
    }
  }

  /** One slash command. Returns "exit" when the session has ended. */
  private async runCommand(name: string, slash: { name: string; rest: string; args: string[] }): Promise<"exit" | void> {
    const { ui, agent, toolCtx, taskManager } = this;
    const arg = slash.args[0];
    switch (name) {
      case "exit":
        await this.shutdown();
        return "exit";
      case "help":
        ui.println(this.helpText());
        break;
      case "models":
        if (arg === "next") await this.nextRecentModel();
        else await this.switchModel();
        break;
      case "mode":
        await this.setMode(arg);
        break;
      case "effort":
        await this.setEffort(arg);
        break;
      case "plan":
        if (toolCtx.plan.exists) ui.println(renderPlan(toolCtx.plan));
        else ui.status("· no plan yet — the agent creates one when it starts a multi-step task");
        break;
      case "tasks":
        ui.println(taskManager.list());
        break;
      case "logs":
        ui.println(taskManager.logs(arg ?? "", Number(slash.args[1]) || 50));
        break;
      case "stop":
        ui.println(taskManager.stop(arg ?? ""));
        break;
      case "compact":
        ui.startSpinner("compacting");
        try {
          await agent.compactNow();
        } catch (err: any) {
          ui.error(String(err?.message ?? err));
        } finally {
          ui.stopSpinner();
        }
        await this.save();
        break;
      case "context": {
        const budget = agent.contextBudget();
        ui.status(
          `Context ${budget.prompt.toLocaleString()} / ${budget.window.toLocaleString()} tokens (${budget.source})\nReply reserve ${budget.reserve.toLocaleString()} · available ${budget.available.toLocaleString()} · ${agent.messages.length} messages · ${agent.tools.length} tools`
        );
        break;
      }
      case "clear":
        await this.save();
        agent.resetTranscript();
        toolCtx.plan.reset();
        // A fresh conversation is a fresh saved session; the old one stays listed.
        if (this.persistence) this.persistTo(this.persistence.store);
        ui.status("· conversation cleared");
        break;
      case "undo":
        await this.undo();
        break;
      case "sessions":
        await this.sessionsCommand();
        break;
      case "commands":
        if (arg === "new") await this.newCustomCommand();
        else this.listCustomCommands();
        break;
      default:
        ui.warn(`Unknown command /${slash.name} — try /help`);
    }
  }

  /** Idempotent: end-of-session hook, save, kill background tasks, close the
   * UI, then tell the host. */
  async shutdown(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.agent.cancel();
    try {
      await this.bus.emit("session_end");
    } catch {
      /* best effort */
    }
    this.saveNow();
    this.taskManager.killAll();
    this.ui.close();
    this.onExit?.();
  }

  // ---- /undo ------------------------------------------------------------------

  private async undo(): Promise<void> {
    let summary: string | null;
    const depth = this.agent.undoDepth;
    try {
      summary = await this.agent.undoLastTurn();
    } catch (err: any) {
      this.ui.error(String(err?.message ?? err));
      return;
    }
    if (this.agent.undoDepth < depth) this.dropUndoneEvents();
    if (summary) this.ui.println(summary);
    else this.ui.status("Nothing to undo");
    await this.save();
  }

  // ---- /sessions --------------------------------------------------------------

  private async sessionsCommand(): Promise<void> {
    const { ui } = this;
    const p = this.persistence;
    if (!p) {
      ui.status("· saved sessions are listed in the sidebar (ctrl+k searches them)");
      return;
    }
    this.saveNow();
    const metas = p.store.listForWorkspace(this.workspace).filter((m) => m.id !== p.meta.id);
    if (!metas.length) {
      ui.status("· no earlier sessions in this workspace yet");
      return;
    }
    const idx = await ui.select("Resume session", sessionOptions(metas));
    if (idx === null) return;
    this.resumeStored(metas[idx]);
  }

  /** Load a saved session into this one: transcript, plan, its web replay;
   * the current model and mode stay. Returns false when it could not be read. */
  resumeStored(meta: SessionMeta): boolean {
    const p = this.persistence;
    if (!p) return false;
    const body = p.store.loadBody(meta.id);
    if (!body) {
      this.ui.warn(`· "${meta.title}" could not be read`);
      return false;
    }
    this.saveNow();
    this.agent.resetTranscript();
    this.toolCtx.plan.reset();
    this.restore(body.snapshot);
    this.persistence = {
      store: p.store,
      meta: { ...meta },
      events: body.events.slice(-EVENTS_CAP),
      seen: new WeakSet(this.agent.messages),
      workspaceAdded: true,
    };
    replayTranscript(this.ui, body.snapshot.messages ?? []);
    const n = countMessages(this.agent.messages);
    const other = body.snapshot.model && body.snapshot.model !== this.chosen.id ? ` · it used ${body.snapshot.model} (/models to switch)` : "";
    this.ui.status(`· resumed "${meta.title}" — ${n} message${n === 1 ? "" : "s"}${other} · earlier command approvals are not remembered`);
    this.ui.refresh();
    return true;
  }

  // ---- /commands --------------------------------------------------------------

  private listCustomCommands(): void {
    const { ui } = this;
    if (!this.customCommands.length) {
      ui.status("· no custom commands yet — /commands new creates one");
      return;
    }
    const w = Math.max(...this.customCommands.map((x) => x.name.length)) + 1;
    ui.println(
      [
        c.bold("Custom commands:"),
        ...this.customCommands.map((x) => `  /${x.name.padEnd(w)} ${x.description} ${c.dim(`(${x.scope === "workspace" ? "this workspace" : "all workspaces"})`)}`),
        c.dim("  /commands new adds one · $ARGUMENTS in its text is what you type after the command"),
      ].join("\n")
    );
  }

  private async newCustomCommand(): Promise<void> {
    const { ui } = this;
    const raw = await ui.prompt("Name of the new command", "e.g. review — then run it as /review");
    if (raw === null) return;
    const name = raw.trim().replace(/^\/+/, "").toLowerCase().replace(/\s+/g, "-");
    const reserved = [...BUILTIN_COMMANDS.map((cmd) => cmd.name), ...Object.keys(COMMAND_ALIASES)];
    if (!isValidCommandName(name)) {
      ui.warn("Use letters, digits, - or _ for a command name (up to 40 characters).");
      return;
    }
    if (reserved.includes(name)) {
      ui.warn(`/${name} is a built-in command — pick another name.`);
      return;
    }
    const text = await ui.prompt(`What /${name} sends`, "$ARGUMENTS = what you type after it · $1 $2 = its words · \\n = new line");
    if (text === null || !text.trim()) return;
    const where = await ui.select(`Save /${name} for`, [
      { label: "This workspace", hint: ".smolcoder/commands/ in this folder" },
      { label: "All workspaces", hint: "~/.smolcoder/commands/" },
    ]);
    if (where === null) return;
    const dir = where === 0 ? workspaceCommandsDir(this.workspace) : globalCommandsDir(this.dataDir);
    if (fs.existsSync(path.join(dir, `${name}.md`))) {
      const ok = await ui.select(`/${name} already exists there`, [{ label: "Replace it" }, { label: "Keep the old one" }]);
      if (ok !== 0) return;
    }
    let file: string;
    try {
      file = writeCustomCommand(dir, name, text.replace(/\\n/g, "\n"));
    } catch (err: any) {
      ui.error(`Could not save /${name}: ${err?.message ?? err}`);
      return;
    }
    this.reloadCommands();
    ui.status(`· saved /${name} (${file.replace(os.homedir(), "~")})`);
  }

  // ---- models -----------------------------------------------------------------

  private async switchModel(): Promise<void> {
    const { ui } = this;
    // The picker opens on the last scan right away and rescans in the
    // background; "Refresh" waits for a fresh scan. It is also where other
    // machines are added and managed; after either, scan and reopen.
    let wait = false;
    for (;;) {
      const hosts = loadConfig().hosts ?? [];
      let list = wait ? null : cachedModels();
      if (wait) {
        ui.startSpinner("looking for models here and on added machines");
        list = await refreshModels();
        ui.stopSpinner();
      } else if (list) {
        void refreshModels();
      } else {
        ui.startSpinner("looking for models");
        list = await localModels();
        ui.stopSpinner();
        void refreshModels();
      }
      wait = false;
      if (!list.length) ui.warn("No model server is answering right now.");
      const models = list;
      let rows = modelRows(models, this.chosen, loadConfig());
      const extra = [REFRESH_ROW, FIND_ROW, ...(hosts.length ? [HOSTS_ROW] : [])];
      const onStar = (i: number): SelectOption[] => {
        const m = rows.models[i];
        if (m) {
          toggleFavoriteModel(modelRef(m));
          rows = modelRows(models, this.chosen, loadConfig());
        }
        return [...rows.options, ...extra];
      };
      const idx = await ui.select("Select model", [...rows.options, ...extra], { onStar });
      if (idx === null) return;
      if (idx < rows.models.length) {
        if (await this.useModel(rows.models[idx])) recordRecentModel(modelRef(this.chosen));
        return;
      }
      const row = extra[idx - rows.models.length];
      if (row === FIND_ROW) await findModelsOnNetwork(ui);
      else if (row === HOSTS_ROW) await manageHosts(ui);
      wait = true;
    }
  }

  /** `/models next` (F2): the next model in the recent list, without a picker.
   * Cycling does not reorder the list, so pressing it again walks on. */
  private async nextRecentModel(): Promise<void> {
    const { ui } = this;
    const recents = loadConfig().recentModels ?? [];
    const at = recents.findIndex((r) => sameModel(r, this.chosen));
    const order = [...recents.slice(at + 1), ...recents.slice(0, Math.max(0, at))].filter((r) => !sameModel(r, this.chosen));
    if (!order.length) {
      ui.status("· no other recent model yet — pick one with /models");
      return;
    }
    for (const ref of order) {
      let m = (cachedModels() ?? []).find((x) => sameModel(x, ref));
      if (!m) {
        ui.startSpinner(`looking for ${ref.id}`);
        const found = await detectAll({ hosts: loadConfig().hosts ?? [], until: (x) => sameModel(x, ref) });
        const hit = found.find((x) => sameModel(x, ref));
        m = hit ? (await withCapabilities([hit]))[0] : undefined;
        ui.stopSpinner();
      }
      if (m && (await this.useModel(m))) return;
      ui.status(`· ${ref.id} is not available right now`);
    }
  }

  /** Load a model and make it this session's: its remembered effort comes
   * with it. False when it could not be loaded. */
  private async useModel(target: DetectedModel): Promise<boolean> {
    const { ui, agent } = this;
    let next: DetectedModel;
    ui.startSpinner(`loading ${target.id}`);
    try {
      next = await resolveContextWindow(target, this.prefs.ctx);
    } catch (err: any) {
      ui.error(String(err?.message ?? err));
      resetModelCache();
      return false;
    } finally {
      ui.stopSpinner();
    }
    this.chosen = next;
    const remembered = loadConfig().effortByModel?.[next.id];
    const restored = remembered !== undefined && remembered !== this.effort;
    if (remembered !== undefined) this.effort = remembered;
    const p = makeProvider(next);
    p.setEffort(this.effort);
    agent.setProvider(p, this.sysPrompt(agent.mode));
    this.ctxMgr.setWindow(next.contextWindow, p.maxOutputTokens);
    this.persist();
    ui.println(sessionLine(next, agent.mode));
    if (restored) ui.status(`· effort ${p.effortLabel() ?? this.effort ?? "default"} (remembered for ${next.id})`);
    for (const note of modelNotes(next)) ui.warn(`  ${note}`);
    const advice = effortAdvice(next, this.effort);
    if (advice) ui.warn(`  ${advice}`);
    return true;
  }

  private async setMode(arg?: string): Promise<void> {
    const { ui, agent } = this;
    let next: Mode | undefined =
      arg === "ro" || arg === "read-only"
        ? "ro"
        : arg === "edit" || arg === "write"
          ? "edit"
          : arg === "bypass" || arg === "yolo"
            ? "bypass"
            : undefined;
    if (!next) {
      const idx = await ui.select("Select mode", [
        { label: "read-only", hint: MODE_HINTS.ro, current: agent.mode === "ro" },
        { label: "edit", hint: MODE_HINTS.edit, current: agent.mode === "edit" },
        { label: "bypass permissions", hint: MODE_HINTS.bypass, current: agent.mode === "bypass" },
      ]);
      if (idx === null) return;
      next = MODE_ORDER[idx];
    }
    agent.setMode(next, this.sysPrompt(next));
    this.persist();
  }

  private async setEffort(arg?: string): Promise<void> {
    const { ui, agent } = this;
    let next: Effort | null | undefined;
    if (arg && (EFFORT_LEVELS as string[]).includes(arg)) {
      next = arg === "default" ? null : (arg as Effort);
    } else {
      const idx = await ui.select("Reasoning effort", effortArgs(this.effort, this.chosen.reasoning?.default));
      if (idx === null) return;
      next = idx === 0 ? null : (EFFORT_LEVELS[idx] as Effort);
    }
    this.effort = next;
    agent.provider.setEffort(this.effort);
    this.persist();
    saveModelEffort(this.chosen.id, this.effort);
    const label = agent.provider.effortLabel();
    ui.status(`· effort ${label ?? this.effort ?? "default"}`);
    const advice = effortAdvice(this.chosen, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }
}
