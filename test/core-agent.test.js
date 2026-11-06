// Agent loop: a stable prefix across edits (B1), harness feedback that is not
// a user turn (B3), stepped overflow recovery (B7), /undo (B9), UI-only tool
// metadata and streamed tool-argument progress, and Ollama's truncate/shift (B2).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");
const { lastUserIndex } = require("../dist/providers/types");
const { OllamaProvider, toWire } = require("../dist/providers/ollama");
const { LmStudioProvider } = require("../dist/providers/lmstudio");

function fakeUi() {
  const ui = {
    lines: [], results: [], progress: [],
    token() {}, thinking() {}, toolCall() {}, println() {},
    toolResult(result, outcome) { ui.results.push({ result, outcome }); },
    status(s) { ui.lines.push(s); }, warn(s) { ui.lines.push(s); }, error(s) { ui.lines.push(s); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "yes"; },
    turnEnd(label) { ui.lines.push("END " + label); }, planUpdated() {},
  };
  return ui;
}

function scripted(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages, tools, opts) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const r = replies[Math.min(i++, replies.length - 1)];
      if (typeof r === "function") return r(messages, opts);
      return { content: "", toolCalls: [], promptTokens: 500, completionTokens: 20, ...r };
    },
  };
}

function makeAgent(t, provider, ui = fakeUi(), verification) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-core-agent-"));
  t.after(() => { try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* busy */ } });
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  const agent = new Agent(provider, "bypass", "sys", toolCtx, new ContextManager(16000, 2000), new EventBus(), ui, false, 30, verification);
  return { agent, ws, ui };
}

const call = (id, name, args) => ({ toolCalls: [{ id, name, args }] });

test("edits and writes never rewrite earlier messages: every request extends the last one", async (t) => {
  // Reads well over the 1500-char size at which the old code stubbed them.
  const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const provider = scripted([
    call("r1", "read_file", { path: "big.txt" }),
    call("e1", "edit_file", { path: "big.txt", old_text: "line 7", new_text: "line seven" }),
    call("r2", "read_file", { path: "big.txt" }),
    call("w1", "write_file", { path: "big.txt", content: "short now" }),
    { content: "done" },
  ]);
  const { agent, ws } = makeAgent(t, provider);
  fs.writeFileSync(path.join(ws, "big.txt"), body);
  await agent.runTurn("change it");
  assert.equal(provider.seen.length, 5);
  for (let i = 1; i < provider.seen.length; i++) {
    const prev = provider.seen[i - 1];
    assert.deepEqual(provider.seen[i].slice(0, prev.length), prev, `request ${i + 1} rewrote part of request ${i}`);
  }
  const reads = agent.messages.filter((m) => m.toolName === "read_file");
  assert.equal(reads.length, 2);
  assert.ok(reads.every((m) => !m.evicted && m.content.includes("line 100")), "reads stay until compaction");
});

test("check feedback rides on the pending tool result, or is a flagged message that keeps the turn's reasoning", async (t) => {
  const provider = scripted([
    { ...call("w1", "write_file", { path: "app.txt", content: "v1" }), thinking: "plan the write" },
    { content: "Done", thinking: "think about finishing" },
    (messages) => {
      const last = messages.at(-1);
      assert.equal(last.role, "user");
      assert.equal(last.harnessNote, true);
      assert.match(last.content, /Acceptance failed/);
      assert.equal(messages[lastUserIndex(messages)].content.startsWith("build"), true);
      // Ollama still replays this turn's reasoning: nothing moved the turn boundary.
      assert.ok(toWire(messages).some((m) => m.thinking === "plan the write"));
      return { content: "", toolCalls: [{ id: "w2", name: "write_file", args: { path: "ready.txt", content: "ok" } }] };
    },
    { content: "Done again" },
  ]);
  const { agent, ws } = makeAgent(t, provider, fakeUi(), { command: "node verify.cjs" });
  fs.writeFileSync(path.join(ws, "verify.cjs"), "if(!require('fs').existsSync('ready.txt'))process.exit(1)");
  await agent.runTurn("build the app");
  assert.equal(agent.outcome, "completed");
  assert.equal(agent.messages.filter((m) => m.role === "user" && !m.harnessNote).length, 1);

  // With a tool result pending, feedback is appended to it instead.
  const before = agent.messages.length;
  agent.messages.push({ role: "assistant", content: "", toolCalls: [{ id: "x", name: "read_file", args: { path: "a" } }] });
  agent.messages.push({ role: "tool", toolCallId: "x", toolName: "read_file", content: "file text" });
  agent["pushFeedback"]("[Project checks passed: npm test.]");
  assert.equal(agent.messages.length, before + 2);
  assert.equal(agent.messages.at(-1).content, "file text\n\n[Project checks passed: npm test.]");
});

