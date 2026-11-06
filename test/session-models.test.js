// Model recents, favorites and per-model effort: the grouped picker (with a
// star action), `/models next` (F2) and effort that follows the model.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smol-models-")), "config.json");
process.env.SMOLCODER_CONFIG = CONFIG;

const config = require("../dist/config");
const { modelRows, modelOptions, resetModelCache, Session } = require("../dist/session");

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const reset = (cfg = {}) => fs.writeFileSync(CONFIG, JSON.stringify(cfg));

/** A fake Ollama serving `models`; records chat requests. */
async function serveOllama(models) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      else if (req.url === "/api/show") res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "x.context_length": 32768 } }));
      else if (req.url === "/api/ps") res.end(JSON.stringify({ models: models.map((name) => ({ name, model: name, context_length: 8192 })) }));
      else if (req.url === "/api/chat" && !json.messages?.length) res.end("{}");
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { port, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function scriptedUI({ inputs = [], onSelect } = {}) {
  const shown = { selects: [], lines: [], warnings: [] };
  return {
    shown,
    slashCommands: [], getStatus: () => "", hintLeft: "", onModeCycle: null, onCancel: null, onExit: null,
    start() {}, close() {}, refresh() {},
    async readInput() { return inputs.shift() ?? "/exit"; },
    async select(title, options, opts) {
      shown.selects.push({ title, options, opts });
      return onSelect ? onSelect(title, options, opts) : null;
    },
    async prompt() { return null; },
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, turnEnd() {}, planUpdated() {}, resetResponse() {},
    println(s = "") { shown.lines.push(strip(s)); },
    status(s) { shown.lines.push(strip(s)); },
    warn(s) { shown.warnings.push(strip(s)); },
    error(s) { shown.warnings.push(strip(s)); },
    startSpinner() {}, stopSpinner() {},
    async confirmCommand() { return "no"; },
  };
}

const m = (id, baseUrl, host) => ({ id, backend: "ollama", baseUrl, contextWindow: 8192, toolsSupported: true, ...(host ? { host } : {}) });

// ---- config ---------------------------------------------------------------------

test("config: recents keep the newest 10 without duplicates; favorites toggle; effort per model", () => {
  reset();
  for (let i = 0; i < 12; i++) config.recordRecentModel({ id: `m${i}`, baseUrl: "http://a" });
  config.recordRecentModel({ id: "m5", baseUrl: "http://a" });
  const recent = config.loadConfig().recentModels;
  assert.equal(recent.length, 10);
  assert.deepEqual(recent.slice(0, 3).map((r) => r.id), ["m5", "m11", "m10"]);
  assert.equal(recent.filter((r) => r.id === "m5").length, 1);
  // The same id on another machine is another entry.
  config.recordRecentModel({ id: "m5", baseUrl: "http://b" });
  assert.deepEqual(config.loadConfig().recentModels.slice(0, 2).map((r) => r.baseUrl), ["http://b", "http://a"]);

  assert.equal(config.toggleFavoriteModel({ id: "x", baseUrl: "http://a" }), true);
  assert.equal(config.toggleFavoriteModel({ id: "y", baseUrl: "http://a" }), true);
  assert.deepEqual(config.loadConfig().favoriteModels.map((f) => f.id), ["y", "x"]);
  assert.equal(config.toggleFavoriteModel({ id: "x", baseUrl: "http://a" }), false);
  assert.deepEqual(config.loadConfig().favoriteModels.map((f) => f.id), ["y"]);

  config.saveModelEffort("x", "low");
  config.saveModelEffort("y", null);
  assert.deepEqual(config.loadConfig().effortByModel, { x: "low", y: null });

  // Broken entries in a hand-made file are dropped.
  reset({ recentModels: [{ id: "ok", baseUrl: "http://a" }, { id: 3 }, null], favoriteModels: "nope", effortByModel: { a: "max", b: "high" } });
  const cfg = config.loadConfig();
  assert.deepEqual(cfg.recentModels, [{ id: "ok", baseUrl: "http://a" }]);
  assert.deepEqual(cfg.favoriteModels, []);
  assert.deepEqual(cfg.effortByModel, { b: "high" });
});

// ---- the picker rows --------------------------------------------------------------

test("picker rows: Favorites, Recent, this computer, then each machine; starred and current set", () => {
  const here1 = m("qwen:8b", "http://127.0.0.1:11434");
  const here2 = m("llama:3b", "http://127.0.0.1:11434");
  const box1 = m("qwen:27b", "http://10.0.0.5:11434", "gpu-box");
  const box2 = m("gemma:12b", "http://10.0.0.5:11434", "gpu-box");
  const mac = m("mlx:7b", "http://10.0.0.9:8000", "mac");
  const all = [box1, mac, here1, box2, here2];
  const prefs = {
    favoriteModels: [{ id: "gemma:12b", baseUrl: box2.baseUrl }, { id: "gone", baseUrl: "http://x" }],
    recentModels: [{ id: "qwen:8b", baseUrl: here1.baseUrl }, { id: "gemma:12b", baseUrl: box2.baseUrl }],
  };
  const { options, models } = modelRows(all, here1, prefs);
  assert.deepEqual(options.map((o) => [o.group, o.label]), [
    ["Favorites", "gemma:12b"],
    ["Recent", "qwen:8b"],
    ["This computer", "llama:3b"],
    ["gpu-box", "qwen:27b"],
    ["mac", "mlx:7b"],
  ]);
  assert.deepEqual(models, [box2, here1, here2, box1, mac], "each row maps to its model");
  assert.deepEqual(options.map((o) => !!o.starred), [true, false, false, false, false]);
  assert.deepEqual(options.map((o) => !!o.current), [false, true, false, false, false]);
  // Without prefs the rows follow the list one to one (old callers index by it).
  assert.deepEqual(modelOptions(all).map((o) => o.label), all.map((x) => x.id));
  assert.deepEqual(modelOptions(all).map((o) => o.group), ["gpu-box", "mac", "This computer", "gpu-box", "This computer"]);
});

test("/models: the picker stars with onStar, records the pick as recent and brings its effort", async () => {
  const ollama = await serveOllama(["alpha:1b", "beta:2b"]);
  const old = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = `127.0.0.1:${ollama.port}`;
  resetModelCache();
  reset({ effortByModel: { "beta:2b": "off" } });
  try {
    let starred;
    const ui = scriptedUI({
      inputs: ["/models"],
      onSelect(title, options, opts) {
        assert.equal(title, "Select model");
        assert.ok(options.some((o) => /Refresh/.test(o.label)), "a refresh row");
        assert.equal(typeof opts?.onStar, "function");
        const beta = options.findIndex((o) => o.label === "beta:2b");
        starred = opts.onStar(beta);
        const first = starred[0];
        assert.deepEqual([first.label, first.group, first.starred], ["beta:2b", "Favorites", true]);
        return 0; // pick it from Favorites
      },
    });
    const alpha = m("alpha:1b", ollama.base);
    const session = new Session(ui, { workspace: tmp("smol-models-ws-"), chosen: alpha, prefs: {}, cfg: config.loadConfig() });
    assert.equal(session.effort, null);
    await session.run();
    assert.equal(session.chosen.id, "beta:2b");
    assert.equal(session.effort, "off", "beta's remembered effort came with it");
    const cfg = config.loadConfig();
    assert.deepEqual(cfg.favoriteModels.map((f) => f.id), ["beta:2b"]);
    assert.deepEqual(cfg.recentModels.slice(0, 2).map((r) => r.id), ["beta:2b", "alpha:1b"]);
    assert.ok(ui.shown.lines.some((l) => /effort off \(remembered for beta:2b\)/.test(l)));
  } finally {
    process.env.OLLAMA_HOST = old;
    if (old === undefined) delete process.env.OLLAMA_HOST;
    await ollama.close();
  }
});

test("/effort is saved for the current model and restored when a session starts with it", () => {
  reset();
  const ui = scriptedUI();
  const chosen = m("gamma:4b", "http://127.0.0.1:9");
  const s1 = new Session(ui, { workspace: tmp("smol-eff-"), chosen, prefs: {}, cfg: config.loadConfig() });
  return s1["setEffort"]("high").then(() => {
    assert.deepEqual(config.loadConfig().effortByModel, { "gamma:4b": "high" });
    config.updateConfig({ effort: "off" }); // the global default says otherwise
    const s2 = new Session(scriptedUI(), { workspace: tmp("smol-eff-"), chosen, prefs: {}, cfg: config.loadConfig() });
    assert.equal(s2.effort, "high");
    const s3 = new Session(scriptedUI(), { workspace: tmp("smol-eff-"), chosen, prefs: { effort: "low" }, cfg: config.loadConfig() });
    assert.equal(s3.effort, "low", "--effort still wins");
  });
});

test("/models next cycles through recent models without a picker", async () => {
  const ollama = await serveOllama(["one:1b", "two:2b", "three:3b"]);
  const old = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = `127.0.0.1:${ollama.port}`;
  resetModelCache();
  const ref = (id) => ({ id, baseUrl: ollama.base, backend: "ollama" });
  reset({ recentModels: [ref("one:1b"), ref("two:2b"), ref("gone:9b"), ref("three:3b")], effortByModel: { "three:3b": "medium" } });
  try {
    const ui = scriptedUI({ inputs: ["/models next", "/models next", "/models next"] });
    const session = new Session(ui, { workspace: tmp("smol-next-"), chosen: m("one:1b", ollama.base), prefs: {}, cfg: config.loadConfig() });
    const seen = [];
    // Watch each switch as it happens.
    const orig = session["useModel"].bind(session);
    session["useModel"] = async (t) => {
      const ok = await orig(t);
      if (ok) seen.push(`${session.chosen.id}/${session.effort}`);
      return ok;
    };
    await session.run();
    assert.deepEqual(seen, ["two:2b/null", "three:3b/medium", "one:1b/medium"], "gone:9b is skipped; cycling wraps; effort follows");
    seen.forEach((s, i) => (seen[i] = s.split("/")[0]));
    assert.deepEqual(seen, ["two:2b", "three:3b", "one:1b"], "gone:9b is skipped; cycling wraps");
    assert.equal(ui.shown.selects.length, 0, "no picker");
    assert.ok(ui.shown.lines.some((l) => /gone:9b is not available right now/.test(l)));
    assert.deepEqual(config.loadConfig().recentModels.map((r) => r.id), ["one:1b", "two:2b", "gone:9b", "three:3b"], "cycling keeps the order");
    assert.equal(seen.length, 3);
  } finally {
    process.env.OLLAMA_HOST = old;
    if (old === undefined) delete process.env.OLLAMA_HOST;
    await ollama.close();
  }
});
