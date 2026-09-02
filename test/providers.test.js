// Unit tests for the provider layer (run: npm test). Pure functions only —
// nothing here talks to a backend.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mapEffort } = require("../dist/providers/lmstudio");
const { toWire } = require("../dist/providers/ollama");
const { estimateReplayTokens, lastUserIndex } = require("../dist/providers/types");
const { parseLmStudioV1 } = require("../dist/detect");

const qwenInfo = { allowed: ["off", "low", "medium", "xhigh", "on"], default: "xhigh" };

test("mapEffort: off is sent as the API value none", () => {
  assert.equal(mapEffort("off", qwenInfo), "none");
  assert.equal(mapEffort("off", undefined), "none");
});

test("mapEffort: default leaves the backend alone", () => {
  assert.equal(mapEffort(null, qwenInfo), undefined);
});

test("mapEffort: supported levels pass through", () => {
  assert.equal(mapEffort("low", qwenInfo), "low");
  assert.equal(mapEffort("medium", qwenInfo), "medium");
});

test("mapEffort: unsupported level snaps to the nearest one the model has (ties go lower)", () => {
  // high sits between medium and xhigh — the cheaper one wins.
  assert.equal(mapEffort("high", qwenInfo), "medium");
  assert.equal(mapEffort("high", { allowed: ["off", "xhigh"] }), "xhigh");
  assert.equal(mapEffort("low", { allowed: ["off", "medium", "high"] }), "medium");
});

test("mapEffort: no model info → send what was asked", () => {
  assert.equal(mapEffort("high", undefined), "high");
  assert.equal(mapEffort("low", { allowed: [] }), "low");
});

test("ollama toWire: thinking is replayed only for the current user turn", () => {
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "first task" },
    { role: "assistant", content: "", thinking: "OLD THOUGHT", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }] },
    { role: "tool", content: "x", toolCallId: "c1", toolName: "read_file" },
    { role: "assistant", content: "done" },
    { role: "user", content: "second task" },
    { role: "assistant", content: "", thinking: "NEW THOUGHT", toolCalls: [{ id: "c2", name: "read_file", args: { path: "b" } }] },
    { role: "tool", content: "y", toolCallId: "c2", toolName: "read_file" },
  ];
  const wire = toWire(msgs);
  assert.equal(wire[2].thinking, undefined, "old turn's thinking must be dropped");
  assert.equal(wire[6].thinking, "NEW THOUGHT", "current turn's thinking must travel");
  assert.equal(wire[3].tool_name, "read_file");
  assert.equal(lastUserIndex(msgs), 5);
});

test("ollama toWire: compaction notes do not count as the turn start", () => {
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "task" },
    { role: "assistant", content: "", thinking: "T1", toolCalls: [{ id: "c1", name: "plan", args: { action: "show" } }] },
    { role: "tool", content: "x", toolCallId: "c1", toolName: "plan" },
    { role: "user", content: "[compacted]", compactNote: true },
    { role: "assistant", content: "", thinking: "T2", toolCalls: [{ id: "c2", name: "plan", args: { action: "show" } }] },
  ];
  const wire = toWire(msgs);
  assert.equal(wire[2].thinking, "T1");
  assert.equal(wire[5].thinking, "T2");
});

test("estimateReplayTokens counts the visible reply and tool-call JSON only", () => {
  const n = estimateReplayTokens("hello world", [{ id: "1", name: "read_file", args: { path: "a.js" } }]);
  assert.ok(n > 3 && n < 40, `got ${n}`);
  assert.equal(estimateReplayTokens("", []), 0);
});

test("parseLmStudioV1 reads loaded context, id, and reasoning options", () => {
  const models = parseLmStudioV1({
    models: [
      {
        type: "llm",
        key: "qwen/qwen3.8-27b",
        loaded_instances: [{ id: "qwen/qwen3.8-27b", config: { context_length: 128000 } }],
        max_context_length: 262144,
        capabilities: { reasoning: { allowed_options: ["off", "low", "medium", "xhigh", "on"], default: "xhigh" } },
      },
      { type: "embedding", key: "nomic" },
      { type: "llm", key: "other/model", loaded_instances: [], max_context_length: 32768 },
    ],
  });
  assert.equal(models.length, 2);
  assert.equal(models[0].id, "qwen/qwen3.8-27b");
  assert.equal(models[0].contextWindow, 128000);
  assert.equal(models[0].loaded, true);
  assert.deepEqual(models[0].reasoning, { allowed: ["off", "low", "medium", "xhigh", "on"], default: "xhigh" });
  assert.equal(models[1].loaded, false);
  assert.equal(models[1].contextWindow, 4096);
  assert.ok(models[1].note);
  assert.equal(parseLmStudioV1({ data: [] }), null, "v0 shape is not accepted");
});
