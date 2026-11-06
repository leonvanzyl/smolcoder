// Web hub safety and behaviour fixes: worktrees are never dropped with work
// in them (archive, delete, "Remove from list", closing an unsaved branch
// session, shutdown), session ids are checked before anything touches disk,
// the Host header is checked on every route, sidebar snapshots stay out of
// the resume ring, replays are flagged, Stop pauses the queue, saves never
// collide, search is bounded and cancellable, folder listing is async, and
// /undo drops the undone turn from the web replay.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { WebHub, FONT_ROUTE } = require("../dist/web/hub");
const { SessionChannel } = require("../dist/web/channel");
const { SessionStore } = require("../dist/web/store");
const side = require("../dist/web/sidebar-data");
const { Session } = require("../dist/session");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, label = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + label);
    await sleep(25);
  }
}
const tmpdirs = [];
function tmpdir(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpdirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpdirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

let hasGit = false;
try {
  execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
  hasGit = true;
} catch {
  /* no git */
}
const noGit = !hasGit && "git is not on PATH";
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], {
    cwd, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
function makeRepo(prefix, ignore = "") {
  const dir = tmpdir(prefix);
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  if (ignore) fs.writeFileSync(path.join(dir, ".gitignore"), ignore);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function fakeFactory() {
  return async (ui, workspace) => {
    const s = {
      chosen: { id: "fake", backend: "ollama" }, workspace, onExit: null,
      taskManager: { killAll() {}, runningSummary: () => [], recentUrls: () => [] },
      state: () => ({ mode: "edit", model: "fake", backend: "ollama", workspace, outcome: "completed", commands: [] }),
      announce() {}, restore() {},
      snapshot: () => ({ messages: [{ role: "user", content: "x" }], plan: [], filesTouched: [], commandsRun: [], originalRequest: "x", currentRequest: "x", mode: "edit", effort: null, model: "fake", backend: "ollama" }),
      async suggestTitle() { return null; },
      async run() {
        for (;;) {
          const i = await ui.readInput();
          if (i === "/exit") { ui.close(); s.onExit && s.onExit(); return; }
          ui.token("echo " + (typeof i === "string" ? i : i.text));
          ui.turnEnd("done");
        }
      },
    };
    return s;
  };
}

function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
async function startHub(dataDir, factory = fakeFactory()) {
  const hub = new WebHub({ port: 0, prefs: {}, help: "h", version: "t", dataDir, factory, quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  const post = async (p, b) => {
    const r = await request(hub.port, "POST", p + k, b);
    return { status: r.status, ...JSON.parse(r.body || "{}") };
  };
  return { hub, k, post };
}
const allSessions = (hub) => hub.snapshot().workspaces.flatMap((w) => w.sessions);
const sessionOf = (hub, id) => allSessions(hub).find((s) => s.id === id);

/** A branch session that has been sent one message (so it is saved). */
async function savedBranchSession(post, hub, repo, branch) {
  const { id, error } = await post("/sessions/new", { workspace: repo, branch });
  assert.ok(id, error);
  await until(() => sessionOf(hub, id)?.status === "idle", 4000, "idle");
  await post("/msg", { sid: id, text: "hello" });
  await until(() => hub.metas.has(id), 6000, "saved");
  return { id, wt: sessionOf(hub, id).worktree.path };
}

// ---- 1, 2, 5: worktrees ------------------------------------------------------------

test("archive keeps the worktree, gitignored files included", { skip: noGit }, async () => {
  const dataDir = tmpdir("smolfix-a-"), repo = makeRepo("smolfix-a-repo-", ".env\n");
  const { hub, post } = await startHub(dataDir);
  try {
    const { id, wt } = await savedBranchSession(post, hub, repo, "feat-a");
    fs.writeFileSync(path.join(wt, ".env"), "SECRET=keep-me\n");
    const r = await post("/sessions/archive", { id, archived: true });
    assert.equal(r.status, 200, r.error);
    await until(() => !hub.live.has(id), 5000, "closed");
    await sleep(300);
    assert.equal(fs.readFileSync(path.join(wt, ".env"), "utf8"), "SECRET=keep-me\n", "the ignored .env survives archive");
    // Undo right away: the session comes back with its worktree as it was.
    await post("/sessions/archive", { id, archived: false });
    await post("/sessions/resume", { id });
    await until(() => sessionOf(hub, id)?.status === "idle", 4000, "resumed");
    assert.ok(fs.existsSync(path.join(wt, ".env")));
  } finally {
    hub.close();
  }
});

test("delete keeps a worktree that has only an ignored file, and says where and why", { skip: noGit }, async () => {
  const dataDir = tmpdir("smolfix-a2-"), repo = makeRepo("smolfix-a2-repo-", ".env\n");
  const { hub, post } = await startHub(dataDir);
  try {
    const { id, wt } = await savedBranchSession(post, hub, repo, "feat-a2");
    fs.writeFileSync(path.join(wt, ".env"), "SECRET=keep-me\n");
    const r = await post("/sessions/delete", { id });
    assert.deepEqual(r.kept, { path: wt, reason: "it has changes" });
    assert.ok(fs.existsSync(path.join(wt, ".env")), "nothing ignored is lost");
    assert.equal(sessionOf(hub, id), undefined, "the session itself is gone");
  } finally {
    hub.close();
  }
});

test("Remove from list never force-removes a worktree with uncommitted work", { skip: noGit }, async () => {
  const dataDir = tmpdir("smolfix-b-"), repo = makeRepo("smolfix-b-repo-");
  const { hub, post } = await startHub(dataDir);
  try {
    const { id, wt } = await savedBranchSession(post, hub, repo, "feat-b");
    fs.writeFileSync(path.join(wt, "a.txt"), "UNCOMMITTED WORK\n");
    await post("/sessions/close", { id });
    await until(() => !hub.live.has(id), 5000, "closed");
    const r = await post("/workspaces/remove", { path: repo });
    assert.equal(r.status, 200, r.error);
    assert.deepEqual(r.kept, [{ path: wt, reason: "it has changes" }]);
    await sleep(500);
    assert.equal(fs.readFileSync(path.join(wt, "a.txt"), "utf8"), "UNCOMMITTED WORK\n");
    assert.match((await post("/workspaces/remove", { path: "" })).error, /path is required/, "an empty path is not the current folder");
  } finally {
    hub.close();
  }
});

// ---- 4: unsaved branch sessions ------------------------------------------------------

test("an unsaved branch session closed clean frees its worktree and branch", { skip: noGit }, async () => {
  const dataDir = tmpdir("smolfix-c-"), repo = makeRepo("smolfix-c-repo-");
  const { hub, post } = await startHub(dataDir);
  try {
    const { id } = await post("/sessions/new", { workspace: repo, branch: "feat-c" });
    await until(() => sessionOf(hub, id)?.status === "idle", 4000, "idle");
    await post("/sessions/close", { id });
    await until(() => fs.readdirSync(path.join(dataDir, "worktrees")).length === 0, 8000, "worktree removed");
    assert.equal(allSessions(hub).length, 0, "nothing to list");
    const again = await post("/sessions/new", { workspace: repo, branch: "feat-c" });
    assert.ok(again.id, "the branch is free again: " + again.error);
  } finally {
    hub.close();
  }
});

test("an unsaved branch session with changes is kept and listed, on close and on shutdown", { skip: noGit }, async () => {
  const dataDir = tmpdir("smolfix-c2-"), repo = makeRepo("smolfix-c2-repo-");
  let { hub, post } = await startHub(dataDir);
  let wt2;
  try {
    const { id } = await post("/sessions/new", { workspace: repo, branch: "feat-c2" });
    await until(() => sessionOf(hub, id)?.status === "idle", 4000, "idle");
    const wt = sessionOf(hub, id).worktree.path;
    fs.writeFileSync(path.join(wt, "new.txt"), "work\n");
    await post("/sessions/close", { id });
    const listed = await until(() => hub.metas.get(id), 8000, "listed");
    assert.equal(listed.title, "Worktree on feat-c2");
    assert.ok(fs.existsSync(path.join(dataDir, "sessions", id + ".meta.json")), "saved to the store");
    assert.ok(sessionOf(hub, id), "shown in the sidebar");
    assert.ok(fs.existsSync(path.join(wt, "new.txt")));

    // Shutdown with an unsaved dirty one still open.
    const r = await post("/sessions/new", { workspace: repo, branch: "feat-c3" });
    await until(() => sessionOf(hub, r.id)?.status === "idle", 4000, "idle");
    wt2 = sessionOf(hub, r.id).worktree.path;
    fs.writeFileSync(path.join(wt2, "b.txt"), "more work\n");
    hub.close();
    ({ hub, post } = await startHub(dataDir));
    assert.ok(sessionOf(hub, r.id), "listed after a restart");
    assert.ok(fs.existsSync(path.join(wt2, "b.txt")));
  } finally {
    hub.close();
  }
});

test("shutdown removes a clean unsaved branch session's worktree", { skip: noGit }, async () => {
  const dataDir = tmpdir("smolfix-c4-"), repo = makeRepo("smolfix-c4-repo-");
  const { hub, post } = await startHub(dataDir);
  const { id } = await post("/sessions/new", { workspace: repo, branch: "feat-c4" });
  await until(() => sessionOf(hub, id)?.status === "idle", 4000, "idle");
  const wt = sessionOf(hub, id).worktree.path;
  hub.close();
  assert.equal(fs.existsSync(wt), false);
  assert.doesNotMatch(git(repo, "worktree", "list"), new RegExp(path.basename(wt)));
});

test("removeWorktree never forces: dirty, untracked and ignored files all keep it", { skip: noGit }, async () => {
  const repo = makeRepo("smolfix-rw-", "*.log\n");
  const wtRoot = tmpdir("smolfix-rw-wt-");
  const cases = [["dirty", (wt) => fs.writeFileSync(path.join(wt, "a.txt"), "x\n")], ["untracked", (wt) => fs.writeFileSync(path.join(wt, "u.txt"), "x")], ["ignored", (wt) => fs.writeFileSync(path.join(wt, "x.log"), "x")]];
  for (const [name, dirty] of cases) {
    const wt = path.join(wtRoot, name);
    git(repo, "worktree", "add", "-b", "b-" + name, wt);
    dirty(wt);
    assert.deepEqual(await side.removeWorktree(repo, wt), { removed: false, reason: "it has changes" }, name);
    assert.ok(fs.existsSync(wt), name + " kept");
    assert.equal(side.removeWorktreeSync(repo, wt).removed, false, name + " (sync)");
  }
  const clean = path.join(wtRoot, "clean");
  git(repo, "worktree", "add", "-b", "b-clean", clean);
  assert.deepEqual(await side.removeWorktree(repo, clean), { removed: true });
  assert.equal(fs.existsSync(clean), false);
});

// ---- 3: ids ----------------------------------------------------------------------------

test("/sessions/delete and the other id endpoints refuse ids that are not a known session", async () => {
  const dataDir = tmpdir("smolfix-id-");
  fs.mkdirSync(path.join(dataDir, "uploads", "abcd"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "uploads", "abcd", "x.png"), "x");
  const { hub, post } = await startHub(dataDir, async () => { throw new Error("no backend"); });
  try {
    for (const id of ["", "..", "../x", "abcd", "nope", 5, null]) {
      const r = await post("/sessions/delete", { id });
      assert.equal(r.status, 400, "delete " + JSON.stringify(id));
      assert.match(r.error, /unknown session/);
    }
    assert.ok(fs.existsSync(path.join(dataDir, "uploads", "abcd", "x.png")), "uploads untouched");
    assert.ok(fs.existsSync(path.join(dataDir, "sessions")), "the data folder untouched");
    for (const p of ["/sessions/archive", "/sessions/pin", "/sessions/seen", "/sessions/unread", "/sessions/rename", "/sessions/resume", "/sessions/close"]) {
      const r = await post(p, { id: "..", title: "x", archived: true, pinned: true });
      assert.equal(r.status, 400, p);
    }
    const store = new SessionStore(dataDir);
    assert.throws(() => store.delete(".."), /not a session id/);
    assert.throws(() => store.saveMeta({ id: "../evil", workspace: dataDir, title: "x", createdAt: 1, updatedAt: 1 }), /not a session id/);
    fs.writeFileSync(path.join(dataDir, "sessions", "ok.meta.json"), JSON.stringify({ id: "../evil", workspace: dataDir }));
    assert.equal(store.listMetas().length, 0, "a meta whose id is not its file name is skipped");
  } finally {
    hub.close();
  }
});

// ---- 14: Host header -------------------------------------------------------------------

test("every route, the font included, needs a loopback Host", async () => {
  const dataDir = tmpdir("smolfix-host-");
  const { hub, k } = await startHub(dataDir);
  try {
    const evil = { host: "evil.example:" + hub.port };
    assert.equal((await request(hub.port, "GET", FONT_ROUTE, null, evil)).status, 403, "font");
    assert.equal((await request(hub.port, "GET", "/ping" + k, null, evil)).status, 403, "ping with the key");
    assert.equal((await request(hub.port, "GET", "/" + k, null, { host: "127.0.0.1" })).status, 403, "the wrong port");
    assert.equal((await request(hub.port, "GET", "/ping" + k)).status, 200, "127.0.0.1:<port>");
    assert.equal((await request(hub.port, "GET", "/ping" + k, null, { host: "localhost:" + hub.port })).status, 200, "localhost:<port>");
    assert.equal((await request(hub.port, "GET", "/ping" + k, null, { host: "[::1]:" + hub.port })).status, 200, "[::1]:<port>");
    assert.notEqual((await request(hub.port, "GET", FONT_ROUTE)).status, 403, "the font, from a loopback Host");
  } finally {
    hub.close();
  }
});

// ---- 9, 10: SSE --------------------------------------------------------------------------

function sse(port, k, lastId, ms = 400) {
  return new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port, path: "/events" + k, headers: lastId ? { "last-event-id": lastId } : {} }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      setTimeout(() => {
        r.destroy();
        const ids = [...buf.matchAll(/^id: (.+)$/gm)].map((m) => m[1]);
        const ev = [...buf.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]));
        resolve({ ids, ev, buf });
      }, ms);
    });
    r.on("error", () => {});
  });
}

