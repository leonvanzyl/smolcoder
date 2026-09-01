// LM Studio adapter — standard OpenAI-compatible /v1/chat/completions with SSE
// streaming. The context window is whatever LM Studio loaded the model with;
// we detect it and budget within it (we cannot change it per request).

import {
  ChatOptions,
  ChatResult,
  Effort,
  MAX_OUTPUT_TOKENS,
  Msg,
  nextCallId,
  parseArgs,
  Provider,
  ToolCall,
  ToolSpec,
} from "./types";

function toWire(messages: Msg[]): any[] {
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
    return { role: m.role, content: m.content };
  });
}

function toWireTools(tools: ToolSpec[]): any[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export class LmStudioProvider implements Provider {
  readonly label: string;
  readonly maxOutputTokens: number;
  private effort: Effort | null = null;
  private effortUnsupported = false;

  constructor(
    private baseUrl: string,
    public readonly modelId: string,
    public readonly contextWindow: number,
    maxOutputTokens = MAX_OUTPUT_TOKENS
  ) {
    this.label = `lmstudio · ${modelId}`;
    this.maxOutputTokens = maxOutputTokens;
  }

  setEffort(effort: Effort | null): void {
    this.effort = effort;
    this.effortUnsupported = false;
  }

  async chat(messages: Msg[], tools: ToolSpec[], opts: ChatOptions = {}): Promise<ChatResult> {
    // effort "off": LM Studio's OpenAI layer has no reliable way to disable
    // thinking, but qwen-family models honor a per-turn /no_think soft switch
    // in the latest USER message (measured: 9.8s -> 1.0s on the same request).
    // Applied at wire time only — the internal transcript stays clean.
    let wireMessages = messages;
    if (this.effort === "off" && /qwen/i.test(this.modelId)) {
      wireMessages = messages.map((m) => ({ ...m }));
      for (let i = wireMessages.length - 1; i >= 0; i--) {
        if (wireMessages[i].role === "user") {
          wireMessages[i].content = wireMessages[i].content + " /no_think";
          break;
        }
      }
    }
    const base: any = {
      model: this.modelId,
      messages: toWire(wireMessages),
      tools: tools.length ? toWireTools(tools) : undefined,
      max_tokens: this.maxOutputTokens,
    };
    if (this.effort && this.effort !== "off" && !this.effortUnsupported) {
      base.reasoning_effort = this.effort;
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
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LM Studio returned ${res.status}: ${text.slice(0, 300)}`);
    }

    if (body.stream === false) {
      const data: any = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => ({
        id: tc.id || nextCallId(),
        name: tc.function?.name ?? "",
        ...parseArgs(tc.function?.arguments),
      }));
      if (started) started.streaming = true;
      if (msg.content) opts.onToken?.(msg.content);
      return {
        content: msg.content ?? "",
        toolCalls,
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        truncated: data.choices?.[0]?.finish_reason === "length",
      };
    }

    // SSE stream.
    let content = "";
    const partials = new Map<number, { id: string; name: string; args: string }>();
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let truncated = false;

    const handleLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      if (started) started.streaming = true; // committed — no safe re-request now
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
      }
      if (chunk.choices?.[0]?.finish_reason === "length") truncated = true;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        opts.onThinking?.(reasoning);
      }
      if (delta.content) {
        content += delta.content;
        opts.onToken?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const p = partials.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) p.id = tc.id;
          if (tc.function?.name) p.name += tc.function.name;
          if (tc.function?.arguments) p.args += tc.function.arguments;
          partials.set(idx, p);
        }
      }
    };

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    }
    // Flush a final line with no trailing newline (may carry usage /
    // finish_reason:"length" — losing it silently drops the anchor / truncation).
    if (buffer.trim()) handleLine(buffer);

    const toolCalls: ToolCall[] = [...partials.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, p]) => ({
        id: p.id || nextCallId(),
        name: p.name,
        ...parseArgs(p.args),
      }));

    return { content, toolCalls, promptTokens, completionTokens, truncated };
  }
}
