// Context budget management — the part local models actually live or die by.
//
// Fill gauge: every backend reports real prompt token usage per response; we
// anchor on that and only estimate the delta of new messages (chars-based). No
// homegrown tokenizer, works for any GGUF.
//
// Tiered compaction, cheap lever first:
//   Tier 0 (free): stale-read eviction — once a file is overwritten, every
//   earlier read of it is dead weight AND misleading. The stubs wait for the
//   next manage(): rewriting history mid-turn would force the backend to
//   re-prefill everything after the first changed message.
//   Tier 1 (free): evict old tool-result bodies and old reasoning traces —
//   files can be re-read, so this is nearly lossless and usually recovers
//   most of the window. Worked out on a copy first, so a summary that is
//   still needed sees the transcript exactly as the backend cached it.
//   Tier 2 (one model call): rebuild the transcript around a state note. The
//   harness assembles the factual part deterministically (plan, files touched,
//   commands run) and the model writes a structured progress summary with
//   thinking OFF, on the same prefix as the coding requests plus one
//   hand-over instruction (a digest prompt is the fallback).
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
import { estimateTokens, truncateEnd, truncateMiddle } from "./util";
import { abortableDelay } from "./providers/transport";
import { isHistoryPlaceholder } from "./history";
import { IMAGE_TOKENS } from "./attachments";

const MSG_OVERHEAD_TOKENS = 8;
const EVICT_KEEP_RECENT = 6; // never evict tool results in the last N messages
const EVICT_STUB = "[old output removed to save space — run the tool again if you need it]";
const STALE_READ_STUB = "[this read is out of date — the file was rewritten afterwards. Call read_file again if you need its current content.]";
const STALE_READ_MIN_CHARS = 1500; // small reads are cheaper to keep than to re-prefill around
const CALIBRATION_WINDOW = 5;
const CALIBRATION_DECAY = 0.97;
/** Below this share of the learned ratio, a report is a cache hit. */
const CACHE_HIT_RATIO = 0.75;
const OVERFLOW_STEPS = [0.85, 0.7, 0.5];
const OVERFLOW_RELAX_AFTER = 8;
/** Appended after the unchanged transcript, so the summary request shares
 * the coding request's prefix and the backend's prompt cache. */
const HANDOVER_INSTRUCTION =
  `[Harness: the conversation above is about to be cleared to save context. Do not call tools. Write hand-over notes for yourself under exactly these headings:\n` +
  `In progress: what was being worked on when the log ends, and its current state.\n` +
  `Next: the next concrete step.\n` +
  `Notes: key decisions, gotchas, exact names/APIs/values you must not forget, and any unresolved errors.\n` +
  `Keep it under 180 words. Preserve exact module exports, function signatures and required argument shapes. Do not repeat the goal, plan or file list: the harness adds those separately. Keep still-relevant decisions from earlier hand-over notes. Never treat a failed check as completed work. Reply with only the notes.]`;
const HANDOVER_RETRY = `\nYour previous reply did not follow this format. Reply in plain text with the three headings; do not call tools.`;

export interface CompactionReport {
  action: "none" | "evicted" | "compacted" | "floor";
  before: number;
  after: number;
}

export interface CompactState {
  originalRequest: string;
  currentRequest?: string;
  filesTouched: Set<string>;
  commandsRun: string[];
  planLine?: string | null;
  verificationLine?: string;
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
  private calibration = 1;
  private ratios: number[] = [];
  private overflowScale = 1;
  private cleanRequests = 0;
  /** Reads made stale by write_file, stubbed at the next manage() so the
   * cached prefix is not rewritten between compactions. By tool-call id and
   * content: a prepared compaction holds copies of the same messages. */
  private staleReads = new Map<string, string>();
  private replaysThinking = true;
  private background: { controller: AbortController; work: Promise<void> } | null = null;
  private prepared: { source: string; count: number; messages: Msg[] } | null = null;
  private preparedAt = 0;

