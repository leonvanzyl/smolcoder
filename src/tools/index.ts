// Tool registry. Eight tools (ten with web access on) with flat parameters — no
// nested objects or arrays: small models mangle them), an example call inside
// every description (small models imitate better than they infer), and the
// mode decides which schemas are sent. The agent rechecks mode at execution.

import { Plan } from "../plan";
import { ToolSpec } from "../providers/types";
import { editFile, listFiles, readFile, writeFile } from "./fs-tools";
import { syntaxCheck } from "./check";
import { runCommand } from "./shell";
import { TaskManager } from "./tasks";
import { resolveInWorkspace, SandboxError } from "../sandbox";
import { truncateMiddle } from "../util";
import { searchFilesBounded } from "./search-worker";
import { WebContext, webFetch, webSearch } from "./web";

export type Mode = "ro" | "edit" | "bypass";

export const MODE_LABELS: Record<Mode, string> = {
  ro: "read-only",
  edit: "edit",
  bypass: "bypass permissions",
};

const TOOL_RESULT_CAP = 10000; // chars — final safety net over per-tool caps

export function buildToolSpecs(mode: Mode, web = false): ToolSpec[] {
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
        'Plan runnable increments, kept across compaction. Create: {"action":"set","steps":"wire entry point; run build; add movement and test"}. Finish current step: {"action":"done"} (or supply step). Save exact APIs, error and next edit before a long investigation: {"action":"checkpoint","text":"..."} (max 1000 chars, replaces current step notes). Append: {"action":"add","text":"..."}. Show: {"action":"show"}.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "done", "add", "show", "checkpoint"] },
          steps: { type: "string", description: 'The steps, one per line; semicolon lists also accepted (only for "set")' },
          step: { type: "number", description: 'Step number to mark done (optional, for "done")' },
          text: { type: "string", description: 'Step to append or working checkpoint' },
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

  // Reading the web changes nothing here, so it belongs with the reads. Never
  // in bypass mode: web text next to unapproved commands is how injection
  // turns into damage. Off, the schemas are not sent and cost no context.
  const online: ToolSpec[] = web && mode !== "bypass" ? WEB_TOOLS : [];
  if (mode === "ro") return [...read, ...online];
  return [...read, ...online, ...write, ...exec];
}

const WEB_TOOLS: ToolSpec[] = [
  {
    name: "web_search",
    description:
      'Search the web. Example: {"query": "vite config alias"}. Returns up to 5 results with title, link and snippet; read one with web_fetch.',
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for" } },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      'Read a web page as text. Example: {"url": "https://vitejs.dev/config/"}. Only links from web_search results, a page you fetched, or the user\'s message. Long pages come in parts: pass "offset" to continue.',
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page to read" },
        offset: { type: "number", description: "Character to continue from (optional)" },
      },
      required: ["url"],
    },
  },
];

export interface ToolContext {
  workspace: string;
  taskManager: TaskManager;
  plan: Plan;
  /** Records for the compaction state note. */
  filesTouched: Set<string>;
  commandsRun: string[];
  /** Internal per-request cap; never a model-supplied tool argument. */
  resultCharLimit?: number;
  /** Present only while web access is on. */
  web?: WebContext;
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
        result = readFile(ctx.workspace, args, ctx.resultCharLimit ? ctx.resultCharLimit - 256 : undefined);
        break;
      case "list_files":
        result = listFiles(ctx.workspace, args);
        break;
      case "search":
        result = await searchFilesBounded(ctx.workspace, args, signal);
        break;
      case "plan": {
        const action = args.action ?? (typeof args.steps === "string" ? "set" : undefined);
        if (action === "set") result = ctx.plan.set(typeof args.steps === "string" ? args.steps : "");
        else if (action === "done")
          result = ctx.plan.markDone(args.step === undefined ? undefined : Number(args.step));
        else if (action === "add") result = ctx.plan.add(String(args.text ?? ""));
        else if (action === "checkpoint") result = ctx.plan.checkpoint(String(args.text ?? ""));
        else if (action === "show") result = ctx.plan.modelView();
        else
          return 'Error: action must be one of "set", "done", "add", "show", "checkpoint". Example: {"action": "done"}';
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
        result = await runCommand(args.command, ctx.workspace, signal);
        ctx.commandsRun.push(`${args.command} → ${result.split("\n").at(-1)}`);
        if (ctx.commandsRun.length > 50) ctx.commandsRun.splice(0, ctx.commandsRun.length - 50);
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
      case "web_search":
      case "web_fetch":
        if (!ctx.web) return "Error: web access is turned off. The user can turn it on in settings.";
        result = name === "web_search" ? await webSearch(ctx.web, args, signal) : await webFetch(ctx.web, args, signal);
        break;
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

/** The command a call would run, if it is an exec call (edit mode may gate it;
 * bypass never asks; in ro mode the tool does not exist). */
export function commandOf(name: string, args: Record<string, any>): string | null {
  if (name === "run_command") return String(args.command ?? "");
  if (name === "task" && args.action === "start") return String(args.command ?? "");
  return null;
}