test("sidebar snapshots stay out of the resume ring; resuming still gets a fresh one", async () => {
  const dataDir = tmpdir("smolfix-ring-");
  const store = new SessionStore(dataDir);
  for (let i = 0; i < 3; i++) store.saveMeta({ id: "s" + i, workspace: dataDir, title: "t" + i, createdAt: i, updatedAt: i });
  const { hub, k, post } = await startHub(dataDir);
  try {
    const a = await sse(hub.port, k);
    const last = a.ids[a.ids.length - 1];
    for (let i = 0; i < 3; i++) await post("/sessions/rename", { id: "s" + i, title: "renamed " + i });
    await sleep(100);
    assert.equal(hub.ring.filter((r) => r.line.includes('"t":"hub"')).length, 0, "no snapshot in the ring");
    const b = await sse(hub.port, k, last);
    assert.notEqual(b.ev[0].t, "reset", "a resume, not a full replay");
    assert.deepEqual(b.ev.map((e) => e.t), ["hub", "synced"]);
    assert.match(JSON.stringify(b.ev[0]), /renamed 2/);
  } finally {
    hub.close();
  }
});

test("resuming a saved session flags its replay, so other tabs do not notify", async () => {
  const dataDir = tmpdir("smolfix-replay-");
  const store = new SessionStore(dataDir);
  store.saveMeta({ id: "old1", workspace: dataDir, title: "old", createdAt: 1, updatedAt: 1 });
  store.saveBodySync("old1", { snapshot: { messages: [] }, events: [{ t: "user", s: "q", sid: "old1" }, { t: "token", s: "a", sid: "old1" }, { t: "turnend", label: "Done", sid: "old1" }] });
  const { hub, k, post } = await startHub(dataDir);
  try {
    const watching = sse(hub.port, k, undefined, 600);
    await sleep(150);
    await post("/sessions/resume", { id: "old1" });
    const { ev } = await watching;
    const replayed = ev.filter((e) => e.sid === "old1" && ["user", "token", "turnend"].includes(e.t));
    assert.equal(replayed.length, 3);
    assert.ok(replayed.every((e) => e.replay === true), "every re-sent event is flagged");
  } finally {
    hub.close();
  }
});

