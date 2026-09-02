// The web hub and its parts: session channel semantics (input, approvals,
// cancel, close), on-disk session/workspace stores, the folder picker
// listing, the embedded terminal (a real shell), and the hub's HTTP surface
// driven with a fake session factory (no model backend needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { SessionChannel } = require("../dist/web/channel");
const { SessionStore, WorkspaceStore, workspaceKey } = require("../dist/web/store");
const { Terminal, stripControl, toOsPath } = require("../dist/web/terminal");
const { WebHub, browseDir, readHubRecord } = require("../dist/web/hub");
const { cleanTitle, suggestTitle } = require("../dist/session");

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
function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- channel -----------------------------------------------------------------

function makeChannel(id = "s1") {
  const sent = [];
  const changes = [];
  const ch = new SessionChannel(id, { send: (ev) => sent.push(ev), changed: () => changes.push(ch.phase), touched() {} });
  return { ch, sent, changes };
}

test("channel: a message resolves readInput, is echoed with the session id, and titles the session", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.readInput();
  assert.equal(ch.phase, "idle");
  ch.handleMessage("  build the game  ");
  assert.equal(await p, "build the game");
  assert.equal(ch.phase, "busy");
  assert.equal(ch.title, "build the game");
  const user = sent.find((e) => e.t === "user");
  assert.deepEqual({ t: user.t, s: user.s, sid: user.sid }, { t: "user", s: "build the game", sid: "s1" });
  assert.ok(ch.replay.some((e) => e.t === "user"), "user events are replayed");
  assert.ok(!ch.replay.some((e) => e.t === "state"), "state events are not replayed");
});

test("channel: messages sent while busy queue up and a slash command does not become the title", async () => {
  const { ch } = makeChannel();
  ch.handleMessage("/models");
  ch.handleMessage("second");
  assert.equal(await ch.readInput(), "/models");
  assert.equal(ch.title, "");
  assert.equal(await ch.readInput(), "second");
  assert.equal(ch.title, "second");
});

test("channel: approvals flip the phase to waiting and resolve through handleAnswer", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.confirmCommand("rm -rf /tmp/x", "reaches outside the workspace");
  assert.equal(ch.phase, "waiting");
  const ask = sent.find((e) => e.t === "confirm");
  ch.handleAnswer(ask.id, "always");
  assert.equal(await p, "always");
  assert.equal(ch.phase, "busy");
  assert.ok(sent.some((e) => e.t === "answered" && e.id === ask.id), "the settled prompt is recorded for replay");
  assert.ok(ch.replay.some((e) => e.t === "line" && /always allow — rm -rf \/tmp\/x/.test(e.s)), "and so is the answer");
  const sel = ch.select("Pick", [{ label: "a" }, { label: "b" }]);
  ch.handleAnswer(sent.find((e) => e.t === "select").id, 1);
  assert.equal(await sel, 1);
});

test("channel: cancel answers an open prompt with no/null before aborting the turn", async () => {
  const { ch } = makeChannel();
  let cancelled = 0;
  ch.onCancel = () => cancelled++;
  const conf = ch.confirmCommand("npm i -g x");
  const sel = ch.select("Pick", [{ label: "a" }]);
  ch.cancel();
  assert.equal(await conf, "no");
  assert.equal(await sel, null);
  assert.equal(cancelled, 1);
});

test("channel: requestExit hands the loop /exit silently, now and on later reads", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.readInput();
  ch.requestExit();
  assert.equal(await p, "/exit");
  assert.equal(await ch.readInput(), "/exit");
  assert.ok(!sent.some((e) => e.t === "user"), "no user echo for the synthetic /exit");
});

test("channel: the state event carries the busy label so a reconnecting page restores its spinner", () => {
  const { ch } = makeChannel();
  ch.getState = () => ({ mode: "edit" });
  ch.startSpinner("thinking");
  assert.deepEqual(ch.stateEvent().s, { mode: "edit", busy: "thinking", title: "" });
  ch.stopSpinner();
  assert.equal(ch.stateEvent().s.busy, null);
});

// ---- stores ------------------------------------------------------------------

test("store: session meta/body round trip, listing and delete", async () => {
  const dir = tmpdir("smol-store-");
  const store = new SessionStore(dir);
  const meta = { id: "ab12", workspace: dir, title: "hello", createdAt: 1, updatedAt: 2, model: "m", backend: "ollama" };
  store.saveMeta(meta);
  await store.saveBody("ab12", { snapshot: { messages: [{ role: "user", content: "hi" }], plan: [] }, events: [{ t: "user", s: "hi" }] });
  assert.deepEqual(store.listMetas(), [meta]);
  const body = store.loadBody("ab12");
  assert.equal(body.snapshot.messages[0].content, "hi");
  assert.equal(body.events.length, 1);
  assert.equal(store.loadBody("nope"), null);
  fs.writeFileSync(path.join(dir, "sessions", "broken.meta.json"), "{not json");
  assert.equal(store.listMetas().length, 1, "broken files are skipped");
  store.delete("ab12");
  assert.equal(store.listMetas().length, 0);
  assert.equal(store.loadBody("ab12"), null);
});

