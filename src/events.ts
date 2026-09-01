// Internal lifecycle event bus. Handlers run sequentially and may be async,
// so a pre_request handler can finish compaction before the request goes out.
// Not user-configurable in v1 by design — this is the spine that compaction,
// the context meter, and logging hang off. User-facing hooks can come later.

export type LifecycleEvent =
  | "session_start"
  | "pre_request"
  | "post_tool"
  | "pre_compact"
  | "post_compact"
  | "session_end";

type Handler = (payload?: any) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<LifecycleEvent, Handler[]>();

  on(event: LifecycleEvent, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async emit(event: LifecycleEvent, payload?: any): Promise<void> {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const h of list) {
      await h(payload);
    }
  }
}
