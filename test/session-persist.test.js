// TUI sessions are saved through the web hub's SessionStore, listed per
// workspace by /sessions (grouped by day), and resumed: transcript into the
// agent, a compact replay on screen, and web-readable replay events on disk.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smol-persist-")), "config.json");
process.env.SMOLCODER_CONFIG = CONFIG;

const { Session } = require("../dist/session");
const { SessionStore, WorkspaceStore } = require("../dist/web/store");
const { dayLabel, eventsFromMessages, sessionOptions } = require("../dist/transcript");
const { SessionChannel } = require("../dist/web/channel");

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function serveOllama(model, reply) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/chat" && json.messages?.length) {
        res.setHeader("content-type", "application/x-ndjson");
        res.write(JSON.stringify({ message: { role: "assistant", content: reply }, done: false }) + "\n");
        res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 40, eval_count: 4 }) + "\n");
      } else res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function scriptedUI({ inputs = [], picks = [] } = {}) {
  const shown = { selects: [], lines: [], tokens: [], tools: [], warnings: [] };
  return {
    shown,
    slashCommands: [], getStatus: () => "", hintLeft: "", onModeCycle: null, onCancel: null, onExit: null,
    start() {}, close() {}, refresh() {},
    async readInput() { return inputs.shift() ?? "/exit"; },
    async select(title, options) {
      shown.selects.push({ title, options });
      const want = picks.shift();
      const idx = options.findIndex((o) => o.label === want);
      return idx < 0 ? null : idx;
    },
    async prompt() { return null; },
    token(s) { shown.tokens.push(s); }, thinking() {}, toolCall(name) { shown.tools.push(name); }, toolResult() {}, turnEnd() {}, planUpdated() {}, resetResponse() {},
    println(s = "") { shown.lines.push(strip(s)); },
    status(s) { shown.lines.push(strip(s)); },
    warn(s) { shown.warnings.push(strip(s)); },
    error(s) { shown.warnings.push(strip(s)); },
    startSpinner() {}, stopSpinner() {},
    async confirmCommand() { return "no"; },
  };
}

test("a TUI session saves itself after each turn and on exit, readable by the web hub", async () => {
  const ollama = await serveOllama("m:1b", "Hello back.");
  try {
    const data = tmp("smol-persist-data-");
    const ws = tmp("smol-persist-ws-");
    const store = new SessionStore(data);
    const ui = scriptedUI({ inputs: ["fix   the\nlogin bug"] });
    const chosen = { id: "m:1b", backend: "ollama", baseUrl: ollama.base, contextWindow: 8192, toolsSupported: true };
    const session = new Session(ui, { workspace: ws, chosen, prefs: {}, cfg: {}, dataDir: data });
    const id = session.persistTo(store);
    assert.equal(session.sessionId, id);
    assert.deepEqual(store.listMetas(), [], "nothing saved before a request");
    await session.run();

    const [meta] = store.listForWorkspace(ws);
    assert.equal(meta.id, id);
    assert.equal(meta.title, "fix the login bug");
    assert.equal(meta.model, "m:1b");
    assert.equal(meta.messages, 2);
    const body = store.loadBody(id);
    assert.equal(body.snapshot.model, "m:1b");
    assert.deepEqual(body.events.map((e) => e.t), ["user", "token"]);
    assert.equal(body.events[1].s, "Hello back.");
    // The web sidebar knows the workspace; a SessionChannel accepts the events.
    assert.ok(new WorkspaceStore(data).has(ws));
    const ch = new SessionChannel("x", { send() {}, changed() {}, touched() {} });
    ch.restoreReplay(body.events);
    assert.equal(ch.replay.length, 2);
    // Another workspace's list is empty.
    assert.deepEqual(store.listForWorkspace(tmp("smol-other-")), []);
  } finally {
    await ollama.close();
  }
});