// ---- 11: Stop pauses the queue ---------------------------------------------------------

function makeChannel() {
  const sent = [];
  const ch = new SessionChannel("s1", { send: (ev) => sent.push(ev), changed() {}, touched() {} });
  ch.getState = () => ({});
  return { ch, sent };
}

test("Stop pauses the queue: nothing runs until the user sends again or resumes", async () => {
  const { ch } = makeChannel();
  const first = ch.readInput();
  ch.handleMessage("one");
  assert.equal(await first, "one");
  ch.handleMessage("two");
  ch.handleMessage("three");
  ch.cancel();
  assert.equal(ch.queuePaused, true);
  assert.equal(ch.stateEvent().s.queuePaused, true);
  let got = null;
  const next = ch.readInput().then((v) => (got = v));
  await sleep(20);
  assert.equal(got, null, "the queue does not run after Stop");
  assert.deepEqual(ch.queued().map((q) => q.text), ["two", "three"], "the chips stay");
  // Sending again continues, in order: the new message goes last.
  ch.handleMessage("four");
  await next;
  assert.equal(got, "two");
  assert.equal(ch.queuePaused, false);
  assert.deepEqual(ch.queued().map((q) => q.text), ["three", "four"]);

  // Resume continues too; clear empties it.
  ch.cancel();
  const r2 = ch.readInput();
  ch.resumeQueue();
  assert.equal(await r2, "three");
  ch.cancel();
  ch.clearQueue();
  assert.deepEqual(ch.queued(), []);
  assert.equal(ch.queuePaused, false);
});

