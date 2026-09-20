// API keys for model servers that require one (oMLX, MTPLX on the network):
// asked for when a machine is added, set or removed from "Network hosts",
// saved per server address, and never shown or kept in a transcript.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smol-key-")), "config.json");
process.env.SMOLCODER_CONFIG = CONFIG;
delete process.env.OMLX_API_KEY;
delete process.env.MTPLX_API_KEY;

const { loadConfig, saveConfig, setKeys } = require("../dist/config");
const { findModelsOnNetwork, manageHosts } = require("../dist/network");
const { omlxApiKey } = require("../dist/omlx");
const { mtplxApiKey } = require("../dist/mtplx");
const { SessionChannel } = require("../dist/web/channel");

const KEY = "sk-local-123";

/** A fake oMLX that lists its model only for the right key. */
async function serveOmlx() {
  const server = http.createServer((req, res) => {
    const ok = req.url === "/health" || req.headers.authorization === `Bearer ${KEY}`;
    const body = !ok ? { error: { message: "API key required" } } : req.url === "/health" ? { status: "healthy", engine_pool: {} } : { data: [{ id: "qwen", owned_by: "omlx", max_model_len: 32768 }] };
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

function scriptedUI({ picks = [], texts = [] }) {
  const shown = { selects: [], prompts: [], lines: [] };
  return {
    shown,
    async select(title, options) {
      shown.selects.push({ title, options });
      const want = picks.shift();
      if (want == null) return null;
      const idx = options.findIndex((o) => o.label === want);
      assert.notEqual(idx, -1, `no option ${want} in "${title}": ${options.map((o) => o.label).join(" | ")}`);
      return idx;
    },
    async prompt(title, placeholder, opts) {
      shown.prompts.push({ title, secret: !!opts?.secret });
      return texts.length ? texts.shift() : null;
    },
    status: (s) => shown.lines.push(s),
    warn: (s) => shown.lines.push(s),
    startSpinner() {},
    stopSpinner() {},
  };
}

test("api key: adding a machine that needs one asks for it, secretly, and saves it with the host", async () => {
  saveConfig({});
  const srv = await serveOmlx();
  try {
    const address = `http://127.0.0.1:${srv.port}`;
    const ui = scriptedUI({ picks: ["Enter an address"], texts: [`127.0.0.1:${srv.port}`, KEY] });
    assert.equal(await findModelsOnNetwork(ui), true);
    assert.deepEqual(ui.shown.prompts[1], { title: `API key for oMLX at 127.0.0.1`, secret: true });
    assert.ok(!ui.shown.lines.some((l) => /plain http/.test(l)), "no warning for a server on this computer");
    assert.ok(!ui.shown.lines.some((l) => /plain http/.test(l)), "no warning for a server on this computer");
    assert.deepEqual(loadConfig().hosts, [{ address }]);
    assert.deepEqual(loadConfig().keys, { [address]: KEY });
    assert.ok(ui.shown.lines.some((l) => /oMLX · 1 model/.test(l)), ui.shown.lines.join("\n"));
    assert.ok(!ui.shown.lines.join("\n").includes(KEY), "the key is never printed");
    assert.equal(fs.statSync(CONFIG).mode & 0o777, 0o600, "a config holding a key is private to its owner");
  } finally {
    await srv.close();
  }
});

test("api key: a wrong key is not saved", async () => {
  saveConfig({});
  const srv = await serveOmlx();
  try {
    const ui = scriptedUI({ picks: ["Enter an address"], texts: [`127.0.0.1:${srv.port}`, "wrong"] });
    assert.equal(await findModelsOnNetwork(ui), false);
    assert.deepEqual(loadConfig().hosts, []);
    assert.deepEqual(loadConfig().keys, {});
    assert.match(ui.shown.lines.join("\n"), /did not accept that API key/);
  } finally {
    await srv.close();
  }
});

test("api key: set and removed from Network hosts", async () => {
  const srv = await serveOmlx();
  const address = `http://127.0.0.1:${srv.port}`;
  saveConfig({ hosts: [{ address }] });
  try {
    const set = scriptedUI({ picks: ["127.0.0.1", "API key", null], texts: [KEY] });
    assert.equal(await manageHosts(set), true);
    assert.deepEqual(loadConfig().keys, { [address]: KEY });
    assert.match(set.shown.selects[0].options[0].hint, /oMLX · 0 models/, "without a key it lists nothing");
    assert.match(set.shown.selects[2].options[0].hint, /oMLX · 1 model/, "the list re-checks with the saved key");

    const clear = scriptedUI({ picks: ["127.0.0.1", "Remove API key", null] });
    assert.equal(await manageHosts(clear), true);
    assert.deepEqual(loadConfig().keys, {});

    setKeys([address], KEY);
    const gone = scriptedUI({ picks: ["127.0.0.1", "Remove", null] });
    assert.equal(await manageHosts(gone), true);
    assert.deepEqual(loadConfig().keys, {}, "removing a machine forgets its keys");
  } finally {
    await srv.close();
  }
});

test("api key: a key saved for a server wins over the environment and oMLX's own settings", () => {
  saveConfig({ keys: { "http://127.0.0.1:8000": "saved" }, hosts: [{ address: "gpu-box" }] });
  process.env.OMLX_API_KEY = "env";
  process.env.MTPLX_API_KEY = "env";
  try {
    assert.equal(omlxApiKey("http://127.0.0.1:8000", { apiKey: "settings" }), "saved");
    assert.equal(mtplxApiKey("http://127.0.0.1:8000"), "saved");
    // gpu-box is a machine the user added, so the environment key applies there.
    assert.equal(omlxApiKey("http://gpu-box:8000", {}), "env");
    assert.equal(mtplxApiKey("http://gpu-box:8000"), "env");
  } finally {
    delete process.env.OMLX_API_KEY;
    delete process.env.MTPLX_API_KEY;
  }
});

test("api key: the web page gets a password field and the transcript only says it was set", async () => {
  const sent = [];
  const ch = new SessionChannel("s1", { send: (ev) => sent.push(ev), changed() {}, touched() {} });
  const p = ch.prompt("API key for oMLX at gpu-box", "", { secret: true });
  const ask = sent.find((e) => e.t === "prompt");
  assert.equal(ask.secret, true);
  ch.handleAnswer(ask.id, KEY);
  assert.equal(await p, KEY);
  assert.ok(!JSON.stringify(ch.replay).includes(KEY), "the key is not kept in the transcript");
  assert.ok(ch.replay.some((e) => e.t === "line" && e.s === "API key for oMLX at gpu-box: (hidden)"));
});

test("api key: an environment key goes only to servers you chose, never to one a scan found", () => {
  saveConfig({ hosts: [{ address: "gpu-box" }] });
  process.env.OMLX_API_KEY = "env";
  process.env.MTPLX_API_KEY = "env";
  try {
    // This computer, and a machine that was added by hand.
    assert.equal(omlxApiKey("http://127.0.0.1:8000", {}), "env");
    assert.equal(mtplxApiKey("http://gpu-box:8000"), "env");
    // Anything a network search turned up: it only has to answer like oMLX.
    assert.equal(omlxApiKey("http://192.168.1.77:8000", {}), undefined);
    assert.equal(mtplxApiKey("http://192.168.1.77:8000"), undefined);
    // oMLX's own settings key stays on this computer, as before.
    assert.equal(omlxApiKey("http://192.168.1.77:8000", { apiKey: "settings" }), undefined);
    assert.equal(omlxApiKey("http://127.0.0.1:8000", { apiKey: "settings" }), "env");
  } finally {
    delete process.env.OMLX_API_KEY;
    delete process.env.MTPLX_API_KEY;
  }
});

test("api key: a machine running two keyed servers gets one key each", async () => {
  const a = "http://127.0.0.1:8000", b = "http://127.0.0.1:8001";
  saveConfig({ hosts: [{ address: "127.0.0.1", name: "Studio" }] });
  const probe = async (hosts) => [{ host: hosts[0], servers: [
    { backend: "omlx", baseUrl: a, models: [] },
    { backend: "mtplx", baseUrl: b, models: [{ id: "qwen" }] },
  ] }];
  const ui = scriptedUI({ picks: ["Studio", "API key", "MTPLX · " + b, null], texts: ["only-mtplx"] });
  assert.equal(await manageHosts(ui, probe), true);
  assert.deepEqual(loadConfig().keys, { [b]: "only-mtplx" }, "the key lands on the server it was typed for");
});
