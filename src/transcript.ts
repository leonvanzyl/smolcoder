// Saved transcripts outside the web hub: the web replay events a TUI session
// stores (so the web sidebar can open it too), the compact replay a resumed
// session prints in the terminal, and the /sessions picker rows.

import { Msg } from "./providers/types";
import { AgentUI, SelectOption, summarizeArgs } from "./ui";
import { c } from "./util";
import { SessionMeta } from "./web/store";

type Event = Record<string, any>;

const BODY_CAP = 20_000;

/** Messages a person wrote or read: not the system prompt, not harness notes. */
function visible(m: Msg): boolean {
  return m.role !== "system" && !m.compactNote && !m.historyNote && !m.harnessNote;
}

/** Visible messages in display order: each tool result right after its call,
 * paired by toolCallId (a batch of calls is followed by all its results).
 * A result whose call is gone (compacted away) keeps its place. */
type Row =
  | { kind: "message"; msg: Msg }
  | { kind: "call"; name: string; args: Record<string, any>; result?: Msg }
  | { kind: "result"; msg: Msg };

function inCallOrder(messages: Msg[]): Row[] {
  const shown = messages.filter(visible);
  const results = new Map<string, Msg>();
  for (const m of shown) if (m.role === "tool" && m.toolCallId !== undefined && !results.has(m.toolCallId)) results.set(m.toolCallId, m);
  const used = new Set<Msg>();
  const rows: Row[] = [];
  for (const m of shown) {
    if (m.role === "tool") {
      if (!used.has(m)) rows.push({ kind: "result", msg: m });
      continue;
    }
    rows.push({ kind: "message", msg: m });
    for (const call of m.toolCalls ?? []) {
      const found = results.get(call.id);
      const result = found && !used.has(found) ? found : undefined;
      if (result) used.add(result);
      rows.push({ kind: "call", name: call.name, args: call.args ?? {}, result });
    }
  }
  return rows;
}

/** The number shown in the /sessions picker: user requests and model replies. */
export function countMessages(messages: Msg[]): number {
  return messages.filter((m) => visible(m) && (m.role === "user" || m.role === "assistant") && m.content.trim()).length;
}

/** Web replay events (the SessionChannel format) for these messages. */
export function eventsFromMessages(messages: Msg[]): Event[] {
  const out: Event[] = [];
  const result = (m: Msg) => {
    const first = m.content.split("\n")[0] ?? "";
    const lines = m.content.split("\n").length;
    out.push({ t: "result", line: first.slice(0, 160), err: first.startsWith("Error"), extra: lines - 1, body: m.content.slice(0, BODY_CAP) });
  };
  for (const row of inCallOrder(messages)) {
    if (row.kind === "call") {
      out.push({ t: "tool", name: row.name, summary: summarizeArgs(row.name, row.args) });
      if (row.result) result(row.result);
    } else if (row.kind === "result") result(row.msg);
    else if (row.msg.role === "user") out.push({ t: "user", s: row.msg.content });
    else if (row.msg.role === "assistant" && row.msg.content.trim()) out.push({ t: "token", s: row.msg.content });
  }
  return out;
}

/** Print a restored transcript compactly: user lines, tool rows, replies.
 * No durations: the saved transcript does not have them. */
export function replayTranscript(ui: Pick<AgentUI, "println" | "token" | "toolCall" | "toolResult" | "status">, messages: Msg[], limit = 60): void {
  const rows = inCallOrder(messages);
  // Count the rows that print something; a call and its result are one.
  const units = rows.filter((r) => r.kind !== "message" || r.msg.role === "user" || !!r.msg.content.trim());
  const skipped = Math.max(0, units.length - limit);
  if (skipped) ui.status(`· ${skipped} earlier message${skipped > 1 ? "s" : ""} not shown`);
  const from = skipped ? rows.indexOf(units[skipped]) : 0;
  const result = (m: Msg) => ui.toolResult(m.content, { ok: !m.content.startsWith("Error") });
  for (const row of rows.slice(from)) {
    if (row.kind === "call") {
      ui.toolCall(row.name, row.args);
      if (row.result) result(row.result);
    } else if (row.kind === "result") result(row.msg);
    else if (row.msg.role === "user") {
      const m = row.msg;
      const text = m.content.length > 500 ? m.content.slice(0, 500) + "…" : m.content;
      ui.println("");
      ui.println(`${c.bold("›")} ${text}`);
    } else if (row.msg.role === "assistant" && row.msg.content.trim()) {
      const text = row.msg.content.trim();
      ui.token(text.length > 4000 ? text.slice(0, 4000) + "…" : text);
      ui.println("");
    }
  }
}

function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today", "Yesterday", or the date ("Mon 3 Nov 2026"). */
export function dayLabel(t: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(t);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${wd} ${d.getDate()} ${mo} ${d.getFullYear()}`;
}

function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Picker rows for saved sessions, newest first, grouped by day. */
export function sessionOptions(metas: SessionMeta[], now = Date.now()): SelectOption[] {
  return metas.map((m) => {
    const n = m.messages;
    return {
      label: m.title || "(untitled)",
      hint: [n !== undefined ? `${n} message${n === 1 ? "" : "s"}` : "", clock(m.updatedAt), m.model ?? ""].filter(Boolean).join(" · "),
      group: dayLabel(m.updatedAt, now),
      keywords: m.model,
    };
  });
}
