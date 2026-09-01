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
  /** Real token usage reported by the backend — our context fill gauge. */
  promptTokens?: number;
  completionTokens?: number;
  /** True when generation hit the output-token cap (done_reason/finish_reason
   * "length") — the reply, possibly including a tool call, was cut off. */
  truncated?: boolean;
}

export interface ChatOptions {
  onToken?: (text: string) => void;
  /** Streamed reasoning/thinking text (models that expose it). */
  onThinking?: (text: string) => void;
  signal?: AbortSignal;
}

/** Reasoning effort. "off" disables thinking where the backend supports it
 * (a real speedup on qwen3-class models); levels map to Ollama's think param
 * and LM Studio's reasoning_effort. Unsupported models fall back gracefully. */
export type Effort = "off" | "low" | "medium" | "high";

export interface Provider {
  readonly label: string;
  readonly modelId: string;
  readonly contextWindow: number;
  /** Tokens reserved for the model's reply within the window. */
  readonly maxOutputTokens: number;
  setEffort(effort: Effort | null): void;
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
