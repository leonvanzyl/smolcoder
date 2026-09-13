import { ChatOptions } from "./types";

interface Job {
  background: boolean;
  controller: AbortController;
  start: () => void;
}
const servers = new Map<string, { active?: Job; queue: Job[] }>();

/** One inference per server. Coding preempts optional summaries and titles,
 * avoiding a second model/KV allocation just to do maintenance. */
export function scheduleInference<T>(server: string, opts: ChatOptions, run: (opts: ChatOptions) => Promise<T>): Promise<T> {
  let state = servers.get(server);
  if (!state) { state = { queue: [] }; servers.set(server, state); }
  const queue = state;
  if (opts.background && (queue.active || queue.queue.length)) return Promise.reject(new Error("Background inference deferred: server is busy"));
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const job: Job = { background: !!opts.background, controller, start: () => {} };
    const cancel = () => {
      controller.abort(opts.signal?.reason);
      const index = queue.queue.indexOf(job);
      if (index >= 0) { queue.queue.splice(index, 1); opts.signal?.removeEventListener("abort", cancel); reject(controller.signal.reason); }
    };
    job.start = () => {
      queue.active = job;
      if (opts.signal?.aborted) cancel();
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return run({ ...opts, signal: controller.signal });
      }).then(resolve, reject).finally(() => {
        opts.signal?.removeEventListener("abort", cancel);
        queue.active = undefined;
        const next = queue.queue.shift();
        if (next) next.start(); else servers.delete(server);
      });
    };
    opts.signal?.addEventListener("abort", cancel, { once: true });
    if (queue.active) {
      queue.queue.push(job);
      if (!job.background && queue.active.background) queue.active.controller.abort();
      if (opts.signal?.aborted) cancel();
    } else job.start();
  });
}
