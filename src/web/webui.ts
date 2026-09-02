// WebUI: the --web session surface. Same AgentUI/SessionUI contract as the
// terminal Tui, but events stream to a browser page over SSE and input comes
// back over JSON POSTs. Localhost-only, guarded by a random URL token so a
// stray local process or webpage can't drive the agent.

import * as crypto from "crypto";
import * as http from "http";
import { Plan } from "../plan";
import { SelectOption, SessionUI, SlashCommand, summarizeArgs } from "../ui";
import { PAGE_HTML } from "./page";

type Event = Record<string, any>;

export class WebUI implements SessionUI {
  slashCommands: SlashCommand[] = [];
  getStatus: () => string = () => "";
  /** Structured snapshot for the page's status bar; assigned by index.ts. */
  getState: () => Record<string, any> = () => ({});
  hintLeft = "";
  onModeCycle: (() => void) | null = null;
  onCancel: (() => void) | null = null;
  onExit: (() => void) | null = null;

  readonly authToken = crypto.randomBytes(9).toString("base64url");
  private server: http.Server | null = null;
  private clients = new Set<http.ServerResponse>();
  private replay: string[] = [];
  private pendingInput: ((s: string) => void) | null = null;
  private inputQueue: string[] = [];
  private pending = new Map<number, (v: any) => void>();
  private askId = 0;

  constructor(private port: number) {}

  url(): string {
    return `http://127.0.0.1:${this.port}/?k=${this.authToken}`;
  }

  start(): void {
    this.server = http.createServer((req, res) => this.route(req, res));
    this.server.listen(this.port, "127.0.0.1", () => {
      console.log(`\n  smolcoder web UI:  ${this.url()}\n`);
    });
    process.on("SIGINT", () => this.onExit?.());
  }

  close(): void {
    for (const c of this.clients) c.end();
    this.server?.close();
  }

  // ---- http ----------------------------------------------------------------

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const origin = req.headers.origin;
    const sameOrigin =
      !origin || origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
    if (url.searchParams.get("k") !== this.authToken || !sameOrigin) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden — open smolcoder's printed URL (it includes the session key)");
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const line of this.replay) res.write(line);
      this.pushStateTo(res);
      this.clients.add(res);
      req.on("close", () => this.clients.delete(res));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (d) => {
        body += d;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        let data: any = {};
        try {
          data = body ? JSON.parse(body) : {};
        } catch {
          /* ignore */
        }
        this.handlePost(url.pathname, data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }

  private handlePost(path: string, data: any): void {
    switch (path) {
      case "/msg": {
        const text = String(data.text ?? "").trim();
        if (!text) return;
        if (this.pendingInput) {
          const resolve = this.pendingInput;
          this.pendingInput = null;
          this.broadcast({ t: "user", s: text });
          resolve(text);
        } else {
          this.inputQueue.push(text);
        }
        break;
      }
      case "/confirm":
      case "/select": {
        const resolve = this.pending.get(Number(data.id));
        if (resolve) {
          this.pending.delete(Number(data.id));
          resolve(path === "/confirm" ? data.answer : data.index);
        }
        break;
      }
      case "/cycle":
        this.onModeCycle?.();
        this.refresh();
        break;
      case "/cancel":
        this.onCancel?.();
        break;
    }
  }

  // ---- event plumbing ------------------------------------------------------

  private broadcast(ev: Event): void {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    if (ev.t !== "busy" && ev.t !== "state") {
      this.replay.push(line);
      if (this.replay.length > 2000) this.replay.shift();
    }
    for (const c of this.clients) c.write(line);
  }

  private pushStateTo(res?: http.ServerResponse): void {
    const line = `data: ${JSON.stringify({ t: "state", s: this.getState() })}\n\n`;
    if (res) res.write(line);
    else for (const c of this.clients) c.write(line);
  }

  refresh(): void {
    this.pushStateTo();
  }

  // ---- SessionUI -----------------------------------------------------------

  readInput(): Promise<string> {
    this.pushStateTo();
    if (this.inputQueue.length) {
      const text = this.inputQueue.shift()!;
      this.broadcast({ t: "user", s: text });
      return Promise.resolve(text);
    }
    return new Promise((resolve) => (this.pendingInput = resolve));
  }

  select(title: string, options: SelectOption[]): Promise<number | null> {
    const id = ++this.askId;
    this.broadcast({ t: "select", id, title, options });
    return new Promise((resolve) =>
      this.pending.set(id, (i) => resolve(typeof i === "number" ? i : null))
    );
  }

  confirmCommand(command: string, reason?: string): Promise<"yes" | "no" | "always"> {
    const id = ++this.askId;
    this.broadcast({ t: "confirm", id, command, reason });
    return new Promise((resolve) =>
      this.pending.set(id, (a) => resolve(a === "always" ? "always" : a === "yes" ? "yes" : "no"))
    );
  }

  // ---- AgentUI -------------------------------------------------------------

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
    this.pushStateTo();
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
    this.pushStateTo();
  }

  startSpinner(label: string): void {
    this.broadcast({ t: "busy", label });
  }

  stopSpinner(): void {
    this.broadcast({ t: "busy", label: null });
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