test("the hub serves /queue/resume and /queue/clear", async () => {
  const dataDir = tmpdir("smolfix-q-");
  const { hub, post } = await startHub(dataDir);
  try {
    const id = hub.openSession(dataDir);
    await until(() => sessionOf(hub, id)?.status === "idle", 4000, "idle");
    const ch = hub.live.get(id).channel;
    ch.inputQueue.push({ id: 99, input: "later" });
    ch.queuePaused = true;
    assert.equal((await post("/queue/resume", { sid: id })).status, 200);
    await until(() => ch.replay.some((e) => e.t === "token" && e.s === "echo later"), 3000, "resumed");
    assert.equal((await post("/queue/clear", { sid: id })).status, 200);
  } finally {
    hub.close();
  }
});

// ---- 12: saves -------------------------------------------------------------------------

test("store: overlapping saves never collide, the last one wins, a sync save or delete wins over one in flight", async () => {
  const dir = tmpdir("smolfix-store-");
  const store = new SessionStore(dir);
  const body = (n) => ({ snapshot: { messages: [], n }, events: [{ t: "token", s: "x".repeat(200_000) + n }] });
  await Promise.all([1, 2, 3, 4, 5].map((n) => store.saveBody("ab", body(n))));
  assert.equal(store.loadBody("ab").snapshot.n, 5, "the last write wins");
  const p = store.saveBody("ab", body(6));
  store.saveBodySync("ab", body(7));
  await p;
  assert.equal(store.loadBody("ab").snapshot.n, 7, "the sync save is not overwritten by the older async one");
  const q = store.saveBody("ab", body(8));
  store.delete("ab");
  await q;
  assert.equal(store.loadBody("ab"), null, "a delete is not undone by a save in flight");
  assert.deepEqual(fs.readdirSync(path.join(dir, "sessions")).filter((f) => f.endsWith(".tmp")), [], "no temp files left");
});

