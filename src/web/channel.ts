// SessionChannel: the SessionUI a web session talks to. Same contract the
// terminal Tui implements, but every event is tagged with the session id and
// handed to the hub, which multiplexes all sessions onto one SSE stream.
// Keeps a replay buffer (so a page that connects later sees the transcript),
// the pending input/approval promises, and a coarse status for the sidebar.

import { Attachment, UserInput } from "../attachments";
import { Plan } from "../plan";
import { PromptOptions, SelectOption, SelectOpts, SessionUI, SlashCommand, summarizeArgs, ToolOutcome } from "../ui";

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
/** Live "writing … N chars" updates are sent at most this often. */
const ARGS_PROGRESS_MS = 120;
/** Status-bar pickers the page can anchor a popover to. */
const VIA = new Set(["mode", "models", "effort"]);

/** A message waiting for the agent to finish its turn. */
interface Queued {
  id: number;
  input: string | UserInput;
  via?: string;
}

export class SessionChannel implements SessionUI {
  slashCommands: SlashCommand[] = [];
  getStatus: () => string = () => "";
  /** Structured snapshot for the page's status bar; assigned by the hub. */
  getState: () => Record<string, any> = () => ({});
  hintLeft = "";
  onModeCycle: (() => void) | null = null;
  onCancel: (() => void) | null = null;
  onExit: (() => void) | null = null;

  private _phase: ChannelStatus = "starting";
  /** When the phase last changed (the sidebar's "Working · 1m 12s"). */
  phaseSince = Date.now();
  /** Called on every phase change; assigned by the hub. */
  onPhase: ((from: ChannelStatus, to: ChannelStatus) => void) | null = null;
  title = "";
  busyLabel: string | null = null;
  replay: Event[] = [];
  closed = false;

