// Network hosts: address parsing, the saved list, subnet selection, the scan,
// and the picker flows that tie them together — all against fake servers on
// loopback, so no real network is touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// Must be set before dist/config is loaded: the flows save hosts for the user.
const CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smol-net-")), "config.json");
process.env.SMOLCODER_CONFIG = CONFIG;

const { loadConfig, saveConfig, updateConfig } = require("../dist/config");
const { addHost, hostLabel, hostUrls, isPrivateHost, parseAddress, removeHost, renameHost } = require("../dist/hosts");
const { localSubnets, scanSubnets } = require("../dist/netscan");
const { findModelsOnNetwork, manageHosts, notFoundHelp } = require("../dist/network");
const { autoPickModel, modelOptions, setupWithoutLocalModels } = require("../dist/session");

async function serveOllama(names = ["remote-model:latest"]) {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") res.end(JSON.stringify({ models: names.map((name) => ({ name })) }));
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A UI that answers from a script: selects by label (a string or regex),
 * prompts with the next queued text. Records everything it was shown. */
function scriptedUI({ picks = [], texts = [] }) {
  const shown = { selects: [], prompts: [], lines: [] };
  return {
    shown,
    async select(title, options) {
      shown.selects.push({ title, options });
      const want = picks.shift();
      if (want === undefined || want === null) return null;
      const idx = options.findIndex((o) => (want instanceof RegExp ? want.test(o.label) : o.label === want));
      assert.notEqual(idx, -1, `no option ${want} in "${title}": ${options.map((o) => o.label).join(" | ")}`);
      return idx;
    },
    async prompt(title) {
      shown.prompts.push(title);
      return texts.length ? texts.shift() : null;
    },
    status: (s) => shown.lines.push(s),
    warn: (s) => shown.lines.push(s),
    startSpinner() {},
    stopSpinner() {},
  };
}

// ---- addresses -------------------------------------------------------------

test("a bare host means both usual ports; anything more specific names one server", () => {
  assert.deepEqual(parseAddress(" 192.168.1.50 "), {
    address: "192.168.1.50",
    hostname: "192.168.1.50",
    urls: ["http://192.168.1.50:11434", "http://192.168.1.50:1234", "http://192.168.1.50:8000"],
  });
  assert.deepEqual(parseAddress("GPU-Box.local").urls, ["http://gpu-box.local:11434", "http://gpu-box.local:1234", "http://gpu-box.local:8000"]);
  assert.deepEqual(parseAddress("gpu-box:4321").urls, ["http://gpu-box:4321"]);
  assert.deepEqual(parseAddress("box:80").urls, ["http://box"], "a typed default port still means that one server");
  assert.deepEqual(parseAddress("https://llm.example.com/").urls, ["https://llm.example.com"]);
  assert.deepEqual(parseAddress("https://llm.example.com/ollama/").urls, ["https://llm.example.com/ollama"]);
  assert.deepEqual(parseAddress("fe80::1").urls, ["http://[fe80::1]:11434", "http://[fe80::1]:1234", "http://[fe80::1]:8000"]);
  assert.deepEqual(parseAddress("[fe80::1]:9000").urls, ["http://[fe80::1]:9000"]);
});

test("unusable addresses are refused in plain words", () => {
  for (const bad of ["", "   ", "two words", "ftp://box", "http://user:pw@box", "0.0.0.0", "http://"]) {
    assert.throws(() => parseAddress(bad), Error, JSON.stringify(bad));
  }
});

test("the saved list adds without duplicates, renames and removes", () => {
  let hosts = addHost([], { address: "192.168.1.50" });
  hosts = addHost(hosts, { address: "gpu-box.local", name: "GPU box" });
  hosts = addHost(hosts, { address: "192.168.1.50 ", name: "Attic" });
  assert.deepEqual(hosts, [{ address: "192.168.1.50", name: "Attic" }, { address: "gpu-box.local", name: "GPU box" }]);
  assert.equal(hostLabel({ address: "http://10.0.0.7:11434" }), "10.0.0.7");
  assert.equal(hostLabel(hosts[1]), "GPU box");
  assert.deepEqual(hostUrls({ address: "not an address" }), []);
  hosts = renameHost(hosts, "192.168.1.50", "  Garage   PC ");
  assert.equal(hosts[0].name, "Garage PC");
  assert.deepEqual(renameHost(hosts, "192.168.1.50", " ")[0], { address: "192.168.1.50" }, "an empty name goes back to the address");
  assert.deepEqual(removeHost(hosts, "GPU-BOX.local"), [hosts[0]]);
});

test("addresses outside a home or office network are recognized", () => {
  for (const inside of ["192.168.1.50", "10.1.2.3", "172.20.0.4", "100.101.102.103", "127.0.0.1", "gpu-box", "gpu-box.local", "nas.lan", "box.tailnet.ts.net", "fd12::1", "::1"]) {
    assert.equal(isPrivateHost(inside), true, inside);
  }
  for (const outside of ["8.8.8.8", "172.32.0.1", "llm.example.com", "2001:db8::1"]) assert.equal(isPrivateHost(outside), false, outside);
});

// ---- config ----------------------------------------------------------------

test("remembering the model never forgets the hosts, and old configs still load", () => {
  saveConfig({ lastModel: "a", hosts: [{ address: "192.168.1.50", name: "Attic" }] });
  updateConfig({ lastModel: "b", lastModelUrl: "http://192.168.1.50:11434", lastMode: "edit", effort: null });
  assert.deepEqual(loadConfig().hosts, [{ address: "192.168.1.50", name: "Attic" }]);
  assert.equal(loadConfig().lastModelUrl, "http://192.168.1.50:11434");

  fs.writeFileSync(CONFIG, JSON.stringify({ lastModel: "x", hosts: [{ address: " 10.0.0.2 " }, { name: "no address" }, "junk", null] }));
  assert.deepEqual(loadConfig().hosts, [{ address: "10.0.0.2" }]);
  fs.writeFileSync(CONFIG, JSON.stringify({ lastModel: "x" }));
  assert.deepEqual(loadConfig().hosts, []);
});

// ---- subnets ---------------------------------------------------------------

const v4 = (address, netmask, internal = false) => ({ address, netmask, family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: null });

test("subnets are chosen by address, the same way on every OS", () => {
  const windows = {
    "Wi-Fi": [v4("192.168.1.23", "255.255.255.0"), { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false }],
    "vEthernet (WSL (Hyper-V firewall))": [v4("172.29.80.1", "255.255.240.0")],
    "Loopback Pseudo-Interface 1": [v4("127.0.0.1", "255.0.0.0", true)],
  };
  const found = localSubnets(windows);
  assert.deepEqual(found.map((s) => s.cidr), ["192.168.1.0/24"]);
  assert.equal(found[0].addresses.length, 253, "254 usable addresses minus our own");
  assert.ok(!found[0].addresses.includes("192.168.1.23"));
  assert.equal(found[0].addresses[0], "192.168.1.1");
  assert.equal(found[0].addresses.at(-1), "192.168.1.254");

  const mac = { lo0: [v4("127.0.0.1", "255.0.0.0", true)], en0: [v4("10.0.4.17", "255.255.252.0")], utun3: [v4("100.64.0.9", "255.255.255.255")] };
  assert.deepEqual(localSubnets(mac).map((s) => [s.cidr, s.addresses.length]), [["10.0.4.0/22", 1021]]);

  const linux = {
    eth0: [v4("10.20.30.40", "255.0.0.0")], // a huge office network: only our own /24 is searched
    docker0: [v4("172.17.0.1", "255.255.0.0")],
    "br-3f9a1c2d4e5f": [v4("172.18.0.1", "255.255.0.0")],
    wlan0: [v4("169.254.10.2", "255.255.0.0")],
    ppp0: [v4("8.8.4.4", "255.255.255.0")],
  };
  assert.deepEqual(localSubnets(linux).map((s) => s.cidr), ["10.20.30.0/24"]);
  assert.deepEqual(localSubnets({}), []);
});

test("a Hyper-V external switch is the real network and is searched", () => {
  const found = localSubnets({ "vEthernet (External Switch)": [v4("192.168.0.9", "255.255.255.0")] });
  assert.deepEqual(found.map((s) => s.cidr), ["192.168.0.0/24"]);
});

// ---- scan + flows ----------------------------------------------------------

test("the scan reports model servers and ignores closed or unrelated ports", async () => {
  const ollama = await serveOllama(["a", "b"]);
  const other = http.createServer((req, res) => res.end("hello"));
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  const closed = await serveOllama();
  await closed.close();
  let last = [0, 0];
  try {
    const found = await scanSubnets([{ cidr: "127.0.0.0/30", addresses: ["127.0.0.1"] }], {
      ports: [ollama.port, other.address().port, closed.port],
      onProgress: (done, total) => (last = [done, total]),
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].ip, "127.0.0.1");
    assert.deepEqual(found[0].servers, [{ url: `http://127.0.0.1:${ollama.port}`, backend: "ollama", models: 2 }]);
    assert.deepEqual(last, [3, 3]);
  } finally {
    await Promise.all([ollama.close(), new Promise((resolve) => other.close(resolve))]);
  }
});

test("entering an address checks it, saves it, and says what it found", async () => {
  saveConfig({ lastModel: "keep-me" });
  const server = await serveOllama(["a", "b", "c"]);
  try {
    const ui = scriptedUI({ picks: ["Enter an address"], texts: [`127.0.0.1:${server.port}`] });
    assert.equal(await findModelsOnNetwork(ui), true);
    assert.deepEqual(loadConfig().hosts, [{ address: `http://127.0.0.1:${server.port}` }]);
    assert.equal(loadConfig().lastModel, "keep-me");
    assert.ok(ui.shown.lines.some((l) => /added 127\.0\.0\.1 — Ollama · 3 models/.test(l)), ui.shown.lines.join("\n"));
  } finally {
    await server.close();
  }
});

test("an address where nothing answers is not saved, and the help names the server-side switches", async () => {
  saveConfig({});
  const gone = await serveOllama();
  await gone.close();
  const ui = scriptedUI({ picks: ["Enter an address"], texts: [`127.0.0.1:${gone.port}`] });
  assert.equal(await findModelsOnNetwork(ui), false);
  assert.deepEqual(loadConfig().hosts, []);
  const said = ui.shown.lines.join("\n");
  assert.match(said, /Nothing answered/);
  assert.match(said, /Expose Ollama to the network/);
  assert.match(said, /Serve on Local Network/);
  assert.match(notFoundHelp("darwin"), /Local Network must allow your terminal/);
  assert.doesNotMatch(notFoundHelp("win32"), /this Mac/);

  const typo = scriptedUI({ picks: ["Enter an address"], texts: ["ftp://box"] });
  assert.equal(await findModelsOnNetwork(typo), false);
  assert.match(typo.shown.lines.join("\n"), /Only http/);
  const cancelled = scriptedUI({ picks: [null] });
  assert.equal(await findModelsOnNetwork(cancelled), false);
});

test("network hosts can be renamed and removed from the picker", async () => {
  const server = await serveOllama(["a"]);
  const address = `http://127.0.0.1:${server.port}`;
  saveConfig({ hosts: [{ address }, { address: "http://127.0.0.1:9", name: "asleep" }] });
  try {
    const ui = scriptedUI({ picks: ["127.0.0.1", "Rename", "asleep", "Remove", null], texts: ["Attic"] });
    assert.equal(await manageHosts(ui), true);
    assert.deepEqual(loadConfig().hosts, [{ address, name: "Attic" }]);
    const first = ui.shown.selects[0].options;
    assert.match(first[0].hint, /Ollama · 1 model$/);
    assert.match(first[1].hint, /not reachable right now/);
    const asleepActions = ui.shown.selects[3].options.map((o) => o.label);
    assert.deepEqual(asleepActions, ["Rename", "Remove", "Look for it again"], "only an unreachable host offers a re-search");
  } finally {
    await server.close();
  }
});

test("with nothing on this computer, startup offers the network instead of giving up", async () => {
  // An LM Studio look-alike with a loaded model, so choosing it needs no further requests.
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/models")
      res.end(JSON.stringify({ models: [{ key: "remote-qwen", type: "llm", max_context_length: 32768, loaded_instances: [{ id: "remote-qwen", config: { context_length: 8192 } }] }] }));
    else res.end(JSON.stringify({ error: "Unexpected endpoint or method." }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    saveConfig({});
    // "zzz" matches no backend, which stands in for a computer with no servers.
    const none = scriptedUI({ picks: ["Look again", null] });
    assert.equal(await setupWithoutLocalModels(none, { backend: "zzz" }), null);
    assert.match(none.shown.lines.join("\n"), /Still no model server answering/);
    assert.deepEqual(none.shown.selects[0].options.map((o) => o.label), ["Find models on another machine", "Look again"]);

    // Add the machine by address; a dev box may also run a real LM Studio, in
    // which case the model picker appears and the remote one is chosen.
    const ui = scriptedUI({
      picks: ["Find models on another machine", "Enter an address", /^remote-qwen$/],
      texts: [`127.0.0.1:${server.address().port}`],
    });
    const chosen = await setupWithoutLocalModels(ui, { backend: "lmstudio" });
    assert.equal(chosen.id, "remote-qwen");
    assert.equal(chosen.host, "127.0.0.1");
    assert.equal(chosen.contextWindow, 8192);
    assert.equal(loadConfig().hosts.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---- picking ---------------------------------------------------------------

test("the same model id on two machines stays unambiguous", () => {
  const here = { id: "qwen:27b", backend: "ollama", baseUrl: "http://127.0.0.1:11434", contextWindow: 0 };
  const there = { ...here, baseUrl: "http://192.168.1.50:11434", host: "gpu-box" };
  const lm = { id: "other", backend: "lmstudio", baseUrl: "http://127.0.0.1:1234", contextWindow: 4096, loaded: true };
  assert.equal(autoPickModel([here, there], undefined, "qwen:27b", there.baseUrl), there);
  assert.equal(autoPickModel([here, there], undefined, "qwen:27b", undefined), here);
  assert.equal(autoPickModel([here, there], "qwen:27b", undefined, there.baseUrl), there, "a resumed web session goes back to its machine");
  assert.equal(autoPickModel([here], undefined, "qwen:27b", there.baseUrl), here, "its machine is off: same model, this computer");
  assert.equal(autoPickModel([there, lm], undefined, undefined), lm, "with nothing remembered, this computer beats the network");
  assert.equal(autoPickModel([there], undefined, undefined), there);

  const rows = modelOptions([here, there, lm], there);
  assert.deepEqual(rows.map((r) => r.hint.replace(/4.096/, "4096")), ["ollama", "ollama · gpu-box", "lm studio · ctx 4096"]);
  assert.deepEqual(rows.map((r) => r.current), [false, true, false]);
});
