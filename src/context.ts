// Context budget management — the part local models actually live or die by.
//
// Fill gauge: every backend reports real prompt token usage per response; we
// anchor on that and only estimate the delta of new messages (chars-based). No
// homegrown tokenizer, works for any GGUF.
//
// Tiered compaction, cheap lever first:
//   Tier 0 (free, continuous): stale-read eviction — the moment a file is
//   overwritten, every earlier read of it is dead weight AND misleading.
//   Tier 1 (free): evict old tool-result bodies and old reasoning traces —
//   files can be re-read, so this is nearly lossless and usually recovers
//   most of the window.
//   Tier 2 (one model call): rebuild the transcript around a state note. The
//   harness assembles the factual part deterministically (plan, files touched,
//   commands run) and the model writes a structured progress summary with
//   thinking OFF — local models summarize well, they just must not be allowed
//   to reason for a minute about it.
//
// Guard rails learned the hard way:
//   - compaction notes are FLAGGED so a later compaction strips them instead
//     of stacking note-on-note (which made compaction stop shrinking anything)
//   - the note always carries the CURRENT turn's request, not only the
//     session's first one
//   - when the irreducible floor (system prompt + tools + protected tail)
//     alone exceeds the threshold, we stop trying instead of thrashing a
//     futile summarizer call before every request

import { lastUserIndex, Msg, Provider, ToolSpec } from "./providers/types";
import { estimateTokens, truncateEnd } from "./util";

const MSG_OVERHEAD_TOKENS = 8;
const EVICT_KEEP_RECENT = 6; // never evict tool results in the last N messages
const EVICT_STUB = "[old output removed to save space — run the tool again if you need it]";
const STALE_READ_STUB = "[this read is out of date — the file was rewritten afterwards. Call read_file again if you need its current content.]";
const STALE_READ_MIN_CHARS = 1500; // small reads are cheaper to keep than to re-prefill around

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

/** Tool-call args for a tool-result message (the call lives on the preceding
 * assistant message). */