  constructor(
    private window: number,
    private reserve: number
  ) {}

  /** Model switches mid-session change the window we budget against. */
  setWindow(window: number, reserve?: number): void {
    this.cancelBackground(true);
    this.window = window;
    this.calibration = 1;
    this.ratios = [];
    this.overflowScale = 1;
    this.cleanRequests = 0;
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
      if (m.images?.length) total += m.images.length * IMAGE_TOKENS;
      if (this.replaysThinking && m.thinking && i > thinkingFrom) total += estimateTokens(m.thinking);
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

  setReplayThinking(value: boolean): void { this.replaysThinking = value; this.resetAnchor(); }

  /** Best estimate of the next request's prompt size in tokens. */
  estimatePrompt(messages: Msg[], tools: ToolSpec[]): number {
    const charBased = Math.ceil((this.estimateMessages(messages) + this.estimateTools(tools)) * this.calibration);
    if (this.lastPromptTokens > 0 && this.anchorIndex <= messages.length) {
      const newMsgs = messages.slice(this.anchorIndex);
      const anchored =
        this.lastPromptTokens + this.lastCompletionTokens + this.estimateMessages(newMsgs);
      return Math.max(charBased, anchored);
    }
    return charBased;
  }

  usableWindow(): number {
    return Math.max(0, Math.floor((this.window - this.reserve - Math.min(256, Math.floor(this.window * 0.05))) * this.overflowScale));
  }

  /** Leave room for several related reads, their calls, and the next edit.
   * This is a character cap, deliberately much smaller than input tokens. */
  toolResultCharLimit(): number {
    return Math.min(10000, Math.max(600, Math.floor(this.usableWindow() * 0.4)));
  }

  /** Learn conservative tokenizer overhead without adding a tokenizer
   * dependency: the largest ratio among the last few responses, so one odd
   * response (an image, a template quirk) stops inflating every later budget. */
  calibrate(promptTokens: number | undefined, input: Msg[], tools: ToolSpec[]): void {
    this.noteCleanRequest();
    if (!promptTokens || !Number.isFinite(promptTokens)) return;
    const estimate = this.estimateMessages(input) + this.estimateTools(tools);
    if (estimate <= 0) return;
    const ratio = Math.min(3, promptTokens / estimate);
    // A prompt-cache hit can be reported as only the newly evaluated tokens.
    // A ratio far below the learned one is that, not a tokenizer change.
    if (ratio < this.calibration * CACHE_HIT_RATIO) return;
    this.ratios.push(ratio);
    if (this.ratios.length > CALIBRATION_WINDOW) this.ratios.shift();
    // Decay slowly instead of dropping the moment the largest ratio leaves
    // the window, so a run of small reports cannot undercut a safe budget.
    this.calibration = Math.max(1, ...this.ratios, this.calibration * CALIBRATION_DECAY);
  }

  /** The backend rejected a prompt we thought fit: budget against a smaller
   * share of the window (0.85, then 0.7, then 0.5). Returns false once there
   * is no smaller step left. */
  shrinkForOverflow(): boolean {
    this.cleanRequests = 0;
    const next = OVERFLOW_STEPS.find((s) => s < this.overflowScale);
    if (next === undefined) return false;
    this.overflowScale = next;
    return true;
  }

  /** A request the backend accepted. After OVERFLOW_RELAX_AFTER of them in a
   * row, a shrunk budget grows back one step. */
  private noteCleanRequest(): void {
    if (this.overflowScale >= 1 || ++this.cleanRequests < OVERFLOW_RELAX_AFTER) return;
    this.cleanRequests = 0;
    this.overflowScale = [...OVERFLOW_STEPS].reverse().find((s) => s > this.overflowScale) ?? 1;
  }

  get overflowShare(): number { return this.overflowScale; }

  budget(messages: Msg[], tools: ToolSpec[]) {
    const prompt = this.estimatePrompt(messages, tools);
    return { prompt, window: this.window, reserve: this.reserve, available: Math.max(0, this.usableWindow() - prompt), source: this.lastPromptTokens > 0 ? "measured + estimate" : "estimate" };
  }

  assertFits(messages: Msg[], tools: ToolSpec[]): void {
    const size = this.estimatePrompt(messages, tools);
    if (size > this.usableWindow()) {
      throw new Error(`Context budget exceeded: about ${size} input tokens, ${this.usableWindow()} available after reserving the reply. Shorten the request or AGENTS.md, use /models for a larger loaded window, or restart with --ctx. The request was not sent.`);
    }
  }

  /** Only run while a command is using the CPU/shell. Never queue behind coding. */
  prepareBackground(messages: Msg[], tools: ToolSpec[], provider: Provider, state: CompactState, delayMs = 750): void {
    if (this.background || this.prepared || messages.length < Math.max(10, this.preparedAt + 6) || this.estimatePrompt(messages, tools) < this.usableWindow() * 0.6) return;
    this.preparedAt = messages.length;
    const snapshot: Msg[] = JSON.parse(JSON.stringify(messages));
    const source = JSON.stringify(snapshot);
    const controller = new AbortController();
    const frozen = { ...state, filesTouched: new Set(state.filesTouched), commandsRun: [...state.commandsRun] };
    // Most shell checks finish faster than a local-model prefill. Give them
    // time to finish before occupying the GPU with a summary we'd immediately
    // cancel. Long installs/builds still overlap with useful compaction.
    const work = abortableDelay(delayMs, controller.signal).then(() =>
      this.compact(snapshot, snapshot, tools, provider, frozen, { signal: controller.signal, background: true })
    ).then((compacted) => {
      if (!controller.signal.aborted && this.estimatePrompt(compacted, tools) < this.estimatePrompt(snapshot, tools)) {
        this.prepared = { source, count: snapshot.length, messages: compacted };
      }
    }).catch(() => {}).finally(() => { if (this.background?.controller === controller) this.background = null; });
    this.background = { controller, work };
  }

  cancelBackground(discard = false): void {
    this.background?.controller.abort();
    if (discard) { this.prepared = null; this.preparedAt = 0; }
  }

  async foreground(): Promise<void> {
    const job = this.background;
    this.cancelBackground();
    if (job) await job.work;
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
    return !this.floorWarned || this.estimatePrompt(messages, tools) > this.usableWindow();
  }

  /** Earlier read_file results for this path that a write just made wrong. */
  private staleReadsOf(messages: Msg[], filePath: string, end = messages.length - 1): Msg[] {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
    const target = norm(filePath);
    const found: Msg[] = [];
    // Skip the most recent message: it is the write's own result.
    for (let i = 1; i < end; i++) {
      const m = messages[i];
      if (m.role !== "tool" || m.evicted || m.content.length < STALE_READ_MIN_CHARS) continue;
      const call = callFor(messages, i);
      if (!call || call.name !== "read_file") continue;
      if (norm(String(call.args?.path ?? "")) !== target) continue;
      found.push(m);
    }
    return found;
  }

  /**
   * Tier 0: a file was just completely rewritten — every earlier read_file
   * result for that path is now wrong. Replace the big ones with a stub so
   * they neither cost context nor mislead the next edit. Returns how many
   * results were stubbed. Rewrites the transcript mid-history: the agent
   * uses noteStaleReads instead, which waits for the next manage().
   */
  evictStaleReads(messages: Msg[], filePath: string): number {
    const stale = this.staleReadsOf(messages, filePath);
    for (const m of stale) { m.content = STALE_READ_STUB; m.evicted = true; }
    if (stale.length) {
      // The transcript shrank behind the usage anchor.
      this.anchorIndex = 0;
      this.lastPromptTokens = 0;
    }
    return stale.length;
  }

  /** Remember the reads a write_file made stale; they are stubbed together
   * with the other evictions the next time manage() rewrites history, so the
   * prefix the backend has cached stays byte-identical until then. Call it
   * before the write's own result is appended. */
  noteStaleReads(messages: Msg[], filePath: string): number {
    const stale = this.staleReadsOf(messages, filePath, messages.length);
    for (const m of stale) this.staleReads.set(m.toolCallId!, m.content);
    return stale.length;
  }

  /** The reads waiting to be stubbed, for /undo to put back. */
  pendingStaleReads(): [string, string][] {
    return [...this.staleReads];
  }

  restorePendingStaleReads(entries: [string, string][]): void {
    this.staleReads = new Map(entries);
  }

  /** Char-based estimate after a rewrite (the usage anchor no longer applies). */
  private rewrittenEstimate(messages: Msg[], tools: ToolSpec[]): number {
    return Math.ceil((this.estimateMessages(messages) + this.estimateTools(tools)) * this.calibration);
  }

  /**
   * The free tiers, applied to `messages` in place: pending stale reads, old
   * reasoning, completed write payloads, old tool-result bodies. Deterministic,
   * so a trial on a copy predicts exactly what it does to the original.
   * `stale` holds the indices of pending stale reads. Returns whether anything
   * changed.
   */
  private evict(messages: Msg[], tools: ToolSpec[], stale: Set<number>): boolean {
    let changed = false;
    for (const i of stale) {
      const m = messages[i];
      if (m && m.role === "tool" && !m.evicted) { m.content = STALE_READ_STUB; m.evicted = true; changed = true; }
    }

    // Older reasoning is cheaper to drop than fresh source code. Preserve the
    // newest assistant group's reasoning; tool calls/results remain intact.
    let thinkingFrom = messages.length;
    for (let i = messages.length - 1; i >= 1; i--) {
      if (messages[i].role === "assistant") { thinkingFrom = i; break; }
    }
    for (let i = 1; i < thinkingFrom; i++) {
      if (messages[i].role === "assistant" && messages[i].thinking) {
        messages[i].thinking = undefined;
        changed = true;
      }
    }

    // Completed writes are already on disk. Old request bodies can be much
    // larger than tool results, and used to force a summary after every file.
    // Replace completed calls with marked historical data, never synthetic
    // executable arguments or assistant answers: small models imitate both.
    // Keep the newest group intact and never remove an unexecuted/failed call.
    let latestGroup = messages.length;
    for (let i = messages.length - 1; i >= 1; i--) {
      if (messages[i].role === "assistant" && messages[i].toolCalls?.length) { latestGroup = i; break; }
    }
    for (let i = latestGroup - 1; i >= 1; i--) {
      const message = messages[i];
      if (!message.toolCalls) continue;
      const results: Msg[] = [];
      for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) results.push(messages[j]);
      const removed = new Set<string>();
      const receipts: string[] = [];
      for (const call of message.toolCalls) {
        const receipt = results.find((m) => m.toolCallId === call.id);
        if (!receipt || !/^(Created|Overwrote|Edited) /.test(receipt.content)) continue;
        const keys = call.name === "write_file" ? ["content"] : call.name === "edit_file" ? ["old_text", "new_text"] : [];
        if (!keys.some((key) => typeof call.args[key] === "string" &&
          (call.args[key].length > 1200 || isHistoryPlaceholder(call.args[key])))) continue;
        removed.add(call.id);
        receipts.push(`${call.name}: ${truncateEnd(receipt.content, 600)}`);
      }
      if (!removed.size) continue;
      const remainingCalls = message.toolCalls.filter((call) => !removed.has(call.id));
      const retained: Msg[] = remainingCalls.length
        ? [{ ...message, toolCalls: remainingCalls }, ...results.filter((result) => !removed.has(result.toolCallId!))]
        : message.content ? [{ role: "assistant", content: message.content }] : [];
      messages.splice(i, results.length + 1, ...retained, {
        role: "user", historyNote: true,
        content: `[Harness history record — earlier tool executions, not a new request. Applied code omitted; read_file returns current source. Future changes require actual tool calls.]\n${receipts.join("\n")}`,
      });
      changed = true;
    }

    // Tier 1b: evict old tool-result bodies, oldest first.
    const evictBoundary = Math.max(1, messages.length - EVICT_KEEP_RECENT);
    for (let i = 1; i < evictBoundary; i++) {
      const m = messages[i];
      if (m.role === "tool" && !m.evicted && m.content.length > 200) {
        m.content = EVICT_STUB;
        m.evicted = true;
        changed = true;
        if (this.rewrittenEstimate(messages, tools) <= 0.6 * this.usableWindow()) break;
      }
    }
    return changed;
  }