// ---- 8: search -------------------------------------------------------------------------

test("search: the transcript cache is capped by size, reads are async, and a stale query stops", async () => {
  const dir = tmpdir("smolfix-search-");
  const store = new SessionStore(dir);
  for (let i = 0; i < 6; i++) {
    store.saveMeta({ id: "s" + i, workspace: dir, title: "t" + i, createdAt: i, updatedAt: i });
    store.saveBodySync("s" + i, { snapshot: { messages: [] }, events: [{ t: "token", s: "word" + i + " " + "y".repeat(50_000) }] });
  }
  const cache = new side.SavedText(250_000);
  for (let i = 0; i < 6; i++) assert.match(await cache.get(store, "s" + i), new RegExp("word" + i));
  assert.ok(cache.size <= 250_000, "never over the cap: " + cache.size);
  const items = [0, 1, 2, 3, 4, 5].map((i) => ({ id: "s" + i, title: "t" + i, workspace: dir, archived: false, updatedAt: i, text: () => cache.get(store, "s" + i) }));
  const hits = await side.searchSessions(items, "word3");
  assert.deepEqual(hits.map((h) => h.id), ["s3"]);
  let reads = 0;
  const counted = items.map((it) => ({ ...it, text: () => (reads++, it.text()) }));
  assert.equal(await side.searchSessions(counted, "zzz", { stale: () => reads >= 2 }), null, "stale: no answer");
  assert.equal(reads, 2, "and it stopped reading");

  const { hub, k } = await startHub(dir);
  try {
    const r = JSON.parse((await request(hub.port, "GET", "/sessions/search" + k + "&q=word4")).body);
    assert.deepEqual(r.hits.map((h) => h.id), ["s4"]);
  } finally {
    hub.close();
  }
});

