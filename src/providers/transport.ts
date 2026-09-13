import { ChatOptions } from "./types";

/** Fail visibly when a local server accepts a request but stops producing data. */
export async function withDeadline<T>(opts: ChatOptions, run: (signal: AbortSignal, activity: () => void) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(opts.signal?.reason);
  let idle: NodeJS.Timeout;
  const activity = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error("Backend timed out waiting for data. Check the model server and available memory.")), opts.idleTimeoutMs ?? 180_000);
  };
  const total = setTimeout(() => controller.abort(new Error("Backend request timed out. The model did not finish within the request deadline.")), opts.timeoutMs ?? 900_000);
  opts.signal?.addEventListener("abort", cancel, { once: true });
  if (opts.signal?.aborted) cancel();
  activity();
  try {
    return await run(controller.signal, activity);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(idle!);
    clearTimeout(total);
    opts.signal?.removeEventListener("abort", cancel);
  }
}

/** Cancel reads and release the connection even on malformed stream data. */
export async function* responseLines(res: Response, activity: () => void): AsyncGenerator<string> {
  if (!res.body) throw new Error("Backend returned an empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      activity();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 4_000_000) throw new Error("Backend stream frame exceeded 4 MB");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        yield buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.trim();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function streamJson(line: string): any {
  let data: any;
  try { data = JSON.parse(line); }
  catch { throw new Error("Backend stream contained malformed JSON; the response was discarded"); }
  if (data?.error) throw new Error(`Backend stream error: ${typeof data.error === "string" ? data.error : data.error.message ?? JSON.stringify(data.error)}`);
  return data;
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
