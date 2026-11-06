// Regressions from the review: edit_file's already-applied check, re-indent
// and typographic tiers; the TypeScript check out of process; stale reads
// and prepared compactions; calibration, summary fallback and overflow
// recovery; /undo state and saved replay; resumed transcripts; alt keys that
// open terminal strings.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

process.env.SMOLCODER_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smol-fix-cfg-")), "config.json");

const { editFile } = require("../dist/tools/fs-tools");
const { syntaxCheck } = require("../dist/tools/check");
const { executeTool } = require("../dist/tools/index");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");
const { ContextManager } = require("../dist/context");
const { Agent } = require("../dist/agent");
const { EventBus } = require("../dist/events");
const { replayTranscript, eventsFromMessages } = require("../dist/transcript");
const { KeyDecoder } = require("../dist/tui/keys");
const { OllamaProvider } = require("../dist/providers/ollama");
const { Session } = require("../dist/session");
const { SessionStore } = require("../dist/web/store");

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* busy */ } });
  return dir;
}

function edit(t, file, args, applied) {
  const dir = tmp(t, "smol-fix-edit-");
  fs.writeFileSync(path.join(dir, "f.py"), file);
  const out = editFile(dir, { path: "f.py", ...args }, {}, applied);
  return { out, text: fs.readFileSync(path.join(dir, "f.py"), "utf8"), dir };
}

// ---- edit_file ----------------------------------------------------------------

const TWO_CLASSES = "class A:\n    def get(self):\n        return self.value\n\nclass B:\n    def get(self):\n        return self.val\n";

test("a typo in old_text is not 'already applied' because a new_text line exists elsewhere", (t) => {
  const { out, text } = edit(t, TWO_CLASSES, { old_text: "        return self.vall", new_text: "        return self.value" });
  assert.match(out, /^Error: old_text was not found in f\.py\. Closest source starts at line 5/);
  assert.equal(text, TWO_CLASSES);
});

test("a repeated edit is still recognised: at old_text's closest match, or remembered from this session", (t) => {
  const done = TWO_CLASSES.replace("return self.val\n", "return self.value\n");
  const { out } = edit(t, done, { old_text: "        return self.val", new_text: "        return self.value" });
  assert.match(out, /^No change: f\.py already contains new_text/);
  // Elsewhere in the file, but this exact edit succeeded earlier.
  const applied = new Set();
  const dir = tmp(t, "smol-fix-edit-");
  fs.writeFileSync(path.join(dir, "f.py"), "def run():\n    start_the_engine(fast=True)\n");
  assert.match(editFile(dir, { path: "f.py", old_text: "    start_the_engine(fast=True)", new_text: "    stop()" }, {}, applied), /^Edited/);
  assert.match(editFile(dir, { path: "f.py", old_text: "    start_the_engine(fast=True)", new_text: "    stop()" }, {}, applied), /^No change/);
});

test("new_text already at the file's depth is not indented twice", (t) => {
  const { out, text } = edit(t, "class A:\n    def f(self):\n        if a:\n            return x\n", { old_text: "if a:\n    return x", new_text: "        if a:\n            return y" });
  assert.match(out, /^Edited/);
  assert.equal(text, "class A:\n    def f(self):\n        if a:\n            return y\n");
});

test("quotes old_text matched only after normalising are normalised in new_text too", (t) => {
  const { text } = edit(t, 'print("hello")\nx = 1\n', { old_text: "print(“hello”)", new_text: "print(“hello world”)" });
  assert.equal(text, 'print("hello world")\nx = 1\n');
  // The line tier does the same.
  const r = edit(t, 'if x:\n    say("hi")\n', { old_text: "  if x:\n      say(“hi”)", new_text: "  if x:\n      say(“hi there”)" });
  assert.equal(r.text, 'if x:\n    say("hi there")\n');
});

