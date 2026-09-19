// The web settings page: which model servers answer (and which wait for a
// key), keys per server, network machines, and the defaults new sessions use.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

process.env.SMOLCODER_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smol-settings-")), "config.json");
delete process.env.OMLX_API_KEY;
delete process.env.MTPLX_API_KEY;

const { loadConfig, saveConfig } = require("../dist/config");
const settings = require("../dist/settings");

const KEY = "sk-settings-1";

async function serveOmlx() {
  const server = http.createServer((req, res) => {
    const ok = req.url === "/health" || req.headers.authorization === `Bearer ${KEY}`;
    const body = !ok ? { error: { message: "API key required" } } : req.url === "/health" ? { status: "healthy", engine_pool: {} } : { data: [{ id: "qwen", owned_by: "omlx", max_model_len: 32768 }] };
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("settings: servers are listed with their models, and one waiting for a key says so", async () => {
  saveConfig({ lastModel: "qwen", effort: "off", lastMode: "ro" });
  const detect = async () => [
    { backend: "omlx", baseUrl: "http://127.0.0.1:8000", models: [] },
    { backend: "ollama", baseUrl: "http://127.0.0.1:11434", host: "gpu-box", models: [{ id: "qwen3:8b", backend: "ollama", baseUrl: "http://127.0.0.1:11434", contextWindow: 0, host: "gpu-box" }] },
  ];
  const view = await settings.settingsView(detect);
  assert.deepEqual(view.servers[0], { backend: "omlx", name: "oMLX", baseUrl: "http://127.0.0.1:8000", models: 0, keyed: true, hasKey: false, locked: true });
  assert.deepEqual(view.servers[1], { backend: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434", host: "gpu-box", models: 1, keyed: false, hasKey: false, locked: false });
  assert.deepEqual(view.models, [{ id: "qwen3:8b", baseUrl: "http://127.0.0.1:11434", backend: "ollama", host: "gpu-box" }]);
  assert.deepEqual(view.defaults, { model: "qwen", modelUrl: undefined, effort: "off", mode: "ro" });
  assert.ok(!JSON.stringify(view).includes("sk-"), "keys never leave the server");
});

test("settings: a key is checked against its server before it is kept", async () => {
  saveConfig({});
  const srv = await serveOmlx();
  try {
    const bad = await settings.setServerKey(srv.base, "wrong");
    assert.equal(bad.ok, false);
    assert.match(bad.error, /did not accept that API key/);
    assert.deepEqual(loadConfig().keys, {});

    const good = await settings.setServerKey(srv.base, KEY);
    assert.equal(good.ok, true);
    assert.equal(good.server.models, 1);
    assert.equal(good.server.hasKey, true);
    assert.deepEqual(loadConfig().keys, { [srv.base]: KEY });

    const cleared = await settings.setServerKey(srv.base, null);
    assert.equal(cleared.ok, true);
    assert.deepEqual(loadConfig().keys, {});
    await assert.rejects(settings.setServerKey("file:///etc/passwd", "x"), /not a server address/);
  } finally {
    await srv.close();
  }
});

test("settings: adding a machine asks for a key only when its server needs one", async () => {
  saveConfig({});
  const srv = await serveOmlx();
  try {
    const first = await settings.addMachine(`127.0.0.1:${srv.port}`);
    assert.deepEqual({ status: first.status, name: first.name }, { status: "needs-key", name: "oMLX" });
    assert.deepEqual(loadConfig().hosts, [], "nothing is saved until the key works");

    assert.equal((await settings.addMachine(`127.0.0.1:${srv.port}`, "wrong")).status, "bad-key");
    const added = await settings.addMachine(`127.0.0.1:${srv.port}`, KEY);
    assert.equal(added.status, "added");
    assert.deepEqual(loadConfig().hosts, [{ address: srv.base }]);
    assert.deepEqual(loadConfig().keys, { [srv.base]: KEY });

    assert.equal((await settings.addMachine("ftp://box")).status, "invalid");
    settings.renameMachine(srv.base, "Mac Studio");
    assert.deepEqual(loadConfig().hosts, [{ address: srv.base, name: "Mac Studio" }]);
    settings.removeMachine(srv.base);
    assert.deepEqual(loadConfig().hosts, []);
    assert.deepEqual(loadConfig().keys, {}, "a removed machine's keys go with it");
  } finally {
    await srv.close();
  }
});

test("settings: an unreachable address is reported, not saved", async () => {
  saveConfig({});
  const srv = await serveOmlx();
  await srv.close();
  const r = await settings.addMachine(`127.0.0.1:${srv.port}`);
  assert.equal(r.status, "not-found");
  assert.match(r.message, /Nothing answered/);
  assert.deepEqual(loadConfig().hosts, []);
});

test("settings: defaults are validated; bypass is never saved as a default", () => {
  saveConfig({});
  settings.saveDefaults({ model: "qwen", modelUrl: "http://127.0.0.1:8000", effort: "low", mode: "edit" });
  assert.deepEqual(
    { m: loadConfig().lastModel, u: loadConfig().lastModelUrl, e: loadConfig().effort, mode: loadConfig().lastMode },
    { m: "qwen", u: "http://127.0.0.1:8000", e: "low", mode: "edit" }
  );
  settings.saveDefaults({ effort: null });
  assert.equal(loadConfig().effort, null, "default effort is allowed");
  assert.throws(() => settings.saveDefaults({ effort: "extreme" }), /effort/);
  assert.throws(() => settings.saveDefaults({ mode: "bypass" }), /mode/);
});
