// Tool registry. Seven tools, flat parameters only (strings and one enum — no
// nested objects or arrays: small models mangle them), an example call inside
// every description (small models imitate better than they infer), and the
// mode decides which tools EXIST — the permission model is "which schemas were
// sent", not a runtime policy engine.

import { Plan } from "../plan";
import { ToolSpec } from "../providers/types";
import { editFile, listFiles, readFile, searchFiles, writeFile } from "./fs-tools";
import { syntaxCheck } from "./check";
import { runCommand } from "./shell";
import { TaskManager } from "./tasks";
import { resolveInWorkspace, SandboxError } from "../sandbox";
import { truncateMiddle } from "../util";

export type Mode = "ro" | "write" | "yolo";

export const MODE_LABELS: Record<Mode, string> = {
  ro: "read-only",
  write: "write",
  yolo: "yolo",
};

const TOOL_RESULT_CAP = 10000; // chars — final safety net over per-tool caps

export function buildToolSpecs(mode: Mode): ToolSpec[] {
  const read: ToolSpec[] = [
    {
      name: "read_file",
      description:
        'Read a text file in the workspace. Example: {"path": "src/app.js"}. Long files are returned in chunks; pass "offset" (a line number) to continue reading.',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace" },
          offset: { type: "number", description: "Line number to start from (optional)" },
          limit: { type: "number", description: "Max lines to return (optional)" },
        },
        required: ["path"],
      },
    },
    {
      name: "list_files",
      description:
        'List files and folders in the workspace. Example: {} for everything, or {"path": "src"} for one folder. Folders end with "/".',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder to list (optional, default: whole workspace)" },
        },
      },
    },
    {
      name: "search",
      description:
        'Search inside files for a pattern (regular expression; plain text also works). Example: {"pattern": "TODO"}. Returns file:line: matching text.',
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text or regex to find" },
          path: { type: "string", description: "Folder to search in (optional)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "plan",
      description:
        'Your to-do list for multi-step tasks — shown to the user and kept for you across context compaction. Create it first: {"action": "set", "steps": "create index.html\\ncreate game.js\\ntest the page"} (one step per line). Mark the current step finished with {"action": "done"} (or {"action": "done", "step": 2}). Append with {"action": "add", "text": "..."}. {"action": "show"} displays it.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "done", "add", "show"] },
          steps: { type: "string", description: 'The steps, one per line (only for "set")' },
          step: { type: "number", description: 'Step number to mark done (optional, for "done")' },
          text: { type: "string", description: 'Step to append (only for "add")' },
        },
        required: ["action"],
      },
    },
  ];

  const write: ToolSpec[] = [
    {
      name: "write_file",
      description:
        'Create a new file or completely overwrite an existing one. Example: {"path": "src/new.js", "content": "..."}. Parent folders are created automatically. To change part of an existing file, prefer edit_file.',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace" },
          content: { type: "string", description: "The full file content" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description:
        'Replace text inside an existing file. Copy old_text EXACTLY from the file (a few lines, enough to be unique), and give the replacement as new_text. Example: {"path": "src/app.js", "old_text": "const x = 1;", "new_text": "const x = 2;"}',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace" },
          old_text: { type: "string", description: "Exact text currently in the file" },
          new_text: { type: "string", description: "Text to replace it with" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  ];

  const exec: ToolSpec[] = [
    {
      name: "run_command",
      description:
        'Run a shell command in the workspace and wait for it to finish. Example: {"command": "npm test"}. Times out after 120s — for servers or watchers use the task tool instead.',
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
        },
        required: ["command"],
      },
    },
    {
      name: "task",
      description:
        'Manage background tasks (things that keep running, like dev servers). action "start" runs a command in the background: {"action": "start", "command": "npm run dev"}. action "logs" shows recent output: {"action": "logs", "task_id": "t1"}. action "list" shows all tasks. action "stop" kills one: {"action": "stop", "task_id": "t1"}.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "list", "logs", "stop"] },
          command: { type: "string", description: 'Command to run (only for "start")' },
          task_id: { type: "string", description: 'Task id like "t1" (for "logs" and "stop")' },
        },
        required: ["action"],
      },
    },
  ];

  if (mode === "ro") return read;
  return [...read, ...write, ...exec];
}