// ---- 13: folder completion ---------------------------------------------------------------

test("/fs lists and completes folders asynchronously, same answers as before", async () => {
  const dir = tmpdir("smolfix-fs-");
  for (const n of ["Alpha", "alpine", "beta", ".hidden"]) fs.mkdirSync(path.join(dir, n));
  fs.mkdirSync(path.join(dir, "Alpha", ".git"));
  const a = await side.completeDirAsync(path.join(dir, "al"));
  assert.equal(a.prefix, "al");
  assert.deepEqual(a.dirs.map((d) => d.name), ["Alpha", "alpine"]);
  assert.equal(a.dirs[0].project, true);
  const whole = await side.browseDirAsync(dir);
  assert.deepEqual(whole.dirs.map((d) => d.name), side.browseDir(dir).dirs.map((d) => d.name));
  assert.match((await side.browseDirAsync(path.join(dir, "missing"))).error, /not a folder/);
  const { hub, k } = await startHub(tmpdir("smolfix-fs-data-"));
  try {
    const r = JSON.parse((await request(hub.port, "GET", "/fs" + k + "&complete=1&path=" + encodeURIComponent(path.join(dir, "be")))).body);
    assert.deepEqual(r.dirs.map((d) => d.name), ["beta"]);
  } finally {
    hub.close();
  }
});

// ---- 15: /undo in the web hub --------------------------------------------------------------

async function serveOllama(reply) {
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const json = b ? JSON.parse(b) : {};
      if (req.url === "/api/chat" && json.messages?.length) {
        res.setHeader("content-type", "application/x-ndjson");
        res.end(JSON.stringify({ message: { role: "assistant", content: reply }, done: true, done_reason: "stop", prompt_eval_count: 40, eval_count: 4 }) + "\n");
      } else {
        res.setHeader("content-type", "application/json");
        res.end("{}");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test("/undo in a web session drops the undone turn from the replay and redraws open pages", async (t) => {
  const ollama = await serveOllama("Hello back.");
  t.after(() => ollama.close());
  const ws = tmpdir("smolfix-undo-ws-");
  const { ch, sent } = makeChannel();
  const chosen = { id: "m:1b", backend: "ollama", baseUrl: ollama.base, contextWindow: 8192, toolsSupported: true };
  const session = new Session(ch, { workspace: ws, chosen, prefs: {}, cfg: {}, dataDir: tmpdir("smolfix-undo-data-") });
  ch.getState = () => session.state();
  const running = session.run();
  const say = async (text) => {
    await until(() => ch.pendingInput, 5000, "waiting for input");
    ch.handleMessage(text);
  };
  await say("first");
  await say("second");
  await until(() => ch.replay.filter((e) => e.t === "token").length === 2, 5000, "two replies");
  sent.length = 0;
  await say("/undo");
  await until(() => sent.some((e) => e.t === "session_reset"), 5000, "redraw");
  await until(() => ch.pendingInput, 5000, "idle again");
  const users = ch.replay.filter((e) => e.t === "user").map((e) => e.s);
  assert.deepEqual(users, ["first"], "the undone turn (and the /undo bubble) left the replay");
  assert.equal(ch.replay.filter((e) => e.t === "token").length, 1);
  const i = sent.findIndex((e) => e.t === "session_reset");
  const redraw = sent.slice(i + 1).filter((e) => e.t === "user");
  assert.ok(redraw.length >= 1 && redraw.every((e) => e.replay === true), "the redraw is flagged as replay");
  ch.requestExit();
  await running;
});
