// The core system prompt. Short instructions; tool details live in schemas.
// Everything else
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
        ? "Read, edit and run commands inside the workspace. Commands reaching outside it need approval; keep scratch files in .scratch/."
        : "You have full access to files and commands; nothing asks the user for approval.";

  return (
    `You are smolcoder, a coding agent working in the workspace ${opts.workspace} on ${os}. ` +
    `Commands run in ${opts.shellLabel} with the workspace as the working directory. ` +
    `File paths are relative to the workspace; you cannot access files outside it. ${modeLine}\n\n` +
    `For multi-step work, first set a short plan of runnable increments; mark each step done as you finish it. The plan survives compaction. Use plan checkpoint to retain exact APIs, errors and your next edit during an investigation. Establish a working entry point early and run the build after wiring modules. ` +
    `Read relevant files before editing. Search narrowly and read small line ranges. Inspect a local module's actual exports before importing it. Make one tool call at a time; use small modules and write large files in parts. ` +
    `Read errors and change your approach when a call fails. Put test programs in files rather than long inline shell commands. Verify changes with the relevant test or command; a failed check is not success. ` +
    `Continue until the request is finished or explain the blocker. Summarize the result and verification briefly.` +
    (opts.agentsMd
      ? `\n\nWorkspace instructions from AGENTS.md — follow these:\n${opts.agentsMd}`
      : "")
  );
}