test("store: workspaces dedupe by normalized path and survive a reload", () => {
  const dir = tmpdir("smol-ws-");
  const ws = new WorkspaceStore(dir);
  const p = path.join(dir, "proj");
  fs.mkdirSync(p);
  ws.add(p + path.sep);
  ws.add(p);
  assert.equal(ws.list().length, 1);
  assert.ok(ws.has(p));
  assert.equal(workspaceKey(p + path.sep), workspaceKey(p));
  const again = new WorkspaceStore(dir);
  assert.equal(again.list().length, 1);
  again.remove(p);
  assert.equal(again.list().length, 0);
});

// ---- folder picker -----------------------------------------------------------

test("browseDir lists subfolders, flags projects, hides dot folders and reports errors", () => {
  const dir = tmpdir("smol-fs-");
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app", "package.json"), "{}");
  fs.mkdirSync(path.join(dir, "notes"));
  fs.mkdirSync(path.join(dir, ".hidden"));
  fs.writeFileSync(path.join(dir, "file.txt"), "x");
  const d = browseDir(dir);
  assert.equal(d.error, undefined);
  assert.deepEqual(d.dirs.map((x) => [x.name, x.project]), [["app", true], ["notes", false]]);
  assert.equal(d.parent, path.dirname(dir));
  assert.ok(Array.isArray(d.roots) && d.roots.length > 0);
  assert.match(browseDir(path.join(dir, "missing")).error, /not a folder/);
  assert.match(browseDir(path.join(dir, "file.txt")).error, /not a folder/);
  assert.equal(browseDir("").path, os.homedir());
});

// ---- terminal ----------------------------------------------------------------

test("terminal helpers: control sequences are stripped but colors kept; msys paths map back", () => {
  assert.equal(stripControl("\x1b[32mok\x1b[0m \x1b[2J\x1b[H\x1b]0;title\x07x"), "\x1b[32mok\x1b[0m x");
  if (process.platform === "win32") assert.equal(toOsPath("/c/Projects/x"), "C:\\Projects\\x");
  else assert.equal(toOsPath("/home/x"), "/home/x");
});

test("terminal: runs commands in a persistent shell, reports exit codes and tracks cwd", async () => {
  const dir = fs.realpathSync(tmpdir("smol-term-"));
  fs.mkdirSync(path.join(dir, "sub"));
  let out = "";
  const dones = [];
  const term = new Terminal("t1", dir, { output: (s) => (out += s), done: (code, cwd) => dones.push({ code, cwd }) });
  try {
    term.write("echo hello-from-shell");
    await until(() => dones.length >= 1, 15000, "first command");
    assert.equal(dones[0].code, 0);
    assert.match(out, /hello-from-shell/);
    assert.match(out.replace(/\x1b\[[0-9;]*m/g, ""), /❯ echo hello-from-shell\n/, "the command is echoed into the stream");
    term.write("cd sub");
    await until(() => dones.length >= 2, 15000, "cd");
    assert.equal(path.basename(dones[1].cwd), "sub");
    assert.equal(path.basename(term.cwd), "sub");
    term.write("exit 3");
    await until(() => /starting a new one/.test(out), 15000, "respawn after exit");
    term.write("echo again");
    await until(() => /again\n/.test(out) || dones.length >= 3, 15000, "command after respawn");
    assert.ok(term.buffer.includes("hello-from-shell"), "the replay buffer keeps output");
  } finally {
    term.close();
  }
});

// ---- hub -------------------------------------------------------------------------

/** A stand-in for Session: echoes each input back, honours /exit. */
function fakeFactory(log) {
  return async (ui, workspace, prefs) => {
    log.push({ workspace, prefs });
    const session = {
      chosen: { id: "fake-model", backend: "ollama" },
      workspace,
      onExit: null,
      restored: null,
      taskManager: { killAll() {}, runningSummary: () => [], recentUrls: () => ["http://localhost:5173"] },
      state: () => ({ mode: prefs.mode || "edit", model: "fake-model", backend: "ollama", workspace, urls: ["http://localhost:5173"], commands: [] }),
      announce() { ui.status("· fake session ready"); },
      restore(s) { session.restored = s; },
      snapshot: () => ({ messages: [{ role: "user", content: "x" }], plan: [], filesTouched: [], commandsRun: [], originalRequest: "x", currentRequest: "x", mode: "edit", effort: null, model: "fake-model", backend: "ollama" }),
      // The "model" takes a moment to name the session, like a real one.
      async suggestTitle() { await sleep(300); return "Hello Session"; },
      async run() {
        for (;;) {
          const input = await ui.readInput();
          if (input === "/exit") { ui.close(); session.onExit && session.onExit(); return; }
          ui.startSpinner("thinking");
          ui.token("echo: " + input);
          ui.stopSpinner();
          ui.turnEnd("done");
          if (session.onTurnDone) session.onTurnDone();
        }
      },
    };
    return session;
  };
}

function request(hub, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: hub.port, method, path: p, headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Read SSE events from /events until one satisfies `stopWhen` (or 3s pass). */
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
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
        }
        if (events.some(stopWhen)) { clearTimeout(timer); finish(); }
      });
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? resolve(events) : reject(e)));
  });
}

