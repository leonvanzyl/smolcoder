// SessionChannel: the SessionUI a web session talks to. Same contract the
// terminal Tui implements, but every event is tagged with the session id and
// handed to the hub, which multiplexes all sessions onto one SSE stream.
// Keeps a replay buffer (so a page that connects later sees the transcript),
// the pending input/approval promises, and a coarse status for the sidebar.

import { Plan } from "../plan";
import { SelectOption, SessionUI, SlashCommand, summarizeArgs } from "../ui";

export type Event = Record<string, any>;

export type ChannelStatus = "starting" | "idle" | "busy" | "waiting" | "error";

export interface ChannelHost {
  /** Deliver an (already tagged) event to every connected page. */
  send(ev: Event): void;
  /** Sidebar-visible facts changed (status, title): resend the hub snapshot. */
  changed(id: string): void;
  /** The transcript grew: schedule a save. */
  touched(id: string): void;
}

const REPLAY_CAP = 2000;

export class SessionChannel implements SessionUI {
  slashCommands: SlashCommand[] = [];
  getStatus: () => string = () => "";
  /** Structured snapshot for the page's status bar; assigned by the hub. */
  getState: () => Record<string, any> = () => ({});
  hintLeft = "";
  onModeCycle: (() => void) | null = null;
  onCancel: (() => void) | null = null;
  onExit: (() => void) | null = null;

  phase: ChannelStatus = "starting";
  title = "";
  busyLabel: string | null = null;
  replay: Event[] = [];
  closed = false;

  private pendingInput: ((s: string) => void) | null = null;
  private inputQueue: string[] = [];
  private exitRequested = false;
  private pending = new Map<number, { resolve: (v: any) => void; kind: "confirm" | "select"; label: string }>();
  private askId = 0;

  constructor(
    readonly id: string,
    private host: ChannelHost
  ) {}

  // ---- lifecycle -----------------------------------------------------------

  start(): void {}

  close(): void {
    this.closed = true;
    this.busyLabel = null;
    this.resolvePending(null);
    this.host.changed(this.id);
  }

  /** Make the session loop's next readInput() return "/exit" without echoing
   * it as a user message. Used when a session is closed from the sidebar. */
  requestExit(): void {
    this.exitRequested = true;
    if (this.pendingInput) {
      const r = this.pendingInput;
      this.pendingInput = null;
      r("/exit");
    }
  }

  // ---- input from the page -------------------------------------------------

  handleMessage(text: string): void {
    text = text.trim();
    if (!text || this.closed) return;
    if (this.pendingInput) {
      const resolve = this.pendingInput;
      this.pendingInput = null;
      this.accept(text);
      resolve(text);
    } else {
      this.inputQueue.push(text);
    }
  }

  handleAnswer(id: number, value: any): void {
    if (!this.pending.has(id)) return;
    this.setStatus("busy");
    this.settle(id, value);
  }

  /** Stop button / esc: answer any open prompt with "no"/cancel, then abort
   * the turn. Without the first step a cancel during an approval prompt
   * would leave the agent waiting on a promise nothing will resolve. */
  cancel(): void {
    this.resolvePending(null);
    this.onCancel?.();
  }

  private resolvePending(value: any): void {
    for (const id of [...this.pending.keys()]) this.settle(id, value);
  }