test("context overflow recovery shrinks the budget in steps and stops after the last one", async (t) => {
  const overflow = () => { throw new Error("Ollama returned 400: {\"error\":\"the prompt is longer than the context length currently available to the model\"}"); };
  const provider = scripted([overflow, overflow, { content: "fits now" }]);
  const { agent, ui } = makeAgent(t, provider);
  await agent.runTurn("hello");
  assert.equal(agent.outcome, "completed");
  assert.deepEqual(ui.lines.filter((l) => /context limit/.test(l)).map((l) => /(\d+)%/.exec(l)[1]), ["85", "70"]);

  const always = scripted([overflow]);
  const { agent: stuck, ui: ui2 } = makeAgent(t, always);
  await assert.rejects(stuck.runTurn("hello"), /longer than the context length/);
  assert.equal(always.seen.length, 4, "three stepped recoveries, then the error surfaces");
  assert.deepEqual(ui2.lines.filter((l) => /context limit/.test(l)).map((l) => /(\d+)%/.exec(l)[1]), ["85", "70", "50"]);
});

test("undoLastTurn restores edited files, deletes created ones and trims the transcript", async (t) => {
  const provider = scripted([
    call("w0", "write_file", { path: "keep.txt", content: "turn one" }),
    { content: "first done" },
    call("e1", "edit_file", { path: "keep.txt", old_text: "turn one", new_text: "turn two" }),
    call("w1", "write_file", { path: "made/new.txt", content: "created" }),
    call("e2", "edit_file", { path: "keep.txt", old_text: "turn two", new_text: "turn two again" }),
    { content: "second done" },
  ]);
  const { agent, ws } = makeAgent(t, provider);
  const read = (p) => fs.readFileSync(path.join(ws, p), "utf8");
  await agent.runTurn("first");
  const afterFirst = agent.messages.length;
  await agent.runTurn("second");
  assert.equal(read("keep.txt"), "turn two again");
  const summary = await agent.undoLastTurn();
  assert.equal(summary, "Undid the last turn: restored keep.txt; deleted made/new.txt.");
  assert.equal(read("keep.txt"), "turn one");
  assert.equal(fs.existsSync(path.join(ws, "made/new.txt")), false);
  assert.equal(agent.messages.length, afterFirst);
  assert.equal(agent.messages.at(-1).content, "first done");
  assert.equal(agent.currentRequest, "first");
  assert.equal(await agent.undoLastTurn(), "Undid the last turn: deleted keep.txt.");
  assert.equal(agent.messages.length, 1);
  assert.equal(agent.originalRequest, "");
  assert.equal(await agent.undoLastTurn(), null);
});

test("undo says when commands ran, and a turn without file changes still trims", async (t) => {
  const provider = scripted([call("c1", "run_command", { command: "node -e \"1\"" }), { content: "ran it" }]);
  const { agent } = makeAgent(t, provider);
  await agent.runTurn("run something");
  assert.equal(await agent.undoLastTurn(), "Undid the last turn (no file changes). Effects of commands it ran are not undone.");
  assert.equal(agent.messages.length, 1);
});