test("re-indenting translates spaces to the file's tabs, and tabs to its spaces", (t) => {
  const tabs = edit(t, "def f():\n\tif x:\n\t\ta()\n", { old_text: "    if x:\n        a()", new_text: "    if x:\n        a()\n        b()" });
  assert.equal(tabs.text, "def f():\n\tif x:\n\t\ta()\n\t\tb()\n");
  const spaces = edit(t, "def f():\n  if x:\n    a()\n", { old_text: "\tif x:\n\t\ta()", new_text: "\tif x:\n\t\ta()\n\t\tb()" });
  assert.equal(spaces.text, "def f():\n  if x:\n    a()\n    b()\n");
});

// ---- TypeScript check -----------------------------------------------------------

const FAKE_TS = (body) => `${body}
module.exports = {
  DiagnosticCategory: { Error: 1 },
  flattenDiagnosticMessageText: (m) => m,
  transpileModule: (src) => ({ diagnostics: src.includes("BAD") ? [{ file: { getLineAndCharacterOfPosition: () => ({ line: 2 }) }, start: 0, category: 1, messageText: "fake error" }] : [] }),
};`;

test("the workspace's typescript.js runs in a child process, never in smolcoder's", async (t) => {
  const ws = tmp(t, "smol-fix-ts-");
  const ctx = { workspace: ws, plan: new Plan(), taskManager: new TaskManager(ws), filesTouched: new Set(), commandsRun: [] };
  const pidFile = path.join(ws, "pid.txt");
  const payload = FAKE_TS(`require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`);
  await executeTool("write_file", { path: "node_modules/typescript/lib/typescript.js", content: payload }, ctx);
  const out = await executeTool("write_file", { path: "src/a.ts", content: "BAD\n" }, ctx);
  assert.match(out, /Warning: src\/a\.ts has a TypeScript syntax error at line 3: fake error/);
  assert.ok(fs.existsSync(pidFile));
  assert.notEqual(fs.readFileSync(pidFile, "utf8"), String(process.pid));
  // When the trust rules would ask, the check is skipped and nothing runs.
  fs.rmSync(pidFile);
  const asks = { ...ctx, mayRunUnasked: () => false };
  assert.doesNotMatch(await executeTool("write_file", { path: "src/b.ts", content: "BAD\n" }, asks), /Warning/);
  assert.equal(fs.existsSync(pidFile), false);
});

test("a missing compiler is looked for again on the next write", (t) => {
  const ws = tmp(t, "smol-fix-ts-");
  const file = path.join(ws, "a.ts");
  fs.writeFileSync(file, "BAD\n");
  assert.equal(syntaxCheck(file, "a.ts", ws), null);
  fs.mkdirSync(path.join(ws, "node_modules", "typescript", "lib"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "typescript", "lib", "typescript.js"), FAKE_TS(""));
  assert.match(syntaxCheck(file, "a.ts", ws), /TypeScript syntax error at line 3: fake error/);
});

// ---- context ----------------------------------------------------------------------

const handover = { content: "In progress: a\nNext: b\nNotes: c", toolCalls: [], truncated: false };
const state = () => ({ originalRequest: "do the task", filesTouched: new Set(), commandsRun: [] });

test("a stale read is stubbed when manage() uses a prepared background compaction", async () => {
  const cm = new ContextManager(8000, 1000);
  const provider = { chat: async () => handover };
  const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "do the task" }];
  for (let i = 0; i < 7; i++) {
    msgs.push({ role: "assistant", content: "", toolCalls: [{ id: "c" + i, name: "list_files", args: { path: "d" + i } }] });
    msgs.push({ role: "tool", toolCallId: "c" + i, toolName: "list_files", content: "z".repeat(2000) });
  }
  msgs.push({ role: "assistant", content: "", toolCalls: [{ id: "r", name: "read_file", args: { path: "x.js" } }] });
  msgs.push({ role: "tool", toolCallId: "r", toolName: "read_file", content: "OLD_X_CONTENT ".repeat(150) });
  cm.prepareBackground(msgs, [], provider, state(), 0);
  await cm["background"].work;
  assert.ok(cm["prepared"], "a compaction was prepared");
  msgs.push({ role: "assistant", content: "", toolCalls: [{ id: "w", name: "write_file", args: { path: "x.js", content: "new" } }] });
  assert.equal(cm.noteStaleReads(msgs, "x.js"), 1);
  msgs.push({ role: "tool", toolCallId: "w", toolName: "write_file", content: "Overwrote x.js" });
  msgs.push({ role: "assistant", content: "", toolCalls: [{ id: "q", name: "list_files", args: {} }] });
  msgs.push({ role: "tool", toolCallId: "q", toolName: "list_files", content: "q".repeat(5000) });
  const r = await cm.manage(msgs, [], provider, state());
  assert.equal(r.report.action, "compacted");
  assert.ok(!r.messages.some((m) => m.role === "tool" && m.content.includes("OLD_X_CONTENT")));
});

