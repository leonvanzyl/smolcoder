// Context budget management — the part local models actually live or die by.
//
// Fill gauge: every backend reports real prompt token usage per response; we
// anchor on that and only estimate the delta of new messages (chars-based). No
// homegrown tokenizer, works for any GGUF.
//
// Tiered compaction, cheap lever first:
//   Tier 1 (free): evict old tool-result bodies — files can be re-read, so
//   this is nearly lossless and usually recovers most of the window.
//   Tier 2 (one model call): rebuild the transcript around a state note. The
//   harness assembles the factual part deterministically (files touched,
//   commands run) because small models are unreliable summarizers; the model
//   only contributes a short "where we are" narrative.
//
// Guard rails learned the hard way:
//   - compaction notes are FLAGGED so a later compaction strips them instead
//     of stacking note-on-note (which made compaction stop shrinking anything)
//   - the note always carries the CURRENT turn's request, not only the
//     session's first one
//   - when the irreducible floor (system prompt + tools + protected tail)
//     alone exceeds the threshold, we stop trying instead of thrashing a
//     futile summarizer call before every request

import { Msg, Provider, ToolSpec } from "./providers/types";
import { estimateTokens, truncateEnd } from "./util";

const MSG_OVERHEAD_TOKENS = 8;
const EVICT_KEEP_RECENT = 6; // never evict tool results in the last N messages
const EVICT_STUB = "[old output removed to save space — run the tool again if you need it]";

export interface CompactionReport {
  action: "none" | "evicted" | "compacted" | "floor";
  before: number;
  after: number;
}

interface CompactState {
  originalRequest: string;
  currentRequest?: string;
  filesTouched: Set<string>;
  commandsRun: string[];
  planLine?: string | null;
}

export class ContextManager {
  private lastPromptTokens = 0;
  private lastCompletionTokens = 0;
  private anchorIndex = 0; // messages.length at the time usage was reported
  private floorWarned = false;

  constructor(
    private window: number,
    private reserve: number
  ) {}

  /** Model switches mid-session change the window we budget against. */
  setWindow(window: number, reserve?: number): void {
    this.window = window;
    if (reserve !== undefined) this.reserve = reserve;
    this.resetAnchor();
  }

  /** Invariant: lastPromptTokens + lastCompletionTokens cover exactly the
   * first `anchorIndex` messages of the transcript at record time. */
  recordUsage(promptTokens: number | undefined, completionTokens: number | undefined, messageCount: number): void {
    if (typeof promptTokens === "number" && promptTokens > 0) {
      this.lastPromptTokens = promptTokens;
      this.lastCompletionTokens = completionTokens ?? 0;
      this.anchorIndex = messageCount;
    }
  }

  /** Drop the usage anchor (transcript replaced/cleared behind it). */
  resetAnchor(): void {
    this.lastPromptTokens = 0;
    this.lastCompletionTokens = 0;
    this.anchorIndex = 0;
    this.floorWarned = false;
  }

  estimateMessages(messages: Msg[]): number {
    let total = 0;
    for (const m of messages) {
      total += estimateTokens(m.content ?? "") + MSG_OVERHEAD_TOKENS;
      if (m.thinking) total += estimateTokens(m.thinking);
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
    if (this.estimatePrompt(messages, tools) <= 0.8 * this.usableWindow()) {
      this.floorWarned = false; // healthy again — re-arm the floor warning
      return false;
    }
    // Once we've established the transcript cannot shrink further, stop
    // triggering a futile compaction before every request.
    return !this.floorWarned;
  }

  /**
   * Bring the transcript back under budget. Mutates and/or replaces `messages`;
   * returns the (possibly new) array plus a report for the UI.
   */
  async manage(
    messages: Msg[],
    tools: ToolSpec[],
    provider: Provider,
    state: CompactState
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
    if (after > 0.8 * this.usableWindow()) {
      // Irreducible floor: the window simply cannot hold what must stay
      // (system prompt + AGENTS.md + tool schemas + the working tail).
      // Continue anyway, but stop re-compacting on every request.
      this.floorWarned = true;
      return { messages: compacted, report: { action: "floor", before, after } };
    }
    return { messages: compacted, report: { action: "compacted", before, after } };
  }

  private async compact(
    allMessages: Msg[],
    provider: Provider,
    state: CompactState
  ): Promise<Msg[]> {
    const system = allMessages[0];
    // Strip prior compaction notes — their content is regenerated fresh below.
    // Without this, notes accrete (each new note keeps the old one in its
    // tail) and compaction stops shrinking the transcript at all.
    const messages = [system, ...allMessages.slice(1).filter((m) => !m.compactNote)];

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

    // Short model-written narrative. Skipped entirely on very small windows —
    // the summarize call itself must fit, and on Ollama an oversized prompt is
    // silently front-truncated (losing the instructions), so facts-only is the
    // safe degradation. If the call fails, facts alone carry the note.
    let narrative = "";
    const digestBudgetChars = Math.min(24000, Math.max(0, (this.usableWindow() - 700) * 3));
    if (digestBudgetChars >= 3000) {
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
              content: `Summarize the current state of this coding session in under 120 words: what is the task, what has been done, what is the very next step?\n\n${truncateEnd(transcript, digestBudgetChars)}`,
            },
          ],
          []
        );
        narrative = res.content.trim();
      } catch {
        narrative = "";
      }
    }

    // Keep a clean tail. Preferred cut: the most recent plain user message.
    // Mid-turn there often is none nearby — then keep the last COMPLETE
    // assistant-toolcall + tool-results group instead of dropping everything,
    // so the model retains the material it just fetched for its next action.
    let keepFrom = messages.length;
    for (let i = messages.length - 1; i >= Math.max(1, messages.length - 8); i--) {
      if (messages[i].role === "user" && !messages[i].compactNote) keepFrom = i;
    }
    if (keepFrom === messages.length) {
      for (let i = messages.length - 1; i >= 1; i--) {
        const m = messages[i];
        if (m.role === "assistant" && m.toolCalls?.length) {
          const allAnswered = m.toolCalls.every((tc) =>
            messages.slice(i + 1).some((t) => t.role === "tool" && t.toolCallId === tc.id)
          );
          if (allAnswered) keepFrom = i;
          break;
        }
        if (m.role === "assistant") {
          keepFrom = i;
          break;
        }
      }
    }
    const tail = keepFrom < messages.length ? messages.slice(keepFrom) : [];

    const requestLines =
      state.currentRequest && state.currentRequest !== state.originalRequest
        ? `Original request: ${truncateEnd(state.originalRequest, 600)}\nCurrent request (what you are working on NOW): ${truncateEnd(state.currentRequest, 1000)}\n`
        : `Original request: ${truncateEnd(state.originalRequest, 1000)}\n`;

    const note =
      `[The conversation so far was compacted to save context.]\n` +
      requestLines +
      (facts.length ? facts.join("\n") + "\n" : "") +
      (narrative ? `Progress summary: ${narrative}` : "");

    return [system, { role: "user", content: note, compactNote: true }, ...tail];
  }
}
