// Context budget management — the part local models actually live or die by.
//
// Fill gauge: every backend reports real prompt token usage per response; we
// anchor on that and only estimate the delta of new messages (chars/4). No
// homegrown tokenizer, works for any GGUF.
//
// Tiered compaction, cheap lever first:
//   Tier 1 (free): evict old tool-result bodies — files can be re-read, so
//   this is nearly lossless and usually recovers most of the window.
//   Tier 2 (one model call): rebuild the transcript around a state note. The
//   harness assembles the factual part deterministically (files touched,
//   commands run) because small models are unreliable summarizers; the model
//   only contributes a short "where we are" narrative.

import { Msg, Provider, ToolSpec } from "./providers/types";
import { estimateTokens, truncateEnd } from "./util";

const MSG_OVERHEAD_TOKENS = 8;
const EVICT_KEEP_RECENT = 6; // never evict tool results in the last N messages
const EVICT_STUB = "[old output removed to save space — run the tool again if you need it]";

export interface CompactionReport {
  action: "none" | "evicted" | "compacted";
  before: number;
  after: number;
}

export class ContextManager {
  private lastPromptTokens = 0;
  private lastCompletionTokens = 0;
  private anchorIndex = 0; // messages.length at the time usage was reported

  constructor(
    private window: number,
    private reserve: number
  ) {}

  /** Model switches mid-session change the window we budget against. */
  setWindow(window: number, reserve?: number): void {
    this.window = window;
    if (reserve !== undefined) this.reserve = reserve;
    this.lastPromptTokens = 0;
    this.anchorIndex = 0;
  }

  recordUsage(promptTokens: number | undefined, completionTokens: number | undefined, messageCount: number): void {
    if (typeof promptTokens === "number" && promptTokens > 0) {
      this.lastPromptTokens = promptTokens;
      this.lastCompletionTokens = completionTokens ?? 0;
      this.anchorIndex = messageCount;
    }
  }

  estimateMessages(messages: Msg[]): number {
    let total = 0;
    for (const m of messages) {
      total += estimateTokens(m.content ?? "") + MSG_OVERHEAD_TOKENS;
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          total += estimateTokens(tc.name + JSON.stringify(tc.args)) + MSG_OVERHEAD_TOKENS;
        }
      }
    }
    return total;
  }

  estimateTools(tools: ToolSpec[]): number {
    return estimateTokens(JSON.stringify(tools));
  }

  /** Best estimate of the next request's prompt size in tokens. */
  estimatePrompt(messages: Msg[], tools: ToolSpec[]): number {
    const charBased = this.estimateMessages(messages) + this.estimateTools(tools);
    if (this.lastPromptTokens > 0 && this.anchorIndex <= messages.length) {
      const newMsgs = messages.slice(this.anchorIndex);
      const anchored =
        this.lastPromptTokens + this.lastCompletionTokens + this.estimateMessages(newMsgs);
      return Math.max(charBased, anchored);
    }
    return charBased;
  }

  usableWindow(): number {
    return this.window - this.reserve;
  }

  fillPercent(messages: Msg[], tools: ToolSpec[]): number {
    return Math.min(100, Math.round((this.estimatePrompt(messages, tools) / this.window) * 100));
  }

  needsAttention(messages: Msg[], tools: ToolSpec[]): boolean {
    return this.estimatePrompt(messages, tools) > 0.8 * this.usableWindow();
  }

  /**
   * Bring the transcript back under budget. Mutates and/or replaces `messages`;
   * returns the (possibly new) array plus a report for the UI.
   */
  async manage(
    messages: Msg[],
    tools: ToolSpec[],
    provider: Provider,
    state: {
      originalRequest: string;
      filesTouched: Set<string>;
      commandsRun: string[];
      planLine?: string | null;
    }
  ): Promise<{ messages: Msg[]; report: CompactionReport }> {
    const before = this.estimatePrompt(messages, tools);
    if (before <= 0.8 * this.usableWindow()) {
      return { messages, report: { action: "none", before, after: before } };
    }

    // Tier 1: evict old tool-result bodies.
    const evictBoundary = Math.max(1, messages.length - EVICT_KEEP_RECENT);
    for (let i = 1; i < evictBoundary; i++) {
      const m = messages[i];
      if (m.role === "tool" && !m.evicted && m.content.length > 200) {
        m.content = EVICT_STUB;
        m.evicted = true;
        // invalidate the usage anchor — the transcript shrank behind it
        this.anchorIndex = 0;
        this.lastPromptTokens = 0;
        if (this.estimatePrompt(messages, tools) <= 0.6 * this.usableWindow()) break;
      }
    }
    let after = this.estimatePrompt(messages, tools);
    if (after <= 0.8 * this.usableWindow()) {
      return { messages, report: { action: "evicted", before, after } };
    }

    // Tier 2: full compaction around a state note.
    const compacted = await this.compact(messages, provider, state);
    this.anchorIndex = 0;
    this.lastPromptTokens = 0;
    after = this.estimatePrompt(compacted, tools);
    return { messages: compacted, report: { action: "compacted", before, after } };
  }

  private async compact(
    messages: Msg[],
    provider: Provider,
    state: {
      originalRequest: string;
      filesTouched: Set<string>;
      commandsRun: string[];
      planLine?: string | null;
    }
  ): Promise<Msg[]> {
    const system = messages[0];

    // Deterministic part of the state note — the harness knows these facts.
    // The plan goes first: it is the model's map of the task.
    const facts: string[] = [];
    if (state.planLine) facts.push(state.planLine);
    if (state.filesTouched.size) {
      facts.push(`Files created/modified so far: ${[...state.filesTouched].slice(-30).join(", ")}`);
    }
    if (state.commandsRun.length) {
      facts.push(`Commands run so far: ${state.commandsRun.slice(-15).join("; ")}`);
    }

    // Short model-written narrative. If the model call fails, facts alone carry it.
    let narrative = "";
    try {
      const transcript = messages
        .slice(1)
        .map((m) => {
          const tools = m.toolCalls?.map((t) => `${t.name}(${JSON.stringify(t.args).slice(0, 120)})`).join(", ");
          return `${m.role.toUpperCase()}: ${truncateEnd(m.content ?? "", 400)}${tools ? ` [called: ${tools}]` : ""}`;
        })
        .join("\n");
      const res = await provider.chat(
        [
          {
            role: "system",
            content: "You summarize coding sessions. Reply with only the summary, no preamble.",
          },
          {
            role: "user",
            content: `Summarize the current state of this coding session in under 120 words: what is the task, what has been done, what is the very next step?\n\n${truncateEnd(transcript, 24000)}`,
          },
        ],
        []
      );
      narrative = res.content.trim();
    } catch {
      narrative = "";
    }

    // Keep a clean tail: cut at the most recent plain user message so we never
    // strand a tool result without its assistant tool-call (strict backends reject that).
    let keepFrom = messages.length;
    for (let i = messages.length - 1; i >= Math.max(1, messages.length - 8); i--) {
      if (messages[i].role === "user") keepFrom = i;
    }
    const tail = keepFrom < messages.length ? messages.slice(keepFrom) : [];

    const note =
      `[The conversation so far was compacted to save context.]\n` +
      `Original request: ${truncateEnd(state.originalRequest, 1000)}\n` +
      (facts.length ? facts.join("\n") + "\n" : "") +
      (narrative ? `Progress summary: ${narrative}` : "");

    return [system, { role: "user", content: note }, ...tail];
  }
}