test("every tool result carries UI-only metadata: ok, duration and the edit diff", async (t) => {
  const provider = scripted([
    call("w1", "write_file", { path: "a.txt", content: "alpha\nbeta\n" }),
    call("e1", "edit_file", { path: "a.txt", old_text: "beta", new_text: "gamma" }),
    call("r1", "read_file", { path: "missing.txt" }),
    { content: "done" },
  ]);
  const { agent, ui } = makeAgent(t, provider);
  await agent.runTurn("go");
  const [write, edit, read] = ui.results;
  assert.equal(write.outcome.ok, true);
  assert.equal(typeof write.outcome.durationMs, "number");
  assert.deepEqual(write.outcome.diff, { path: "a.txt", before: "", after: "alpha\nbeta\n" });
  assert.deepEqual(edit.outcome.diff, { path: "a.txt", before: "beta", after: "gamma" });
  assert.equal(read.outcome.ok, false);
  assert.equal(read.outcome.diff, undefined);
  const tools = agent.messages.filter((m) => m.role === "tool");
  assert.ok(tools.every((m) => Object.keys(m).every((k) => ["role", "content", "toolCallId", "toolName"].includes(k))));
});

test("streamed tool-argument progress reaches the UI about ten times a second at most", async (t) => {
  const provider = scripted([
    (messages, opts) => {
      for (let i = 1; i <= 50; i++) opts.onToolArgs("write_file", i * 100);
      return { content: "done", toolCalls: [] };
    },
  ]);
  const ui = fakeUi();
  ui.toolArgsProgress = (name, chars) => ui.progress.push([name, chars]);
  const { agent } = makeAgent(t, provider, ui);
  await agent.runTurn("go");
  assert.deepEqual(ui.progress, [["write_file", 100]]);
});

function server(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, res, body ? JSON.parse(body) : {}));
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test("Ollama: truncate and shift are off, and an oversized prompt fails once with a context error", async (t) => {
  const bodies = [];
  let mode = "ok";
  const { srv, url } = await server((req, res, body) => {
    bodies.push(body);
    if (mode === "overflow") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "the prompt is longer than the context length currently available to the model" }));
      return;
    }
    res.setHeader("content-type", "application/x-ndjson");
    res.write(JSON.stringify({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "write_file", arguments: { path: "a", content: "abc" } } }] }, done: false }) + "\n");
    res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "length", prompt_eval_count: 10, eval_count: 5 }) + "\n");
  });
  t.after(() => srv.close());
  const provider = new OllamaProvider(url, "m", 8192);
  const args = [];
  const res = await provider.chat([{ role: "user", content: "hi" }], [], { onToolArgs: (n, c) => args.push([n, c]) });
  assert.equal(bodies[0].truncate, false);
  assert.equal(bodies[0].shift, false);
  assert.equal(res.truncated, true, "done_reason length still reaches the truncation nudges");
  assert.deepEqual(args, [["write_file", JSON.stringify({ path: "a", content: "abc" }).length]]);
  mode = "overflow";
  await assert.rejects(provider.chat([{ role: "user", content: "hi" }], []), /longer than the context length/);
  assert.equal(bodies.length, 2, "no non-streaming retry of an oversized prompt");
});

test("LM Studio reports tool arguments as they stream", async (t) => {
  const { srv, url } = await server((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    const parts = ['{"path":', '"a.txt","content":"', "x".repeat(40), '"}'];
    parts.forEach((p, i) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...(i === 0 ? { id: "c1", function: { name: "write_file", arguments: p } } : { function: { arguments: p } }) }] } }] })}\n\n`));
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  t.after(() => srv.close());
  const provider = new LmStudioProvider(url, "m", 8192);
  const seen = [];
  const res = await provider.chat([{ role: "user", content: "hi" }], [], { onToolArgs: (n, c) => seen.push([n, c]) });
  assert.equal(res.toolCalls[0].args.content.length, 40);
  assert.deepEqual(seen.map((s) => s[0]), ["write_file", "write_file", "write_file", "write_file"]);
  assert.deepEqual(seen.map((s) => s[1]), [8, 27, 67, 69]);
});
