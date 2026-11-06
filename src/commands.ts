// The one command registry: the slash menu, the TUI ctrl+p palette, the web
// Ctrl+K palette, /help and `smol --help` are all built from this list. Each
// session binds the argument providers that depend on its own state (running
// tasks, the current mode and effort) — see Session.commandList().

import { MODE_LABELS, Mode } from "./tools/index";
import { Effort } from "./providers/types";
import { SelectOption, SlashCommand } from "./ui";
import { c } from "./util";

/** Display order of the groups in /help and the palettes. "Custom" holds the
 * user's own commands from .smolcoder/commands/. */
export const COMMAND_GROUPS = ["Model", "Session", "Tasks", "General", "Custom"];

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "models", desc: "Switch model · star favorites · add models from other machines", group: "Model", aliases: ["model", "switch", "favorites", "recent"], key: "F2: next recent", args: () => MODELS_ARGS },
  { name: "mode", desc: "Set mode (ro / edit / bypass)", group: "Model", aliases: ["permissions", "read-only", "bypass"], key: "shift+tab", args: () => modeArgs() },
  { name: "effort", desc: "Set reasoning effort (remembered per model)", group: "Model", aliases: ["thinking", "reasoning"], args: () => effortArgs() },
  { name: "sessions", desc: "Resume an earlier session in this workspace", group: "Session", aliases: ["resume", "history"] },
  { name: "undo", desc: "Undo the last turn's file changes and messages", group: "Session", aliases: ["revert"] },
  { name: "clear", desc: "Start a new conversation", group: "Session", aliases: ["new", "reset"] },
  { name: "compact", desc: "Compact the conversation now", group: "Session", aliases: ["summarize"] },
  { name: "context", desc: "Show context usage", group: "Session", aliases: ["tokens"] },
  { name: "plan", desc: "Show the agent's plan", group: "Session", aliases: ["steps"] },
  { name: "tasks", desc: "List background tasks", group: "Tasks", aliases: ["jobs"] },
  { name: "logs", desc: "Show task output — /logs t1", group: "Tasks", aliases: ["output"], args: () => [] },
  { name: "stop", desc: "Stop a background task — /stop t1", group: "Tasks", aliases: ["kill"], args: () => [] },
  { name: "commands", desc: "List or create custom commands — /commands new", group: "General", aliases: ["custom", "templates"], args: () => COMMANDS_ARGS },
  { name: "help", desc: "Show commands and keys", group: "General", aliases: ["?", "keys"] },
  { name: "exit", desc: "Quit smolcoder (web: close this session)", group: "General", aliases: ["quit", "q"] },
];

/** Keys worth knowing, for /help and `smol --help`. */
export const KEYBOARD: { key: string; desc: string }[] = [
  { key: "shift+tab", desc: "cycle mode (read-only → edit → bypass permissions)" },
  { key: "ctrl+p", desc: "command palette (web: ctrl+k)" },
  { key: "F2", desc: "next recent model" },
  { key: "ctrl+r", desc: "search prompt history" },
  { key: "ctrl+j / alt+enter", desc: "newline (Windows Terminal keeps alt+enter for fullscreen)" },
  { key: "@", desc: "mention a file" },
  { key: "esc", desc: "interrupt a running turn · esc esc clears the draft (↑ restores it)" },
  { key: "ctrl+o", desc: "show / hide full reasoning" },
  { key: "ctrl+l", desc: "clear the screen" },
  { key: "ctrl+f in pickers", desc: "star a model (favorites)" },
  { key: "ctrl+c ×2", desc: "quit" },
];

/** Other names a command answers to when typed in full. (`aliases` are only
 * search words for the fuzzy matcher, not names.) */
export const COMMAND_ALIASES: Record<string, string> = { model: "models", quit: "exit", q: "exit", resume: "sessions" };

/** The command a typed name means: its own name or a COMMAND_ALIASES entry. */
export function findCommand(name: string, commands: SlashCommand[]): SlashCommand | undefined {
  const n = name.toLowerCase();
  return commands.find((cmd) => cmd.name === n) ?? commands.find((cmd) => cmd.name === COMMAND_ALIASES[n]);
}

function groupOrder(g: string | undefined): number {
  const i = COMMAND_GROUPS.indexOf(g ?? "");
  return i < 0 ? COMMAND_GROUPS.length : i;
}

/** /help (and the slash section of `smol --help`), generated from the registry. */
export function commandHelp(commands: SlashCommand[] = BUILTIN_COMMANDS): string {
  const groups = [...new Set(commands.map((cmd) => cmd.group ?? "Other"))].sort((a, b) => groupOrder(a) - groupOrder(b));
  const width = Math.max(12, ...commands.map((cmd) => cmd.name.length + 2 + (cmd.args ? 6 : 0)));
  const lines: string[] = [c.bold("Commands:")];
  for (const g of groups) {
    lines.push(`  ${c.dim(g)}`);
    for (const cmd of commands.filter((x) => (x.group ?? "Other") === g)) {
      const name = `/${cmd.name}${cmd.args ? " [arg]" : ""}`;
      lines.push(`    ${name.padEnd(width + 1)} ${cmd.desc}${cmd.key ? c.dim(` (${cmd.key})`) : ""}`);
    }
  }
  const kw = Math.max(...KEYBOARD.map((k) => k.key.length));
  lines.push("", c.bold("Keyboard:"));
  for (const k of KEYBOARD) lines.push(`  ${k.key.padEnd(kw)}  ${k.desc}`);
  return lines.join("\n");
}

// ---- argument values ---------------------------------------------------------

export const MODE_HINTS: Record<Mode, string> = {
  ro: "read and search files only",
  edit: "edit files; run commands inside the workspace, ask y/n for anything outside it",
  bypass: "full access, never asks for approval",
};

export function modeArgs(current?: Mode): SelectOption[] {
  return (["ro", "edit", "bypass"] as Mode[]).map((m) => ({
    label: m,
    hint: `${MODE_LABELS[m]} — ${MODE_HINTS[m]}`,
    current: m === current,
  }));
}

export const EFFORT_LEVELS: (Effort | "default")[] = ["default", "off", "low", "medium", "high"];

export function effortArgs(current?: Effort | null, modelDefault?: string): SelectOption[] {
  const hints: Record<string, string> = {
    default: modelDefault ? `the model's own default (${modelDefault})` : "leave it to the model",
    off: "no thinking — fastest, best for long tool loops",
    low: "brief reasoning",
    medium: "",
    high: "most thorough — slow on local models",
  };
  return EFFORT_LEVELS.map((e) => ({
    label: e,
    hint: hints[e],
    current: current !== undefined && (e === "default" ? current === null : current === e),
  }));
}

/** Running background tasks as argument values, from TaskManager.runningSummary(). */
export function taskArgs(running: string[]): SelectOption[] {
  return running.map((line) => {
    const i = line.indexOf(":");
    return { label: i > 0 ? line.slice(0, i) : line, hint: i > 0 ? line.slice(i + 1).trim() : "" };
  });
}

export const MODELS_ARGS: SelectOption[] = [{ label: "next", hint: "switch to the next recent model (F2)" }];
export const COMMANDS_ARGS: SelectOption[] = [
  { label: "new", hint: "create a custom command" },
  { label: "list", hint: "show the custom commands" },
];