test("hub: token guard, page, ping, folder listing, and the running-hub record", async () => {
  const dataDir = tmpdir("smol-hub-");
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  try {
    assert.equal((await request(hub, "GET", "/")).status, 403);
    assert.equal((await request(hub, "GET", "/?k=wrong")).status, 403);
    const page = await request(hub, "GET", "/?k=" + hub.authToken);
    assert.equal(page.status, 200);
    assert.match(page.body, /id="side"/);
    assert.match(page.body, /id="panel"/);
    const ping = JSON.parse((await request(hub, "GET", "/ping?k=" + hub.authToken)).body);
    assert.equal(ping.ok, true);
    const rec = readHubRecord(dataDir);
    assert.equal(rec.port, hub.port);
    assert.equal(rec.token, hub.authToken);
    const fsr = JSON.parse((await request(hub, "GET", "/fs?k=" + hub.authToken + "&path=" + encodeURIComponent(dataDir))).body);
    assert.deepEqual(fsr.dirs.map((d) => d.name), ["sessions"]);
    const bad = await request(hub, "POST", "/nope?k=" + hub.authToken, {});
    assert.equal(bad.status, 400);
  } finally {
    hub.close();
  }
  assert.equal(readHubRecord(dataDir), null, "the record is removed on shutdown");
});

test("hub: sessions start, echo, save, close, resume, delete; workspaces add and remove", async () => {
  const dataDir = tmpdir("smol-hub2-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const calls = [];
  const hub = new WebHub({ port: 0, prefs: { effort: "off" }, help: "help", version: "9.9.9", dataDir, factory: fakeFactory(calls), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    // add a workspace without starting anything
    const added = JSON.parse((await request(hub, "POST", "/workspaces/add" + k, { path: ws })).body);
    assert.equal(added.path, ws);
    assert.equal(added.id, undefined);
    let snap = hub.snapshot();
    assert.equal(snap.workspaces.length, 1);
    assert.equal(snap.workspaces[0].sessions.length, 0);
    assert.match((await request(hub, "POST", "/workspaces/add" + k, { path: path.join(dataDir, "missing") })).body, /not a folder/);

    // start a session and talk to it
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    assert.ok(id);
    await until(() => calls.length === 1, 2000, "factory call");
    assert.equal(calls[0].prefs.effort, "off");
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle session");
    await request(hub, "POST", "/msg" + k, { sid: id, text: "hello there" });
    await until(() => hub.snapshot().workspaces[0].sessions[0].title === "hello there", 2000, "verbatim title");
    await until(() => hub.snapshot().workspaces[0].sessions[0].title === "Hello Session", 2000, "model-written title");
    const events = await readEvents(hub, (e) => e.t === "state" && e.sid === id);
    assert.equal(events[0].t, "hub");
    assert.ok(events.some((e) => e.t === "user" && e.sid === id && e.s === "hello there"), "replay includes the user message");
    assert.ok(events.some((e) => e.t === "token" && e.s === "echo: hello there"), "replay includes the reply");
    assert.ok(events.some((e) => e.t === "state" && e.sid === id && e.s.model === "fake-model"), "state follows the replay");

    // a terminal on the session shows up in the snapshot and is replayed to new pages
    const term = JSON.parse((await request(hub, "POST", "/term/open" + k, { sid: id })).body);
    assert.ok(term.tid);
    assert.equal(hub.snapshot().workspaces[0].sessions[0].terminals[0].tid, term.tid);
    await request(hub, "POST", "/term/close" + k, { sid: id, tid: term.tid });
    assert.equal(hub.snapshot().workspaces[0].sessions[0].terminals.length, 0);

    // saved to disk after the debounce
    const metaFile = path.join(dataDir, "sessions", id + ".meta.json");
    await until(() => fs.existsSync(metaFile) && fs.existsSync(path.join(dataDir, "sessions", id + ".json")), 4000, "save");
    assert.equal(JSON.parse(fs.readFileSync(metaFile, "utf8")).title, "Hello Session");

    // close: it stays listed as a stored session
    await request(hub, "POST", "/sessions/close" + k, { id });
    await until(() => hub.snapshot().workspaces[0].sessions[0].live === false, 2000, "closed");
    assert.equal(hub.snapshot().workspaces[0].sessions[0].status, "stored");

    // resume: the factory runs again with the saved prefs and the transcript is restored
    await request(hub, "POST", "/sessions/resume" + k, { id });
    await until(() => calls.length === 2, 2000, "second factory call");
    assert.equal(calls[1].prefs.model, "fake-model");
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "resumed idle");
    const events2 = await readEvents(hub, (e) => e.t === "state" && e.sid === id);
    assert.ok(events2.some((e) => e.t === "user" && e.s === "hello there"), "old transcript replays after resume");

    // rename, then delete while live: gone from disk and from the list
    await request(hub, "POST", "/sessions/rename" + k, { id, title: "renamed" });
    assert.equal(hub.snapshot().workspaces[0].sessions[0].title, "renamed");
    await request(hub, "POST", "/sessions/delete" + k, { id });
    await until(() => hub.snapshot().workspaces[0].sessions.length === 0, 2000, "deleted");
    await sleep(100);
    assert.equal(fs.existsSync(metaFile), false);

    // remove the workspace
    await request(hub, "POST", "/workspaces/remove" + k, { path: ws });
    assert.equal(hub.snapshot().workspaces.length, 0);
    assert.match((await request(hub, "POST", "/sessions/resume" + k, { id: "zzz" })).body, /unknown session/);
  } finally {
    hub.close();
  }
});

// ---- titles ----------------------------------------------------------------------

test("titles: cleanTitle normalizes what a model writes", () => {
  assert.equal(cleanTitle('"Fix login bug".\n'), "Fix login bug");
  assert.equal(cleanTitle("Title: Add dark mode toggle"), "Add dark mode toggle");
  assert.equal(cleanTitle("<think>hmm, what to call it</think>\nRefactor session loop"), "Refactor session loop");
  assert.equal(cleanTitle("  **Snake game in canvas**  "), "Snake game in canvas");
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle("<not a title>"), null);
  const long = cleanTitle("word ".repeat(30));
  assert.ok(long.length <= 60 && !/\s$/.test(long), "long titles are cut at a word boundary");
});

