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
