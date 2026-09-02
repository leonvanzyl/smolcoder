// One internal message/tool shape; each provider adapts it to its wire format.

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments object. If parsing failed, args is {} and rawArgs holds the text. */
  args: Record<string, any>;
  rawArgs?: string;
  parseError?: string;
}

export interface Msg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** Assistant reasoning trace (Ollama passes it back on tool loops). */
  thinking?: string;
  /** Set when a tool result body was evicted during context management. */
  evicted?: boolean;
  /** Set on a synthesized compaction-note message so a later compaction can
   * strip it instead of stacking notes. */
  compactNote?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  /** Accumulated reasoning trace, when the backend streamed one. */
  thinking?: string;
  /** Real token usage reported by the backend — our context fill gauge.
   * completionTokens counts only what will be re-sent in the next prompt
   * (reasoning that the backend does not replay is excluded). */
  promptTokens?: number;
  completionTokens?: number;
  /** Tokens generated in total, reasoning included (for the speed readout). */
  generatedTokens?: number;
  /** Generation speed measured by the backend (Ollama) or from the stream
   * wall-clock between first and last token (LM Studio). */
  genTokPerSec?: number;
  /** Prompt-processing speed when the backend reports it (Ollama). */
  promptTokPerSec?: number;
  /** Milliseconds from request start to the first streamed token. */
  ttftMs?: number;
  /** True when generation hit the output-token cap (done_reason/finish_reason
   * "length") — the reply, possibly including a tool call, was cut off. */
  truncated?: boolean;
}

export interface ChatOptions {
  onToken?: (text: string) => void;
  /** Streamed reasoning/thinking text (models that expose it). */
  onThinking?: (text: string) => void;
  signal?: AbortSignal;
  /** Override the session effort for this one call (the compaction
   * summarizer runs with thinking off — a summary is not worth 30s of
   * reasoning, and on a max-effort model it would burn the whole budget). */
  effortOverride?: Effort;
  /** Cap the reply for this one call (summaries stay short by construction). */
  maxTokens?: number;
}

/** Reasoning effort. "off" disables thinking where the backend supports it
 * (a real speedup on qwen3-class models); levels map to Ollama's think param
 * and LM Studio's reasoning_effort. Unsupported models fall back gracefully. */
export type Effort = "off" | "low" | "medium" | "high";

/** Rank of every reasoning level any backend knows about, used to map a
 * requested effort onto whatever a specific model actually supports. */
export const EFFORT_RANK: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  on: 3,
};

export interface Provider {
  readonly label: string;
  readonly modelId: string;
  readonly contextWindow: number;
  /** Tokens reserved for the model's reply within the window. */
  readonly maxOutputTokens: number;
  setEffort(effort: Effort | null): void;
  /** What the current effort setting actually does on this backend/model —
   * shown in the status line so "default" is never a mystery. null = nothing
   * worth saying (the plain effort name is enough). */
  effortLabel(): string | null;
  chat(messages: Msg[], tools: ToolSpec[], opts?: ChatOptions): Promise<ChatResult>;
}

export const MAX_OUTPUT_TOKENS = 2048;

let callCounter = 0;
export function nextCallId(): string {
  return `call_${++callCounter}`;
}

export function parseArgs(raw: unknown): Pick<ToolCall, "args" | "rawArgs" | "parseError"> {
  if (raw && typeof raw === "object") return { args: raw as Record<string, any> };
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return { args: parsed, rawArgs: raw };
      return { args: {}, rawArgs: raw, parseError: "arguments were not a JSON object" };
    } catch (e: any) {
      return { args: {}, rawArgs: raw, parseError: `invalid JSON: ${e.message}` };
    }
  }
  return { args: {} };
}

/** Tokens the visible reply + tool-call JSON will occupy when replayed in the
 * next prompt (~4 chars/token, corrected by real usage on the next response). */
export function estimateReplayTokens(content: string, toolCalls: ToolCall[]): number {
  let chars = (content ?? "").length;
  for (const tc of toolCalls) chars += tc.name.length + (tc.rawArgs ?? JSON.stringify(tc.args)).length + 12;
  return Math.ceil(chars / 4);
}

/** Index of the most recent plain user message (the current turn's start).
 * Reasoning traces from assistant messages BEFORE it are dropped from the
 * wire — that is what the Qwen3-family chat templates do themselves, and it
 * is the biggest single saving on a long tool loop with a thinking model. */
export function lastUserIndex(messages: Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !messages[i].compactNote) return i;
  }
  return -1;
}
