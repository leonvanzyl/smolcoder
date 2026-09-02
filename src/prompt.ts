// The whole system prompt. Two short paragraphs, ~120 tokens. Everything else
// the model needs lives in the tool schemas and in coaching error messages.
// If the workspace has an AGENTS.md, its contents ride along directly after
// the prompt (size-capped) — and because they are part of message[0], they
// survive compaction the same way the system prompt does.

import * as fs from "fs";
import * as path from "path";
import { Mode } from "./tools/index";

const AGENTS_MD_CAP_CHARS = 8000; // ~2k tokens — small-context friendly

/** Read the workspace's AGENTS.md memory file, if any. */
export function loadAgentsMd(workspace: string): string | null {
  try {
    const p = path.join(workspace, "AGENTS.md");
    if (!fs.existsSync(p)) return null;
    let text = fs.readFileSync(p, "utf8").trim();
    if (!text) return null;
    if (text.length > AGENTS_MD_CAP_CHARS) {
      text =
        text.slice(0, AGENTS_MD_CAP_CHARS) +
        "\n[AGENTS.md was truncated here to save context]";
    }
    return text;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(opts: {
  workspace: string;
  mode: Mode;
  shellLabel: string;
  /** Contents of the workspace AGENTS.md, when present. */
  agentsMd?: string | null;
}): string {
  const os =
    process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";

  const modeLine =
    opts.mode === "ro"
      ? "You are in read-only mode: you can read and search files but not change anything."
      : opts.mode === "edit"
        ? "You can read, write and edit files freely and run commands (install packages, run tests, scripts) without asking, as long as everything stays inside the workspace. A command that touches paths outside it (absolute paths, /tmp, ~, ..) asks the user for approval first — so keep scratch files inside the workspace, e.g. in a .scratch/ folder."
        : "You have full access to files and commands; nothing asks the user for approval.";

  return (
    `You are tiny-coder, a coding agent working in the workspace ${opts.workspace} on ${os}. ` +
    `Commands run in ${opts.shellLabel} with the workspace as the working directory. ` +
    `File paths are relative to the workspace; you cannot access files outside it. ${modeLine}\n\n` +
    `Work step by step: look at the relevant files before changing them, make one tool call at a time, ` +
    `keep changes small and focused, and verify your work when you can. ` +
    `For any task with more than one step, FIRST call the plan tool ({"action": "set"}) with your step list. ` +
    `The moment a step is finished, call plan {"action": "done"} BEFORE starting the next one — the plan is your map of the task and is kept for you even when older context is dropped. ` +
    `If a tool returns an error, read it carefully — it tells you how to fix the call. ` +
    `When the task is done, stop and summarize briefly what you did.` +
    (opts.agentsMd
      ? `\n\nWorkspace instructions from AGENTS.md — follow these:\n${opts.agentsMd}`
      : "")
  );
}
