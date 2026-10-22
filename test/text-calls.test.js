// Tool calls a model writes as reply text instead of a real tool call
// (qwen2.5-coder on Ollama, issue #15): recovered and run, not dropped.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractTextToolCalls } = require("../dist/providers/text-calls");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

const TOOLS = ["read_file", "write_file", "list_files"];

test("a bare JSON call is recovered", () => {
  const { calls, content } = extractTextToolCalls('{"name": "write_file", "arguments": {"path": "a.txt", "content": "hi {}"}}', TOOLS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write_file");
  assert.deepEqual(calls[0].args, { path: "a.txt", content: "hi {}" });
  assert.equal(content, "");
});

test("fenced, tagged and stringified-argument calls are recovered with the surrounding prose kept", () => {
  const text = [
    "I'll create the folder layout.",
    "```json",
    '{"name": "write_file", "parameters": {"path": "src/index.js", "content": "console.log(\\"}\\")"}}',
    "```",
    "<tool_call>",
    '{"name": "list_files", "arguments": "{\\"path\\": \\".\\"}"}',
    "</tool_call>",
  ].join("\n");
  const { calls, content } = extractTextToolCalls(text, TOOLS);
  assert.deepEqual(calls.map((c) => c.name), ["write_file", "list_files"]);
  assert.equal(calls[0].args.content, 'console.log("}")');
  assert.deepEqual(calls[1].args, { path: "." });
  assert.equal(content, "I'll create the folder layout.");
});

test("an array of OpenAI-shaped calls is recovered", () => {
  const text = '[{"type":"function","function":{"name":"read_file","arguments":{"path":"a"}}},{"type":"function","function":{"name":"read_file","arguments":{"path":"b"}}}]';
  const { calls, content } = extractTextToolCalls(text, TOOLS);
  assert.deepEqual(calls.map((c) => c.args.path), ["a", "b"]);
  assert.equal(content, "");
});

test("JSON that is not a call to an offered tool is left alone", () => {
  for (const text of [
    'Your package.json should contain {"name": "my-app", "version": "1.0.0"}.',
    '{"name": "run_command", "arguments": {"command": "rm -rf /"}}',
    '{"name": "write_file"}',
    "plain answer, no JSON",
  ]) {
    const r = extractTextToolCalls(text, TOOLS);
    assert.equal(r.calls.length, 0, text);
    assert.equal(r.content, text);
  }
  assert.equal(extractTextToolCalls('{"name":"read_file","arguments":{}}', []).calls.length, 0);
});

test("the agent runs a call the model wrote as text and replays it as a real tool call", async () => {
  const seen = [];
  const replies = [
    { content: '```json\n{"name": "write_file", "arguments": {"path": "hello/world.txt", "content": "hi"}}\n```' },
    { content: "Created hello/world.txt." },
  ];
  let i = 0;
  const provider = {
    label: "fake", modelId: "qwen2.5-coder:7b", contextWindow: 8000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages) {
      seen.push(messages.map((m) => ({ ...m })));
      return { toolCalls: [], promptTokens: 500, completionTokens: 20, ...replies[Math.min(i++, replies.length - 1)] };
    },
  };
  const lines = [];
  const ui = {
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {},
    status(s) { lines.push(s); }, warn(s) { lines.push(s); }, error(s) { lines.push(s); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "yes"; },
    turnEnd() {}, planUpdated() {},
  };
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tc-textcalls-"));
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  const agent = new Agent(provider, "bypass", "sys", toolCtx, new ContextManager(8000, 2000), new EventBus(), ui, false, 20);
  await agent.runTurn("create hello/world.txt");
  assert.equal(fs.readFileSync(path.join(ws, "hello", "world.txt"), "utf8"), "hi");
  assert.ok(lines.some((l) => /wrote a tool call as text/.test(l)), lines.join("\n"));
  const assistant = seen[1].find((m) => m.role === "assistant");
  assert.equal(assistant.toolCalls[0].name, "write_file");
  assert.equal(assistant.content, "");
  assert.equal(agent.outcome, "completed");
});
