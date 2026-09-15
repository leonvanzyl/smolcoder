// Attachments: pasted screenshots and dropped files reach the model (images as
// vision input when the model can see, text files inlined), and the web hub
// stores, serves and forgets them under its own data folder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { classifyUpload, extOf, renderAttachmentsForModel, safeName, IMAGE_TOKENS, MAX_TEXT_BYTES } = require("../dist/attachments");
const { toWire: ollamaWire } = require("../dist/providers/ollama");
const { toWire: lmWire } = require("../dist/providers/lmstudio");
const { ContextManager } = require("../dist/context");
const { parseLmStudioV1 } = require("../dist/detect");
const { Agent } = require("../dist/agent");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");
const { SessionChannel } = require("../dist/web/channel");
const { WebHub } = require("../dist/web/hub");

// A 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + label);
    await sleep(25);
  }
}

test("uploads: names are sanitized, kinds classified, unusable files refused", () => {
  assert.equal(safeName("..\\..\\evil.png"), "evil.png");
  assert.equal(safeName("/tmp/notes.md"), "notes.md");
  assert.equal(safeName(""), "file");
  assert.equal(extOf("shot.PNG", "application/octet-stream"), "png");
  assert.equal(extOf("", "image/png"), "png");
  assert.equal(extOf("", "text/plain; charset=utf-8"), "txt");
  assert.deepEqual(classifyUpload("a.png", "image/png", PNG), { kind: "image", mime: "image/png" });
  assert.deepEqual(classifyUpload("pasted", "image/jpeg", PNG), { kind: "image", mime: "image/jpeg" });
  assert.equal(classifyUpload("notes.md", "text/markdown", Buffer.from("# hi")).kind, "text");
  assert.match(classifyUpload("a.zip", "application/zip", Buffer.from([0x50, 0x4b, 3, 4, 0, 0])).error, /not a supported attachment/);
  assert.match(classifyUpload("big.log", "text/plain", Buffer.alloc(MAX_TEXT_BYTES + 1, 97)).error, /too large/);
  assert.match(classifyUpload("empty.txt", "text/plain", Buffer.alloc(0)).error, /empty/);
});

test("model rendering: text files are inlined, images become vision input or a note", () => {
  const dir = tmp("smol-att-");
  const txt = path.join(dir, "a.txt");
  fs.writeFileSync(txt, "hello ```world```");
  const img = path.join(dir, "b.png");
  fs.writeFileSync(img, PNG);
  const atts = [
    { id: "1", name: "a.txt", kind: "text", mime: "text/plain", size: 17, path: txt },
    { id: "2", name: "shot.png", kind: "image", mime: "image/png", size: PNG.length, path: img },
  ];
  const seen = renderAttachmentsForModel(atts, true);
  assert.match(seen.text, /\[Attached file: a\.txt \(17 bytes\)\]\n````\nhello ```world```\n````/);
  assert.match(seen.text, /\[Attached image: shot\.png\]/);
  assert.deepEqual(seen.images, [{ path: img, mime: "image/png", name: "shot.png" }]);
  const blind = renderAttachmentsForModel(atts, false);
  assert.equal(blind.images.length, 0);
  assert.match(blind.text, /cannot view images/);
  rm(dir);
});

test("ollama and lm studio wire formats carry the image bytes and skip missing files", () => {
  const dir = tmp("smol-wire-");
  const img = path.join(dir, "c.png");
  fs.writeFileSync(img, PNG);
  const b64 = PNG.toString("base64");
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "look", images: [{ path: img, mime: "image/png", name: "c.png" }, { path: path.join(dir, "missing.png"), mime: "image/png", name: "missing.png" }] },
  ];
  assert.deepEqual(ollamaWire(msgs)[1], { role: "user", content: "look", images: [b64] });
  assert.deepEqual(lmWire(msgs)[1], { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64," + b64 } }] });
  assert.deepEqual(ollamaWire([{ role: "user", content: "plain" }])[0], { role: "user", content: "plain" });
  assert.deepEqual(lmWire([{ role: "user", content: "plain" }])[0], { role: "user", content: "plain" });
  rm(dir);
});

test("context gauge counts images and lm studio listings report vision", () => {
  const m = new ContextManager(8000, 2000);
  const base = m.estimateMessages([{ role: "user", content: "x" }]);
  const withImg = m.estimateMessages([{ role: "user", content: "x", images: [{ path: "p", mime: "image/png", name: "n" }] }]);
  assert.equal(withImg - base, IMAGE_TOKENS);
  const models = parseLmStudioV1({ models: [{ key: "a", type: "vlm" }, { key: "b", type: "llm" }, { key: "c" }] });
  assert.deepEqual(models.map((x) => x.vision), [true, false, undefined]);
});

