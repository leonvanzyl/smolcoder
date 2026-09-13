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
import { abortableDelay } from "./providers/transport";
import { truncateMiddle } from "./util";
import { createHash } from "crypto";
import { runCommand } from "./tools/shell";
import { failureSignature, projectVerification } from "./verification";

/** Supplied by the caller, never generated or changed by a model tool. */
export interface Verification {
  command: string;
  maxAttempts?: number;
  source?: "project";
}

const TRANSIENT_ERROR = /fetch failed|econn|socket|network|timed?.?out|429|50[0-4]|stream ended|malformed JSON|stream error/i;
const CONTEXT_ERROR = /context.{0,50}(exceed|overflow|full|length)|too (many|long).{0,30}tokens|prompt.{0,30}(too long|exceed)/i;

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
  outcome: "idle" | "running" | "completed" | "cancelled" | "error" = "idle";
  lastError: string | null = null;
  verificationResult: { attempts: number; passed: boolean; output: string } | null = null;
  private verification?: Verification;
  private progressFailure = "";
  private sameVerificationFailures = 0;
  private canRefreshVerification = false;

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
    private maxSteps = 30,
    private callerVerification?: Verification
  ) {
    this.verification = callerVerification;
    if (callerVerification && (!callerVerification.command.trim() || (callerVerification.maxAttempts !== undefined && (!Number.isSafeInteger(callerVerification.maxAttempts) || callerVerification.maxAttempts < 1)))) throw new Error("Verification needs a command and a positive attempt limit.");
    this.messages = [{ role: "system", content: systemPrompt }];
    this.tools = buildToolSpecs(mode);
    this.ctxMgr.setReplayThinking(provider.replaysThinking !== false);
  }

  setMode(mode: Mode, systemPrompt: string): void {
    this.ctxMgr.cancelBackground(true);
    this.ctxMgr.resetAnchor();
    this.mode = mode;
    this.tools = buildToolSpecs(mode);
    this.messages[0] = { role: "system", content: systemPrompt };
  }

  setProvider(provider: Provider): void {
    this.ctxMgr.cancelBackground(true);
    this.provider = provider;
    this.ctxMgr.setReplayThinking(provider.replaysThinking !== false);
  }

  resetTranscript(): void {
    this.ctxMgr.cancelBackground(true);
    this.messages = [this.messages[0]];
    this.originalRequest = "";
    this.currentRequest = "";
    this.planNudged = false;
    this.outcome = "idle";
    this.lastError = null;
    this.verificationResult = null;
    this.verification = this.callerVerification;
    this.progressFailure = "";
    this.sameVerificationFailures = 0;
    // Session facts feed the compaction state note — stale ones from a
    // cleared conversation would assert work the new task never did.
    this.toolCtx.filesTouched.clear();
    this.toolCtx.commandsRun.length = 0;
    this.ctxMgr.resetAnchor();
  }

  /** Resume a saved session: the transcript (without its system message) and
   * the two requests the compaction note is built around. */
  restoreTranscript(messages: Msg[], originalRequest: string, currentRequest: string): void {
    this.ctxMgr.cancelBackground(true);
    this.messages = [this.messages[0], ...messages];
    this.originalRequest = originalRequest;
    this.currentRequest = currentRequest;
    this.planNudged = false;
    this.ctxMgr.resetAnchor();
    this.repairTranscript("[Tool execution was interrupted by a restart. Its outcome is unknown. Inspect files or command state before retrying; do not assume it failed or rerun it blindly.]");
  }

  cancel(): void {
    this.abort?.abort();
    this.ctxMgr.cancelBackground(true);
  }

  contextPercent(): number {
    return this.ctxMgr.fillPercent(this.messages, this.tools);
  }

  contextTokens(): number {
    return this.ctxMgr.estimatePrompt(this.messages, this.tools);
  }

  contextBudget() { return this.ctxMgr.budget(this.messages, this.tools); }

  private compactState() {
    const failure = this.verificationResult && !this.verificationResult.passed
      ? `\nLast acceptance failure (actual command output; resolve before completion):\n${truncateMiddle(this.verificationResult.output, 1800)}` : "";
    const progress = this.progressFailure ? `\nLast project check failure (may predate subsequent edits):\n${truncateMiddle(this.progressFailure, 1800)}` : "";
    return { originalRequest: this.originalRequest, currentRequest: this.currentRequest, verificationLine: this.verificationInstruction() + failure + progress, filesTouched: this.toolCtx.filesTouched, commandsRun: this.toolCtx.commandsRun, planLine: this.toolCtx.plan.compactLine() };
  }

  private async checkProgress(signal: AbortSignal): Promise<boolean> {
    const command = projectVerification(this.toolCtx.workspace);
    if (!command) return false;
    this.ui.status("· checking implementation progress");
    this.ui.toolCall("verification", { command });
    this.ctxMgr.prepareBackground(this.messages, this.tools, this.provider, this.compactState());
    const output = await runCommand(command, this.toolCtx.workspace, signal);
    if (signal.aborted) throw abortError();
    const passed = !output.startsWith("Error") && /\[exit code 0 in [^\]]+\]\s*$/.test(output);
    this.progressFailure = passed ? "" : output;
    this.ui.toolResult(output);
    await this.bus.emit("post_progress_check", { command, passed, output });
    this.messages.push({ role: "user", content: passed
      ? `[Project checks passed: ${command}. Continue the remaining work in the original request.]`
      : `[Progress checks failed. Fix the first concrete failure before further investigation. Continue the same task.\nCommand: ${command}\n${truncateMiddle(output, this.ctxMgr.toolResultCharLimit())}]` });
    return true;
  }

  private verificationInstruction(): string {
    return this.verification ? `\n${this.verification.source === "project" ? `Project checks (${this.verification.command})` : "Caller-owned acceptance checks"} must pass before completion. The harness runs them automatically and returns failures for repair. Use project files and returned failures to fix the application. Do not weaken or bypass acceptance checks.` : "";
  }

  private discoverVerification(wroteThisTurn: boolean): void {
    if ((!this.verification || this.verification.source === "project") && wroteThisTurn && this.mode !== "ro") {
      const command = projectVerification(this.toolCtx.workspace);
      if (command) {
        // Include scripts added during repairs, while retaining checks already
        // required earlier in this turn (deleting one must not bypass it).
        const commands = new Set([...(this.verification?.command.split(" && ") ?? []), ...command.split(" && ")]);
        this.verification = { command: [...commands].join(" && "), source: "project" };
      }
    }
  }

  private async verify(signal: AbortSignal): Promise<boolean> {
    if (this.mode === "ro") throw new Error("Acceptance commands are unavailable in read-only mode.");
    const check = this.verification!;
    const attempts = (this.verificationResult?.attempts ?? 0) + 1;
    if (attempts > (check.maxAttempts ?? 6)) throw new Error("Acceptance attempt limit reached before the agent finished. The task is incomplete.");
    this.ui.status(`· checking acceptance (${attempts}/${check.maxAttempts ?? 6})`);
    this.ui.toolCall("verification", { command: check.command });
    const output = await runCommand(check.command, this.toolCtx.workspace, signal);
    if (signal.aborted) throw abortError();
    const passed = !output.startsWith("Error") && /\[exit code 0 in [^\]]+\]\s*$/.test(output);
    this.sameVerificationFailures = passed ? 0
      : this.verificationResult && !this.verificationResult.passed && failureSignature(this.verificationResult.output) === failureSignature(output)
        ? this.sameVerificationFailures + 1 : 1;
    this.verificationResult = { attempts, passed, output };
    this.ui.toolResult(output);
    await this.bus.emit("post_verify", this.verificationResult);
    if (passed) { this.ui.status("· acceptance checks passed"); return true; }
    if (attempts >= (check.maxAttempts ?? 6)) throw new Error(`Acceptance checks still fail after ${attempts} attempts. The task is incomplete.\n${truncateMiddle(output, 1600)}`);
    this.ui.status("· acceptance failed — continuing repairs automatically");
    this.messages.push({ role: "user", content: `[Acceptance failed; the task is not complete. Repair the first failing behavior. The harness will rerun acceptance automatically. Do not skip tests or report success.${check.source === "project" ? `\nCommand: ${check.command}` : ""}\n${truncateMiddle(output, this.ctxMgr.toolResultCharLimit())}]` });
    if (this.sameVerificationFailures === 2 && this.canRefreshVerification) {
      this.ui.status("· same check failed again — refreshing working context");
      // Repeating an unchanged hypothesis in a larger transcript is not
      // progress. Keep the task, plan/checkpoint and actual failure, but drop
      // old model-written narratives before a facts-only handover. Current
      // files remain untouched and can be reread; no additional inference.
      this.ctxMgr.cancelBackground(true);
      this.messages = this.messages.filter(message => !message.compactNote);
      this.ctxMgr.resetAnchor();
      await this.compactNow(true, true);
    }
    return false;
  }

  async compactNow(force = true, deterministic = false): Promise<void> {
    this.ui.startSpinner("organizing context");
    try {
      await this.ctxMgr.foreground();
      await this.bus.emit("pre_compact");
      const { messages, report } = await this.ctxMgr.manage(
        this.messages,
        this.tools,
        this.provider,
        this.compactState(),
        { force, deterministic, signal: this.abort?.signal }
      );
      this.messages = messages;
      await this.bus.emit("post_compact", report);
      await this.bus.emit("context_update");
    } finally {
      this.ui.stopSpinner();
    }
  }

  async runTurn(userInput: string): Promise<void> {
    await this.ctxMgr.foreground();
    this.ctxMgr.cancelBackground(true);
    this.outcome = "running";
    this.ctxMgr.resetAnchor(); // prior-turn reasoning no longer travels on the wire
    this.lastError = null;
    this.verificationResult = null;
    this.verification = this.callerVerification;
    this.progressFailure = "";
    this.sameVerificationFailures = 0;
    // Earlier user decisions may exist only in a previous turn's summary.
    // Only a fresh conversation can safely discard every old narrative.
    this.canRefreshVerification = !this.originalRequest && this.messages.length === 1;
    if (!this.originalRequest) this.originalRequest = userInput;
    this.currentRequest = userInput; // the task compaction must never lose
    this.messages.push({ role: "user", content: userInput + this.verificationInstruction() });
    this.abort = new AbortController();
    const signal = this.abort.signal;

    const t0 = Date.now();
    let completed = false;
    let steps = 0;
    let nudges = 0;
    let toolCallsThisTurn = 0;
    let lastVerifiedToolCalls = -1;
    const runAcceptance = async () => {
      if (signal.aborted) throw abortError();
      // A summary after a successful check does not need to run it twice.
      if (this.verificationResult?.passed && lastVerifiedToolCalls === toolCallsThisTurn) return true;
      const passed = await this.verify(signal);
      lastVerifiedToolCalls = toolCallsThisTurn;
      return passed;
    };
    let sincePlanUpdate = 0;
    let repeatKey = "";
    let repeats = 0;
    let failedCalls = 0;
    const repeatedReads = new Map<string, { count: number; receipt?: Msg }>();
    let readsSinceAction = 0;
    let actionOnlyCalls = 0;
    let reasoningExhaustions = 0;
    let wroteThisTurn = false;
    let lastProgressCheck = 0;
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
      await this.refreshLoadedWindow();
      agentLoop: while (steps++ < this.maxSteps) {
        // Context management before every request.
        await this.bus.emit("pre_request");
        if (this.ctxMgr.needsAttention(this.messages, this.tools)) {
          await this.compactNow(false);
        }
        await this.ctxMgr.foreground();
        this.ctxMgr.assertFits(this.messages, this.tools);

        this.ui.startSpinner("thinking");
        let result: ChatResult;
        try {
          result = await this.chatWithRetry(signal, actionOnlyCalls > 0);
          if (actionOnlyCalls > 0) actionOnlyCalls--;
        } finally {
          this.ui.stopSpinner();
        }
        this.ctxMgr.calibrate(result.promptTokens, this.messages, this.tools);
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
        if (stats.modelCalls === 0) await this.refreshLoadedWindow();
        await this.bus.emit("context_update");
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
            if (burnedByThinking) {
              reasoningExhaustions++;
              actionOnlyCalls = reasoningExhaustions === 1 ? 1 : Math.min(8, 2 ** Math.min(reasoningExhaustions, 3));
              this.ui.status(`· reasoning exhausted the reply budget — ${actionOnlyCalls} response${actionOnlyCalls === 1 ? "" : "s"} with thinking off, then restore the selected effort`);
            }
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
          if (result.truncated || !result.content.trim()) throw new Error("The model repeatedly returned an empty or cut-off reply. Progress is kept. Try /effort off, switch models with /models, or say continue.");
          this.discoverVerification(wroteThisTurn);
          if (this.verification && !(await runAcceptance())) {
            repeatedReads.clear(); repeats = 0; failedCalls = 0; readsSinceAction = 0; lastProgressCheck = toolCallsThisTurn;
            continue;
          }
          completed = true;
          this.outcome = "completed";
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
          let observedOutput: string | undefined;
          if (call.parseError) {
            // LM Studio streams the partial arguments of a cut-off call, so
            // the overflow surfaces here as unparseable JSON.
            output = result.truncated
              ? `Error: ${this.truncatedCallHint()}`
              : `Error: your tool call arguments could not be parsed (${call.parseError}). Send the arguments as a single JSON object, e.g. {"path": "src/app.js"}.`;
          } else if (result.truncated) {
            output = `Error: ${this.truncatedCallHint()}`;
          } else if (!this.tools.some((t) => t.name === call.name)) {
            // HARD mode enforcement. The schemas sent to the model are only
            // advisory — a hallucinated or injected write_file/run_command in
            // read-only mode must be rejected here, at execution time.
            output = `Error: the tool "${call.name}" is not available in ${MODE_LABELS[this.mode]} mode. Available tools: ${this.tools.map((t) => t.name).join(", ")}.`;
          } else {
            this.toolCtx.resultCharLimit = this.ctxMgr.toolResultCharLimit();
            if (call.name === "run_command") {
              let end = this.messages.length - 1;
              while (this.messages[end]?.role === "tool") end--;
              this.ctxMgr.prepareBackground(this.messages.slice(0, end), this.tools, this.provider, this.compactState());
            }
            output = await this.gateAndExecute(call.name, call.args, signal);
            observedOutput = output; // fingerprint real evidence before coaching/reminders
            toolCallsThisTurn++;
            stats.toolCalls++;
            // Tier-0 context hygiene: a full overwrite makes every earlier
            // read of that file wrong. Stub them out right away.
            if ((call.name === "write_file" || call.name === "edit_file") && !output.startsWith("Error") && typeof call.args?.path === "string") {
              wroteThisTurn = true;
              this.ctxMgr.evictStaleReads(this.messages, call.args.path);
              repeatedReads.clear();
              readsSinceAction = 0;
            }
            // Keep the plan honest: small models forget to mark steps done
            // mid-flow, leaving the checklist stale for minutes. A periodic
            // one-line reminder riding on a tool result fixes it cheaply.
            const plan = this.toolCtx.plan;
            if (call.name === "plan") {
              sincePlanUpdate = 0;
              if (!output.startsWith("Error") && ["set", "done", "add"].includes(String(call.args?.action))) this.planNudged = false;
            } else if (plan.exists && plan.currentIndex >= 0 && ++sincePlanUpdate >= 4) {
              sincePlanUpdate = 0;
              const cur = plan.steps[plan.currentIndex];
              output += `\n[Reminder: the plan still shows step ${plan.currentIndex + 1} "${cur.text}" as current. If you have finished steps, mark each with plan {"action": "done"} now.]`;
            }
          }

          const key = JSON.stringify([call.name, call.args, observedOutput ?? output]);
          repeats = key === repeatKey ? repeats + 1 : 1;
          repeatKey = key;
          failedCalls = output.startsWith("Error") ? failedCalls + 1 : 0;
          if (repeats === 3 || failedCalls === 3) output += "\n[Repeated attempts are not making progress. Inspect the error or relevant file and change your approach before trying again.]";
          let readRepeats = 0;
          let readKey = "";
          if (["read_file", "search", "list_files"].includes(call.name) && !output.startsWith("Error")) {
            if (++readsSinceAction % 12 === 0 && this.mode !== "ro") output += "\n[Investigation checkpoint: record the exact APIs, unresolved error and next small edit with plan checkpoint. Then make and verify that edit before inspecting more modules.]";
            // Match both the request and file/output contents: rereading an
            // edited file or a different line range is legitimate progress.
            readKey = createHash("sha256").update(call.name + JSON.stringify(call.args) + (observedOutput ?? output)).digest("hex");
            const previous = repeatedReads.get(readKey);
            // Refetching evidence that WE removed is legitimate. Count only
            // repeated observations the model can still see in its context.
            const retained = previous?.receipt && !previous.receipt.evicted && this.messages.includes(previous.receipt);
            readRepeats = retained ? previous!.count + 1 : 1;
            if (!retained) repeats = 1; // the generic consecutive-call guard must agree
            repeatedReads.set(readKey, { count: readRepeats });
            if (readRepeats >= 3) output += "\n[This unchanged result has already been read repeatedly. Do not restart the same reads after compaction. Use a different small line range or narrow search if needed, then implement the next step.]";
          }
          const outputCap = this.ctxMgr.toolResultCharLimit();
          // read_file already paginates on complete lines. Never middle-cut
          // that page while its trailer claims a contiguous line range.
          if (output.length > outputCap && call.name !== "read_file") output = truncateMiddle(output, outputCap) + "\n[Output capped for this context window. Read a smaller line range or narrow the search.]";

          // Plan changes render as the visual checklist instead of a ✓ line.
          if (
            call.name === "plan" &&
            !output.startsWith("Error") &&
            ["set", "done", "add"].includes(String(call.args?.action ?? (typeof call.args?.steps === "string" ? "set" : undefined)))
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
          if (readKey) repeatedReads.get(readKey)!.receipt = this.messages[this.messages.length - 1];
          await this.bus.emit("post_tool", { name: call.name, args: call.args });
          await this.bus.emit("context_update");
          // A cancel during tool execution ends the turn now, with the
          // (cancelled) result already recorded so the transcript stays valid.
          if (signal.aborted) throw abortError();
          // Individual rereads after eviction are legitimate, but a long
          // investigation with no edit must still return to executable evidence.
          // Preserve this counter across compaction; only an edit or check
          // resets it. Read-only investigations never execute commands.
          const needsEvidence = readRepeats >= 5 || repeats >= 6 || failedCalls >= 6 ||
            (wroteThisTurn && readsSinceAction >= 24 && this.mode !== "ro");
          if (needsEvidence) this.discoverVerification(wroteThisTurn);
          if (this.verification && needsEvidence) {
            this.repairTranscript("[Not executed: the harness switched to executable checks after repeated attempts.]");
            this.ctxMgr.resetAnchor();
            // During implementation, known failing project checks are already
            // the actionable evidence. Tool-recovery checks must not spend the
            // caller's final acceptance budget before acceptance has started.
            if (!this.verificationResult && this.progressFailure && await this.checkProgress(signal)) {
              repeatedReads.clear(); repeats = 0; failedCalls = 0; readsSinceAction = 0; lastProgressCheck = toolCallsThisTurn;
              continue agentLoop;
            }
            if (!(await runAcceptance())) {
              repeatedReads.clear(); repeats = 0; failedCalls = 0; readsSinceAction = 0; lastProgressCheck = toolCallsThisTurn;
              continue agentLoop;
            }
            // Passing acceptance does not authorize dropping the remaining
            // task: ask for a final requirements review before completion.
            this.messages.push({role:"user",content:"[Acceptance passed. Review the original request, finish any remaining work, and summarize the verified result.]"});
            repeatedReads.clear(); repeats = 0; failedCalls = 0; readsSinceAction = 0; lastProgressCheck = toolCallsThisTurn;
            continue agentLoop;
          }
          if (readRepeats >= 5) throw new Error("Paused after repeatedly reading the same unchanged data without an edit. Progress is kept. Ask for a specific next change, read a different range, or use a larger context window.");
          if (repeats >= 6 || failedCalls >= 6) throw new Error("Paused after repeated tool attempts made no progress. Progress is kept; inspect the error, change the request or model, then continue.");
        }
        // A model can cycle through different reads and small API edits forever
        // without triggering an identical-call guard. Periodic executable
        // feedback grounds that investigation before a proposed completion.
        if (wroteThisTurn && this.mode !== "ro" && toolCallsThisTurn - lastProgressCheck >= 24) {
          lastProgressCheck = toolCallsThisTurn;
          this.discoverVerification(wroteThisTurn);
          if (this.verification && this.verificationResult) {
            // Once acceptance has found a real failure, keep checking THAT
            // behavior. Passing a weaker build check cannot resolve it.
            if (await runAcceptance()) this.messages.push({role:"user",content:"[Acceptance checks passed. Finish your response with the verified result.]"});
            readsSinceAction = 0; repeatedReads.clear(); repeats = 0; failedCalls = 0;
          } else if (await this.checkProgress(signal)) {
            readsSinceAction = 0; repeatedReads.clear(); repeats = 0; failedCalls = 0;
          }
        }
      }
      throw new Error(`Paused after ${this.maxSteps} model steps. Progress is kept. Say "continue" to keep going.`);
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) {
        this.ui.println();
        this.ui.status("· cancelled");
        this.outcome = "cancelled";
        this.sanitizeAfterCancel();
        return;
      }
      this.outcome = "error";
      this.lastError = String(err?.message ?? err);
      this.repairTranscript("[Tool did not run because the turn stopped after an error. Inspect the preceding error before continuing.]");
      throw err;
    } finally {
      await this.ctxMgr.foreground();
      this.abort = null;
      stats.durationMs = Date.now() - t0;
      if (completed) {
        this.ui.turnEnd(
          `${fmtDuration(stats.durationMs)}${describeStats(stats)}`
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
  private async chatWithRetry(signal: AbortSignal, actionOnly = false): Promise<ChatResult> {
    let lastErr: any;
    let recoveredContext = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let streamed = false;
      try {
        return await this.provider.chat(this.messages, this.tools, {
          signal,
          ...(actionOnly ? { effortOverride: "off" as const } : {}),
          maxTokens: Math.min(this.provider.maxOutputTokens, this.contextBudget().reserve),
          onToken: (t) => { streamed = true; this.ui.token(t); },
          onThinking: (t) => { streamed = true; this.ui.thinking(t); },
        });
      } catch (err: any) {
        if (err?.name === "AbortError" || signal.aborted) throw err;
        lastErr = err;
        if (streamed) this.ui.resetResponse?.();
        if (!recoveredContext && CONTEXT_ERROR.test(String(err?.message ?? err))) {
          recoveredContext = true;
          this.ui.status("· backend context limit — reducing history and retrying");
          await this.compactNow(true, true);
          this.ctxMgr.assertFits(this.messages, this.tools);
          continue;
        }
        if (attempt === 3 || !TRANSIENT_ERROR.test(String(err?.message ?? err))) throw err;
        this.ui.warn(`· backend error (${String(err?.message ?? err).slice(0, 80)}) — retrying in ${attempt * 3}s`);
        await abortableDelay(attempt * 3000, signal);
      }
    }
    throw lastErr;
  }

  private async refreshLoadedWindow(): Promise<void> {
    const actual = await this.provider.loadedContextWindow?.();
    if (actual && Number.isSafeInteger(actual) && actual < this.contextBudget().window) {
      this.ctxMgr.setWindow(actual, Math.min(this.provider.maxOutputTokens, Math.floor(actual / 4)));
      this.ui.status(`· loaded model context changed to ${actual.toLocaleString()} tokens; budget adjusted`);
      await this.bus.emit("context_update");
    }
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
    if (signal?.aborted) throw signal.reason;
    if (!this.tools.some((t) => t.name === name)) return `Error: ${name} is no longer available in ${MODE_LABELS[this.mode]} mode.`;
    return executeTool(name, args, this.toolCtx, signal);
  }

  private repairTranscript(reason: string): void {
    const repaired: Msg[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role === "tool") continue; // consumed with its assistant, or orphaned
      repaired.push(m);
      if (!m.toolCalls?.length) continue;
      const results = new Map<string | undefined, Msg>();
      while (this.messages[i + 1]?.role === "tool") { const t = this.messages[++i]; results.set(t.toolCallId, t); }
      for (const call of m.toolCalls) repaired.push(results.get(call.id) ?? { role: "tool", toolCallId: call.id, toolName: call.name, content: reason });
    }
    this.messages = repaired;
  }

  /**
   * After a cancel, the most recent assistant tool-call message may have some
   * calls unanswered — strict backends reject that shape on the next request.
   * A cancel mid-way through a MULTI-call batch buries that assistant message
   * behind the already-pushed tool results, so walk back past them.
   */
  private sanitizeAfterCancel(): void {
    this.repairTranscript("[cancelled by the user before this tool ran]");
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