  /** Resolve one prompt and record the outcome in the transcript, so a page
   * that replays it later (reconnect, resume) sees the answer, not live
   * buttons for a question nobody is asking any more. */
  private settle(id: number, value: any): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.broadcast({ t: "answered", id });
    if (p.kind === "confirm") {
      const a = value === "always" ? "always allow" : value === "yes" ? "yes" : "no";
      this.broadcast({ t: "line", kind: "status", s: `${a} — ${p.label}` });
    } else if (value === null || value === undefined) {
      this.broadcast({ t: "line", kind: "status", s: `cancelled — ${p.label}` });
    }
    p.resolve(value);
  }

  private accept(text: string): void {
    this.setStatus("busy");
    this.broadcast({ t: "user", s: text });
    if (!this.title && !text.startsWith("/")) {
      this.title = text.replace(/\s+/g, " ").slice(0, 60);
      this.host.changed(this.id);
    }
  }

  private setStatus(s: ChannelStatus): void {
    if (this.phase === s) return;
    this.phase = s;
    this.host.changed(this.id);
  }

  // ---- event plumbing ------------------------------------------------------

  private broadcast(ev: Event): void {
    ev.sid = this.id;
    if (ev.t !== "busy" && ev.t !== "state") {
      this.replay.push(ev);
      if (this.replay.length > REPLAY_CAP) this.replay.shift();
      this.host.touched(this.id);
    }
    this.host.send(ev);
  }

  stateEvent(): Event {
    return { t: "state", sid: this.id, s: { ...this.getState(), busy: this.busyLabel, title: this.title } };
  }

  pushState(): void {
    this.host.send(this.stateEvent());
  }

  refresh(): void {
    this.pushState();
  }

  // ---- SessionUI -----------------------------------------------------------

  readInput(): Promise<string> {
    this.busyLabel = null;
    this.setStatus("idle");
    this.pushState();
    if (this.exitRequested || this.closed) return Promise.resolve("/exit");
    if (this.inputQueue.length) {
      const text = this.inputQueue.shift()!;
      this.accept(text);
      return Promise.resolve(text);
    }
    return new Promise((resolve) => (this.pendingInput = resolve));
  }

  select(title: string, options: SelectOption[]): Promise<number | null> {
    const id = ++this.askId;
    this.broadcast({ t: "select", id, title, options });
    this.setStatus("waiting");
    return new Promise((resolve) =>
      this.pending.set(id, { kind: "select", label: title, resolve: (i) => resolve(typeof i === "number" ? i : null) })
    );
  }

  confirmCommand(command: string, reason?: string): Promise<"yes" | "no" | "always"> {
    const id = ++this.askId;
    this.broadcast({ t: "confirm", id, command, reason });
    this.setStatus("waiting");
    return new Promise((resolve) =>
      this.pending.set(id, {
        kind: "confirm",
        label: command,
        resolve: (a) => resolve(a === "always" ? "always" : a === "yes" ? "yes" : "no"),
      })
    );
  }

  token(text: string): void {
    this.broadcast({ t: "token", s: text });
  }

  thinking(text: string): void {
    this.broadcast({ t: "thinking", s: text });
  }

  toolCall(name: string, args: Record<string, any>): void {
    this.broadcast({ t: "tool", name, summary: summarizeArgs(name, args) });
  }

  toolResult(result: string): void {
    const lines = result.split("\n");
    const first = lines[0] ?? "";
    this.broadcast({
      t: "result",
      line: first.slice(0, 160),
      err: first.startsWith("Error"),
      extra: lines.length > 1 ? lines.length - 1 : 0,
    });
  }

  planUpdated(plan: Plan): void {
    this.broadcast({ t: "plan", steps: plan.steps, current: plan.currentIndex });
    this.pushState();
  }

  println(s = ""): void {
    if (s.trim()) this.broadcast({ t: "line", kind: "status", s: stripAnsi(s) });
  }

  status(s: string): void {
    this.broadcast({ t: "line", kind: "status", s: stripAnsi(s) });
  }

  warn(s: string): void {
    this.broadcast({ t: "line", kind: "warn", s: stripAnsi(s) });
  }

  error(s: string): void {
    this.broadcast({ t: "line", kind: "error", s: stripAnsi(s) });
  }

  turnEnd(label: string): void {
    this.broadcast({ t: "turnend", label });
    this.pushState();
  }

  startSpinner(label: string): void {
    this.busyLabel = label;
    this.broadcast({ t: "busy", label });
  }

  stopSpinner(): void {
    this.busyLabel = null;
    this.broadcast({ t: "busy", label: null });
  }
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