  /**
   * Bring the transcript back under budget. Mutates and/or replaces `messages`;
   * returns the (possibly new) array plus a report for the UI.
   */
  async manage(
    messages: Msg[],
    tools: ToolSpec[],
    provider: Provider,
    state: CompactState,
    opts: { force?: boolean; signal?: AbortSignal; deterministic?: boolean } = {}
  ): Promise<{ messages: Msg[]; report: CompactionReport }> {
    const before = this.estimatePrompt(messages, tools);
    if (!opts.force && before <= 0.8 * this.usableWindow()) {
      return { messages, report: { action: "none", before, after: before } };
    }
    const staleIndices = (list: Msg[]) => {
      const found = new Set<number>();
      list.forEach((m, i) => {
        if (m.role === "tool" && m.toolCallId !== undefined && this.staleReads.get(m.toolCallId) === m.content) found.add(i);
      });
      return found;
    };

    if (this.prepared) {
      const ready = this.prepared;
      this.prepared = null;
      if (JSON.stringify(messages.slice(0, ready.count)) === ready.source) {
        const candidate = [...ready.messages, ...messages.slice(ready.count)];
        for (const i of staleIndices(candidate)) { candidate[i].content = STALE_READ_STUB; candidate[i].evicted = true; }
        const after = this.rewrittenEstimate(candidate, tools);
        if (after < before && after <= this.usableWindow() * 0.8) {
          this.staleReads.clear();
          this.resetAnchor();
          return { messages: candidate, report: { action: "compacted", before, after } };
        }
      }
    }

    // Work the free tiers out on a copy first. When they are not enough, the
    // summary request must see the transcript exactly as the backend last
    // processed it, so its cached prefix is reused instead of re-prefilled.
    const trial: Msg[] = JSON.parse(JSON.stringify(messages));
    this.evict(trial, tools, staleIndices(messages));
    const trialAfter = this.rewrittenEstimate(trial, tools);
    if (!opts.force && trialAfter <= 0.8 * this.usableWindow()) {
      if (this.evict(messages, tools, staleIndices(messages))) this.resetAnchor();
      this.staleReads.clear();
      return { messages, report: { action: "evicted", before, after: this.estimatePrompt(messages, tools) } };
    }

    // Tier 2: full compaction around a state note. The summary reads the
    // untouched transcript; the rebuilt one keeps an evicted tail.
    const source = [...messages];
    const working = messages;
    const compacted = await this.compact(source, working, tools, provider, state, opts, () => {
      this.evict(working, tools, staleIndices(working));
      this.staleReads.clear();
    });
    this.resetAnchor();
    let after = this.estimatePrompt(compacted, tools);
    // Evict whole assistant/tool groups when the protected tail itself is too
    // large. Never leave orphan tool results or silently trim the live request.
    // 80% is a soft trigger, not permission to erase the data just requested.
    // Keep the latest complete result if it fits the hard input budget. Losing
    // it here causes read -> compact -> reread loops on small windows.
    while (after > this.usableWindow() && compacted.length > 2) {
      let end = 3;
      if (compacted[2].role === "assistant" && compacted[2].toolCalls?.length) {
        while (end < compacted.length && compacted[end].role === "tool") end++;
      }
      compacted.splice(2, end - 2);
      after = this.estimatePrompt(compacted, tools);
    }
    if (after > 0.8 * this.usableWindow()) {
      // Irreducible floor: the window simply cannot hold what must stay
      // (system prompt + AGENTS.md + tool schemas + the working tail).
      // Stop repeated futile summaries; assertFits still guards every request.
      this.floorWarned = true;
      return { messages: compacted, report: { action: "floor", before, after } };
    }
    return { messages: compacted, report: { action: "compacted", before, after } };
  }

