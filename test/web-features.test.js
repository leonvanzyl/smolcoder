// Web UI server features: the visible message queue, status-bar pickers
// (via), starring in pickers, slash-command arguments, tool timing and diffs
// (UI events only), throttled argument progress, SSE resume from a ring
// buffer, and the @-mention file list. Also checks the client script parses.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { SessionChannel, lineDiff } = require("../dist/web/channel");
const { WebHub, listWorkspaceFiles } = require("../dist/web/hub");
const { CLIENT_JS } = require("../dist/web/client");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + label);
    await sleep(20);
  }
}
const tmpdir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function makeChannel(id = "s1") {
  const sent = [];
  const ch = new SessionChannel(id, { send: (ev) => sent.push(ev), changed() {}, touched() {} });
  return { ch, sent };
}
const lastState = (sent) => sent.filter((e) => e.t === "state").pop();

// ---- channel ---------------------------------------------------------------

test("queue: messages sent while busy show up in the state at once, can be removed, and the rest arrive in order", async () => {
  const { ch, sent } = makeChannel();
  ch.handleMessage("first");
  ch.handleMessage("second");
  ch.handleMessage("third");
  assert.deepEqual(lastState(sent).s.queued.map((q) => q.text), ["first", "second", "third"]);
  const second = lastState(sent).s.queued[1];
  assert.equal(ch.removeQueued(second.id), true);
  assert.equal(ch.removeQueued(second.id), false, "already gone");
  assert.deepEqual(lastState(sent).s.queued.map((q) => q.text), ["first", "third"]);
  assert.equal(await ch.readInput(), "first");
  assert.deepEqual(lastState(sent).s.queued.map((q) => q.text), ["third"], "taking one off the queue pushes the new list");
  assert.equal(await ch.readInput(), "third");
  assert.deepEqual(ch.stateEvent().s.queued, []);
  assert.ok(!sent.some((e) => e.t === "user" && e.s === "second"), "a removed message is never sent");
});

test("via: a status-bar pick is not echoed and its select is marked for a popover; the next turn's select is not", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.readInput();
  ch.handleMessage("/mode", [], "mode");
  assert.equal(await p, "/mode");
  assert.ok(!sent.some((e) => e.t === "user"), "no user bubble for a status-bar click");
  const sel = ch.select("Select mode", [{ label: "ro" }, { label: "edit" }]);
  const ev = sent.find((e) => e.t === "select");
  assert.equal(ev.via, "mode");
  ch.handleAnswer(ev.id, 1);
  assert.equal(await sel, 1);

  const p2 = ch.readInput();
  ch.handleMessage("pick something", [], "mode"); // not a slash command: via ignored
  await p2;
  assert.ok(sent.some((e) => e.t === "user" && e.s === "pick something"));
  ch.select("Agent asks", [{ label: "a" }]);
  assert.equal(sent.filter((e) => e.t === "select")[1].via, undefined, "agent-initiated selects stay in the transcript");
  const p3 = ch.readInput();
  ch.handleMessage("/mode", [], "bogus");
  await p3;
  assert.ok(sent.some((e) => e.t === "user" && e.s === "/mode"), "an unknown via is ignored");
});

test("star: a select with onStar offers a star; starring calls it, redraws the list and updates the replay", async () => {
  const { ch, sent } = makeChannel();
  const rows = [{ label: "qwen" }, { label: "llama" }];
  const calls = [];
  const sel = ch.select("Select model", rows, {
    onStar: (i) => {
      calls.push(i);
      rows[i] = { ...rows[i], starred: !rows[i].starred, group: "Favorites" };
      return rows.slice();
    },
  });
  const ev = sent.find((e) => e.t === "select");
  assert.equal(ev.star, true);
  const options = await ch.star(ev.id, 1);
  assert.deepEqual(calls, [1]);
  assert.equal(options[1].starred, true);
  const upd = sent.find((e) => e.t === "select_update");
  assert.equal(upd.id, ev.id);
  assert.equal(upd.options[1].starred, true);
  assert.equal(ch.replay.find((e) => e.t === "select").options[1].starred, true, "a reconnecting page sees the star");
  assert.equal(await ch.star(ev.id, -1), null);
  ch.handleAnswer(ev.id, 1);
  assert.equal(await sel, 1);
  assert.equal(await ch.star(ev.id, 0), null, "a settled select cannot be starred");
  const plain = ch.select("No stars", [{ label: "x" }]);
  const pev = sent.filter((e) => e.t === "select")[1];
  assert.equal(pev.star, undefined);
  assert.equal(await ch.star(pev.id, 0), null);
  ch.cancel();
  assert.equal(await plain, null);
});