test("titles: suggestTitle asks with thinking off and a small cap, and falls back to null", async () => {
  const calls = [];
  const provider = { async chat(messages, tools, opts) { calls.push({ messages, opts }); return { content: " 'Sidebar Session Titles' ", toolCalls: [] }; } };
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "add titles to the sidebar" },
    { role: "assistant", content: "Done: titles added." },
  ];
  assert.equal(await suggestTitle(msgs, provider), "Sidebar Session Titles");
  assert.equal(calls[0].opts.effortOverride, "off");
  assert.ok(calls[0].opts.maxTokens <= 40);
  assert.match(calls[0].messages[1].content, /add titles to the sidebar/);
  assert.match(calls[0].messages[1].content, /Done: titles added/);
  assert.equal(await suggestTitle([{ role: "system", content: "s" }], provider), null, "no user message, no call");
  assert.equal(calls.length, 1);
  const failing = { async chat() { throw new Error("backend down"); } };
  assert.equal(await suggestTitle(msgs, failing), null);
});

test("hub: a manual rename is never overwritten by the model-written title", async () => {
  const dataDir = tmpdir("smol-hub4-");
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: dataDir })).body);
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle");
    await request(hub, "POST", "/msg" + k, { sid: id, text: "first message" });
    await until(() => hub.snapshot().workspaces[0].sessions[0].title === "first message", 2000, "verbatim title");
    await request(hub, "POST", "/sessions/rename" + k, { id, title: "My Name" });
    await sleep(600); // past the fake model's naming delay
    assert.equal(hub.snapshot().workspaces[0].sessions[0].title, "My Name");
  } finally {
    hub.close();
  }
});

test("hub: a session that fails to start shows the error and can be retried", async () => {
  const dataDir = tmpdir("smol-hub3-");
  let attempts = 0;
  const factory = async (ui, workspace, prefs) => {
    attempts++;
    if (attempts === 1) throw new Error("No local model backend found.");
    return fakeFactory([])(ui, workspace, prefs);
  };
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory, quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: dataDir })).body);
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "error", 2000, "error status");
    const events = await readEvents(hub, (e) => e.t === "line" && e.kind === "error");
    assert.ok(events.some((e) => e.t === "line" && e.kind === "error" && /No local model/.test(e.s)));
    await request(hub, "POST", "/sessions/resume" + k, { id });
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "retried");
    assert.equal(attempts, 2);
  } finally {
    hub.close();
  }
});
