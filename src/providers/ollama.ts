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
import { responseLines, streamJson, withDeadline } from "./transport";
import { scheduleInference } from "./scheduler";
import { imageBase64 } from "../attachments";
import { tryFetchJson } from "../util";

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
    if (m.role === "user" && m.images?.length) {
      const images = m.images.map(imageBase64).filter((b): b is string => b !== null);
      return { role: "user", content: m.content, ...(images.length ? { images } : {}) };
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
const KEEP_ALIVE = process.env.SMOLCODER_KEEP_ALIVE || "30m";

/** Ollama's answer to a prompt larger than the loaded context (truncate:false). */
const CONTEXT_OVERFLOW = /longer than the context|context length|exceeds? (the )?context/i;

export class OllamaProvider implements Provider {
  readonly replaysThinking = true;
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
    maxOutputTokens = MAX_OUTPUT_TOKENS,
    /** Whether the model accepts images (from /api/show capabilities). */
    public readonly vision?: boolean,
    /** Whether the model can call tools; false = strip tool schemas before sending. */
    public readonly toolsSupported?: boolean
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

  async loadedContextWindow(): Promise<number | undefined> {
    if (this.numCtx) return this.numCtx;
    const ps = await tryFetchJson(`${this.baseUrl}/api/ps`, undefined, 1500);
    const model = ps?.models?.find((m: any) => m.name === this.modelId || m.model === this.modelId);
    return typeof model?.context_length === "number" ? model.context_length : undefined;
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
    return scheduleInference(this.baseUrl, opts, (scheduled) => this.chatScheduled(messages, tools, scheduled));
  }

  private async chatScheduled(messages: Msg[], tools: ToolSpec[], opts: ChatOptions): Promise<ChatResult> {
    const effort = opts.effortOverride ?? this.effort;
    // A model whose /api/show capabilities lack "tools" cannot consume tool
    // schemas: Ollama answers 400 "does not support tools" and the turn dies
    // (the same class as the empty-reply cliff). Negotiate up front — drop the
    // tool schemas and let the agent answer in plain text. Unknown capability
    // (older Ollama) keeps tools, matching the previous behavior.
    const sendTools = this.toolsSupported === false ? [] : tools;
    const makeBody = (stream: boolean, think: boolean | string | undefined) => ({
      model: this.modelId,
      messages: toWire(messages),
      tools: sendTools.length ? toWireTools(sendTools) : undefined,
      stream,
      keep_alive: KEEP_ALIVE,
      // Never let Ollama make room by itself: truncate drops the oldest
      // messages (our compaction note among them) and shift slides the window
      // mid-generation. Off, an oversized prompt is a 400 "prompt is longer
      // than the context length" error, which the agent's context recovery
      // handles, and a reply that runs out of room ends with done_reason
      // "length", which the truncation nudges handle.
      truncate: false,
      shift: false,
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
      // once, but only for a pre-stream rejection (not a transient error, and
      // not an oversized prompt, which would only fail again).
      if (/returned 4\d\d/.test(msg) && !CONTEXT_OVERFLOW.test(msg)) {
        return await this.request(makeBody(false, think), opts, started);
      }
      throw err;
    }
  }

  private async request(body: any, opts: ChatOptions, started?: { streaming: boolean }): Promise<ChatResult> {
    return withDeadline(opts, (signal, activity) => this.readResponse(body, { ...opts, signal }, activity, started));
  }

  private async readResponse(body: any, opts: ChatOptions, activity: () => void, started?: { streaming: boolean }): Promise<ChatResult> {
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
    let finished = false;
    let firstTokAt = 0;

    const handleChunk = (chunk: any) => {
      if (chunk.error) throw new Error(`Ollama stream error: ${chunk.error}`);
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
          opts.onToolArgs?.(fn.name ?? "", typeof fn.arguments === "string" ? fn.arguments.length : JSON.stringify(fn.arguments ?? {}).length);
        }
      }
      if (chunk.done) {
        finished = true;
        if (typeof chunk.prompt_eval_count === "number") promptTokens = chunk.prompt_eval_count;
        // prompt_eval_cached_count is documented as the part of the prompt
        // read from cache. Larger than prompt_eval_count, it cannot be part
        // of it: the count then covers only the newly evaluated tokens.
        const cached = chunk.prompt_eval_cached_count;
        if (promptTokens !== undefined && typeof cached === "number" && cached > promptTokens) promptTokens += cached;
        if (typeof chunk.eval_count === "number") completionTokens = chunk.eval_count;
        if (typeof chunk.prompt_eval_duration === "number" && chunk.prompt_eval_duration > 0 && promptTokens) {
          promptTokPerSec = (chunk.prompt_eval_count ?? promptTokens) / (chunk.prompt_eval_duration / 1e9);
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
      for await (const line of responseLines(res, activity)) {
        if (line) handleChunk(streamJson(line));
      }
    }
    if (!finished) throw new Error("Ollama stream ended before completion; the response was discarded");

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
