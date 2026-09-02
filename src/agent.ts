// The agent loop: one tool call at a time, tool results fed back, until the
// model answers in plain text. Parallel tool calls are not requested; if a
// model emits several anyway, they simply run sequentially. Malformed calls
// come back as coaching errors so the model can retry instead of derailing.

import { ContextManager } from "./context";
import { EventBus } from "./events";
import { ChatResult, Msg, Provider, ToolSpec } from "./providers/types";
import {
  buildToolSpecs,
  executeTool,
  Mode,
  MODE_LABELS,
  commandOf,
  ToolContext,
} from "./tools/index";
import { AgentUI } from "./ui";
import { c, fmtDuration } from "./util";
import { commandEscapesWorkspace } from "./sandbox";

const TRANSIENT_ERROR = /fetch failed|econn|socket|network|timed?.?out|50[0234]/i;

/** Shell metacharacters that let one "allowed program" smuggle in others.
 * Auto-approval via always-allow only applies to commands without them. */
const SHELL_META = /[;&|`$<>(){}\n\r\\]/;

/** Exported for tests: does the always-allow set cover this exact command?
 * First-token match alone is bypassable (`npm -v; evil`) because commands run
 * under a real shell — so chained/piped/substituted commands always re-prompt. */
export function isAutoApproved(command: string, allowed: Set<string>): boolean {
  const trimmed = command.trim();
  let program = trimmed.split(/\s+/)[0] ?? "";
  if (process.platform === "win32") program = program.toLowerCase();
  return allowed.has(program) && !SHELL_META.test(trimmed);
}

export class Agent {
  messages: Msg[] = [];
  tools: ToolSpec[];
  private alwaysAllowed = new Set<string>();
  originalRequest = "";
  currentRequest = "";
  private planNudged = false;
  private abort: AbortController | null = null;
  /** Speed/size figures for the last completed turn (for the turn-end label
   * and headless stats). */
  lastTurnStats: TurnStats | null = null;

  constructor(
    public provider: Provider,
    public mode: Mode,
    private systemPrompt: string,
    private toolCtx: ToolContext,
    private ctxMgr: ContextManager,
    private bus: EventBus,
    private ui: AgentUI,
    private interactive: boolean,
    /** Tool-call budget per user turn. Headless runs get a much larger one. */
    private maxSteps = 30
  ) {
    this.messages = [{ role: "system", content: systemPrompt }];
    this.tools = buildToolSpecs(mode);
  }

  setMode(mode: Mode, systemPrompt: string): void {
    this.mode = mode;
    this.tools = buildToolSpecs(mode);
    this.messages[0] = { role: "system", content: systemPrompt };
  }

  setProvider(provider: Provider): void {
    this.provider = provider;
  }

  resetTranscript(): void {
    this.messages = [this.messages[0]];
    this.originalRequest = "";
    this.currentRequest = "";
    this.planNudged = false;
    // Session facts feed the compaction state note — stale ones from a
    // cleared conversation would assert work the new task never did.
    this.toolCtx.filesTouched.clear();
    this.toolCtx.commandsRun.length = 0;
    this.ctxMgr.resetAnchor();
  }

  /** Resume a saved session: the transcript (without its system message) and
   * the two requests the compaction note is built around. */
  restoreTranscript(messages: Msg[], originalRequest: string, currentRequest: string): void {
    this.messages = [this.messages[0], ...messages];
    this.originalRequest = originalRequest;
    this.currentRequest = currentRequest;
    this.planNudged = false;
    this.ctxMgr.resetAnchor();
  }

  cancel(): void {
    this.abort?.abort();
  }

  contextPercent(): number {
    return this.ctxMgr.fillPercent(this.messages, this.tools);
  }

  contextTokens(): number {
    return this.ctxMgr.estimatePrompt(this.messages, this.tools);
  }

  async compactNow(): Promise<void> {
    await this.bus.emit("pre_compact");
    const { messages, report } = await this.ctxMgr.manage(
      this.messages,
      this.tools,
      this.provider,
      {
        originalRequest: this.originalRequest,
        currentRequest: this.currentRequest,
        filesTouched: this.toolCtx.filesTouched,
        commandsRun: this.toolCtx.commandsRun,
        planLine: this.toolCtx.plan.compactLine(),
      }
    );
    this.messages = messages;
    await this.bus.emit("post_compact", report);
  }

  async runTurn(userInput: string): Promise<void> {
    if (!this.originalRequest) this.originalRequest = userInput;
    this.currentRequest = userInput; // the task compaction must never lose
    this.messages.push({ role: "user", content: userInput });
    this.abort = new AbortController();
    const signal = this.abort.signal;

    const t0 = Date.now();
    let completed = false;
    let steps = 0;
    let nudges = 0;
    let toolCallsThisTurn = 0;
    let sincePlanUpdate = 0;
    const stats: TurnStats = {
      modelCalls: 0,
      toolCalls: 0,
      generatedTokens: 0,
      genSeconds: 0,
      thinkingChars: 0,
      promptTokensLast: 0,
      durationMs: 0,
    };
    this.lastTurnStats = stats;
    try {
      while (steps++ < this.maxSteps) {
        // Context management before every request.
        await this.bus.emit("pre_request");
        if (this.ctxMgr.needsAttention(this.messages, this.tools)) {
          this.ui.status("· context is getting full — compacting…");
          await this.compactNow();
        }

        this.ui.startSpinner("thinking");
        let result: ChatResult;
        try {
          result = await this.chatWithRetry(signal);
        } finally {
          this.ui.stopSpinner();
        }
        this.messages.push({
          role: "assistant",
          content: result.content,
          toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
          thinking: result.thinking,
        });
        // Anchor AFTER the push: lastPromptTokens+lastCompletionTokens then
        // cover exactly the first `messages.length` messages — recording
        // before the push double-counted the reply in every estimate.
        this.ctxMgr.recordUsage(
          result.promptTokens,
          result.completionTokens,
          this.messages.length
        );
        stats.modelCalls++;
        if (result.generatedTokens) {
          stats.generatedTokens += result.generatedTokens;
          if (result.genTokPerSec) stats.genSeconds += result.generatedTokens / result.genTokPerSec;
        }
        if (result.promptTokens) stats.promptTokensLast = result.promptTokens;
        if (result.thinking) stats.thinkingChars += result.thinking.length;
        if (result.content) this.ui.println(); // end the streamed line

        if (result.toolCalls.length === 0) {
          // A reply cut off by the output cap, or an empty reply, is not a
          // finished turn — that is how local-model sessions die silently.
          // Nudge the model back on track (bounded).
          if (result.truncated && nudges < 3) {
            nudges++;
            this.ui.status("· reply hit the output limit — asking the model to continue");
            // Reasoning models can burn the ENTIRE budget thinking, arriving
            // with no visible output at all — "continue where you left off"
            // would just restart the same doomed think. Target that case.
            // With thinking off, an empty truncated reply is almost always a
            // tool call whose arguments (a whole file) overflowed the cap — it
            // was never parsed, so nothing was saved and "continue" cannot
            // work. Name the cap and coach the split explicitly.
            const noContent = !result.content.trim();
            const burnedByThinking = noContent && !!result.thinking?.trim();
            const nudgeText = burnedByThinking
              ? `[Your reasoning used the entire output limit (${this.provider.maxOutputTokens} tokens) and produced no answer. Do not re-derive everything — reply now with your next tool call or a brief answer.]`
              : noContent
                ? `[${this.truncatedCallHint()}]`
                : `[Your reply was cut off by the output length limit of ${this.provider.maxOutputTokens} tokens. Continue where you left off. If a file was too large for one write_file call, split the content into separate files — writing the same path again replaces it completely.]`;
            this.messages.push({ role: "user", content: nudgeText });
            continue;
          }
          if (!result.content.trim() && nudges < 2) {
            nudges++;
            this.ui.status("· empty reply — nudging the model");
            this.messages.push({
              role: "user",
              content:
                "[Your reply was empty. If the task is finished, summarize what you did. Otherwise make the next tool call now.]",
            });
            continue;
          }
          // The model wants to stop but its own plan still has open steps —
          // the classic local-model quit-halfway. One bounded push back.
          // One nudge PER PLAN STATE, not per turn: an abandoned plan must not
          // drag every later unrelated question back to stale work. The flag
          // re-arms only when the plan actually changes (set/done/add).
          const plan = this.toolCtx.plan;
          if (plan.exists && plan.currentIndex >= 0 && toolCallsThisTurn > 0 && !this.planNudged) {
            this.planNudged = true;
            this.ui.status("· plan has unfinished steps — nudging the model to continue");
            this.messages.push({
              role: "user",
              content: `[Your plan still has unfinished steps: ${plan.pendingSummary()}. Continue with the next step now — or if a step no longer applies, mark it done with the plan tool and explain why.]`,
            });
            continue;
          }
          completed = true;
          return; // plain answer — turn over
        }
        nudges = 0;

        for (const call of result.toolCalls) {
          if (signal.aborted) throw abortError();
          this.ui.toolCall(
            call.name,
            call.parseError ? { __raw: (call.rawArgs ?? "").slice(0, 80) } : call.args
          );

          let output: string;
          if (call.parseError) {
            // LM Studio streams the partial arguments of a cut-off call, so
            // the overflow surfaces here as unparseable JSON.
            output = result.truncated
              ? `Error: ${this.truncatedCallHint()}`
              : `Error: your tool call arguments could not be parsed (${call.parseError}). Send the arguments as a single JSON object, e.g. {"path": "src/app.js"}.`;
          } else if (!this.tools.some((t) => t.name === call.name)) {
            // HARD mode enforcement. The schemas sent to the model are only
            // advisory — a hallucinated or injected write_file/run_command in
            // read-only mode must be rejected here, at execution time.
            output = `Error: the tool "${call.name}" is not available in ${MODE_LABELS[this.mode]} mode. Available tools: ${this.tools.map((t) => t.name).join(", ")}.`;
          } else {
            output = await this.gateAndExecute(call.name, call.args, signal);
            toolCallsThisTurn++;
            stats.toolCalls++;
            // Tier-0 context hygiene: a full overwrite makes every earlier
            // read of that file wrong. Stub them out right away.
            if (call.name === "write_file" && !output.startsWith("Error") && typeof call.args?.path === "string") {
              this.ctxMgr.evictStaleReads(this.messages, call.args.path);
            }
            // Keep the plan honest: small models forget to mark steps done
            // mid-flow, leaving the checklist stale for minutes. A periodic
            // one-line reminder riding on a tool result fixes it cheaply.
            const plan = this.toolCtx.plan;
            if (call.name === "plan") {
              sincePlanUpdate = 0;
              if (!output.startsWith("Error")) this.planNudged = false; // plan changed — re-arm
            } else if (plan.exists && plan.currentIndex >= 0 && ++sincePlanUpdate >= 4) {
              sincePlanUpdate = 0;
              const cur = plan.steps[plan.currentIndex];
              output += `\n[Reminder: the plan still shows step ${plan.currentIndex + 1} "${cur.text}" as current. If you have finished steps, mark each with plan {"action": "done"} now.]`;
            }
          }

          // Plan changes render as the visual checklist instead of a ✓ line.
          if (
            call.name === "plan" &&
            !output.startsWith("Error") &&
            ["set", "done", "add"].includes(String(call.args?.action))
          ) {
            this.ui.planUpdated(this.toolCtx.plan);
          } else {
            this.ui.toolResult(output);
          }
          this.messages.push({
            role: "tool",
            content: output,
            toolCallId: call.id,
            toolName: call.name,
          });
          await this.bus.emit("post_tool", { name: call.name, args: call.args });
          // A cancel during tool execution ends the turn now, with the
          // (cancelled) result already recorded so the transcript stays valid.
          if (signal.aborted) throw abortError();
        }
      }
      this.ui.warn(
        `Stopped after ${this.maxSteps} tool calls in one turn. Say "continue" to keep going.`
      );
      completed = true;
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) {
        this.ui.println();
        this.ui.status("· cancelled");
        this.sanitizeAfterCancel();
        return;
      }
      throw err;
    } finally {
      this.abort = null;
      stats.durationMs = Date.now() - t0;
      if (completed) {
        this.ui.turnEnd(
          `${MODE_LABELS[this.mode]} · ${this.provider.modelId} · ${fmtDuration(stats.durationMs)}${describeStats(stats)}`
        );
      }
    }
  }

  /** Coaching for a tool call that overflowed the output cap. Exported via
   * the class for tests. */
  truncatedCallHint(): string {
    const cap = this.provider.maxOutputTokens;
    const part = Math.max(300, Math.floor(cap * 0.5));
    return (
      `Your tool call was cut off by the output limit of ${cap} tokens, so it was NOT executed and nothing was saved. ` +
      `Send smaller calls: write the file in parts of at most ~${part} tokens — write_file with the first part, ` +
      `then edit_file to append each next part (old_text = the last line you wrote, new_text = that line followed by the next part) — ` +
      `or split the code across several smaller files.`
    );
  }

  /** One model call, with bounded retries on transient backend failures
   * (Ollama/LM Studio hiccups, dropped sockets, 5xx). The transcript is
   * unchanged between attempts, so a retry is always safe. */
  private async chatWithRetry(signal: AbortSignal): Promise<ChatResult> {
    let lastErr: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.provider.chat(this.messages, this.tools, {
          signal,
          onToken: (t) => this.ui.token(t),
          onThinking: (t) => this.ui.thinking(t),
        });
      } catch (err: any) {
        if (err?.name === "AbortError" || signal.aborted) throw err;
        lastErr = err;
        if (attempt === 3 || !TRANSIENT_ERROR.test(String(err?.message ?? err))) throw err;
        this.ui.warn(`· backend error (${String(err?.message ?? err).slice(0, 80)}) — retrying in ${attempt * 3}s`);
        await new Promise((r) => setTimeout(r, attempt * 3000));
      }
    }
    throw lastErr;
  }

  private async gateAndExecute(
    name: string,
    args: Record<string, any>,
    signal?: AbortSignal
  ): Promise<string> {
    const command = commandOf(name, args);
    // Gate everywhere except bypass (defense-in-depth: in ro mode exec tools are
    // already rejected before this point by the tool-existence check). Edit
    // mode runs commands that stay inside the workspace without asking and
    // only prompts for ones that reach outside it.
    if (command !== null && this.mode !== "bypass") {
      const reason = commandEscapesWorkspace(command, this.toolCtx.workspace);
      if (reason !== null && !isAutoApproved(command, this.alwaysAllowed)) {
        if (!this.interactive) {
          return `Error: this command ${reason}, which needs user approval, and this session is non-interactive. Keep every path inside the workspace (relative paths, a scratch folder in the workspace instead of /tmp), or the user can rerun smol with --mode bypass, or run this themselves: ${command}`;
        }
        const answer = await this.ui.confirmCommand(command, reason);
        if (answer === "no") {
          return "The user declined to run this command. Continue without it, or ask the user what to do instead.";
        }
        if (answer === "always") {
          let program = command.trim().split(/\s+/)[0] ?? "";
          if (process.platform === "win32") program = program.toLowerCase();
          if (program) this.alwaysAllowed.add(program);
        }
      }
    }
    return executeTool(name, args, this.toolCtx, signal);
  }

  /**
   * After a cancel, the most recent assistant tool-call message may have some
   * calls unanswered — strict backends reject that shape on the next request.
   * A cancel mid-way through a MULTI-call batch buries that assistant message
   * behind the already-pushed tool results, so walk back past them.
   */
  private sanitizeAfterCancel(): void {
    let i = this.messages.length - 1;
    while (i >= 0 && this.messages[i].role === "tool") i--;
    const anchor = this.messages[i];
    if (anchor?.role === "assistant" && anchor.toolCalls?.length) {
      for (const tc of anchor.toolCalls) {
        const answered = this.messages.some(
          (m) => m.role === "tool" && m.toolCallId === tc.id
        );
        if (!answered) {
          this.messages.push({
            role: "tool",
            content: "[cancelled by the user before this tool ran]",
            toolCallId: tc.id,
            toolName: tc.name,
          });
        }
      }
    }
  }

  statusLine(): string {
    const pct = this.contextPercent();
    const tasks = this.toolCtx.taskManager.runningSummary();
    const taskPart = tasks.length ? ` · ${tasks.length} bg task${tasks.length > 1 ? "s" : ""}` : "";
    return c.gray(
      `ctx ${pct}% of ${this.provider.contextWindow.toLocaleString()} · ${this.provider.label} · ${this.mode}${taskPart}`
    );
  }
}

export interface TurnStats {
  modelCalls: number;
  toolCalls: number;
  /** All tokens the model produced this turn, reasoning included. */
  generatedTokens: number;
  /** Seconds spent generating (from backend timings or stream wall-clock). */
  genSeconds: number;
  /** Characters of reasoning streamed this turn (~4 chars per token). */
  thinkingChars: number;
  /** Prompt size of the last request — where the context sits now. */
  promptTokensLast: number;
  durationMs: number;
}

/** " · 12 tools · 4.1k tok @ 118 tok/s" — the speed readout local-model users
 * actually want to compare backends with. */
export function describeStats(s: TurnStats): string {
  const parts: string[] = [];
  if (s.toolCalls) parts.push(`${s.toolCalls} tool${s.toolCalls === 1 ? "" : "s"}`);
  if (s.generatedTokens) {
    const k = s.generatedTokens >= 1000 ? `${(s.generatedTokens / 1000).toFixed(1)}k` : String(s.generatedTokens);
    const rate = s.genSeconds > 0 ? ` @ ${Math.round(s.generatedTokens / s.genSeconds)} tok/s` : "";
    parts.push(`${k} tok${rate}`);
  }
  return parts.length ? " · " + parts.join(" · ") : "";
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
