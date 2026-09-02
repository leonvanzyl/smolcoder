// Context management: stale-read eviction, thinking accounting, tiered
// compaction with a fake provider, and the digest renderer.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ContextManager, renderForDigest } = require("../dist/context");
const { describeStats } = require("../dist/agent");

const tools = [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }];

function readCall(id, path) {
  return { role: "assistant", content: "", toolCalls: [{ id, name: "read_file", args: { path } }] };
}
function toolResult(id, name, content) {
  return { role: "tool", content, toolCallId: id, toolName: name };
}

test("evictStaleReads stubs big earlier reads of an overwritten file only", () => {
  const cm = new ContextManager(32000, 2048);
  const big = "x".repeat(3000);
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "go" },
    readCall("r1", "game.js"),
    toolResult("r1", "read_file", big),
    readCall("r2", "index.html"),
    toolResult("r2", "read_file", big),
    readCall("r3", "./game.js"),
    toolResult("r3", "read_file", "short"),
    { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", args: { path: "game.js", content: "new" } }] },
    toolResult("w1", "write_file", "Overwrote game.js"),
  ];
  const n = cm.evictStaleReads(msgs, "game.js");
  assert.equal(n, 1);
  assert.equal(msgs[3].evicted, true);
  assert.match(msgs[3].content, /out of date/);
  assert.equal(msgs[5].evicted, undefined, "other files untouched");
  assert.equal(msgs[7].content, "short", "small reads are kept");
  assert.equal(msgs[9].content, "Overwrote game.js", "the write's own result untouched");
});

test("estimateMessages ignores thinking from finished turns", () => {
  const cm = new ContextManager(32000, 2048);
  const think = "t".repeat(4000);
  const base = [
    { role: "system", content: "s" },
    { role: "user", content: "a" },
    { role: "assistant", content: "ok", thinking: think },
    { role: "user", content: "b" },
    { role: "assistant", content: "ok", thinking: think },
  ];
  const withOld = cm.estimateMessages(base);
  const noThinking = cm.estimateMessages(base.map((m) => ({ ...m, thinking: undefined })));
  // exactly one 1000-token trace should count (the current turn's)
  assert.ok(withOld - noThinking >= 900 && withOld - noThinking <= 1100, `delta ${withOld - noThinking}`);
});

test("manage: tier 1 evicts old tool output, summarizer runs with thinking off", async () => {
  const cm = new ContextManager(4000, 500); // usable 3500, threshold 2800 tokens
  const calls = [];
  const provider = {
    label: "fake", modelId: "fake", contextWindow: 4000, maxOutputTokens: 500,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages, t, opts) {
      calls.push({ messages, opts });
      return { content: "Task: build it.\nDone: a.js\nIn progress: b.js\nNext: c.js\nNotes: none", toolCalls: [] };
    },
  };
  const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "build the thing" }];
  for (let i = 0; i < 8; i++) {
    msgs.push(readCall(`r${i}`, `f${i}.js`));
    msgs.push(toolResult(`r${i}`, "read_file", "y".repeat(2400))); // ~600 tokens each
  }
  const before = cm.estimatePrompt(msgs, tools);
  assert.ok(before > 2800, `setup should exceed the threshold, got ${before}`);
  const { messages, report } = await cm.manage(msgs, tools, provider, {
    originalRequest: "build the thing", filesTouched: new Set(["a.js"]), commandsRun: [], planLine: "Plan (1/3 done):\n1.[x] a\n2.[>] b\n3.[ ] c",
  });
  assert.equal(report.action, "evicted", "eviction alone should be enough here");
  assert.equal(calls.length, 0, "no summarizer call when eviction suffices");
  assert.ok(messages.filter((m) => m.evicted).length >= 1);
  assert.ok(report.after < report.before);

  // Now force tier 2: make the tail itself too big to evict.
  const cm2 = new ContextManager(4000, 500);
  const msgs2 = [{ role: "system", content: "sys" }, { role: "user", content: "build the thing" }];
  for (let i = 0; i < 6; i++) {
    msgs2.push({ role: "assistant", content: "z".repeat(3000) }); // non-tool content is not evictable
    msgs2.push({ role: "user", content: "more" });
  }
  const r2 = await cm2.manage(msgs2, tools, provider, {
    originalRequest: "build the thing", currentRequest: "more", filesTouched: new Set(), commandsRun: ["npm test"], planLine: null,
  });
  assert.ok(["compacted", "floor"].includes(r2.report.action));
  assert.equal(calls.length, 1, "summarizer called once");
  assert.equal(calls[0].opts.effortOverride, "off", "summary must not think");
  assert.ok(calls[0].opts.maxTokens <= 700);
  assert.equal(r2.messages[0].content, "sys");
  assert.equal(r2.messages[1].compactNote, true);
  assert.match(r2.messages[1].content, /Hand-over notes/);
  assert.match(r2.messages[1].content, /Commands run so far: npm test/);
  assert.match(r2.messages[1].content, /Current request \(what you are working on NOW\): more/);
  // A second compaction must not stack notes.
  const r3 = await cm2.manage([r2.messages[0], r2.messages[1], ...msgs2.slice(1)], tools, provider, {
    originalRequest: "build the thing", filesTouched: new Set(), commandsRun: [], planLine: null,
  });
  assert.equal(r3.messages.filter((m) => m.compactNote).length, 1);
});

test("renderForDigest keeps the end of the log and hides file bodies", () => {
  const msgs = [];
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: "assistant", content: `step ${i}`, toolCalls: [{ id: `c${i}`, name: "write_file", args: { path: `f${i}.js`, content: "q".repeat(5000) } }] });
    msgs.push({ role: "tool", content: `Created f${i}.js`, toolCallId: `c${i}`, toolName: "write_file" });
  }
  const out = renderForDigest(msgs, 3000);
  assert.ok(out.length <= 3100);
  assert.match(out, /^\[earlier log omitted\]/);
  assert.match(out, /step 39/);
  assert.doesNotMatch(out, /qqqqq/, "file content never reaches the summarizer");
  assert.match(out, /<5000 chars>/);
});

test("describeStats formats a compact speed readout", () => {
  assert.equal(describeStats({ modelCalls: 3, toolCalls: 2, generatedTokens: 4100, genSeconds: 34.7, thinkingChars: 0, promptTokensLast: 0, durationMs: 0 }), " · 2 tools · 4.1k tok @ 118 tok/s");
  assert.equal(describeStats({ modelCalls: 1, toolCalls: 0, generatedTokens: 0, genSeconds: 0, thinkingChars: 0, promptTokensLast: 0, durationMs: 0 }), "");
  assert.equal(describeStats({ modelCalls: 1, toolCalls: 1, generatedTokens: 50, genSeconds: 0, thinkingChars: 0, promptTokensLast: 0, durationMs: 0 }), " · 1 tool · 50 tok");
});