test("a same-prefix summary that was cut off or empty goes straight to the digest", async () => {
  for (const first of [{ content: "In progress: half", toolCalls: [], truncated: true }, { content: "", toolCalls: [] }]) {
    const cm = new ContextManager(16000, 2000);
    const calls = [];
    const provider = {
      chat: async (messages, tools) => { calls.push(tools.length ? "same-prefix" : "digest"); return calls.length === 1 ? first : handover; },
    };
    const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "do the task" }, { role: "assistant", content: "working" }];
    const r = await cm.manage(msgs, [{ name: "read_file", description: "d", parameters: {} }], provider, state(), { force: true });
    assert.deepEqual(calls, ["same-prefix", "digest"]);
    assert.match(r.messages[1].content, /Next: b/);
    assert.doesNotMatch(r.messages[1].content, /half/);
  }
});

test("a shrunk overflow budget grows back one step after clean requests", () => {
  const cm = new ContextManager(16384, 4096);
  const msgs = [{ role: "system", content: "x".repeat(400) }];
  cm.shrinkForOverflow();
  cm.shrinkForOverflow();
  assert.equal(cm.overflowShare, 0.7);
  for (let i = 0; i < 7; i++) cm.calibrate(100, msgs, []);
  assert.equal(cm.overflowShare, 0.7);
  cm.calibrate(100, msgs, []);
  assert.equal(cm.overflowShare, 0.85);
  for (let i = 0; i < 8; i++) cm.calibrate(100, msgs, []);
  assert.equal(cm.overflowShare, 1);
});

test("Ollama: a cached count larger than prompt_eval_count is added to it", async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/x-ndjson");
      res.end(JSON.stringify({ message: { role: "assistant", content: "hi" }, done: true, done_reason: "stop", prompt_eval_count: 40, prompt_eval_cached_count: 2000, eval_count: 2 }) + "\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const p = new OllamaProvider(`http://127.0.0.1:${server.address().port}`, "m:1b", 8192);
  const res = await p.chat([{ role: "user", content: "x" }], [], {});
  assert.equal(res.promptTokens, 2040);
});

// ---- agent --------------------------------------------------------------------------

function fakeUi() {
  return {
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {}, warn() {}, error() {},
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "yes"; }, turnEnd() {}, planUpdated() {},
  };
}

function makeAgent(t, provider, cm) {
  const ws = tmp(t, "smol-fix-agent-");
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  const agent = new Agent(provider, "bypass", "sys", toolCtx, cm, new EventBus(), fakeUi(), false, 30);
  return { agent, ws, toolCtx };
}