  /**
   * Summary on the SAME prefix as the coding requests (same system prompt,
   * same tools, the unmodified messages) plus one hand-over instruction, so
   * the backend reuses its cache instead of prefilling a digest. null when it
   * cannot be used: the transcript does not fit as-is, or the model twice
   * answered with a tool call or without the headings.
   */
  private async samePrefixSummary(
    source: Msg[],
    tools: ToolSpec[],
    provider: Provider,
    opts: { signal?: AbortSignal; background?: boolean }
  ): Promise<string | null> {
    const instructionTokens = estimateTokens(HANDOVER_INSTRUCTION + HANDOVER_RETRY) + MSG_OVERHEAD_TOKENS;
    if (this.estimatePrompt(source, tools) + instructionTokens > this.usableWindow()) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await provider.chat(
        // Flagged so providers keep this turn's reasoning exactly as the
        // coding request sent it: the instruction is not a new user turn.
        [...source, { role: "user", content: HANDOVER_INSTRUCTION + (attempt ? HANDOVER_RETRY : ""), harnessNote: true }],
        tools,
        { effortOverride: "off", maxTokens: Math.min(700, this.reserve), signal: opts.signal, timeoutMs: 45_000, background: opts.background }
      );
      const text = res.content.trim();
      // A cut-off or empty reply would only repeat on the same prefix: go
      // straight to the digest.
      if (res.truncated || (!text && !res.toolCalls.length)) return null;
      if (!res.toolCalls.length && /in progress\s*:/i.test(text) && /next\s*:/i.test(text)) return text;
    }
    return null;
  }

  /** The digest summary: a separate small prompt with a rendered log. A full
   * prefill, so only the fallback (and the path when the transcript itself
   * no longer fits). */
  private async digestSummary(
    messages: Msg[],
    allMessages: Msg[],
    provider: Provider,
    state: CompactState,
    digestBudgetChars: number,
    opts: { signal?: AbortSignal; background?: boolean }
  ): Promise<string> {
    // Prior notes contain decisions that may exist nowhere else now.
    const previous = allMessages.filter((m) => m.compactNote).map((m) => m.content.split("Hand-over notes:\n")[1] ?? m.content).join("\n");
    const transcript = renderForDigest(messages.slice(1), Math.max(0, digestBudgetChars - Math.min(previous.length, 2400)));
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
            `In progress: what was being worked on when the log ends, and its current state.\n` +
            `Next: the next concrete step.\n` +
            `Notes: key decisions, gotchas, exact names/APIs/values the agent must not forget, and any unresolved errors.\n` +
            `Keep it under 180 words. Preserve exact module exports, function signatures and required argument shapes. Do not repeat the goal, plan or file list: the harness adds those separately. Never treat a failed check as completed work.\n\n` +
            (state.planLine ? `Current plan:\n${truncateEnd(state.planLine, 1600)}\n\n` : "") +
            (previous ? `Previous hand-over (retain still-relevant decisions):\n${truncateEnd(previous, 2400)}\n\n` : "") +
            `Session log (oldest first, long outputs shortened):\n${transcript}`,
        },
      ],
      [],
      { effortOverride: "off", maxTokens: Math.min(700, this.reserve), signal: opts.signal, timeoutMs: 45_000, background: opts.background }
    );
    return res.truncated ? "" : res.content.trim();
  }

  /**
   * Rebuild the transcript around a state note. `source` is the transcript as
   * last sent (the summary request reuses it); `working` is the one the new
   * transcript's tail is cut from, after `prepare` (the free tiers) ran on it.
   */
  private async compact(
    source: Msg[],
    working: Msg[],
    tools: ToolSpec[],
    provider: Provider,
    state: CompactState,
    opts: { signal?: AbortSignal; deterministic?: boolean; background?: boolean } = {},
    prepare?: () => void
  ): Promise<Msg[]> {
    // Deterministic part of the state note — the harness knows these facts.
    // The plan goes first: it is the model's map of the task.
    const facts: string[] = [];
    if (state.planLine) facts.push(state.planLine);
    if (state.filesTouched.size) {
      facts.push(`Files created/modified so far: ${[...state.filesTouched].slice(-30).join(", ")}`);
    }
    if (state.commandsRun.length) {
      // Keep recent outcomes, not entire inline scripts or the oldest command
      // swallowing the facts budget. Middle truncation preserves the exit code.
      facts.push(`Recent commands: ${state.commandsRun.slice(-6).map((s) => truncateMiddle(s.replace(/\s+/g, " "), 180)).join("; ")}`);
    }

    // Model-written progress summary — structured, thinking off, short cap.
    // Skipped entirely on very small windows: the summarize call itself must
    // fit. If the call fails, facts alone carry the note.
    let narrative = "";
    const narrativeCap = Math.min(2800, Math.max(600, Math.floor(this.usableWindow() * 0.3)));
    const digestBudgetChars = Math.min(60000, Math.max(0, (this.usableWindow() / this.calibration - 1500) * 3));
    if (!opts.deterministic && digestBudgetChars >= 3000) {
      try {
        let text = await this.samePrefixSummary(source, tools, provider, opts);
        if (text === null) {
          prepare?.();
          prepare = undefined;
          const stripped = [working[0], ...working.slice(1).filter((m) => !m.compactNote)];
          text = await this.digestSummary(stripped, working, provider, state, digestBudgetChars, opts);
        }
        narrative = truncateEnd(text, narrativeCap);
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (opts.background) throw err;
        narrative = "";
      }
    }
    prepare?.();
    if (!narrative) {
      narrative = truncateEnd(source.filter((m) => m.compactNote).map((m) => m.content.split("Hand-over notes:\n")[1] ?? "").join("\n"), narrativeCap);
    }

    const system = working[0];
    // Strip prior compaction notes — their content is regenerated fresh below.
    // Without this, notes accrete (each new note keeps the old one in its
    // tail) and compaction stops shrinking the transcript at all.
    const messages = [system, ...working.slice(1).filter((m) => !m.compactNote)];

    // Keep a clean tail. Preferred cut: the most recent plain user message.
    // Mid-turn there often is none nearby — then keep the last COMPLETE
    // assistant-toolcall + tool-results group instead of dropping everything,
    // so the model retains the material it just fetched for its next action.
    let keepFrom = messages.length;
    for (let i = messages.length - 1; i >= Math.max(1, messages.length - 8); i--) {
      if (messages[i].role === "user" && !messages[i].compactNote && !messages[i].historyNote) { keepFrom = i; break; }
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
        ? `Original request: ${state.originalRequest}\nCurrent request (what you are working on NOW): ${state.currentRequest}\n`
        : `Original request: ${state.originalRequest}\n`;

    const note =
      `[The conversation so far was compacted to save context. Continue the task from these notes — do not start over, and do not redo finished steps.]\n` +
      requestLines +
      (state.verificationLine ? state.verificationLine + "\n" : "") +
      (facts.length ? truncateEnd(facts.join("\n"), 2400) + "\n" : "") +
      (narrative ? `\n[Model-written summary; file contents and tool results take precedence.]\nHand-over notes:\n${narrative}` : "");

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