test("commands: the state flags commands that take arguments, and commandArgs resolves sync and async providers", async () => {
  const { ch } = makeChannel();
  const commands = [
    { name: "mode", desc: "Set mode", group: "Session", key: "shift+tab", aliases: ["permissions"], args: () => [{ label: "ro" }, { label: "edit", current: true }] },
    { name: "logs", desc: "Show logs", args: async () => [{ label: "t1", hint: "npm run dev" }] },
    { name: "help", desc: "Show help" },
  ];
  ch.slashCommands = commands;
  ch.getState = () => ({ mode: "edit", commands });
  const view = ch.stateEvent().s.commands;
  assert.deepEqual(view[0], { name: "mode", desc: "Set mode", aliases: ["permissions"], group: "Session", key: "shift+tab", args: true });
  assert.equal(view[1].args, true);
  assert.equal(view[2].args, undefined);
  assert.deepEqual(await ch.commandArgs("mode"), [{ label: "ro" }, { label: "edit", current: true }]);
  assert.deepEqual(await ch.commandArgs("logs"), [{ label: "t1", hint: "npm run dev" }]);
  assert.deepEqual(await ch.commandArgs("help"), []);
  assert.deepEqual(await ch.commandArgs("nope"), []);

  // Session.state() sends plain data with the values already resolved.
  const { ch: ch2 } = makeChannel("s2");
  ch2.getState = () => ({ commands: [{ name: "effort", desc: "Set effort", args: [{ label: "low" }, { label: "high", current: true }] }] });
  const v2 = ch2.stateEvent().s.commands[0];
  assert.equal(v2.args, true);
  assert.deepEqual(v2.argOptions, [{ label: "low" }, { label: "high", current: true }], "inline values ride along");
  assert.deepEqual(await ch2.commandArgs("effort"), v2.argOptions);
});

test("tools: timing and the diff travel in the result event only; the result text is unchanged", () => {
  const { ch, sent } = makeChannel();
  ch.toolCall("edit_file", { path: "src/a.ts" });
  const result = "Edited src/a.ts";
  ch.toolResult(result, { ok: true, durationMs: 42, diff: { path: "src/a.ts", before: "a\nb\nc\n", after: "a\nB\nc\nd\n" } });
  const ev = sent.find((e) => e.t === "result");
  assert.equal(ev.body, result, "the body is exactly what the model saw");
  assert.equal(ev.ms, 42);
  assert.equal(ev.err, false);
  assert.equal(ev.diff.path, "src/a.ts");
  assert.equal(ev.diff.added, 2);
  assert.equal(ev.diff.removed, 1);
  assert.ok(!/[+-]B|\+d/.test(ev.body));
  ch.toolCall("run_command", { command: "false" });
  ch.toolResult("exit 1", { ok: false, durationMs: 5 });
  assert.equal(sent.filter((e) => e.t === "result")[1].err, true, "a failed outcome marks the row failed");
  ch.toolCall("read_file", { path: "x" });
  ch.toolResult("contents");
  const third = sent.filter((e) => e.t === "result")[2];
  assert.equal(typeof third.ms, "number", "without an outcome the channel times the call itself");
  assert.equal(third.diff, undefined);
});

test("tools: argument progress is throttled, sends the latest count, and is never replayed", async () => {
  const { ch, sent } = makeChannel();
  for (let i = 1; i <= 50; i++) ch.toolArgsProgress("write_file", i * 100);
  await sleep(200);
  const prog = sent.filter((e) => e.t === "toolargs");
  assert.ok(prog.length >= 1 && prog.length <= 3, "throttled: " + prog.length);
  assert.equal(prog[prog.length - 1].chars, 5000, "the last count arrives");
  assert.equal(prog[0].name, "write_file");
  assert.ok(!ch.replay.some((e) => e.t === "toolargs"));
  ch.toolArgsProgress("write_file", 6000);
  ch.toolArgsProgress("write_file", 7000);
  ch.toolCall("write_file", { path: "a", content: "x" });
  await sleep(200);
  assert.ok(!sent.some((e) => e.t === "toolargs" && e.chars === 7000), "a pending update is dropped once the call lands");
});