test("a progress check's prepared compaction survives the feedback it appends", async (t) => {
  let calls = 0;
  const provider = { label: "fake", contextWindow: 8000, maxOutputTokens: 1000, chat: async () => { calls++; return handover; } };
  const cm = new ContextManager(8000, 1000);
  const { agent, ws } = makeAgent(t, provider, cm);
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { build: "node -e \"\"" } }));
  const msgs = [agent.messages[0], { role: "user", content: "do the task" }];
  for (let i = 0; i < 8; i++) {
    msgs.push({ role: "assistant", content: "", toolCalls: [{ id: "c" + i, name: "read_file", args: { path: "f" + i } }] });
    msgs.push({ role: "tool", toolCallId: "c" + i, toolName: "read_file", content: "x".repeat(2400) });
  }
  agent.messages = msgs;
  agent.originalRequest = "do the task";
  assert.equal(await agent["checkProgress"](new AbortController().signal), true);
  await cm["background"]?.work;
  assert.match(agent.messages.at(-1).content, /\[Project checks passed/);
  assert.ok(cm["prepared"], "prepared");
  agent.messages.push({ role: "assistant", content: "", toolCalls: [{ id: "z", name: "read_file", args: { path: "z" } }] });
  agent.messages.push({ role: "tool", toolCallId: "z", toolName: "read_file", content: "y".repeat(2400) });
  const before = calls;
  const r = await cm.manage(agent.messages, [], provider, state());
  assert.equal(r.report.action, "compacted");
  assert.equal(calls, before, "the prepared summary was used, not a new one");
});

test("undo puts back stale reads, touched files, commands and untouched message objects", async (t) => {
  const body = "const big = 1;\n".repeat(200);
  let step = 0;
  const replies = [
    { content: "", toolCalls: [{ id: "r1", name: "read_file", args: { path: "x.js" } }] },
    { content: "read it", toolCalls: [] },
    { content: "", toolCalls: [{ id: "w1", name: "write_file", args: { path: "x.js", content: "new\n" } }] },
    { content: "", toolCalls: [{ id: "k1", name: "run_command", args: { command: "node -e \"\"" } }] },
    { content: "rewrote it", toolCalls: [] },
  ];
  const provider = { label: "fake", contextWindow: 16000, maxOutputTokens: 2000, chat: async () => ({ promptTokens: 500, completionTokens: 10, ...replies[step++] }) };
  const cm = new ContextManager(16000, 2000);
  const { agent, ws, toolCtx } = makeAgent(t, provider, cm);
  fs.writeFileSync(path.join(ws, "x.js"), body);
  await agent.runTurn("read x.js");
  const readMsg = agent.messages.find((m) => m.role === "tool" && m.toolCallId === "r1");
  const original = readMsg.content;
  await agent.runTurn("rewrite x.js");
  assert.equal(cm.pendingStaleReads().length, 1);
  assert.ok(toolCtx.filesTouched.has("x.js"));
  assert.equal(toolCtx.commandsRun.length, 1);
  readMsg.content = "[evicted in place]"; // what an eviction does to a shared object
  assert.match(await agent.undoLastTurn(), /^Undid the last turn: restored x\.js/);
  assert.equal(fs.readFileSync(path.join(ws, "x.js"), "utf8"), body);
  assert.deepEqual(cm.pendingStaleReads(), []);
  assert.equal(toolCtx.filesTouched.size, 0);
  assert.deepEqual(toolCtx.commandsRun, []);
  assert.equal(agent.messages.find((m) => m.toolCallId === "r1").content, original);
});

// ---- saved session replay --------------------------------------------------------------