test("/sessions lists this workspace's sessions by day and resumes one into the agent", async () => {
  const data = tmp("smol-resume-data-");
  const ws = tmp("smol-resume-ws-");
  const store = new SessionStore(data);
  const now = Date.now();
  const messages = [
    { role: "user", content: "add a --json flag" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "cli.ts" } }] },
    { role: "tool", content: "export function main() {}", toolCallId: "c1", toolName: "read_file" },
    { role: "assistant", content: "Added the flag." },
  ];
  const snapshot = { messages, plan: [{ text: "add flag", done: true }], filesTouched: ["cli.ts"], commandsRun: [], originalRequest: "add a --json flag", currentRequest: "add a --json flag", mode: "edit", effort: null, model: "old:7b", backend: "ollama" };
  store.saveMeta({ id: "aaaa1111", workspace: ws, title: "Add a JSON flag", createdAt: now - 1000, updatedAt: now - 1000, model: "old:7b" });
  await store.saveBody("aaaa1111", { snapshot, events: eventsFromMessages(messages) });
  store.saveMeta({ id: "bbbb2222", workspace: ws, title: "Older work", createdAt: now - 3 * 86400000, updatedAt: now - 3 * 86400000 });
  await store.saveBody("bbbb2222", { snapshot: { ...snapshot, messages: [{ role: "user", content: "hi" }] }, events: [] });
  store.saveMeta({ id: "cccc3333", workspace: tmp("smol-elsewhere-"), title: "Elsewhere", createdAt: now, updatedAt: now });

  const ui = scriptedUI({ inputs: ["/sessions"], picks: ["Add a JSON flag"] });
  const chosen = { id: "new:8b", backend: "ollama", baseUrl: "http://127.0.0.1:9", contextWindow: 8192, toolsSupported: true };
  const session = new Session(ui, { workspace: ws, chosen, prefs: {}, cfg: {}, dataDir: data });
  session.persistTo(store);
  await session.run();

  const picker = ui.shown.selects[0];
  assert.equal(picker.title, "Resume session");
  assert.deepEqual(picker.options.map((o) => [o.group, o.label]), [["Today", "Add a JSON flag"], [dayLabel(now - 3 * 86400000, now), "Older work"]]);
  assert.match(picker.options[0].hint, /^2 messages · \d\d:\d\d · old:7b$/);

  // The agent has the transcript; the plan and touched files came back.
  assert.deepEqual(session.agent.messages.slice(1).map((m) => m.content), messages.map((m) => m.content));
  assert.equal(session.toolCtx.plan.steps[0].text, "add flag");
  assert.ok(session.toolCtx.filesTouched.has("cli.ts"));
  // Replayed compactly on screen.
  assert.ok(ui.shown.lines.includes("› add a --json flag"));
  assert.deepEqual(ui.shown.tools, ["read_file"]);
  assert.deepEqual(ui.shown.tokens, ["Added the flag."]);
  assert.ok(ui.shown.lines.some((l) => /resumed "Add a JSON flag" — 2 messages · it used old:7b/.test(l)));
  // Saving now continues that session, not a new one.
  assert.equal(session.sessionId, "aaaa1111");
  assert.equal(store.listForWorkspace(ws).length, 2);
  assert.equal(store.loadBody("aaaa1111").snapshot.model, "new:8b");
});

test("/sessions without a store (the web hub) points at the sidebar; day labels", async () => {
  const ui = scriptedUI({ inputs: ["/sessions"] });
  const chosen = { id: "x:1b", backend: "ollama", baseUrl: "http://127.0.0.1:9", contextWindow: 8192 };
  const session = new Session(ui, { workspace: tmp("smol-nostore-"), chosen, prefs: {}, cfg: {}, dataDir: tmp("smol-nostore-data-") });
  await session.run();
  assert.ok(ui.shown.lines.some((l) => /sidebar/.test(l)));
  assert.equal(ui.shown.selects.length, 0);

  const day = new Date(2026, 10, 6, 15, 0).getTime();
  assert.equal(dayLabel(day, day), "Today");
  assert.equal(dayLabel(day - 86400000, day), "Yesterday");
  assert.equal(dayLabel(new Date(2026, 10, 2, 9).getTime(), day), "Mon 2 Nov 2026");
  assert.deepEqual(sessionOptions([{ id: "a", workspace: "/w", title: "", createdAt: day, updatedAt: day }], day)[0].label, "(untitled)");
});
