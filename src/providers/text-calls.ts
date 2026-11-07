// Tool calls written as reply text. Some models (qwen2.5-coder is the common
// one) answer a tool request with the call as JSON in the message body —
// bare, in a ```json fence, or wrapped in <tool_call> tags — and the server's
// template parser does not turn it into a real tool call. The turn then ends
// as a "plain answer" and nothing is written: a silent failure. Recover such
// calls, but only for tools that were actually offered, so prose that happens
// to contain JSON is left alone.

import { nextCallId, parseArgs, ToolCall } from "./types";

const NAME_KEYS = ["name", "tool", "tool_name", "function"];
const ARG_KEYS = ["arguments", "parameters", "args", "input", "tool_input"];

/** The end index (exclusive) of the balanced JSON object starting at `start`, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

function asCall(obj: any, toolNames: Set<string>): ToolCall | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  // OpenAI wire shape: {"type": "function", "function": {"name", "arguments"}}.
  if (obj.function && typeof obj.function === "object") return asCall(obj.function, toolNames);
  const nameKey = NAME_KEYS.find((k) => typeof obj[k] === "string");
  if (!nameKey || !toolNames.has(obj[nameKey])) return null;
  const argKey = ARG_KEYS.find((k) => k in obj);
  if (!argKey) return null;
  const parsed = parseArgs(obj[argKey]);
  if (parsed.parseError) return null;
  return { id: nextCallId(), name: obj[nameKey], ...parsed };
}

/** Pull tool calls out of reply text. `content` is the text with the calls
 * (and the fences/tags around them) removed. No calls → content unchanged. */
export function extractTextToolCalls(text: string, toolNames: Iterable<string>): { calls: ToolCall[]; content: string } {
  const names = new Set(toolNames);
  const calls: ToolCall[] = [];
  if (!names.size || !text.includes("{")) return { calls, content: text };
  let rest = "";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start < 0) break;
    const end = objectEnd(text, start);
    if (end < 0) break;
    let call: ToolCall | null = null;
    try {
      call = asCall(JSON.parse(text.slice(start, end)), names);
    } catch {
      call = null;
    }
    if (call) {
      calls.push(call);
      rest += text.slice(i, start);
      i = end;
    } else {
      // Not a call: keep scanning inside it (an array of calls, or a call
      // nested in some wrapper object).
      rest += text.slice(i, start + 1);
      i = start + 1;
    }
  }
  if (!calls.length) return { calls, content: text };
  rest += text.slice(i);
  const content = rest
    .replace(/<\/?tool_call>/g, "")
    .replace(/```[a-z]*\s*```/gi, "")
    .replace(/\[\s*(,\s*)*\]/g, "")
    .trim();
  return { calls, content };
}
