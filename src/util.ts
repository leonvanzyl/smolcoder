// Small shared helpers. Zero dependencies: ANSI codes are written by hand.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code: string, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  dim: (s: string) => wrap("2", s),
  bold: (s: string) => wrap("1", s),
  cyan: (s: string) => wrap("36", s),
  green: (s: string) => wrap("32", s),
  yellow: (s: string) => wrap("33", s),
  red: (s: string) => wrap("31", s),
  magenta: (s: string) => wrap("35", s),
  gray: (s: string) => wrap("90", s),
};

/** Rough token estimate: ~4 chars per token. Corrected by real usage after each request. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Cap a string in the middle, keeping head and tail — best shape for command output. */
export function truncateMiddle(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = s.length - maxChars;
  return (
    s.slice(0, head) +
    `\n... [${omitted} characters omitted to save context] ...\n` +
    s.slice(s.length - tail)
  );
}

export function truncateEnd(s: string, maxChars: number, note?: string): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n... [truncated${note ? ": " + note : ""}]`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

/** Like tryFetchJson, but also says whether anything answered at all — a 404
 * from a live server is worth a follow-up request, a dead address is not. */
export async function probeJson(url: string, timeoutMs = 1500): Promise<{ reached: boolean; data: any | null }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { reached: true, data: null };
    return { reached: true, data: await res.json().catch(() => null) };
  } catch {
    return { reached: false, data: null };
  } finally {
    clearTimeout(t);
  }
}

/** fetch with a hard timeout; returns null on any failure (used for detection probes). */
export async function tryFetchJson(
  url: string,
  init?: RequestInit,
  timeoutMs = 1500
): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Fuzzy match score for pickers and menus: the query's characters must appear
 * in order. Higher is better; null means no match. Bonuses for a prefix match,
 * matches at word starts and runs of adjacent characters. Self-contained (no
 * outside references) so the web client can embed it via `fuzzyScore.toString()`. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    // Prefer a word-start occurrence ahead of the cursor, else the next one.
    for (let k = ti; k < t.length; k++) {
      if (t[k] !== ch) continue;
      const before = k === 0 ? " " : t[k - 1];
      if (/[^a-z0-9]/.test(before)) { found = k; break; }
      if (found < 0) found = k;
    }
    if (found < 0) return null;
    const before = found === 0 ? " " : t[found - 1];
    score += 1;
    if (/[^a-z0-9]/.test(before)) score += 8;
    if (found === prev + 1) score += 5;
    prev = found;
    ti = found + 1;
  }
  if (t.includes(q)) score += 40;
  return score - t.length * 0.05;
}

/** Rank items by the best fuzzy score over their fields; earlier fields weigh
 * more (field i is scaled by 1 / (i + 1)). Ties keep the original order. */
export function fuzzyFilter<T>(query: string, items: T[], fields: (item: T) => (string | undefined)[]): T[] {
  if (!query.trim()) return items.slice();
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    let best: number | null = null;
    fields(item).forEach((f, fi) => {
      if (!f) return;
      const s = fuzzyScore(query, f);
      if (s === null) return;
      const w = s / (fi + 1);
      if (best === null || w > best) best = w;
    });
    if (best !== null) scored.push({ item, score: best, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}
