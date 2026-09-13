// Agent-loop behaviour with a scripted fake provider: what the model is told
// when its output overflows the cap (the classic local-model "write the whole
// file in one call" failure), and the per-turn stats.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

function fakeUi() {
  const lines = [];
  return {
    lines,
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {},
    status(s) { lines.push(s); }, warn(s) { lines.push(s); }, error(s) { lines.push(s); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "yes"; },
    turnEnd(label) { lines.push("END " + label); }, planUpdated() {},
  };
}

function scriptedProvider(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages) {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const r = replies[Math.min(i++, replies.length - 1)];
      return { content: "", toolCalls: [], generatedTokens: 100, genTokPerSec: 50, promptTokens: 500, completionTokens: 20, ...r };
    },
  };
}

function makeAgent(provider, ui, mode = "bypass", interactive = false) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tc-agent-"));
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  return new Agent(provider, mode, "sys", toolCtx, new ContextManager(8000, 2000), new EventBus(), ui, interactive, 20);
}

test("alternating unchanged reads stop with a recoverable error before the model-step limit", async () => {
  const replies = Array.from({length:12}, (_, i) => ({ content:'', toolCalls:[{id:`r${i}`, name:'read_file', args:{path:i%2?'b.txt':'a.txt'}}] }));
  const agent = makeAgent(scriptedProvider(replies), fakeUi());
  fs.writeFileSync(path.join(agent.toolCtx.workspace,'a.txt'),'first module');
  fs.writeFileSync(path.join(agent.toolCtx.workspace,'b.txt'),'second module');
  await assert.rejects(agent.runTurn('implement the next module'), /same unchanged data/);
  assert.equal(agent.outcome, 'error');
  assert.equal(agent.lastTurnStats.toolCalls, 9);
  assert.match(agent.messages.at(-1).content, /Do not restart the same reads/);
});

test("showing a plan does not re-arm its premature-completion nudge", async () => {
  const provider = scriptedProvider([
    {toolCalls:[{id:'p1',name:'plan',args:{action:'set',steps:'Implement\nTest'}}]},
    {content:'paused'},
    {toolCalls:[{id:'p2',name:'plan',args:{action:'show'}}]},
    {content:'blocked and needs clarification'},
  ]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn('build');
  assert.equal(provider.seen.length, 4);
});

test("a cut-off tool call (empty, truncated, no thinking) is coached to split the file", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [], truncated: true },
    { content: "ok, splitting", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("build it");
  const nudge = provider.seen[1].at(-1);
  assert.equal(nudge.role, "user");
  assert.match(nudge.content, /cut off by the output limit of 2000 tokens/);
  assert.match(nudge.content, /NOT executed and nothing was saved/);
  assert.match(nudge.content, /write_file with the first part/);
  assert.doesNotMatch(nudge.content, /reasoning used/);
});

test("an empty truncated reply WITH thinking is blamed on reasoning", async () => {
  const provider = scriptedProvider([
    { content: "", thinking: "hmm hmm hmm", toolCalls: [], truncated: true },
    { content: "answer", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("think");
  assert.match(provider.seen[1].at(-1).content, /reasoning used the entire output limit \(2000 tokens\)/);
});

test('reasoning exhaustion uses one action-only retry without changing session effort',async()=>{
  const options=[];
  const provider=scriptedProvider([
    {thinking:'long reasoning',truncated:true},
    {toolCalls:[{id:'read',name:'list_files',args:{}}]},
    {content:'done'}
  ]);
  const chat=provider.chat.bind(provider);
  provider.chat=(messages,tools,opts)=>{options.push(opts);return chat(messages);};
  provider.setEffort=()=>{throw Error('must not mutate preference');};
  const ui=fakeUi();const agent=makeAgent(provider,ui);
  await agent.runTurn('make progress');
  assert.equal(agent.outcome,'completed');
  assert.equal(options[0].effortOverride,undefined);
  assert.equal(options[1].effortOverride,'off');
  assert.equal(options[2].effortOverride,undefined);
  assert.ok(ui.lines.some(s=>s.includes('thinking off')));
});

test("a truncated call that arrives as unparseable JSON (LM Studio) gets the same coaching", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "write_file", args: {}, rawArgs: '{"path": "a.js", "content": "....', parseError: "invalid JSON" }], truncated: true },
    { content: "ok", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("build it");
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /^Error: Your tool call was cut off by the output limit of 2000 tokens/);
});

test("turn stats accumulate tokens, speed and tool calls", async () => {
  const provider = scriptedProvider([
    // list_files (not plan: an unfinished plan would trigger the quit-halfway nudge and a third call)
    { content: "", toolCalls: [{ id: "c1", name: "list_files", args: {} }], generatedTokens: 200, genTokPerSec: 100 },
    { content: "done", toolCalls: [], generatedTokens: 50, genTokPerSec: 50 },
  ]);
  const ui = fakeUi();
  const agent = makeAgent(provider, ui);
  await agent.runTurn("go");
  const st = agent.lastTurnStats;
  assert.equal(st.modelCalls, 2);
  assert.equal(st.toolCalls, 1);
  assert.equal(st.generatedTokens, 250);
  // 200 tok @ 100/s = 2 s, 50 tok @ 50/s = 1 s → 250 tok over 3 s ≈ 83 tok/s
  assert.equal(Math.round(st.generatedTokens / st.genSeconds), 83);
  assert.match(ui.lines.find((l) => l.startsWith("END ")), /1 tool · 250 tok @ 83 tok\/s/);
});

test("edit mode: an in-workspace command runs without asking", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "echo hello-from-tree" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  let asked = 0;
  ui.confirmCommand = async () => { asked++; return "no"; };
  const agent = makeAgent(provider, ui, "edit", true);
  await agent.runTurn("go");
  assert.equal(asked, 0);
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /hello-from-tree/);
});

test("edit mode: a command reaching outside the workspace asks, with the reason", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "node /tmp/probe.mjs && node /tmp/other.mjs" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  const asks = [];
  ui.confirmCommand = async (command, reason) => { asks.push({ command, reason }); return "no"; };
  const agent = makeAgent(provider, ui, "edit", true);
  await agent.runTurn("go");
  assert.equal(asks.length, 1);
  assert.match(asks[0].reason, /outside the workspace \(\/tmp\/probe\.mjs\)/);
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /declined/);
});

test("edit mode, headless: an outside command is refused with coaching instead of hanging", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "cat ~/.npmrc" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  ui.confirmCommand = async () => { throw new Error("must not prompt when non-interactive"); };
  const agent = makeAgent(provider, ui, "edit", false);
  await agent.runTurn("go");
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /^Error: this command uses the home directory/);
  assert.match(toolMsg.content, /--mode bypass/);
});

test("bypass mode never asks", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "echo ~/nothing-is-read" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  ui.confirmCommand = async () => { throw new Error("bypass must not prompt"); };
  const agent = makeAgent(provider, ui, "bypass", true);
  await agent.runTurn("go");
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /nothing-is-read/);
});
