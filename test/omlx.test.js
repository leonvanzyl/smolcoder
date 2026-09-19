// oMLX (Apple Silicon MLX server): found on its own port, identified by its
// /health answer, and asked for models with the API key it requires.
const test = require("node:test");
// Saved hosts can hold keys: never read the real config.
process.env.SMOLCODER_CONFIG = require("node:path").join(require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "smol-cfg-")), "c.json");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { identifyServer } = require("../dist/detect");
const { omlxApiKey, parseOmlxModels, readOmlxSettings } = require("../dist/omlx");
const { parseAddress } = require("../dist/hosts");
const { LmStudioProvider } = require("../dist/providers/lmstudio");

const KEY = "test-key-123";
const HEALTH = { status: "healthy", default_model: "qwen", engine_pool: { model_count: 1, loaded_count: 1 } };
const MODELS = { object: "list", data: [{ id: "qwen3.8-27b-8bit", object: "model", owned_by: "omlx", max_model_len: 262144 }] };

/** A fake oMLX: /health is open, everything else wants the bearer key. */
async function serveOmlx(seen = []) {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    await new Promise((resolve) => req.on("end", resolve));
    seen.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    const ok = req.url === "/health" || req.headers.authorization === `Bearer ${KEY}`;
    const body = !ok ? { error: { message: "API key required", type: "authentication_error" } } : req.url === "/health" ? HEALTH : req.url === "/v1/models" ? MODELS : { error: "not found" };
    res.writeHead(!ok ? 401 : req.url === "/health" || req.url === "/v1/models" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function withEnv(key, value, fn) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  return Promise.resolve(fn()).finally(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}

test("omlx: only a listing owned by oMLX is parsed, with its context window", () => {
  const [m] = parseOmlxModels(MODELS, "http://127.0.0.1:8000");
  assert.deepEqual({ id: m.id, backend: m.backend, ctx: m.contextWindow }, { id: "qwen3.8-27b-8bit", backend: "omlx", ctx: 262144 });
  assert.equal(parseOmlxModels({ data: [{ id: "x", owned_by: "organization_owner" }] }, "b"), null);
});

test("omlx: port and key come from oMLX's own settings file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "smol-omlx-"));
  assert.deepEqual(readOmlxSettings(home), {}, "no oMLX installed");
  fs.mkdirSync(path.join(home, ".omlx"));
  fs.writeFileSync(path.join(home, ".omlx", "settings.json"), JSON.stringify({ server: { port: 8123 }, auth: { api_key: KEY } }));
  assert.deepEqual(readOmlxSettings(home), { port: 8123, apiKey: KEY });
});

test("omlx: the local settings key never leaves this computer; OMLX_API_KEY goes anywhere", () =>
  withEnv("OMLX_API_KEY", undefined, async () => {
    const settings = { apiKey: KEY };
    assert.equal(omlxApiKey("http://127.0.0.1:8000", settings), KEY);
    assert.equal(omlxApiKey("http://localhost:8000", settings), KEY);
    assert.equal(omlxApiKey("http://192.168.1.50:8000", settings), undefined);
    process.env.OMLX_API_KEY = "from-env";
    assert.equal(omlxApiKey("http://192.168.1.50:8000", settings), "from-env");
  }));

test("omlx: identified by /health and listed with the API key", async () => {
  const seen = [];
  const srv = await serveOmlx(seen);
  try {
    await withEnv("OMLX_API_KEY", KEY, async () => {
      const info = await identifyServer(srv.base, 2000);
      assert.equal(info.backend, "omlx");
      assert.deepEqual(info.models.map((m) => [m.id, m.backend, m.baseUrl]), [["qwen3.8-27b-8bit", "omlx", srv.base]]);
    });
    assert.ok(seen.some((r) => r.url === "/v1/models" && r.auth === `Bearer ${KEY}`));
    await withEnv("OMLX_API_KEY", "wrong", async () => {
      const info = await identifyServer(srv.base, 2000);
      assert.equal(info.backend, "omlx", "still recognised, so the user can be told the key is wrong");
      assert.deepEqual(info.models, []);
    });
  } finally {
    await srv.close();
  }
});

test("omlx: a bare host address also tries oMLX's port", () => {
  assert.ok(parseAddress("192.168.1.50").urls.includes("http://192.168.1.50:8000"));
});

test("omlx: chat requests carry the key", async () => {
  const seen = [];
  const srv = await serveOmlx(seen);
  try {
    const p = new LmStudioProvider(srv.base, "qwen3.8-27b-8bit", 32768, undefined, undefined, undefined, "wrong-key");
    await assert.rejects(p.chat([{ role: "user", content: "hi" }], [], {}));
    const call = seen.find((r) => r.url === "/v1/chat/completions");
    assert.equal(call.auth, "Bearer wrong-key");
    assert.equal(call.body.reasoning_effort, undefined, "no effort chosen, none sent");
  } finally {
    await srv.close();
  }
});

test("omlx: effort off switches thinking off through the chat template", async () => {
  const seen = [];
  const srv = await serveOmlx(seen);
  try {
    const p = new LmStudioProvider(srv.base, "qwen", 32768, undefined, undefined, undefined, KEY, "oMLX");
    p.setEffort("off");
    await assert.rejects(p.chat([{ role: "user", content: "hi" }], [], {}));
    const call = seen.find((r) => r.url === "/v1/chat/completions");
    assert.deepEqual(call.body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(call.body.reasoning_effort, undefined);
  } finally {
    await srv.close();
  }
});

test("omlx: the LM Studio catalog is not polled on a server that has no such thing", async () => {
  const seen = [];
  const srv = await serveOmlx(seen);
  try {
    const omlx = new LmStudioProvider(srv.base, "qwen", 32768, undefined, undefined, undefined, KEY, "oMLX");
    assert.equal(await omlx.loadedContextWindow(), undefined);
    assert.deepEqual(seen, [], "no request at all");
    const lmstudio = new LmStudioProvider(srv.base, "qwen", 32768);
    await lmstudio.loadedContextWindow();
    assert.deepEqual(seen.map((r) => r.url), ["/api/v1/models"], "LM Studio still asks");
  } finally {
    await srv.close();
  }
});
