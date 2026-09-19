const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  detectAll,
  groupServers,
  identifyServer,
  lmStudioBaseUrls,
  ollamaBaseUrls,
  parseDefaultGateway,
  parseDockerBaseUrls,
  parseLmStudioServerPort,
  probeHosts,
  readLmStudioPort,
} = require("../dist/detect");

/** A fake model server: `routes` maps a path to a JSON body (or [status, body]). */
async function serve(routes) {
  const server = http.createServer((req, res) => {
    const hit = routes[req.url];
    const [status, body] = Array.isArray(hit) ? hit : hit === undefined ? [404, { error: "not found" }] : [200, hit];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

const OLLAMA = { "/api/tags": { models: [{ name: "local-test:latest" }] } };
// LM Studio answers unknown paths with 200 and an error body, not a 404.
const LMSTUDIO = {
  "/api/tags": { error: "Unexpected endpoint or method. (GET /api/tags)" },
  "/api/v1/models": { models: [{ key: "qwen-test", type: "llm", max_context_length: 32768, loaded_instances: [{ id: "qwen-test", config: { context_length: 16384 } }] }] },
};

test("Ollama candidates cover Windows and IPv6 loopback spellings", () => {
  assert.deepEqual(ollamaBaseUrls(undefined).slice(0, 3), [
    "http://127.0.0.1:11434",
    "http://localhost:11434",
    "http://[::1]:11434",
  ]);
  assert.deepEqual(ollamaBaseUrls("localhost").slice(0, 3), [
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://[::1]:11434",
  ]);
  assert.equal(ollamaBaseUrls("0.0.0.0")[0], "http://127.0.0.1:11434");
});

test("a remote OLLAMA_HOST is tried before local fallbacks", () => {
  assert.deepEqual(ollamaBaseUrls("http://model-box:22114").slice(0, 2), [
    "http://model-box:22114",
    "http://127.0.0.1:11434",
  ]);
});

test("LM Studio candidates follow the port in its settings, then the default", () => {
  assert.deepEqual(lmStudioBaseUrls(undefined), ["http://127.0.0.1:1234", "http://localhost:1234", "http://[::1]:1234"]);
  assert.deepEqual(lmStudioBaseUrls(1234), lmStudioBaseUrls(undefined), "the default port is not listed twice");
  assert.deepEqual(lmStudioBaseUrls(4321).filter((u) => u.startsWith("http://127")), ["http://127.0.0.1:4321", "http://127.0.0.1:1234"]);
});

test("LM Studio's server port is read from its settings file, wherever its home is", () => {
  assert.equal(parseLmStudioServerPort('{"port": 4321, "networkInterface": "127.0.0.1"}'), 4321);
  assert.equal(parseLmStudioServerPort('{"port": "4321"}'), undefined);
  assert.equal(parseLmStudioServerPort('{"port": 0}'), undefined);
  assert.equal(parseLmStudioServerPort("not json"), undefined);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "smol-lms-"));
  assert.equal(readLmStudioPort(home), undefined, "no LM Studio installed");
  const write = (dir, port) => {
    fs.mkdirSync(path.join(dir, ".internal"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".internal", "http-server-config.json"), JSON.stringify({ port }));
  };
  write(path.join(home, ".lmstudio"), 5001);
  assert.equal(readLmStudioPort(home), 5001);
  const moved = path.join(home, "elsewhere");
  write(moved, 5002);
  fs.writeFileSync(path.join(home, ".lmstudio-home-pointer"), moved + "\n");
  assert.equal(readLmStudioPort(home), 5002, "the home pointer wins over the default folder");
});

test("container port discovery finds nonstandard published ports for both backends", () => {
  const output = [
    "0.0.0.0:49160->11434/tcp, [::]:49160->11434/tcp",
    "127.0.0.1:22114->11434/tcp",
    "0.0.0.0:8081->1234/tcp",
    "0.0.0.0:3000->3000/tcp",
    "11434/tcp",
  ].join("\n");
  assert.deepEqual(parseDockerBaseUrls(output), [
    "http://127.0.0.1:49160",
    "http://[::1]:49160",
    "http://127.0.0.1:22114",
    "http://127.0.0.1:8081",
  ]);
  assert.deepEqual(parseDockerBaseUrls("0.0.0.0:9000->4321/tcp", [11434, 4321]), ["http://127.0.0.1:9000"], "a custom LM Studio port is followed into containers");
});

test("the WSL/container host is found through the default gateway", () => {
  const route = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "eth0\t0010A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0",
    "eth0\t00000000\t0110A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0",
  ].join("\n");
  assert.equal(parseDefaultGateway(route), "192.168.16.1");
  assert.equal(parseDefaultGateway("Iface\tDestination\tGateway\n"), undefined);
});