async function serveOllama(reply) {
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const json = b ? JSON.parse(b) : {};
      if (req.url === "/api/chat" && json.messages?.length) {
        res.setHeader("content-type", "application/x-ndjson");
        res.end(JSON.stringify({ message: { role: "assistant", content: reply }, done: true, done_reason: "stop", prompt_eval_count: 40, eval_count: 4 }) + "\n");
      } else { res.setHeader("content-type", "application/json"); res.end("{}"); }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function scriptedUI(inputs) {
  return {
    slashCommands: [], getStatus: () => "", hintLeft: "", onModeCycle: null, onCancel: null, onExit: null,
    start() {}, close() {}, refresh() {},
    async readInput() { return inputs.shift() ?? "/exit"; },
    async select() { return null; }, async prompt() { return null; },
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, turnEnd() {}, planUpdated() {}, resetResponse() {},
    println() {}, status() {}, warn() {}, error() {}, startSpinner() {}, stopSpinner() {},
    async confirmCommand() { return "no"; },
  };
}

test("/undo drops the undone turn from the saved replay events", async (t) => {
  const ollama = await serveOllama("Hello back.");
  t.after(() => ollama.close());
  const data = tmp(t, "smol-fix-data-");
  const ws = tmp(t, "smol-fix-ws-");
  const store = new SessionStore(data);
  const chosen = { id: "m:1b", backend: "ollama", baseUrl: ollama.base, contextWindow: 8192, toolsSupported: true };
  const session = new Session(scriptedUI(["first", "second", "/undo"]), { workspace: ws, chosen, prefs: {}, cfg: {}, dataDir: data });
  const id = session.persistTo(store);
  await session.run();
  const body = store.loadBody(id);
  assert.deepEqual(body.events.map((e) => `${e.t}:${e.s}`), ["user:first", "token:Hello back."]);
  assert.deepEqual(body.snapshot.messages.map((m) => m.content), ["first", "Hello back."]);
});

// ---- transcript -------------------------------------------------------------------------

test("a resumed transcript pairs results with calls by id, shows no duration, hides harness notes", () => {
  const messages = [
    { role: "user", content: "look" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read_file", args: { path: "a.js" } }, { id: "b", name: "list_files", args: {} }] },
    { role: "tool", toolCallId: "b", toolName: "list_files", content: "a.js\nb.js" },
    { role: "tool", toolCallId: "a", toolName: "read_file", content: "const a = 1;" },
    { role: "user", content: "[Project checks passed: npm test.]", harnessNote: true },
    { role: "assistant", content: "Done." },
  ];
  const seen = [];
  const ui = {
    println(s = "") { if (s) seen.push(`line:${s.replace(/\x1b\[[0-9;]*m/g, "")}`); },
    token(s) { seen.push(`token:${s}`); }, status(s) { seen.push(`status:${s}`); },
    toolCall(name) { seen.push(`call:${name}`); },
    toolResult(r, outcome) { seen.push(`result:${r.split("\n")[0]}`); assert.equal(outcome?.durationMs, undefined); assert.equal(outcome?.ok, true); },
  };
  replayTranscript(ui, messages);
  assert.deepEqual(seen, ["line:› look", "call:read_file", "result:const a = 1;", "call:list_files", "result:a.js", "token:Done."]);
  const events = eventsFromMessages(messages);
  assert.deepEqual(events.map((e) => e.t + (e.name ? ":" + e.name : e.line ? ":" + e.line : "")), ["user", "tool:read_file", "result:const a = 1;", "tool:list_files", "result:a.js", "token"]);
});

// ---- keys ----------------------------------------------------------------------------------

const types = (keys) => keys.map((k) => k.type + (k.text !== undefined ? ":" + k.text : ""));

test("Alt+Shift+P, Alt+], Alt+_ and Alt+^ are keys unless a terminal reply is awaited", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.decode("\x1bP")), ["alt:P"]);
  assert.deepEqual(types(d.decode("abc")), ["text:abc"], "typing after it is not swallowed");
  assert.deepEqual(types(d.decode("\x1b]\x1b_\x1b^")), ["alt:]", "alt:_", "alt:^"]);
  assert.deepEqual(types(d.decode("\x1b]11;rgb:ffff/ffff/ffff\x07x")), ["osc:11;rgb:ffff/ffff/ffff", "char:x"], "a complete reply is still a reply");
  const waiting = new KeyDecoder(() => true);
  assert.deepEqual(waiting.decode("\x1b]11;rgb:00"), []);
  assert.deepEqual(types(waiting.decode("00/0000/0000\x07")), ["osc:11;rgb:0000/0000/0000"]);
});

test("an Esc right before a bracketed paste in the same read is delivered", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.decode("\x1b\x1b[200~p\x1b[201~")), ["esc", "text:p"]);
});
