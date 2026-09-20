// LM Studio adapter — standard OpenAI-compatible /v1/chat/completions with SSE
// streaming. The context window is whatever LM Studio loaded the model with;
// we detect it and budget within it (we cannot change it per request).
//
// Reasoning is the part that decides whether LM Studio feels fast or slow.
// LM Studio's API accepts reasoning_effort none|minimal|low|medium|high|xhigh,
// but each MODEL only supports a subset (read from /api/v1/models). A value
// the model does not support is silently replaced by the model's DEFAULT —
// which for current qwen3.x builds is "xhigh", the maximum. That is how a
// harness asking for "high" ends up with 8,000-token thinking bursts per tool
// call. So: "off" is sent as "none" (measured: fully disables thinking), and
// every other level is snapped to the nearest level the model really has.

import {
  ChatOptions,
  ChatResult,
  Effort,
  EFFORT_RANK,
  estimateReplayTokens,
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
import { imageDataUrl } from "../attachments";
import { tryFetchJson } from "../util";

export interface ReasoningInfo {
  /** Levels the loaded model supports, as reported by LM Studio. */
  allowed: string[];
  /** The level LM Studio applies when the request names none / an invalid one. */
  default?: string;
}

/** Exported for tests. */
export function toWire(messages: Msg[]): any[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "user" && m.images?.length) {
      // OpenAI-style content parts: the text, then each image as a data URL.
      const parts: any[] = [{ type: "text", text: m.content }];
      for (const ref of m.images) {
        const url = imageDataUrl(ref);
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
      return { role: "user", content: parts.length > 1 ? parts : m.content };
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

/** Exported for tests. Map a smolcoder effort onto LM Studio's wire value,
 * respecting what the model supports. Returns undefined for "leave it to the
 * backend". */
export function mapEffort(effort: Effort | null, info: ReasoningInfo | undefined): string | undefined {
  if (effort === null) return undefined;
  if (effort === "off") return "none";
  const wireLevels = ["low", "medium", "high", "xhigh"];
  if (!info || info.allowed.length === 0) return effort;
  // Model-supported levels that the API also accepts (the model list uses
  // "off"/"on" too; those are not valid wire values).
  const candidates = wireLevels.filter((l) => info.allowed.includes(l));
  if (candidates.length === 0) return effort;
  if (candidates.includes(effort)) return effort;
  const want = EFFORT_RANK[effort];
  let best = candidates[0];
  let bestDist = Infinity;
  for (const cnd of candidates) {
    const d = Math.abs(EFFORT_RANK[cnd] - want);
    // Ties go to the LOWER level: on a local model the cheaper step wins.
    if (d < bestDist || (d === bestDist && EFFORT_RANK[cnd] < EFFORT_RANK[best])) {
      best = cnd;
      bestDist = d;
    }
  }
  return best;
}

export class LmStudioProvider implements Provider {
  readonly replaysThinking = false;
  readonly label: string;
  readonly maxOutputTokens: number;
  private effort: Effort | null = null;
  private effortUnsupported = false;

  constructor(
    private baseUrl: string,
    public readonly modelId: string,
    public readonly contextWindow: number,
    maxOutputTokens = MAX_OUTPUT_TOKENS,
    private reasoning?: ReasoningInfo,
    /** Whether the model accepts images (LM Studio lists such models as "vlm"). */
    public readonly vision?: boolean,
    /** Bearer key, for OpenAI-compatible servers that require one (oMLX). */
    private apiKey?: string,
    private serverName = "LM Studio"
  ) {
    this.label = `${serverName === "LM Studio" ? "lmstudio" : serverName.toLowerCase()} · ${modelId}`;
    this.maxOutputTokens = maxOutputTokens;
  }

  setEffort(effort: Effort | null): void {
    this.effort = effort;
    this.effortUnsupported = false;
  }

  async loadedContextWindow(): Promise<number | undefined> {
    // LM Studio's own catalog, which the other OpenAI-compatible servers do
    // not have: asking them costs a request per turn and can only fail.
    if (this.serverName !== "LM Studio") return undefined;
    const data = await tryFetchJson(`${this.baseUrl}/api/v1/models`, undefined, 1500);
    for (const model of data?.models ?? []) {
      const instances = model.loaded_instances ?? [];
      const instance = instances.find((m: any) => m.id === this.modelId) ?? (model.key === this.modelId ? instances[0] : undefined);
      if (typeof instance?.config?.context_length === "number") return instance.config.context_length;
    }
    return undefined;
  }

  effortLabel(): string | null {
    if (this.effortUnsupported) return this.effort ? `${this.effort} (ignored by this server)` : null;
    if (this.effort === null) {
      return this.reasoning?.default ? `default → ${this.reasoning.default}` : null;
    }
    const wire = mapEffort(this.effort, this.reasoning);
    if (wire && wire !== this.effort && wire !== "none") return `${this.effort} → ${wire}`;
    return null;
  }

  async chat(messages: Msg[], tools: ToolSpec[], opts: ChatOptions = {}): Promise<ChatResult> {
    return scheduleInference(this.baseUrl, opts, (scheduled) => this.chatScheduled(messages, tools, scheduled));
  }

  private async chatScheduled(messages: Msg[], tools: ToolSpec[], opts: ChatOptions): Promise<ChatResult> {
    const effort = opts.effortOverride ?? this.effort;
    let wireMessages = messages;
    const base: any = {
      model: this.modelId,
      messages: toWire(wireMessages),
      tools: tools.length ? toWireTools(tools) : undefined,
      max_tokens: opts.maxTokens ?? this.maxOutputTokens,
    };
    const wireEffort = mapEffort(effort, this.reasoning);
    if (effort === "off" && this.serverName === "oMLX") {
      // oMLX reads reasoning_effort "none" as "low"; only the chat template
      // switch really turns thinking off (measured: 5.7s → 1.0s on "say hi").
      base.chat_template_kwargs = { enable_thinking: false };
    } else if (wireEffort && !this.effortUnsupported) {
      base.reasoning_effort = wireEffort;
    } else if (effort === "off" && /qwen/i.test(this.modelId)) {
      // Older LM Studio builds without reasoning_effort: fall back to the
      // qwen per-turn /no_think soft switch (older qwen3 models honor it).
      wireMessages = messages.map((m) => ({ ...m }));
      for (let i = wireMessages.length - 1; i >= 0; i--) {
        if (wireMessages[i].role === "user") {
          wireMessages[i].content = wireMessages[i].content + " /no_think";
          break;
        }
      }
      base.messages = toWire(wireMessages);
    }
    const started = { streaming: false };
    try {
      return await this.chain(base, opts, started);
    } catch (err: any) {
      if (err?.name === "AbortError") throw err;
      if (started.streaming) throw err; // tokens already shown — don't re-emit
      const msg = String(err?.message ?? "");
      // Only latch effortUnsupported on an actual param rejection (4xx naming
      // it), never on a transient 5xx / dropped socket.
      if (base.reasoning_effort && /returned 4\d\d/.test(msg) && /reasoning|effort/i.test(msg)) {
        this.effortUnsupported = true;
        delete base.reasoning_effort;
        return await this.chain(base, opts, started);
      }
      throw err;
    }
  }

  private async chain(base: any, opts: ChatOptions, started: { streaming: boolean }): Promise<ChatResult> {
    try {
      return await this.request(
        { ...base, stream: true, stream_options: { include_usage: true } },
        opts,
        started
      );
    } catch (err: any) {
      if (err?.name === "AbortError") throw err;
      if (started.streaming) throw err;
      const msg = String(err?.message ?? "");
      // Only degrade the request shape on a pre-stream HTTP rejection; a
      // transient error must propagate to chatWithRetry for backoff.
      if (!/returned 4\d\d/.test(msg)) throw err;
      // A reasoning_effort rejection must reach chat()'s handler, not be
      // masked by the stream-shape fallback ladder.
      if (/reasoning|effort/i.test(msg)) throw err;
      try {
        return await this.request({ ...base, stream: true }, opts, started);
      } catch (err2: any) {
        if (err2?.name === "AbortError" || started.streaming) throw err2;
        if (!/returned 4\d\d/.test(String(err2?.message ?? ""))) throw err2;
        return await this.request({ ...base, stream: false }, opts, started);
      }
    }
  }

  private async request(body: any, opts: ChatOptions, started?: { streaming: boolean }): Promise<ChatResult> {
    return withDeadline(opts, (signal, activity) => this.readResponse(body, { ...opts, signal }, activity, started));
  }

  private async readResponse(body: any, opts: ChatOptions, activity: () => void, started?: { streaming: boolean }): Promise<ChatResult> {
    const t0 = Date.now();
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.serverName} returned ${res.status}: ${text.slice(0, 300)}`);
    }

    if (body.stream === false) {
      const data: any = await res.json();
      if (data.error || !data.choices?.[0]?.message) throw new Error(`LM Studio returned an invalid completion: ${data.error?.message ?? "missing message"}`);
      const msg = data.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => ({
        id: tc.id || nextCallId(),
        name: tc.function?.name ?? "",
        ...parseArgs(tc.function?.arguments),
      }));
      if (started) started.streaming = true;
      if (msg.content) opts.onToken?.(msg.content);
      const content = msg.content ?? "";
      const total = Date.now() - t0;
      return {
        content,
        toolCalls,
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: estimateReplayTokens(content, toolCalls),
        generatedTokens: data.usage?.completion_tokens,
        genTokPerSec: data.usage?.completion_tokens ? data.usage.completion_tokens / (total / 1000) : undefined,
        truncated: data.choices?.[0]?.finish_reason === "length",
      };
    }

    // SSE stream.
    let content = "";
    let thinking = "";
    const partials = new Map<number, { id: string; name: string; args: string }>();
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let truncated = false;
    let finished = false;
    let firstTokAt = 0;
    let lastTokAt = 0;

    const handleLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      const chunk = streamJson(payload);
      if (started) started.streaming = true; // committed — no safe re-request now
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
      }
      if (chunk.choices?.[0]?.finish_reason === "length") truncated = true;
      if (chunk.choices?.[0]?.finish_reason) finished = true;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      let sawToken = false;
      if (typeof reasoning === "string" && reasoning) {
        thinking += reasoning;
        opts.onThinking?.(reasoning);
        sawToken = true;
      }
      if (delta.content) {
        content += delta.content;
        opts.onToken?.(delta.content);
        sawToken = true;
      }
      if (Array.isArray(delta.tool_calls)) {
        sawToken = true;
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const p = partials.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) p.id = tc.id;
          if (tc.function?.name) p.name += tc.function.name;
          if (tc.function?.arguments) p.args += tc.function.arguments;
          partials.set(idx, p);
        }
      }
      if (sawToken) {
        const now = Date.now();
        if (!firstTokAt) firstTokAt = now;
        lastTokAt = now;
      }
    };

    for await (const line of responseLines(res, activity)) handleLine(line);
    if (!finished) throw new Error("LM Studio stream ended before completion; the response was discarded");

    const toolCalls: ToolCall[] = [...partials.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, p]) => ({
        id: p.id || nextCallId(),
        name: p.name,
        ...parseArgs(p.args),
      }));

    const genMs = lastTokAt > firstTokAt ? lastTokAt - firstTokAt : 0;
    return {
      content,
      toolCalls,
      thinking: thinking || undefined,
      promptTokens,
      // LM Studio does not replay reasoning into the next prompt, so only the
      // visible reply and tool-call JSON count toward the next request.
      completionTokens: estimateReplayTokens(content, toolCalls),
      generatedTokens: completionTokens,
      genTokPerSec: completionTokens && genMs > 0 ? completionTokens / (genMs / 1000) : undefined,
      ttftMs: firstTokAt ? firstTokAt - t0 : undefined,
      truncated,
    };
  }
}