  private pendingInput: ((s: string | UserInput) => void) | null = null;
  private inputQueue: Queued[] = [];
  private queueId = 0;
  /** After a Stop the waiting messages stay put until the user sends again
   * or resumes the queue: a Stop means "stop", not "go on with the next". */
  queuePaused = false;
  /** replay.length where each undoable turn's events start, newest last. */
  private turnMarks: number[] = [];
  /** replay.length just before the last accepted input's bubble. */
  private acceptMark: number | null = null;
  private exitRequested = false;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      kind: "confirm" | "select" | "prompt";
      label: string;
      secret?: boolean;
      onStar?: SelectOpts["onStar"];
    }
  >();
  private askId = 0;
  /** The status-bar picker the current input came from ("mode", "models",
   * "effort"); a select it opens is drawn as a popover there. */
  private via: string | null = null;
  private toolStart = 0;
  private argsTimer: NodeJS.Timeout | null = null;
  private argsLast = 0;
  private argsPending: { name: string; chars: number } | null = null;

  restoreReplay(events: Event[]): void {
    this.replay = events
      .slice(-REPLAY_CAP)
      .filter((e) => e.t !== "confirm" && e.t !== "select" && e.t !== "select_update" && e.t !== "prompt" && e.t !== "answered");
    this.askId = Math.max(0, ...events.map((e) => typeof e.id === "number" ? e.id : 0));
    // A resumed session starts with nothing to undo.
    this.turnMarks = [];
    this.acceptMark = null;
  }

  constructor(
    readonly id: string,
    private host: ChannelHost
  ) {}

  get phase(): ChannelStatus {
    return this._phase;
  }

  set phase(to: ChannelStatus) {
    const from = this._phase;
    if (from === to) return;
    this._phase = to;
    this.phaseSince = Date.now();
    this.onPhase?.(from, to);
  }

  /** The current turn came from a status-bar picker (mode, model, effort),
   * not from something the user wrote. */
  get pickerTurn(): boolean {
    return this.via !== null;
  }

  // ---- lifecycle -----------------------------------------------------------

  start(): void {}

  close(): void {
    this.closed = true;
    this.flushArgs(false);
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

  /** A message from the page: text, attachments, or both. `via` names the
   * status-bar picker a slash command was sent from (no echo, popover). */
  handleMessage(text: string, attachments: Attachment[] = [], via?: string): void {
    text = text.trim();
    if ((!text && !attachments.length) || this.closed) return;
    const input: string | UserInput = attachments.length ? { text, attachments } : text;
    const from = via && VIA.has(via) && text.startsWith("/") && !attachments.length ? via : undefined;
    if (this.pendingInput && this.queuePaused && this.inputQueue.length && !from) {
      // Sending while the queue is paused continues it, in order: the new
      // message goes after the ones already waiting.
      this.inputQueue.push({ id: ++this.queueId, input });
      this.resumeQueue();
    } else if (this.pendingInput) {
      const resolve = this.pendingInput;
      this.pendingInput = null;
      this.accept(input, from);
      resolve(input);
    } else {
      // Busy: the message waits, and the page shows it as a removable chip.
      this.inputQueue.push({ id: ++this.queueId, input, ...(from ? { via: from } : {}) });
      this.pushState();
    }
  }

  /** The user took a waiting message off the queue. */
  removeQueued(id: number): boolean {
    const i = this.inputQueue.findIndex((q) => q.id === id);
    if (i < 0) return false;
    this.inputQueue.splice(i, 1);
    if (!this.inputQueue.length) this.queuePaused = false;
    this.pushState();
    return true;
  }

  /** Drop every waiting message. */
  clearQueue(): void {
    this.inputQueue = [];
    this.queuePaused = false;
    this.pushState();
  }

  /** Go on with a paused queue: the next message runs now when the agent is
   * idle, or when the current turn ends. */
  resumeQueue(): void {
    this.queuePaused = false;
    if (this.pendingInput && this.inputQueue.length && !this.closed && !this.exitRequested) {
      const resolve = this.pendingInput;
      this.pendingInput = null;
      const q = this.inputQueue.shift()!;
      this.accept(q.input, q.via);
      this.pushState();
      resolve(q.input);
      return;
    }
    this.pushState();
  }

  // ---- turn marks (/undo) ----------------------------------------------------

  /** The session is starting an undoable turn (the input just accepted). */
  turnStarted(): void {
    this.turnMarks.push(this.acceptMark ?? this.replay.length);
    this.acceptMark = null;
    if (this.turnMarks.length > 20) this.turnMarks.shift();
  }

  /** /undo took the last turn back: its events leave the replay (so a page
   * that reconnects, and the saved session, no longer show it), and every
   * page redraws this session from the shortened replay. */
  turnUndone(): void {
    const mark = this.turnMarks.pop();
    if (mark === undefined) return;
    this.replay.length = Math.min(this.replay.length, mark);
    this.acceptMark = null;
    this.host.send({ t: "session_reset", sid: this.id });
    for (const ev of this.replay) this.host.send({ ...ev, replay: true });
    this.pushState();
    this.host.touched(this.id);
  }

  /** What the page lists above the composer. */
  queued(): { id: number; text: string; files?: string[] }[] {
    return this.inputQueue.map((q) => {
      const text = typeof q.input === "string" ? q.input : q.input.text;
      const files = typeof q.input === "string" ? [] : q.input.attachments.map((a) => a.name);
      return { id: q.id, text: text.slice(0, 500), ...(files.length ? { files } : {}) };
    });
  }

  /** The star button in a picker: toggle the row and redraw the list. */
  async star(id: number, index: number): Promise<SelectOption[] | null> {
    const p = this.pending.get(id);
    if (!p || p.kind !== "select" || !p.onStar || !Number.isInteger(index) || index < 0) return null;
    const options = cleanOptions(await p.onStar(index));
    if (!this.pending.has(id)) return options;
    // Keep the replay in step, so a page that reconnects sees the new stars.
    const ev = this.replay.find((e) => e.t === "select" && e.id === id);
    if (ev) ev.options = options;
    this.host.send({ t: "select_update", sid: this.id, id, options });
    return options;
  }

  /** The values a slash command takes (its args provider), for the menu. */
  async commandArgs(name: string): Promise<SelectOption[]> {
    // The live list first (fresh values), then whatever the state carries.
    for (const list of [this.slashCommands, this.getState().commands ?? []] as any[][]) {
      const cmd = list.find((c) => c && c.name === name);
      if (typeof cmd?.args === "function") return cleanOptions(await cmd.args());
      if (Array.isArray(cmd?.args)) return cleanOptions(cmd.args);
    }
    return [];
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
    if (this.inputQueue.length && !this.queuePaused) {
      this.queuePaused = true;
      this.pushState();
    }
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
    } else if (value === null || value === undefined || (p.kind === "prompt" && !String(value).trim())) {
      this.broadcast({ t: "line", kind: "status", s: `cancelled — ${p.label}` });
    } else if (p.kind === "prompt") {
      this.broadcast({ t: "line", kind: "status", s: `${p.label}: ${p.secret ? "(hidden)" : String(value).trim().slice(0, 200)}` });
    }
    p.resolve(value);
  }

  private accept(input: string | UserInput, via?: string): void {
    const text = typeof input === "string" ? input : input.text;
    const files =
      typeof input === "string"
        ? []
        : input.attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size, url: uploadUrl(this.id, a.id) }));
    this.setStatus("busy");
    this.via = via ?? null;
    this.acceptMark = this.replay.length;
    // A status-bar click is not something the user said: no bubble for it.
    if (!via) this.broadcast({ t: "user", s: text, ...(files.length ? { files } : {}) });
    const label = text || files.map((f) => f.name).join(", ");
    if (!this.title && !label.startsWith("/")) {
      this.title = label.replace(/\s+/g, " ").slice(0, 60);
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
      const prev = this.replay[this.replay.length - 1];
      if ((ev.t === "token" || ev.t === "thinking") && prev?.t === ev.t && String(prev.s).length + String(ev.s).length < 100_000) {
        prev.s += ev.s;
      } else this.replay.push({ ...ev });
      if (this.replay.length > REPLAY_CAP) {
        this.replay.shift();
        this.turnMarks = this.turnMarks.map((n) => Math.max(0, n - 1));
        if (this.acceptMark !== null) this.acceptMark = Math.max(0, this.acceptMark - 1);
      }
      this.host.touched(this.id);
    }
    this.host.send(ev);
  }

  stateEvent(): Event {
    const s = this.getState();
    const out: Record<string, any> = { ...s, busy: this.busyLabel, title: this.title, queued: this.queued(), queuePaused: this.queuePaused };
    // Functions do not survive JSON: say which commands take an argument.
    if (Array.isArray(s.commands)) out.commands = s.commands.map(commandView);
    return { t: "state", sid: this.id, s: out };
  }

  pushState(): void {
    this.host.send(this.stateEvent());
  }

  refresh(): void {
    this.pushState();
  }

  // ---- SessionUI -----------------------------------------------------------

  readInput(): Promise<string | UserInput> {
    this.busyLabel = null;
    this.setStatus("idle");
    this.pushState();
    this.via = null;
    if (this.exitRequested || this.closed) return Promise.resolve("/exit");
    if (this.inputQueue.length && !this.queuePaused) {
      const q = this.inputQueue.shift()!;
      this.accept(q.input, q.via);
      this.pushState();
      return Promise.resolve(q.input);
    }
    return new Promise((resolve) => (this.pendingInput = resolve));
  }

  select(title: string, options: SelectOption[], opts: SelectOpts = {}): Promise<number | null> {
    const id = ++this.askId;
    this.broadcast({
      t: "select",
      id,
      title,
      options: cleanOptions(options),
      ...(opts.onStar ? { star: true } : {}),
      ...(this.via ? { via: this.via } : {}),
    });
    this.setStatus("waiting");
    return new Promise((resolve) =>
      this.pending.set(id, {
        kind: "select",
        label: title,
        onStar: opts.onStar,
        resolve: (i) => resolve(typeof i === "number" && Number.isInteger(i) && i >= 0 ? i : null),
      })
    );
  }

  prompt(title: string, placeholder = "", opts: PromptOptions = {}): Promise<string | null> {
    const id = ++this.askId;
    this.broadcast({ t: "prompt", id, title, placeholder, ...(opts.secret ? { secret: true } : {}) });
    this.setStatus("waiting");
    return new Promise((resolve) =>
      this.pending.set(id, {
        kind: "prompt",
        label: title,
        secret: opts.secret,
        resolve: (s) => resolve(typeof s === "string" && s.trim() ? s.trim().slice(0, 500) : null),
      })
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

  resetResponse(): void {
    this.broadcast({ t: "response_reset" });
  }

  thinking(text: string): void {
    this.broadcast({ t: "thinking", s: text });
  }

  toolCall(name: string, args: Record<string, any>): void {
    this.flushArgs(false);
    this.toolStart = Date.now();
    this.broadcast({ t: "tool", name, summary: summarizeArgs(name, args) });
  }

  /** `outcome` (timing, diff) goes to the page only; the model sees `result`. */
  toolResult(result: string, outcome?: ToolOutcome): void {
    const lines = result.split("\n");
    const first = lines[0] ?? "";
    const ms =
      outcome && Number.isFinite(outcome.durationMs) ? outcome.durationMs : this.toolStart ? Date.now() - this.toolStart : undefined;
    this.toolStart = 0;
    const diff = outcome?.diff ? lineDiff(outcome.diff.path, outcome.diff.before ?? "", outcome.diff.after ?? "") : undefined;
    this.broadcast({
      t: "result",
      line: first.slice(0, 160),
      err: outcome ? !outcome.ok : first.startsWith("Error"),
      extra: lines.length > 1 ? lines.length - 1 : 0,
      body: result,
      ...(ms !== undefined ? { ms: Math.max(0, Math.round(ms)) } : {}),
      ...(diff ? { diff } : {}),
    });
  }

  /** A long tool call's arguments are still arriving: show it moving.
   * Throttled, and never kept in the replay (it is gone once the call lands). */
  toolArgsProgress(name: string, chars: number): void {
    this.argsPending = { name, chars };
    const wait = this.argsLast + ARGS_PROGRESS_MS - Date.now();
    if (wait <= 0) this.flushArgs(true);
    else if (!this.argsTimer) this.argsTimer = setTimeout(() => this.flushArgs(true), wait);
  }

  private flushArgs(send: boolean): void {
    if (this.argsTimer) {
      clearTimeout(this.argsTimer);
      this.argsTimer = null;
    }
    const p = this.argsPending;
    this.argsPending = null;
    if (!send || !p || this.closed) return;
    this.argsLast = Date.now();
    this.host.send({ t: "toolargs", sid: this.id, name: p.name, chars: p.chars });
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

/** A slash command as the page sees it: `args` becomes a flag, and values
 * already resolved (an array, as Session.state() sends them) ride along. */
function commandView(c: any): Record<string, any> {
  return {
    name: c.name,
    desc: c.desc,
    ...(c.aliases?.length ? { aliases: c.aliases } : {}),
    ...(c.group ? { group: c.group } : {}),
    ...(c.key ? { key: c.key } : {}),
    ...(typeof c.args === "function" || Array.isArray(c.args) ? { args: true } : {}),
    ...(Array.isArray(c.args) ? { argOptions: cleanOptions(c.args) } : {}),
  };
}

/** Only the fields the page draws, as plain values. */
function cleanOptions(options: SelectOption[] | null | undefined): SelectOption[] {
  if (!Array.isArray(options)) return [];
  return options.map((o) => ({
    label: String(o?.label ?? ""),
    ...(o?.hint ? { hint: String(o.hint) } : {}),
    ...(o?.current ? { current: true } : {}),
    ...(o?.group ? { group: String(o.group) } : {}),
    ...(o?.keywords ? { keywords: String(o.keywords) } : {}),
    ...(o?.starred ? { starred: true } : {}),
  }));
}

export interface LineDiff {
  path: string;
  added: number;
  removed: number;
  /** [" " | "+" | "-", text], or ["~", "N unchanged lines"] between hunks. */
  lines: [string, string][];
  /** More changed lines than are shown. */
  truncated?: boolean;
}

const DIFF_CONTEXT = 3;
const DIFF_MAX_LINES = 400;
const DIFF_MAX_CELLS = 4_000_000;

/** A compact line diff for the page (UI only, never sent to the model):
 * common ends trimmed, an LCS over the rest, three lines of context. */
export function lineDiff(path: string, before: string, after: string): LineDiff {
  const a = before === "" ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const b = after === "" ? [] : after.replace(/\r\n/g, "\n").split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: [string, string][] = [];
  for (let i = 0; i < pre; i++) ops.push([" ", a[i]]);
  const n = am.length;
  const m = bm.length;
  if (n && m && n * m <= DIFF_MAX_CELLS) {
    // lcs[i * w + j] = LCS length of am[i..] and bm[j..].
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push([" ", am[i]]);
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) ops.push(["-", am[i++]]);
      else ops.push(["+", bm[j++]]);
    }
    while (i < n) ops.push(["-", am[i++]]);
    while (j < m) ops.push(["+", bm[j++]]);
  } else {
    for (const l of am) ops.push(["-", l]);
    for (const l of bm) ops.push(["+", l]);
  }
  for (let i = a.length - suf; i < a.length; i++) ops.push([" ", a[i]]);

  let added = 0;
  let removed = 0;
  const keep = new Uint8Array(ops.length);
  ops.forEach(([op], i) => {
    if (op === " ") return;
    if (op === "+") added++;
    else removed++;
    for (let k = Math.max(0, i - DIFF_CONTEXT); k <= Math.min(ops.length - 1, i + DIFF_CONTEXT); k++) keep[k] = 1;
  });
  const lines: [string, string][] = [];
  let skipped = 0;
  let truncated = false;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) {
      skipped++;
      continue;
    }
    if (lines.length >= DIFF_MAX_LINES) {
      truncated = true;
      break;
    }
    if (skipped) {
      lines.push(["~", `${skipped} unchanged line${skipped > 1 ? "s" : ""}`]);
      skipped = 0;
    }
    lines.push([ops[i][0], ops[i][1].length > 2000 ? ops[i][1].slice(0, 2000) + "…" : ops[i][1]]);
  }
  if (skipped && !truncated) lines.push(["~", `${skipped} unchanged line${skipped > 1 ? "s" : ""}`]);
  return { path, added, removed, lines, ...(truncated ? { truncated } : {}) };
}

/** Where the page fetches a stored upload (it appends its own key). */
export function uploadUrl(sid: string, id: string): string {
  return `/upload?sid=${sid}&id=${id}`;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