test("lineDiff: context hunks, counts, new files and long-diff truncation", () => {
  const before = Array.from({ length: 30 }, (_, i) => "line " + i).join("\n");
  const after = before.replace("line 15", "LINE 15");
  const d = lineDiff("f.txt", before, after);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.deepEqual(d.lines[0], ["~", "12 unchanged lines"]);
  assert.deepEqual(d.lines.filter((l) => l[0] !== " " && l[0] !== "~"), [["-", "line 15"], ["+", "LINE 15"]]);
  assert.equal(d.lines.filter((l) => l[0] === " ").length, 6, "three lines of context each side");
  const created = lineDiff("new.txt", "", "a\nb");
  assert.equal(created.added, 2);
  assert.equal(created.removed, 0);
  const big = lineDiff("big.txt", "", Array.from({ length: 1000 }, (_, i) => "x" + i).join("\n"));
  assert.equal(big.added, 1000);
  assert.ok(big.truncated);
  assert.ok(big.lines.length <= 401);
});

// ---- hub -------------------------------------------------------------------

/** A fake session: "/pick" opens a starrable select, "/ask" a plain one; other
 * input is echoed. `ctl.release` ends a turn that waits on "/hold". */
function controlledFactory(ctl) {
  return async (ui, workspace) => {
    const rows = [{ label: "alpha" }, { label: "beta" }];
    ui.slashCommands = [
      { name: "logs", desc: "Show task output", group: "Tasks", args: async () => [{ label: "t1", hint: "dev server" }] },
      { name: "help", desc: "Show help" },
    ];
    const session = {
      chosen: { id: "fake-model", backend: "ollama" },
      workspace,
      onExit: null,
      taskManager: { killAll() {}, runningSummary: () => [], recentUrls: () => [] },
      state: () => ({ mode: "edit", model: "fake-model", backend: "ollama", workspace, commands: ui.slashCommands }),
      announce() {},
      restore() {},
      snapshot: () => ({ messages: [], plan: [], mode: "edit", effort: null, model: "fake-model", backend: "ollama" }),
      async suggestTitle() { return null; },
      async run() {
        for (;;) {
          const input = await ui.readInput();
          if (input === "/exit") { ui.close(); session.onExit && session.onExit(); return; }
          ui.startSpinner("thinking");
          if (input === "/hold") await new Promise((r) => (ctl.release = r));
          else if (input === "/pick") {
            const i = await ui.select("Select model", rows, {
              onStar: (k) => { rows[k] = { ...rows[k], starred: !rows[k].starred }; return rows.slice(); },
            });
            ctl.picked = i;
          } else ui.token("echo: " + input);
          ui.stopSpinner();
          ui.turnEnd("done");
        }
      },
    };
    return session;
  };
}

function post(hub, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: hub.port, method: "POST", path: p + "?k=" + hub.authToken, headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data || "{}") }));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body || {}));
  });
}
function get(hub, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: hub.port, path: p + (p.includes("?") ? "&" : "?") + "k=" + hub.authToken }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data || "{}") }));
    }).on("error", reject);
  });
}

/** Read SSE (with ids) until a "synced" event, optionally resuming. */
function readStream(hub, lastId) {
  return new Promise((resolve, reject) => {
    const events = [];
    let last = null;
    const headers = lastId ? { "last-event-id": lastId } : {};
    const req = http.get({ host: "127.0.0.1", port: hub.port, path: "/events?k=" + hub.authToken, headers }, (res) => {
      let buf = "";
      const timer = setTimeout(() => { req.destroy(); reject(new Error("no synced event")); }, 3000);
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const lines = chunk.split("\n");
          const id = lines.find((l) => l.startsWith("id: "));
          const data = lines.find((l) => l.startsWith("data: "));
          if (id) last = id.slice(4);
          if (!data) continue;
          const ev = JSON.parse(data.slice(6));
          events.push(ev);
          if (ev.t === "synced") { clearTimeout(timer); req.destroy(); resolve({ events, last }); return; }
        }
      });
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
  });
}

