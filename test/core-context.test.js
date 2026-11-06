// Context manager: deferred stale-read stubs (B1), same-prefix summaries with
// a digest fallback (B4), windowed calibration and stepped overflow budgets (B7).
const test = require("node:test");
const assert = require("node:assert/strict");
const { ContextManager } = require("../dist/context");
const { lastUserIndex } = require("../dist/providers/types");

const TOOLS = [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const state = () => ({ originalRequest: "build it", filesTouched: new Set(["app.js"]), commandsRun: [] });

function recorder(replies) {
  const calls = [];
  return {
    calls,
    label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages, tools, opts) {
      calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools, opts });
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { content: "", toolCalls: [], ...r };
    },
  };
}

const NOTES = "In progress: wiring the save button.\nNext: run the tests.\nNotes: save() takes (state, slot).";

test("write_file stale reads are stubbed at the next manage(), not when the write happens", async () => {
  const mgr = new ContextManager(4000, 1000);
  const read = { role: "tool", toolCallId: "r1", toolName: "read_file", content: "x".repeat(10000) };
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "rewrite app.js" },
    { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", args: { path: "app.js" } }] },
    read,
    { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", args: { path: "./app.js", content: "new" } }] },
  ];
  assert.equal(mgr.noteStaleReads(messages, "app.js"), 1);
  messages.push({ role: "tool", toolCallId: "w1", toolName: "write_file", content: "Overwrote app.js (was 1 lines, now 1 lines)." });
  assert.equal(read.content.length, 10000, "the transcript is untouched until compaction");
  assert.ok(mgr.needsAttention(messages, TOOLS));
  const { messages: after, report } = await mgr.manage(messages, TOOLS, recorder([]), state());
  assert.equal(report.action, "evicted");
  assert.equal(after, messages);
  assert.match(read.content, /out of date/);
  assert.equal(read.evicted, true);
});

test("the summary request is the unmodified transcript plus one flagged hand-over instruction", async () => {
  const mgr = new ContextManager(8000, 2000);
  const messages = [
    { role: "system", content: "sys prompt" },
    { role: "user", content: "first request " + "a".repeat(19000) },
    { role: "assistant", content: "done with that" },
    { role: "user", content: "second request" },
    { role: "assistant", content: "", thinking: "old reasoning that eviction would drop", toolCalls: [{ id: "r1", name: "read_file", args: { path: "a.js" } }] },
    { role: "tool", toolCallId: "r1", toolName: "read_file", content: "b".repeat(600) },
    { role: "assistant", content: "", thinking: "current reasoning", toolCalls: [{ id: "r2", name: "read_file", args: { path: "b.js" } }] },
    { role: "tool", toolCallId: "r2", toolName: "read_file", content: "c".repeat(400) },
  ];
  const sent = JSON.stringify(messages);
  const provider = recorder([{ content: NOTES }]);
  const { messages: compacted, report } = await mgr.manage(messages, TOOLS, provider, state(), { force: true });
  assert.equal(report.action, "compacted");
  assert.equal(provider.calls.length, 1);
  const call = provider.calls[0];
  assert.equal(JSON.stringify(call.messages.slice(0, -1)), sent, "same system prompt and messages, byte for byte");
  assert.equal(call.tools, TOOLS, "same tools");
  const instruction = call.messages.at(-1);
  assert.equal(instruction.role, "user");
  assert.equal(instruction.harnessNote, true);
  assert.match(instruction.content, /In progress:[\s\S]*Next:[\s\S]*Notes:/);
  assert.equal(lastUserIndex(call.messages), 3, "the instruction is not a new user turn, so this turn's reasoning still travels");
  assert.equal(call.opts.effortOverride, "off");
  assert.equal(call.opts.maxTokens, 700);
  assert.equal(compacted[0].content, "sys prompt");
  assert.ok(compacted[1].compactNote);
  assert.match(compacted[1].content, /save\(\) takes \(state, slot\)/);
});

