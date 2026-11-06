import { isMainThread, parentPort, workerData, Worker } from "worker_threads";
import { ripgrepAvailable, searchFiles } from "./fs-tools";

if (!isMainThread) parentPort!.postMessage(searchFiles(workerData.root, workerData.args, { rg: workerData.rg }));

/** A pathological regex can be terminated without freezing the agent/UI. */
export function searchFilesBounded(root: string, args: Record<string, any>, signal?: AbortSignal, timeoutMs = 5000, opts: { rg?: boolean } = {}): Promise<string> {
  if (signal?.aborted) return Promise.resolve("Error: search cancelled");
  // Probe ripgrep once in this process, not in every short-lived worker.
  const rg = opts.rg ?? ripgrepAvailable();
  return new Promise((resolve) => {
    const worker = new Worker(__filename, { workerData: { root, args, rg } });
    let settled = false;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      void worker.terminate();
      resolve(result);
    };
    const cancel = () => finish("Error: search cancelled");
    const timer = setTimeout(() => finish("Error: search timed out. Use a simpler pattern or search a smaller folder."), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.once("message", finish);
    worker.once("error", (err) => finish(`Error: search failed: ${err.message}`));
    worker.once("exit", (code) => { if (!settled) finish(`Error: search worker exited (${code})`); });
  });
}