export interface ToolContext {
  workspace: string;
  taskManager: TaskManager;
  plan: Plan;
  /** Records for the compaction state note. */
  filesTouched: Set<string>;
  commandsRun: string[];
}

export async function executeTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext,
  signal?: AbortSignal
): Promise<string> {
  try {
    let result: string;
    switch (name) {
      case "read_file":
        result = readFile(ctx.workspace, args);
        break;
      case "list_files":
        result = listFiles(ctx.workspace, args);
        break;
      case "search":
        result = searchFiles(ctx.workspace, args);
        break;
      case "plan": {
        const action = args.action;
        if (action === "set") result = ctx.plan.set(String(args.steps ?? ""));
        else if (action === "done")
          result = ctx.plan.markDone(args.step === undefined ? undefined : Number(args.step));
        else if (action === "add") result = ctx.plan.add(String(args.text ?? ""));
        else if (action === "show") result = ctx.plan.modelView();
        else
          return 'Error: action must be one of "set", "done", "add", "show". Example: {"action": "done"}';
        break;
      }
      case "write_file":
        result = writeFile(ctx.workspace, args);
        if (!result.startsWith("Error")) {
          ctx.filesTouched.add(String(args.path));
          result += afterWrite(ctx.workspace, String(args.path));
        }
        break;
      case "edit_file":
        result = editFile(ctx.workspace, args);
        if (!result.startsWith("Error")) {
          ctx.filesTouched.add(String(args.path));
          result += afterWrite(ctx.workspace, String(args.path));
        }
        break;
      case "run_command":
        if (typeof args.command !== "string" || !args.command.trim()) {
          return 'Error: command is required. Example: {"command": "npm test"}';
        }
        ctx.commandsRun.push(args.command);
        result = await runCommand(args.command, ctx.workspace, signal);
        break;
      case "task": {
        const action = args.action;
        if (action === "start") {
          if (typeof args.command !== "string" || !args.command.trim()) {
            return 'Error: "start" needs a command. Example: {"action": "start", "command": "npm run dev"}';
          }
          ctx.commandsRun.push(`[bg] ${args.command}`);
          result = await ctx.taskManager.startWithEarlyOutput(args.command);
        } else if (action === "logs") {
          result = ctx.taskManager.logs(String(args.task_id ?? ""), Number(args.lines) || 50);
        } else if (action === "stop") {
          result = ctx.taskManager.stop(String(args.task_id ?? ""));
        } else if (action === "list") {
          result = ctx.taskManager.list();
        } else {
          return 'Error: action must be one of "start", "list", "logs", "stop". Example: {"action": "list"}';
        }
        break;
      }
      default:
        return `Error: unknown tool "${name}". Available tools are listed in your tool definitions — use one of those.`;
    }
    return truncateMiddle(result, TOOL_RESULT_CAP);
  } catch (err: any) {
    if (err instanceof SandboxError) return `Error: ${err.message}`;
    return `Error: ${err?.message ?? String(err)}`;
  }
}

/** Post-write hook: parse what was just written and coach on the first
 * syntax error. A one-line warning riding on the success message is the
 * cheapest possible feedback loop for a local model. */
function afterWrite(workspace: string, relPath: string): string {
  try {
    const abs = resolveInWorkspace(workspace, relPath);
    const warning = syntaxCheck(abs, relPath);
    return warning ? `
Warning: ${warning} Fix this before moving on (use edit_file).` : "";
  } catch {
    return "";
  }
}

/** Does this call need approval in write mode? (yolo: never; ro: tool doesn't exist) */
export function needsApproval(name: string, args: Record<string, any>): string | null {
  if (name === "run_command") return String(args.command ?? "");
  if (name === "task" && args.action === "start") return String(args.command ?? "");
  return null;
}