test("agent: a turn with attachments sends the file text and the images to the provider", async (t) => {
  const dir = tmp("smol-agent-");
  const ws = path.join(dir, "ws");
  fs.mkdirSync(ws);
  const txt = path.join(dir, "notes.txt");
  fs.writeFileSync(txt, "remember the milk");
  const img = path.join(dir, "shot.png");
  fs.writeFileSync(img, PNG);
  const atts = [
    { id: "1", name: "notes.txt", kind: "text", mime: "text/plain", size: 17, path: txt },
    { id: "2", name: "shot.png", kind: "image", mime: "image/png", size: PNG.length, path: img },
  ];
  const seen = [];
  const managers = [];
  const make = (vision) => {
    const ui = { token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {}, warn() {}, error() {}, startSpinner() {}, stopSpinner() {}, turnEnd() {}, planUpdated() {}, confirmCommand: async () => "yes" };
    const provider = { label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000, vision, setEffort() {}, effortLabel() { return null; }, async chat(messages) { seen.push(messages.at(-1)); return { content: "Done", toolCalls: [] }; } };
    const taskManager = new TaskManager(ws);
    managers.push(taskManager);
    const ctx = { workspace: ws, plan: new Plan(), taskManager, filesTouched: new Set(), commandsRun: [] };
    return new Agent(provider, "ro", "sys", ctx, new ContextManager(8000, 2000), new EventBus(), ui, false, 5);
  };
  t.after(() => { for (const m of managers) m.killAll(); rm(dir); });
  const sighted = make(true);
  await sighted.runTurn("what is this?", atts);
  assert.match(seen[0].content, /^what is this\?\n\n\[Attached file: notes\.txt \(17 bytes\)\]\n```\nremember the milk\n```\n\n\[Attached image: shot\.png\]/);
  assert.deepEqual(seen[0].images, [{ path: img, mime: "image/png", name: "shot.png" }]);
  assert.equal(sighted.originalRequest, "what is this? [attached: notes.txt, shot.png]");
  const blind = make(false);
  await blind.runTurn("", [atts[1]]);
  assert.equal(seen[1].images, undefined);
  assert.match(seen[1].content, /^See the attached file\.\n\n\[Attached image: shot\.png — this model cannot view images/);
  assert.equal(blind.originalRequest, "See the attached file. [attached: shot.png]");
});

test("channel: attachments ride along with the message and are echoed to the page", async () => {
  const sent = [];
  const ch = new SessionChannel("s9", { send: (ev) => sent.push(ev), changed() {}, touched() {} });
  const p = ch.readInput();
  const att = { id: "abc", name: "shot.png", kind: "image", mime: "image/png", size: 3, path: "/x/abc.png" };
  ch.handleMessage("", [att]);
  assert.deepEqual(await p, { text: "", attachments: [att] });
  const user = sent.find((e) => e.t === "user");
  assert.deepEqual(user.files, [{ id: "abc", name: "shot.png", kind: "image", size: 3, url: "/upload?sid=s9&id=abc" }]);
  assert.equal(ch.title, "shot.png");
  ch.handleMessage("plain");
  assert.equal(await ch.readInput(), "plain");
  ch.handleMessage("   ");
  assert.equal(sent.filter((e) => e.t === "user").length, 2, "an empty message with no attachments is ignored");
});

// ---- hub -----------------------------------------------------------------------

function request(hub, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const isBuf = Buffer.isBuffer(body);
    const req = http.request(
      { host: "127.0.0.1", port: hub.port, method, path: p, headers: Object.assign({ "content-type": isBuf ? "application/octet-stream" : "application/json" }, headers || {}) },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => { const raw = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, raw, body: raw.toString("utf8") }); });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(isBuf ? body : JSON.stringify(body));
    req.end();
  });
}

function readEvents(hub, stopWhen) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get({ host: "127.0.0.1", port: hub.port, path: "/events?k=" + hub.authToken }, (res) => {
      let buf = "";
      const finish = () => { req.destroy(); resolve(events); };
      const timer = setTimeout(finish, 3000);
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
        }
        if (events.some(stopWhen)) { clearTimeout(timer); finish(); }
      });
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? resolve(events) : reject(e)));
  });
}