test("loopback spellings of one port are one server; everything else stands alone", () => {
  const groups = groupServers(
    ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434", "http://127.0.0.1:1234", "http://gpu-box:11434", "http://gpu-box:1234"],
    1000
  );
  assert.deepEqual(groups.map((g) => g.urls), [
    ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"],
    ["http://127.0.0.1:1234"],
    ["http://gpu-box:11434"],
    ["http://gpu-box:1234"],
  ]);
});

test("a server is identified by what it answers, not by its port", async () => {
  const ollama = await serve(OLLAMA);
  const lmstudio = await serve(LMSTUDIO);
  const neither = await serve({ "/": { hello: "world" } });
  try {
    const o = await identifyServer(`http://127.0.0.1:${ollama.port}`, 2000);
    assert.equal(o.backend, "ollama");
    assert.deepEqual(o.models.map((m) => m.id), ["local-test:latest"]);

    const l = await identifyServer(`http://127.0.0.1:${lmstudio.port}`, 2000);
    assert.equal(l.backend, "lmstudio");
    assert.equal(l.models[0].baseUrl, `http://127.0.0.1:${lmstudio.port}`, "models carry the address they were found at");
    assert.equal(l.models[0].contextWindow, 16384);

    assert.equal(await identifyServer(`http://127.0.0.1:${neither.port}`, 2000), null);
  } finally {
    await Promise.all([ollama.close(), lmstudio.close(), neither.close()]);
  }
  assert.equal(await identifyServer(`http://127.0.0.1:${ollama.port}`, 2000), null, "nothing listening");
});

test("an Ollama server's OpenAI-compatible listing does not make it look like LM Studio", async () => {
  const server = await serve({ "/api/tags": { models: [] }, "/v1/models": { object: "list", data: [{ id: "x" }] } });
  try {
    const info = await identifyServer(`http://127.0.0.1:${server.port}`, 2000);
    assert.equal(info.backend, "ollama");
    assert.deepEqual(info.models, []);
  } finally {
    await server.close();
  }
});

test("detection falls back between loopback spellings and merges every server found", async () => {
  const ollama = await serve(OLLAMA);
  const lmstudio = await serve(LMSTUDIO);
  const old = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = `[::1]:${ollama.port}`; // the server only listens on 127.0.0.1
  try {
    const models = await detectAll({ hosts: [{ address: `127.0.0.1:${lmstudio.port}`, name: "gpu-box" }] });
    const local = models.find((m) => m.id === "local-test:latest");
    assert.equal(local.baseUrl, `http://127.0.0.1:${ollama.port}`);
    assert.equal(local.host, undefined, "this computer has no host label");
    const remote = models.find((m) => m.id === "qwen-test");
    assert.equal(remote.backend, "lmstudio");
    assert.equal(remote.host, "gpu-box");
    assert.ok(models.indexOf(local) < models.indexOf(remote), "this computer's models come first");
  } finally {
    if (old === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = old;
    await Promise.all([ollama.close(), lmstudio.close()]);
  }
});

test("a host that is switched off is reported as unreachable and hides nothing else", async () => {
  const up = await serve(OLLAMA);
  const down = await serve(OLLAMA);
  await down.close();
  try {
    const hosts = [{ address: `127.0.0.1:${down.port}`, name: "asleep" }, { address: `127.0.0.1:${up.port}`, name: "awake" }];
    const statuses = await probeHosts(hosts);
    assert.deepEqual(statuses.map((s) => s.servers.length), [0, 1]);
    const models = await detectAll({ hosts });
    assert.ok(models.some((m) => m.host === "awake"));
    assert.ok(!models.some((m) => m.host === "asleep"));
  } finally {
    await up.close();
  }
});

test("startup stops looking once the remembered model turns up", async () => {
  const fast = await serve(OLLAMA);
  // Accepts connections and never answers — a machine that would cost a full timeout.
  const hung = http.createServer(() => {});
  await new Promise((resolve) => hung.listen(0, "127.0.0.1", resolve));
  try {
    const hosts = [{ address: `127.0.0.1:${fast.port}`, name: "fast" }, { address: `127.0.0.1:${hung.address().port}`, name: "hung" }];
    const t0 = Date.now();
    const models = await detectAll({ hosts, until: (m) => m.id === "local-test:latest" });
    assert.ok(models.some((m) => m.id === "local-test:latest"));
    assert.ok(Date.now() - t0 < 1400, "did not wait for the unresponsive host's timeout");
  } finally {
    hung.closeAllConnections?.();
    await Promise.all([fast.close(), new Promise((resolve) => hung.close(resolve))]);
  }
});