test("a tool call or a reply without headings is retried once, then the digest path takes over", async () => {
  const mgr = new ContextManager(8000, 2000);
  const messages = [
    { role: "system", content: "sys prompt" },
    { role: "user", content: "request " + "a".repeat(19000) },
    { role: "assistant", content: "ok, reading" },
  ];
  const provider = recorder([
    { toolCalls: [{ id: "x", name: "read_file", args: { path: "a.js" } }] },
    { content: "I looked at the files and things are fine." },
    { content: NOTES },
  ]);
  const { messages: compacted } = await mgr.manage(messages, TOOLS, provider, state(), { force: true });
  assert.equal(provider.calls.length, 3);
  assert.match(provider.calls[1].messages.at(-1).content, /did not follow this format/);
  const digest = provider.calls[2];
  assert.match(digest.messages[0].content, /hand-over notes for a coding agent/);
  assert.deepEqual(digest.tools, []);
  assert.match(compacted[1].content, /Hand-over notes:\nIn progress: wiring/);
});

test("a transcript that no longer fits as-is goes straight to the digest", async () => {
  const mgr = new ContextManager(8000, 2000);
  const messages = [
    { role: "system", content: "sys prompt" },
    { role: "user", content: "request " + "a".repeat(23500) },
  ];
  const provider = recorder([{ content: NOTES }]);
  await mgr.manage(messages, TOOLS, provider, state(), { force: true });
  assert.equal(provider.calls.length, 1);
  assert.match(provider.calls[0].messages[0].content, /hand-over notes for a coding agent/);
});

test("free eviction that is enough never calls the model; the original is changed only then", async () => {
  const mgr = new ContextManager(4000, 1000);
  const big = { role: "tool", toolCallId: "r1", toolName: "read_file", content: "x".repeat(10000) };
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", args: { path: "a" } }] },
    big,
    ...Array.from({ length: 4 }, (_, i) => [
      { role: "assistant", content: "", toolCalls: [{ id: "q" + i, name: "read_file", args: { path: "q" + i } }] },
      { role: "tool", toolCallId: "q" + i, toolName: "read_file", content: "small " + i },
    ]).flat(),
  ];
  const provider = recorder([{ content: NOTES }]);
  const { report } = await mgr.manage(messages, TOOLS, provider, state());
  assert.equal(report.action, "evicted");
  assert.equal(provider.calls.length, 0);
  assert.equal(big.evicted, true);
});

test("calibration follows the largest recent response, decays slowly, and ignores cache-hit reports", () => {
  const mgr = new ContextManager(100000, 8000);
  const msgs = [{ role: "system", content: "x".repeat(4000) }];
  const base = mgr.estimatePrompt(msgs, []); // ~1008 tokens, calibration 1
  mgr.calibrate(base * 1.6, msgs, []);
  assert.ok(Math.abs(mgr.estimatePrompt(msgs, []) / base - 1.6) < 0.01);
  for (let i = 0; i < 4; i++) mgr.calibrate(base * 1.3, msgs, []);
  assert.ok(mgr.estimatePrompt(msgs, []) / base > 1.55, "the spike is still within the last five");
  mgr.calibrate(base * 1.3, msgs, []);
  const after = mgr.estimatePrompt(msgs, []) / base;
  assert.ok(after < 1.6 && after > 1.4, "out of the window it decays instead of dropping at once");
  for (let i = 0; i < 40; i++) mgr.calibrate(base * 1.3, msgs, []);
  assert.ok(Math.abs(mgr.estimatePrompt(msgs, []) / base - 1.3) < 0.02, "and settles on the recent maximum");
  // A prompt-cache hit reported as only the newly evaluated tokens.
  for (let i = 0; i < 10; i++) mgr.calibrate(base * 0.1, msgs, []);
  assert.ok(mgr.estimatePrompt(msgs, []) / base >= 1.3 - 0.02, "cache-hit counts never lower the budget");
});

test("overflow recovery budgets 85%, then 70%, then 50% of the window", () => {
  const mgr = new ContextManager(16384, 4096);
  const full = mgr.usableWindow();
  assert.equal(full, 12032);
  const shares = [];
  while (mgr.shrinkForOverflow()) shares.push(mgr.overflowShare);
  assert.deepEqual(shares, [0.85, 0.7, 0.5]);
  assert.equal(mgr.usableWindow(), Math.floor(full * 0.5));
  mgr.setWindow(16384, 4096);
  assert.equal(mgr.usableWindow(), full, "a new window starts over");
});
