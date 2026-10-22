// Lemonade (AMD's local model server): identified by its own /api/v1/models
// listing even when it sits on Ollama's port and answers Ollama's routes,
// budgeted at the context it reports, driven through its /api/v1 chat API.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { identifyServer, resolveContextWindow } = require("../dist/detect");
const { loadedLemonadeContext, parseLemonadeModels } = require("../dist/lemonade");
const { makeProvider } = require("../dist/session");

const MODELS = {
  object: "list",
  data: [
    { id: "Qwen3-Coder-30B-A3B-Instruct-GGUF", object: "model", owned_by: "lemonade", recipe: "llamacpp", max_context_window: 262144, context_length: 32768, downloaded: true, labels: ["tool-calling"] },
    { id: "Gemma-3-4b-it-GGUF", object: "model", owned_by: "lemonade", recipe: "llamacpp", downloaded: true, labels: ["hot", "vision"] },
    { id: "nomic-embed-text-v1-GGUF", object: "model", owned_by: "lemonade", recipe: "llamacpp", labels: ["embeddings"] },
    { id: "SD-Turbo", object: "model", owned_by: "lemonade", recipe: "sd-cpp", labels: ["image"] },
    { id: "Whisper-Tiny", object: "model", owned_by: "lemonade", recipe: "whispercpp" },
  ],
};

/** A fake Lemonade that also answers Ollama's routes, as it does on port 11434. */
async function serveLemonade(seen = [], health = { status: "ok", all_models_loaded: [] }) {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    await new Promise((resolve) => req.on("end", resolve));
    seen.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined });
    const routes = {
      "/api/tags": { models: [{ name: "Qwen3-Coder-30B-A3B-Instruct-GGUF" }] },
      "/api/ps": { models: [] },
      "/api/v1/models": MODELS,
      "/v1/models": MODELS,
      "/api/v1/health": health,
      "/api/v1/load": { status: "success" },
    };
    const body = routes[req.url] ?? { error: "not found" };
    res.writeHead(body.error ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("lemonade: chat models only, each with the context Lemonade reports", () => {
  const models = parseLemonadeModels(MODELS, "http://127.0.0.1:13305");
  assert.deepEqual(
    models.map((m) => [m.id, m.backend, m.contextWindow, m.maxContext, m.vision, !!m.note]),
    [
      ["Qwen3-Coder-30B-A3B-Instruct-GGUF", "lemonade", 32768, 262144, false, false],
      ["Gemma-3-4b-it-GGUF", "lemonade", 4096, undefined, true, true],
    ]
  );
  assert.equal(parseLemonadeModels({ data: [{ id: "x", owned_by: "omlx" }] }, "b"), null, "another server's listing");
  assert.equal(parseLemonadeModels({ models: [] }, "b"), null);
});

test("lemonade: on Ollama's port it is still Lemonade, and chat goes to its /api/v1", async () => {
  const seen = [];
  const srv = await serveLemonade(seen);
  try {
    const info = await identifyServer(srv.base, 2000);
    assert.equal(info.backend, "lemonade", "not driven as Ollama, whose context it does not report");
    assert.equal(info.models[0].contextWindow, 32768);
    const p = makeProvider(info.models[0]);
    assert.equal(p.label, "lemonade · Qwen3-Coder-30B-A3B-Instruct-GGUF");
    await assert.rejects(p.chat([{ role: "user", content: "hi" }], [], {}), /Lemonade returned 404/);
    assert.ok(seen.some((r) => r.url === "/api/v1/chat/completions"));
  } finally {
    await srv.close();
  }
});

test("lemonade: the loaded context is read from /health", async () => {
  const health = { status: "ok", model_loaded: "Qwen3-Coder-30B-A3B-Instruct-GGUF", all_models_loaded: [{ model_name: "Qwen3-Coder-30B-A3B-Instruct-GGUF", type: "llm", recipe_options: { ctx_size: 16384 } }] };
  assert.equal(loadedLemonadeContext(health, "Qwen3-Coder-30B-A3B-Instruct-GGUF"), 16384);
  assert.equal(loadedLemonadeContext(health, "other"), undefined);
  assert.equal(loadedLemonadeContext(null, "x"), undefined);
  const srv = await serveLemonade([], health);
  try {
    const [m] = (await identifyServer(srv.base, 2000)).models;
    assert.equal(await makeProvider(m).loadedContextWindow(), 16384);
  } finally {
    await srv.close();
  }
});

test("lemonade: --ctx loads the model at that size, capped at its maximum", async () => {
  const seen = [];
  const srv = await serveLemonade(seen);
  try {
    const [m] = (await identifyServer(srv.base, 2000)).models;
    const resolved = await resolveContextWindow(m, 65536);
    assert.equal(resolved.contextWindow, 65536);
    assert.deepEqual(seen.find((r) => r.url === "/api/v1/load").body, { model_name: m.id, ctx_size: 65536 });
    const capped = await resolveContextWindow(m, 1_000_000);
    assert.equal(capped.contextWindow, 262144);
    const untouched = await resolveContextWindow(m);
    assert.equal(untouched.contextWindow, 32768, "without --ctx the reported context is kept");
  } finally {
    await srv.close();
  }
});