async function startHub(ctl) {
  const dataDir = tmpdir("smol-hubf-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: controlledFactory(ctl), quiet: true });
  await hub.start();
  const id = hub.openSession(ws);
  await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle");
  return { hub, id, ws };
}

test("hub: SSE resumes from Last-Event-ID without a reset, and replays in full after a gap or from another hub", async () => {
  const ctl = {};
  const { hub, id } = await startHub(ctl);
  try {
    const first = await readStream(hub);
    assert.equal(first.events[0].t, "reset", "a first visit gets a full replay");
    assert.ok(first.last && /^[a-f0-9]+\.\d+$/.test(first.last));
    assert.equal(first.events[first.events.length - 1].resumed, false);

    await post(hub, "/msg", { sid: id, text: "while away" });
    await until(() => hub.live.get(id).channel.replay.some((e) => e.t === "token" && /while away/.test(e.s)), 2000, "echo");
    const again = await readStream(hub, first.last);
    assert.ok(!again.events.some((e) => e.t === "reset"), "a clean resume does not reset");
    assert.ok(again.events.some((e) => e.t === "user" && e.s === "while away"), "the missed events arrive");
    assert.ok(!again.events.some((e) => e.t === "line" && first.events.some((f) => f.t === "line" && f.s === e.s)), "nothing already seen is resent");
    assert.equal(again.events[again.events.length - 1].resumed, true);

    const none = await readStream(hub, again.last);
    assert.deepEqual(none.events.map((e) => e.t), ["hub", "synced"], "nothing missed: just the sidebar");

    const other = await readStream(hub, "abcdef.3");
    assert.equal(other.events[0].t, "reset", "an id from another hub is not trusted");
    const future = await readStream(hub, again.last.replace(/\d+$/, "999999999"));
    assert.equal(future.events[0].t, "reset");

    // Overflow the ring: the old id now has a gap.
    const ch = hub.live.get(id).channel;
    for (let i = 0; i < 10050; i++) ch.status("filler " + i);
    const gap = await readStream(hub, again.last);
    assert.equal(gap.events[0].t, "reset", "a gap falls back to a full replay");
  } finally {
    hub.close();
  }
});

test("hub: queue removal, status-bar picks, starring and command args over HTTP", async () => {
  const ctl = {};
  const { hub, id } = await startHub(ctl);
  try {
    await post(hub, "/msg", { sid: id, text: "/hold" });
    await until(() => ctl.release, 2000, "turn in progress");
    await post(hub, "/msg", { sid: id, text: "queued one" });
    await post(hub, "/msg", { sid: id, text: "queued two" });
    const queued = hub.live.get(id).channel.stateEvent().s.queued;
    assert.deepEqual(queued.map((q) => q.text), ["queued one", "queued two"]);
    assert.equal((await post(hub, "/queue/remove", { sid: id, id: queued[0].id })).status, 200);
    assert.equal((await post(hub, "/queue/remove", { sid: id, id: queued[0].id })).status, 400);
    ctl.release();
    await until(() => hub.live.get(id).channel.replay.some((e) => e.t === "token" && e.s === "echo: queued two"), 2000, "second queued message");
    assert.ok(!hub.live.get(id).channel.replay.some((e) => e.s === "echo: queued one"), "the removed message never ran");

    await post(hub, "/msg", { sid: id, text: "/pick", via: "models" });
    const ch = hub.live.get(id).channel;
    const sel = await until(() => ch.replay.find((e) => e.t === "select"), 2000, "select");
    assert.equal(sel.via, "models");
    assert.equal(sel.star, true);
    assert.ok(!ch.replay.some((e) => e.t === "user" && e.s === "/pick"), "no bubble for a status-bar pick");
    const starred = await post(hub, "/select/star", { sid: id, id: sel.id, index: 0 });
    assert.equal(starred.status, 200);
    assert.equal(starred.body.options[0].starred, true);
    await post(hub, "/select", { sid: id, id: sel.id, index: 1 });
    await until(() => ctl.picked === 1, 2000, "pick");
    assert.equal((await post(hub, "/select/star", { sid: id, id: sel.id, index: 0 })).status, 400);

    const args = await post(hub, "/command/args", { sid: id, name: "logs" });
    assert.deepEqual(args.body.options, [{ label: "t1", hint: "dev server" }]);
    assert.deepEqual((await post(hub, "/command/args", { sid: id, name: "help" })).body.options, []);
    assert.equal(ch.stateEvent().s.commands[0].args, true);
  } finally {
    hub.close();
  }
});

test("hub: /files lists workspace files for @-mentions, skipping .git, node_modules and .gitignore entries", async () => {
  const ctl = {};
  const { hub, id, ws } = await startHub(ctl);
  try {
    fs.mkdirSync(path.join(ws, "src", "deep"), { recursive: true });
    fs.mkdirSync(path.join(ws, ".git"));
    fs.mkdirSync(path.join(ws, "node_modules", "x"), { recursive: true });
    fs.mkdirSync(path.join(ws, "dist"));
    fs.writeFileSync(path.join(ws, ".gitignore"), "# build output\ndist/\n*.log\n/secret.txt\n!keep.log\n");
    for (const f of ["src/a.ts", "src/deep/b.ts", "README.md", "debug.log", "secret.txt", "dist/out.js", ".git/HEAD", "node_modules/x/i.js"]) {
      fs.writeFileSync(path.join(ws, f), "x");
    }
    const r = await get(hub, "/files?sid=" + id);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.files, [".gitignore", "README.md", "src/a.ts", "src/deep/b.ts"]);
    assert.equal(r.body.truncated, false);
    assert.equal((await get(hub, "/files?sid=nope")).status, 404);
    const capped = listWorkspaceFiles(ws, 2);
    assert.equal(capped.files.length, 2);
    assert.equal(capped.truncated, true);
  } finally {
    hub.close();
  }
});