/** A session whose model cannot see images; it records what readInput hands it. */
function fakeFactory(seen) {
  return async (ui, workspace) => {
    const session = {
      chosen: { id: "fake-model", backend: "ollama", vision: false },
      workspace,
      onExit: null,
      taskManager: { killAll() {}, runningSummary: () => [], recentUrls: () => [] },
      state: () => ({ mode: "edit", model: "fake-model", backend: "ollama", workspace, urls: [], commands: [] }),
      announce() {},
      restore() {},
      snapshot: () => ({ messages: [], plan: [], filesTouched: [], commandsRun: [], originalRequest: "", currentRequest: "", mode: "edit", effort: null, model: "fake-model", backend: "ollama" }),
      async suggestTitle() { return null; },
      async run() {
        for (;;) {
          const input = await ui.readInput();
          if (input === "/exit") { ui.close(); if (session.onExit) session.onExit(); return; }
          seen.push(input);
          ui.startSpinner("thinking");
          ui.token("ok");
          ui.stopSpinner();
          ui.turnEnd("done");
        }
      },
    };
    return session;
  };
}

test("hub: uploads are stored, served, attached to a message, and removed with the session", async () => {
  const dataDir = tmp("smol-up-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const seen = [];
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory(seen), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id: sid } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    const up = (name, bytes, type) => request(hub, "POST", "/upload" + k + "&sid=" + sid + "&name=" + encodeURIComponent(name), bytes, { "content-type": type });

    // a pasted screenshot arrives as raw png bytes
    const shotRes = await up("pasted-image.png", PNG, "image/png");
    assert.equal(shotRes.status, 200, shotRes.body);
    const shot = JSON.parse(shotRes.body);
    assert.equal(shot.kind, "image");
    assert.equal(shot.size, PNG.length);
    assert.match(shot.warning, /fake-model cannot see images/);
    const stored = path.join(dataDir, "uploads", sid, shot.id + ".png");
    assert.ok(fs.existsSync(stored), "stored under the data folder, not the workspace");
    assert.deepEqual(fs.readdirSync(ws), []);

    // served back for thumbnails and links
    const got = await request(hub, "GET", shot.url + "&k=" + hub.authToken);
    assert.equal(got.status, 200);
    assert.equal(got.headers["content-type"], "image/png");
    assert.ok(got.raw.equals(PNG));
    assert.equal((await request(hub, "GET", shot.url)).status, 403, "the key is still required");
    assert.equal((await request(hub, "GET", "/upload" + k + "&sid=" + sid + "&id=../../x")).status, 404);

    // a text file, and the kinds that are refused
    const tx = JSON.parse((await up("notes.md", Buffer.from("# plan"), "text/markdown")).body);
    assert.equal(tx.kind, "text");
    assert.equal(tx.warning, undefined);
    assert.equal((await up("a.zip", Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), "application/zip")).status, 415);
    assert.equal((await request(hub, "POST", "/upload" + k + "&sid=nope&name=a.png", PNG, { "content-type": "image/png" })).status, 404);

    // a removed upload is gone from disk and can no longer be attached
    const gone = JSON.parse((await up("x.txt", Buffer.from("x"), "text/plain")).body);
    await request(hub, "POST", "/upload/remove" + k, { sid, id: gone.id });
    assert.ok(!fs.existsSync(path.join(dataDir, "uploads", sid, gone.id + ".txt")));
    assert.match((await request(hub, "POST", "/msg" + k, { sid, text: "hi", attachments: [gone.id] })).body, /no longer available/);

    // the message carries both attachments to the session and to the page
    assert.equal((await request(hub, "POST", "/msg" + k, { sid, text: "what is this?", attachments: [shot.id, tx.id] })).status, 200);
    await until(() => seen.length === 1, 4000, "session input");
    assert.equal(seen[0].text, "what is this?");
    assert.deepEqual(seen[0].attachments.map((a) => [a.name, a.kind, a.path]), [
      ["pasted-image.png", "image", stored],
      ["notes.md", "text", path.join(dataDir, "uploads", sid, tx.id + ".md")],
    ]);
    const events = await readEvents(hub, (e) => e.t === "user");
    const user = events.find((e) => e.t === "user");
    assert.equal(user.s, "what is this?");
    assert.deepEqual(user.files.map((f) => [f.name, f.kind, f.url]), [["pasted-image.png", "image", shot.url], ["notes.md", "text", tx.url]]);

    // deleting the session takes its uploads with it
    await request(hub, "POST", "/sessions/delete" + k, { id: sid });
    await until(() => !fs.existsSync(path.join(dataDir, "uploads", sid)), 4000, "uploads removed");
  } finally {
    hub.close();
  }
  rm(dataDir);
});
