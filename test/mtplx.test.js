// MTPLX (MLX server with native MTP speculative decoding): identified by its
// /health answer, listed from /v1/models, thinking switched off the way it
// documents. Shares port 8000 with oMLX by default; the answer decides.
const test = require("node:test");
// Saved hosts can hold keys: never read the real config.
process.env.SMOLCODER_CONFIG = require("node:path").join(require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "smol-cfg-")), "c.json");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { identifyServer } = require("../dist/detect");
const { parseMtplxModels, readMtplxPort } = require("../dist/mtplx");
const { makeProvider } = require("../dist/session");

const HEALTH = { status: "ok", generation_mode: "mtp", load_mtp: true, mtp_enabled: true, depth: 3, api_key_required: false };
const MODELS = { object: "list", data: [{ id: "Qwen3.8-27B-MTPLX", object: "model", owned_by: "mtplx", capability: "chat", supports_vision: true, context_length: 131072, max_model_len: 131072 }] };

async function serveMtplx(seen = []) {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    await new Promise((resolve) => req.on("end", resolve));
    seen.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined });
    const body = req.url === "/health" ? HEALTH : req.url === "/v1/models" ? MODELS : { error: "not found" };
    res.writeHead(body.error ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("mtplx: only a listing owned by MTPLX is parsed, with its context and vision", () => {
  const [m] = parseMtplxModels(MODELS, "http://127.0.0.1:8000");
  assert.deepEqual({ id: m.id, backend: m.backend, ctx: m.contextWindow, vision: m.vision }, { id: "Qwen3.8-27B-MTPLX", backend: "mtplx", ctx: 131072, vision: true });
  assert.equal(parseMtplxModels({ data: [{ id: "x", owned_by: "omlx" }] }, "b"), null);
});

test("mtplx: the port comes from the app's settings", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mtplx-"));
  assert.equal(readMtplxPort(home), undefined, "not installed");
  const dir = path.join(home, "Library", "Application Support", "MTPLX");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ port: 8001, host: "127.0.0.1" }));
  assert.equal(readMtplxPort(home), 8001);
});

test("mtplx: identified by /health, and effort off uses the chat template switch", async () => {
  const seen = [];
  const srv = await serveMtplx(seen);
  try {
    const info = await identifyServer(srv.base, 2000);
    assert.equal(info.backend, "mtplx");
    assert.deepEqual(info.models.map((m) => [m.id, m.contextWindow]), [["Qwen3.8-27B-MTPLX", 131072]]);
    const p = makeProvider(info.models[0]);
    p.setEffort("off");
    await assert.rejects(p.chat([{ role: "user", content: "hi" }], [], {}));
    const call = seen.find((r) => r.url === "/v1/chat/completions");
    assert.deepEqual(call.body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(call.body.reasoning_effort, undefined, "MTPLX maps none to low, which still thinks");
  } finally {
    await srv.close();
  }
});

test("mtplx: the ports a running MLX server listens on are read from lsof", () => {
  const { parseLsofPorts } = require("../dist/detect");
  const out = "p38372\nf4\nn127.0.0.1:8001\np19534\nf4\nn*:8000\nf5\nn[::1]:8000\n";
  assert.deepEqual(parseLsofPorts(out), [8001, 8000]);
  assert.deepEqual(parseLsofPorts(""), []);
});
