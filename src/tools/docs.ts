// lookup_docs: current library documentation from Context7's search API.
// Its plain-text answer is already model-ready markdown snippets, so this only
// asks, caps the answer on a snippet boundary and turns every failure into one
// actionable line. Only the query and library names leave the machine, plus
// the user's own API key when one is set. Works without a key (a monthly
// anonymous limit); /docs turns the tool off or adds a key.

import { abortableDelay } from "../providers/transport";

export const CONTEXT7_SEARCH_URL = "https://context7.com/api/v3/search";
/** Anonymous lookups a month (Ratelimit-Limit; resets on the 1st, 00:00 UTC). */
export const ANON_MONTHLY_LIMIT = 200;

const DEFAULT_MAX_CHARS = 6000;
const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 1000;
const MAX_LIBRARIES = 4;
const MAX_QUERY_CHARS = 500;

/** The starts of the results the harness also shows the user (docsWarning). */
const LIMIT_ANON = "Error: Context7 rate limit reached (no API key";
const LIMIT_KEYED = "Error: Context7 rate limit reached for this API key";
const KEY_REJECTED = "Error: Context7 rejected the API key";

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface DocsOptions {
  /** The caller's cancel (esc / the stop button). */
  signal?: AbortSignal;
  /** The most characters the result may use (the agent's per-result cap). */
  maxChars?: number;
  apiKey?: string;
  /** Tests inject a fake; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
}

/** Library names or IDs: a comma list (or an array, if a model sends one), at most four. */
function libraryList(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return parts.map((p) => String(p).trim()).filter(Boolean).slice(0, MAX_LIBRARIES);
}

/** The search URL: the query plus a `library` parameter per library. */
export function docsUrl(query: string, library?: unknown): string {
  const params = new URLSearchParams({ query });
  for (const lib of libraryList(library)) params.append("library", lib);
  return `${CONTEXT7_SEARCH_URL}?${params}`;
}

interface Reply {
  status: number;
  body: string;
  reset: string | null;
}
type Outcome = Reply | { failure: "cancelled" | "timeout" | "network"; detail: string };

/** One GET with a deadline joined to the caller's signal; a 503 or a network
 * error is retried once after a short pause. */
async function get(url: string, opts: DocsOptions): Promise<Outcome> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  opts.signal?.addEventListener("abort", cancel, { once: true });
  if (opts.signal?.aborted) cancel();
  const headers: Record<string, string> = { accept: "text/plain" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const stopped = (detail = ""): Outcome =>
    opts.signal?.aborted ? { failure: "cancelled", detail } : timedOut ? { failure: "timeout", detail: `${Math.max(1, Math.round(timeoutMs / 1000))}s` } : { failure: "network", detail };
  try {
    for (let attempt = 1; ; attempt++) {
      if (controller.signal.aborted) return stopped();
      try {
        const res = await fetchImpl(url, { headers, signal: controller.signal });
        const body = await res.text();
        if (res.status !== 503 || attempt === 2) return { status: res.status, body, reset: res.headers.get("ratelimit-reset") };
      } catch (err: any) {
        if (controller.signal.aborted || attempt === 2) return stopped(String(err?.cause?.code ?? err?.message ?? err));
      }
      try { await abortableDelay(opts.retryDelayMs ?? RETRY_DELAY_MS, controller.signal); } catch { /* reported above */ }
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", cancel);
  }
}

/** " (resets 2026-12-01)" from Ratelimit-Reset (a unix time, or seconds from now). */
function resetNote(reset: string | null): string {
  const n = Number(reset);
  if (!reset || !Number.isFinite(n) || n <= 0) return "";
  const at = n > 1e9 ? n * 1000 : Date.now() + n * 1000;
  return `, resets ${new Date(at).toISOString().slice(0, 10)}`;
}

/** The server's own short message from a JSON error body, if any. */
function serverMessage(body: string): string {
  try {
    const m = JSON.parse(body)?.message;
    return typeof m === "string" && m.trim() ? `: ${m.trim().slice(0, 160)}` : "";
  } catch {
    return "";
  }
}

/** Cap the markdown at a snippet boundary (a "### Title" + "Source:" header or
 * a "---" separator), never mid-snippet, with a note saying more was cut. */
export function capDocs(text: string, maxChars: number): string {
  const doc = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (doc.length <= maxChars) return doc;
  const note = "\n\n[More documentation was cut. A narrower query or a library name gives more focused results.]";
  const room = Math.max(0, maxChars - note.length);
  let cut = -1;
  for (const re of [/\n(?=### [^\n]*\n\s*Source: )/g, /\n---(?=\n|$)/g]) {
    for (const m of doc.matchAll(re)) if (m.index! <= room && m.index! > cut) cut = m.index!;
  }
  // A library header or separator with nothing after it is noise.
  let body = cut > 0 ? doc.slice(0, cut).replace(/(?:\n+(?:---|Library: [^\n]*))+\s*$/, "").trimEnd() : "";
  if (!/^### /m.test(body)) {
    // The first snippet alone is over the cap: keep whole lines, close an open code fence.
    body = doc.slice(0, Math.max(0, room - 4));
    body = body.slice(0, Math.max(0, body.lastIndexOf("\n"))).trimEnd();
    if ((body.match(/^[ \t]*```/gm)?.length ?? 0) % 2) body += "\n```";
  }
  return body + note;
}

/** lookup_docs. Never throws: every outcome is a line the model can act on. */
export async function lookupDocs(args: Record<string, any>, opts: DocsOptions = {}): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim().slice(0, MAX_QUERY_CHARS) : "";
  if (!query) return 'Error: query is required. Example: {"query": "next.js 15 middleware redirect"}';
  const libs = libraryList(args.library);
  const reply = await get(docsUrl(query, libs), opts);
  if ("failure" in reply) {
    if (reply.failure === "cancelled") return "Error: docs lookup cancelled";
    if (reply.failure === "timeout") return `Error: context7.com did not answer within ${reply.detail}. Continue without the docs.`;
    return "Error: could not reach context7.com (offline?). Continue without the docs.";
  }
  const { status, body } = reply;
  const keyed = !!opts.apiKey;
  if (status === 200 && body.trim()) {
    const cap = Math.max(400, Math.min(DEFAULT_MAX_CHARS, opts.maxChars ?? DEFAULT_MAX_CHARS));
    return capDocs(body, cap);
  }
  if (status === 200 || status === 404)
    return `No documentation found for "${query}"${libs.length ? ` in ${libs.join(", ")}` : ""}. Reword the query, or name the library (e.g. "library": "react").`;
  if (status === 429) {
    const resets = resetNote(reply.reset);
    return keyed
      ? `${LIMIT_KEYED}${resets ? ` (${resets.slice(2)})` : ""}. Continue without the docs.`
      : `${LIMIT_ANON}: ${ANON_MONTHLY_LIMIT} lookups a month${resets}). Continue without the docs; the user can add a free API key with /docs key.`;
  }
  if (status === 401 || status === 403)
    return keyed
      ? `${KEY_REJECTED} (HTTP ${status}). Continue without the docs; the user can fix or remove it with /docs key.`
      : `Error: Context7 refused the request (HTTP ${status}). Continue without the docs.`;
  if (status === 503) return "Error: Context7 search is temporarily unavailable (HTTP 503). Continue without the docs.";
  return `Error: Context7 search failed (HTTP ${status}${serverMessage(body)}). Continue without the docs.`;
}

/** For the user, once per session: the limit or key problems a model would
 * only mention in passing (null for every other result). */
export function docsWarning(output: string): string | null {
  if (output.startsWith(LIMIT_ANON))
    return `· Context7's free limit (${ANON_MONTHLY_LIMIT} lookups/month) is used up — add a free key with /docs key (from context7.com/dashboard)`;
  if (output.startsWith(LIMIT_KEYED)) return "· Context7's rate limit for your API key is reached — lookups work again once it resets";
  if (output.startsWith(KEY_REJECTED)) return "· Context7 rejected your API key — fix or remove it with /docs key";
  return null;
}

export type KeyCheck = "ok" | "rejected" | "limited" | "unreachable";

/** Try a key with one small search before it is saved: "rejected" (401/403)
 * keys are not saved; "unreachable" ones are, unchecked. */
export async function verifyContext7Key(key: string, opts: Omit<DocsOptions, "apiKey" | "maxChars"> = {}): Promise<KeyCheck> {
  const reply = await get(docsUrl("useState", "react"), { timeoutMs: 10_000, ...opts, apiKey: key });
  if ("failure" in reply) return "unreachable";
  if (reply.status === 401 || reply.status === 403) return "rejected";
  if (reply.status === 429) return "limited";
  return reply.status >= 500 ? "unreachable" : "ok";
}

/** "…abcd": the most of a key that is ever shown. */
export function keyTail(key: string): string {
  return key.length >= 8 ? `…${key.slice(-4)}` : "…";
}