// ---- client ---------------------------------------------------------------

test("client: the browser script parses and embeds the fuzzy matcher", () => {
  assert.doesNotThrow(() => new Function(CLIENT_JS));
  assert.ok(CLIENT_JS.includes("function fuzzyScore("), "fuzzyScore is embedded");
  assert.ok(!/\balert\(/.test(CLIENT_JS), "alert() blocks every session's stream; use toasts");
});

test("hub: serves the bundled Inter font without the key, as font/woff2 cached for a year", async () => {
  const { FONT_ROUTE, FONT_FILE } = require("../dist/web/hub");
  assert.equal(FONT_ROUTE, "/fonts/inter-latin-wght-normal.woff2");
  assert.ok(fs.existsSync(FONT_FILE), "the font resolves from the package root: " + FONT_FILE);
  const dataDir = tmpdir("smol-font-");
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: controlledFactory({}), quiet: true });
  await hub.start();
  const raw = (p, method, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: hub.port, path: p, method: method || "GET", headers: headers || {} }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    const r = await raw(FONT_ROUTE);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "font/woff2");
    assert.equal(r.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(r.body.subarray(0, 4).toString("latin1"), "wOF2");
    assert.ok(r.body.equals(fs.readFileSync(FONT_FILE)));
    const head = await raw(FONT_ROUTE, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    // Same-origin page loads send their own Origin; anyone else's is refused.
    assert.equal((await raw(FONT_ROUTE, "GET", { origin: "http://127.0.0.1:" + hub.port })).status, 200);
    assert.equal((await raw(FONT_ROUTE, "GET", { origin: "http://evil.test" })).status, 403);
    // Only that one file skips the key.
    assert.equal((await raw("/fonts/other.woff2")).status, 403);
    assert.equal((await raw("/")).status, 403);
    assert.equal((await raw(FONT_ROUTE, "POST")).status, 403);
  } finally {
    hub.close();
  }
});

test("page: the stylesheet loads the self-hosted font and follows the system theme", () => {
  const { STYLES } = require("../dist/web/styles");
  const { PAGE_HTML } = require("../dist/web/page");
  assert.match(STYLES, /@font-face \{[^}]*font-family: "Inter Variable";[^}]*font-display: swap;[^}]*src: local\("Inter Variable"\), local\("InterVariable"\), url\("\/fonts\/inter-latin-wght-normal\.woff2"\) format\("woff2"\);[^}]*unicode-range:/);
  assert.match(STYLES, /--font-ui: -apple-system, BlinkMacSystemFont, "Inter Variable"/);
  assert.match(STYLES, /@media \(prefers-color-scheme: dark\) \{\s*:root \{/);
  assert.match(STYLES, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(STYLES, /gradient\(/, "no gradients");
  assert.doesNotMatch(PAGE_HTML, /fonts\.googleapis|fonts\.gstatic|cdn\./i, "no remote fonts");
});
