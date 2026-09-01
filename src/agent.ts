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
  needsApproval,
  ToolContext,
} from "./tools/index";
import { AgentUI } from "./ui";
import { c, fmtDuration } from "./util";

const TRANSIENT_ERROR = /fetch failed|econn|socket|network|timed?.?out|50[0234]/i;

export class Agent {
  messages: Msg[] = [];
  tools: ToolSpec[];
  private alwaysAllowed = new Set<string>();
  private originalRequest = "";
  private abort: AbortController | null = null;

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
    this.messages.push({ role: "user", content: userInput });
    this.abort = new AbortController();
    const signal = this.abort.signal;

    const t0 = Date.now();
    let completed = false;
    let steps = 0;
    let nudges = 0;
    let planNudged = false;
    let toolCallsThisTurn = 0;
    let sincePlanUpdate = 0;
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
        this.ctxMgr.recordUsage(
          result.promptTokens,
          result.completionTokens,
          this.messages.length
        );

        this.messages.push({
          role: "assistant",
          content: result.content,
          toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
        });
        if (result.content) this.ui.println(); // end the streamed line

        if (result.toolCalls.length === 0) {
          // A reply cut off by the output cap, or an empty reply, is not a
          // finished turn — that is how local-model sessions die silently.
          // Nudge the model back on track (bounded).
          if (result.truncated && nudges < 3) {
            nudges++;
            this.ui.status("· reply hit the output limit — asking the model to continue");
            this.messages.push({
              role: "user",
              content:
                "[Your reply was cut off by the output length limit. Continue where you left off. If you were writing a file, send the complete write_file call again — split large files into several smaller writes or separate files.]",
            });
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
          const plan = this.toolCtx.plan;
          if (plan.exists && plan.currentIndex >= 0 && toolCallsThisTurn > 0 && !planNudged) {
            planNudged = true;
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
          this.ui.toolCall(call.name, call.args);

          let output: string;
          if (call.parseError) {
            output = `Error: your tool call arguments could not be parsed (${call.parseError}). Send the arguments as a single JSON object, e.g. {"path": "src/app.js"}.`;
          } else {
            output = await this.gateAndExecute(call.name, call.args);
            toolCallsThisTurn++;
            // Keep the plan honest: small models forget to mark steps done
            // mid-flow, leaving the checklist stale for minutes. A periodic
            // one-line reminder riding on a tool result fixes it cheaply.
            const plan = this.toolCtx.plan;
            if (call.name === "plan") {
              sincePlanUpdate = 0;
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
      if (completed) {
        this.ui.turnEnd(
          `${MODE_LABELS[this.mode]} · ${this.provider.modelId} · ${fmtDuration(Date.now() - t0)}`
        );
      }
    }
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

  private async gateAndExecute(name: string, args: Record<string, any>): Promise<string> {
    const command = needsApproval(name, args);
    if (command !== null && this.mode === "write") {
      const program = command.trim().split(/\s+/)[0] ?? "";
      if (!this.alwaysAllowed.has(program)) {
        if (!this.interactive) {
          return `Error: running commands needs user approval, and this session is non-interactive. The user must rerun tiny-coder in yolo mode (--mode yolo) to allow commands, or run this themselves: ${command}`;
        }
        const answer = await this.ui.confirmCommand(command);
        if (answer === "no") {
          return "The user declined to run this command. Continue without it, or ask the user what to do instead.";
        }
        if (answer === "always" && program) this.alwaysAllowed.add(program);
      }
    }
    return executeTool(name, args, this.toolCtx);
  }

  /**
   * After a cancel we may have an assistant tool-call message with no tool
   * results behind it — strict backends reject that shape on the next request.
   */
  private sanitizeAfterCancel(): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "assistant" && last.toolCalls?.length) {
      for (const tc of last.toolCalls) {
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

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
