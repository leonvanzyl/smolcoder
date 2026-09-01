// Ollama adapter — uses the NATIVE /api/chat endpoint, not the OpenAI-compat
// one, because only the native API lets us set num_ctx per request. Relying on
// Ollama's default context is the classic local-agent footgun (it silently
// truncates the oldest part of the prompt — i.e. the system prompt — first).

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
        content: m.content ?? "",
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

export class OllamaProvider implements Provider {
  readonly label: string;
  readonly maxOutputTokens: number;
  private effort: Effort | null = null;
  private thinkUnsupported = false;

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
  }

  setEffort(effort: Effort | null): void {
    this.effort = effort;
    this.thinkUnsupported = false;
  }

  /** Ollama's think param: boolean for most reasoning models; gpt-oss accepts levels. */
  private thinkParam(): boolean | string | undefined {
    if (this.effort === null || this.thinkUnsupported) return undefined;
    if (this.effort === "off") return false;
    return this.modelId.toLowerCase().includes("gpt-oss") ? this.effort : true;
  }

  async chat(messages: Msg[], tools: ToolSpec[], opts: ChatOptions = {}): Promise<ChatResult> {
    const makeBody = (stream: boolean, think: boolean | string | undefined) => ({
      model: this.modelId,
      messages: toWire(messages),
      tools: tools.length ? toWireTools(tools) : undefined,
      stream,
      ...(think !== undefined ? { think } : {}),
      options: {
        ...(this.numCtx ? { num_ctx: this.numCtx } : {}),
        num_predict: this.maxOutputTokens,
      },
    });

    let think = this.thinkParam();
    try {
      return await this.request(makeBody(true, think), opts);
    } catch (err: any) {
      if (err?.name === "AbortError") throw err;
      // The model may not support the think param — drop it and remember.
      if (think !== undefined) {
        this.thinkUnsupported = true;
        think = undefined;
        try {
          return await this.request(makeBody(true, undefined), opts);
        } catch (err2: any) {
          if (err2?.name === "AbortError") throw err2;
        }
      }
      // Older Ollama versions reject stream+tools together; retry non-streaming once.
      return await this.request(makeBody(false, think), opts);
    }
  }

  private async request(body: any, opts: ChatOptions): Promise<ChatResult> {
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
    const toolCalls: ToolCall[] = [];
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let truncated = false;

    const handleChunk = (chunk: any) => {
      const msg = chunk.message;
      if (msg?.thinking) {
        opts.onThinking?.(msg.thinking);
      }
      if (msg?.content) {
        content += msg.content;
        opts.onToken?.(msg.content);
      }
      if (Array.isArray(msg?.tool_calls)) {
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

    return { content, toolCalls, promptTokens, completionTokens, truncated };
  }
}
