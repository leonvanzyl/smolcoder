// Ollama adapter — uses the NATIVE /api/chat endpoint, not the OpenAI-compat
// one, because only the native API lets us set num_ctx per request, pass
// thinking traces back, and read real timings (prompt/eval durations).
//
// Prompt-size savings that matter on a long tool loop with a thinking model:
// reasoning traces from assistant messages BEFORE the current user turn are
// not sent back (the qwen3-family templates drop them anyway); only the
// current turn's traces travel, which is what tool-call loops need.

import {
  ChatOptions,
  ChatResult,
  Effort,
  lastUserIndex,
  MAX_OUTPUT_TOKENS,
  Msg,
  nextCallId,
  parseArgs,
  Provider,
  ToolCall,
  ToolSpec,
} from "./types";

/** Exported for tests. */
export function toWire(messages: Msg[]): any[] {
  const keepThinkingFrom = lastUserIndex(messages);
  return messages.map((m, i) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content ?? "",
        ...(m.thinking && i > keepThinkingFrom ? { thinking: m.thinking } : {}),
        tool_calls: m.toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: tc.args },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_name: m.toolName };
    }
    return { role: m.role, content: m.content };
  });
}

function toWireTools(tools: ToolSpec[]): any[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Keep the model resident between tool calls and while the user reads or
 * approves. Ollama's own default (5 min) unloads mid-session on any longer
 * pause, and a reload of a 17 GB model costs 10-20 s plus a cold cache. */
const KEEP_ALIVE = process.env.TINY_CODER_KEEP_ALIVE || "30m";

export class OllamaProvider implements Provider {
  readonly label: string;
  readonly maxOutputTokens: number;
  private effort: Effort | null = null;
  private thinkUnsupported = false;
  /** null = unknown, tried lazily; false = this model only takes a boolean. */
  private levelsSupported: boolean | null = null;

  constructor(
    private baseUrl: string,
    public readonly modelId: string,
    public readonly contextWindow: number,
    /** Explicit num_ctx to send; undefined = respect the server's configured context. */
    private numCtx?: number,
    maxOutputTokens = MAX_OUTPUT_TOKENS
  ) {
    this.label = `ollama · ${modelId}`;
    this.maxOutputTokens = maxOutputTokens;
    // Only gpt-oss is documented to take levels; everything else gets a
    // boolean straight away instead of a wasted probe request.
    if (!/gpt-oss/i.test(modelId)) this.levelsSupported = false;
  }

  setEffort(effort: Effort | null): void {
    this.effort = effort;
    this.thinkUnsupported = false;
  }

  effortLabel(): string | null {
    if (this.effort === null || this.effort === "off") return null;
    if (this.thinkUnsupported) return `${this.effort} (model has no thinking switch)`;
    if (this.levelsSupported === false) return `${this.effort} → thinking on`;
    return null;
  }

  /** Ollama's think param: boolean for most reasoning models; gpt-oss accepts levels. */
  private thinkParam(effort: Effort | null): boolean | string | undefined {
    if (effort === null || this.thinkUnsupported) return undefined;
    if (effort === "off") return false;
    return this.levelsSupported === false ? true : effort;
  }

  async chat(messages: Msg[], tools: ToolSpec[], opts: ChatOptions = {}): Promise<ChatResult> {
    const effort = opts.effortOverride ?? this.effort;
    const makeBody = (stream: boolean, think: boolean | string | undefined) => ({
      model: this.modelId,
      messages: toWire(messages),
      tools: tools.length ? toWireTools(tools) : undefined,
      stream,
      keep_alive: KEEP_ALIVE,
      ...(think !== undefined ? { think } : {}),
      options: {
        ...(this.numCtx ? { num_ctx: this.numCtx } : {}),
        num_predict: opts.maxTokens ?? this.maxOutputTokens,
      },
    });

    let think = this.thinkParam(effort);
    const started = { streaming: false };
    try {
      return await this.request(makeBody(true, think), opts, started);
    } catch (err: any) {
      if (err?.name === "AbortError") throw err;
      // Never re-request after tokens were already streamed to the UI — that
      // double-emits. Let agent.ts's chatWithRetry handle mid-stream failures.
      if (started.streaming) throw err;
      const msg = String(err?.message ?? "");
      const paramRejected = /returned 4\d\d/.test(msg) && /think/i.test(msg);
      // Only treat the think param as unsupported on an actual param rejection;
      // a transient 5xx/network error must NOT permanently disable reasoning.
      if (think !== undefined && paramRejected) {
        if (typeof think === "string") {
          // Levels rejected — this model takes a boolean. Same intent: on.
          this.levelsSupported = false;
          think = true;
          try {
            return await this.request(makeBody(true, think), opts, started);
          } catch (err2: any) {
            if (err2?.name === "AbortError" || started.streaming) throw err2;
            const msg2 = String(err2?.message ?? "");
            if (!(/returned 4\d\d/.test(msg2) && /think/i.test(msg2))) throw err2;
          }
        }
        this.thinkUnsupported = true;
        think = undefined;
        return await this.request(makeBody(true, undefined), opts, started);
      }
      // Older Ollama versions reject stream+tools together; retry non-streaming
      // once, but only for a pre-stream rejection (not a transient error).
      if (/returned 4\d\d/.test(msg)) {
        return await this.request(makeBody(false, think), opts, started);
      }
      throw err;
    }
  }

  private async request(body: any, opts: ChatOptions, started?: { streaming: boolean }): Promise<ChatResult> {
    const t0 = Date.now();
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama returned ${res.status}: ${text.slice(0, 300)}`);
    }

    let content = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let promptTokPerSec: number | undefined;
    let genTokPerSec: number | undefined;
    let truncated = false;
    let firstTokAt = 0;

    const handleChunk = (chunk: any) => {
      if (started) started.streaming = true; // committed — no safe re-request now
      const msg = chunk.message;
      if (msg?.thinking) {
        thinking += msg.thinking;
        opts.onThinking?.(msg.thinking);
        if (!firstTokAt) firstTokAt = Date.now();
      }
      if (msg?.content) {
        content += msg.content;
        opts.onToken?.(msg.content);
        if (!firstTokAt) firstTokAt = Date.now();
      }
      if (Array.isArray(msg?.tool_calls)) {
        if (!firstTokAt) firstTokAt = Date.now();
        for (const tc of msg.tool_calls) {
          const fn = tc.function ?? {};
          toolCalls.push({
            id: nextCallId(),
            name: fn.name ?? "",
            ...parseArgs(fn.arguments),
          });
        }
      }
      if (chunk.done) {
        if (typeof chunk.prompt_eval_count === "number") promptTokens = chunk.prompt_eval_count;
        if (typeof chunk.eval_count === "number") completionTokens = chunk.eval_count;
        if (typeof chunk.prompt_eval_duration === "number" && chunk.prompt_eval_duration > 0 && promptTokens) {
          promptTokPerSec = promptTokens / (chunk.prompt_eval_duration / 1e9);
        }
        if (typeof chunk.eval_duration === "number" && chunk.eval_duration > 0 && completionTokens) {
          genTokPerSec = completionTokens / (chunk.eval_duration / 1e9);
        }
        if (chunk.done_reason === "length") truncated = true;
      }
    };

    if (body.stream === false) {
      handleChunk(await res.json());
    } else {
      // NDJSON stream: one JSON object per line.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            handleChunk(JSON.parse(line));
          } catch {
            /* partial/garbled line — skip */
          }
        }
      }
      if (buffer.trim()) {
        try {
          handleChunk(JSON.parse(buffer.trim()));
        } catch {
          /* ignore */
        }
      }
    }

    return {
      content,
      toolCalls,
      thinking: thinking || undefined,
      promptTokens,
      // Ollama replays this turn's thinking into the next prompt, so the full
      // eval count is what the next request carries.
      completionTokens,
      generatedTokens: completionTokens,
      promptTokPerSec,
      genTokPerSec,
      ttftMs: firstTokAt ? firstTokAt - t0 : undefined,
      truncated,
    };
  }
}