function callFor(messages: Msg[], toolMsgIndex: number): { name: string; args: Record<string, any> } | null {
  const id = messages[toolMsgIndex].toolCallId;
  if (!id) return null;
  for (let i = toolMsgIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.toolCalls) continue;
    const tc = m.toolCalls.find((t) => t.id === id);
    if (tc) return { name: tc.name, args: tc.args };
  }
  return null;
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
    // Reasoning traces before the current user turn are not sent to the
    // backend (see providers), so they must not count either.
    const thinkingFrom = lastUserIndex(messages);
    let total = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      total += estimateTokens(m.content ?? "") + MSG_OVERHEAD_TOKENS;
      if (m.thinking && i > thinkingFrom) total += estimateTokens(m.thinking);
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
   * Tier 0: a file was just completely rewritten — every earlier read_file
   * result for that path is now wrong. Replace the big ones with a stub so
   * they neither cost context nor mislead the next edit. Returns how many
   * results were stubbed.
   */
  evictStaleReads(messages: Msg[], filePath: string): number {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
    const target = norm(filePath);
    let n = 0;
    // Skip the most recent message: it is the write's own result.
    for (let i = 1; i < messages.length - 1; i++) {
      const m = messages[i];
      if (m.role !== "tool" || m.evicted || m.content.length < STALE_READ_MIN_CHARS) continue;
      const call = callFor(messages, i);
      if (!call || call.name !== "read_file") continue;
      if (norm(String(call.args?.path ?? "")) !== target) continue;
      m.content = STALE_READ_STUB;
      m.evicted = true;
      n++;
    }
    if (n) {
      // The transcript shrank behind the usage anchor.
      this.anchorIndex = 0;
      this.lastPromptTokens = 0;
    }
    return n;
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

    // Tier 1a: reasoning traces of finished turns are never sent again —
    // drop them for real so they stop costing memory and estimate.
    const thinkingFrom = lastUserIndex(messages);
    for (let i = 1; i < thinkingFrom; i++) {
      if (messages[i].role === "assistant" && messages[i].thinking) messages[i].thinking = undefined;
    }

    // Tier 1b: evict old tool-result bodies, oldest first.
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

    // Model-written progress summary — structured, thinking off, short cap.
    // Skipped entirely on very small windows: the summarize call itself must
    // fit, and on Ollama an oversized prompt is silently front-truncated
    // (losing the instructions), so facts-only is the safe degradation. If the
    // call fails, facts alone carry the note.
    let narrative = "";
    const digestBudgetChars = Math.min(60000, Math.max(0, (this.usableWindow() - 1200) * 3));
    if (digestBudgetChars >= 3000) {
      try {
        const transcript = renderForDigest(messages.slice(1), digestBudgetChars);
        const res = await provider.chat(
          [
            {
              role: "system",
              content:
                "You write hand-over notes for a coding agent whose conversation is about to be cleared. Be concrete and factual; never invent. Reply with only the notes.",
            },
            {
              role: "user",
              content:
                `Write hand-over notes for this session under exactly these headings:\n` +
                `Task: the user's goal in one sentence.\n` +
                `Done: what is finished and known to work (files, features).\n` +
                `In progress: what was being worked on when the log ends, and its current state.\n` +
                `Next: the next concrete step.\n` +
                `Notes: key decisions, gotchas, exact names/APIs/values the agent must not forget, and any unresolved errors.\n` +
                `Keep it under 250 words. Prefer file names, function names and exact error text over prose.\n\n` +
                (state.planLine ? `Current plan:\n${state.planLine}\n\n` : "") +
                `Session log (oldest first, long outputs shortened):\n${transcript}`,
            },
          ],
          [],
          { effortOverride: "off", maxTokens: 700 }
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
    // The tail's own reasoning is history now; the model does not need to
    // re-read its old thoughts, and Ollama would replay them.
    for (const m of tail) if (m.role === "assistant") m.thinking = undefined;

    const requestLines =
      state.currentRequest && state.currentRequest !== state.originalRequest
        ? `Original request: ${truncateEnd(state.originalRequest, 600)}\nCurrent request (what you are working on NOW): ${truncateEnd(state.currentRequest, 1000)}\n`
        : `Original request: ${truncateEnd(state.originalRequest, 1000)}\n`;

    const note =
      `[The conversation so far was compacted to save context. Continue the task from these notes — do not start over, and do not redo finished steps.]\n` +
      requestLines +
      (facts.length ? facts.join("\n") + "\n" : "") +
      (narrative ? `\nHand-over notes:\n${narrative}` : "");

    return [system, { role: "user", content: note, compactNote: true }, ...tail];
  }
}

/** Transcript rendering for the summarizer: recent messages get more room
 * than old ones (the end of the log is where the live state is), tool
 * results are shortened, reasoning traces are dropped entirely. Exported for
 * tests. */
export function renderForDigest(messages: Msg[], budgetChars: number): string {
  const n = messages.length;
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    const recent = i >= n - 12;
    const cap = m.role === "tool" ? (recent ? 700 : 200) : recent ? 1500 : 400;
    const tools = m.toolCalls
      ?.map((t) => {
        const a = { ...t.args };
        if (typeof a.content === "string") a.content = `<${a.content.length} chars>`;
        if (typeof a.new_text === "string") a.new_text = truncateEnd(a.new_text, 120);
        if (typeof a.old_text === "string") a.old_text = truncateEnd(a.old_text, 80);
        return `${t.name}(${truncateEnd(JSON.stringify(a), 200)})`;
      })
      .join(", ");
    const body = truncateEnd(m.content ?? "", cap);
    lines.push(`${m.role.toUpperCase()}: ${body}${tools ? ` [called: ${tools}]` : ""}`);
  }
  let out = lines.join("\n");
  if (out.length > budgetChars) {
    // Keep the END of the log — that is where the current state lives.
    out = "[earlier log omitted]\n" + out.slice(out.length - budgetChars);
  }
  return out;
}
