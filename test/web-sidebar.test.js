// Web sidebar server side: the new session/workspace store fields (pin,
// archive, unread, worktree), the hub endpoints behind them, search over
// titles and transcripts, project icons, git branch and +N −M, worktree
// sessions, /fs prefix completion and sibling-project suggestions. All UI
// metadata: the fake session never sees any of it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { SessionStore, WorkspaceStore, workspaceKey } = require("../dist/web/store");
const { WebHub, completeDir } = require("../dist/web/hub");
const side = require("../dist/web/sidebar-data");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = "condition") {
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
  /* no git on PATH */
}
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
function makeRepo(prefix) {
  const dir = tmpdir(prefix);
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A stand-in Session that echoes input and reports a completed outcome. */
function fakeFactory(log = []) {
  return async (ui, workspace, prefs) => {
    log.push({ workspace, prefs });
    const session = {
      chosen: { id: "fake-model", backend: "ollama" },
      workspace,
      onExit: null,
      taskManager: { killAll() {}, runningSummary: () => [], recentUrls: () => [] },
      state: () => ({ mode: "edit", model: "fake-model", backend: "ollama", workspace, outcome: "completed", commands: [] }),
      announce() {},
      restore() {},
      snapshot: () => ({ messages: [{ role: "user", content: "x" }], plan: [], filesTouched: [], commandsRun: [], originalRequest: "x", currentRequest: "x", mode: "edit", effort: null, model: "fake-model", backend: "ollama" }),
      async suggestTitle() { return null; },
      async run() {
        for (;;) {
          const input = await ui.readInput();
          if (input === "/exit") { ui.close(); session.onExit && session.onExit(); return; }
          ui.token("echo: " + (typeof input === "string" ? input : input.text));
          ui.turnEnd("done");
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
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function startHub(dataDir, factory = fakeFactory()) {
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory, quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  const post = async (p, body) => {
    const r = await request(hub, "POST", p + k, body);
    return { status: r.status, ...JSON.parse(r.body || "{}") };
  };
  const get = async (p, query = "") => request(hub, "GET", p + k + query);
  return { hub, k, post, get };
}

const findSession = (hub, id) => {
  for (const w of hub.snapshot().workspaces) {
    const s = w.sessions.find((x) => x.id === id);
    if (s) return { ...s, group: w.path };
  }
  return null;
};
const findGroup = (hub, p) => hub.snapshot().workspaces.find((w) => workspaceKey(w.path) === workspaceKey(p));

// ---- stores ------------------------------------------------------------------

test("store: new session meta fields persist and old-format metas still load", () => {
  const dir = tmpdir("smol-side-store-");
  const store = new SessionStore(dir);
  const meta = {
    id: "aa11", workspace: path.join(dir, "wt"), title: "t", createdAt: 1, updatedAt: 2, model: "m", backend: "ollama",
    pinnedAt: 10, archivedAt: 11, lastVisitedAt: 12, lastTurnEndedAt: 13, lastOutcome: "error",
    project: path.join(dir, "proj"), worktree: { path: path.join(dir, "wt"), branch: "feat/x" },
  };
  store.saveMeta(meta);
  // An old file: none of the new fields.
  fs.writeFileSync(path.join(dir, "sessions", "bb22.meta.json"), JSON.stringify({ id: "bb22", workspace: dir, title: "old", createdAt: 1, updatedAt: 1 }));
  // Junk values are dropped, not passed through.
  fs.writeFileSync(path.join(dir, "sessions", "cc33.meta.json"), JSON.stringify({ id: "cc33", workspace: dir, title: "junk", createdAt: 1, updatedAt: 1, pinnedAt: "x", lastOutcome: "maybe", worktree: { path: 3 } }));
  const fresh = new SessionStore(dir);
  const byId = Object.fromEntries(fresh.listMetas().map((m) => [m.id, m]));
  assert.deepEqual(byId.aa11, meta);
  assert.deepEqual(byId.bb22, { id: "bb22", workspace: dir, title: "old", createdAt: 1, updatedAt: 1, model: undefined, backend: undefined });
  assert.equal(byId.cc33.pinnedAt, undefined);
  assert.equal(byId.cc33.lastOutcome, undefined);
  assert.equal(byId.cc33.worktree, undefined);
  assert.equal(fresh.bodyMtime("aa11"), null);
});

test("store: workspace pin and manual order persist; old workspaces.json still loads", () => {
  const dir = tmpdir("smol-side-ws-");
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  const c = path.join(dir, "c");
  fs.writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify([{ path: a, addedAt: 1, lastOpened: 2 }, { path: b, addedAt: 3, lastOpened: 4 }]));
  const ws = new WorkspaceStore(dir);
  assert.deepEqual(ws.list(), [{ path: a, addedAt: 1, lastOpened: 2 }, { path: b, addedAt: 3, lastOpened: 4 }]);
  ws.setPinned(b, true);
  ws.setPinned(c, true); // not listed yet: added
  ws.setOrder([b, a]);
  let again = new WorkspaceStore(dir);
  const by = Object.fromEntries(again.list().map((e) => [path.basename(e.path), e]));
  assert.equal(typeof by.b.pinnedAt, "number");
  assert.equal(typeof by.c.pinnedAt, "number");
  assert.equal(by.a.pinnedAt, undefined);
  assert.deepEqual([by.b.order, by.a.order, by.c.order], [0, 1, undefined]);
  again.setPinned(b, false);
  again.setOrder([c]);
  again = new WorkspaceStore(dir);
  const by2 = Object.fromEntries(again.list().map((e) => [path.basename(e.path), e]));
  assert.equal(by2.b.pinnedAt, undefined);
  assert.deepEqual([by2.a.order, by2.b.order, by2.c.order], [undefined, undefined, 0]);
});

// ---- unread, pin, archive ------------------------------------------------------

test("hub: a finished turn makes a session unread; seen and unread flip it and persist", async () => {
  const dataDir = tmpdir("smol-side-unread-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const { hub, post } = await startHub(dataDir);
  try {
    const { id } = await post("/sessions/new", { workspace: ws });
    await until(() => findSession(hub, id)?.status === "idle", 2000, "idle");
    let s = findSession(hub, id);
    assert.equal(s.unread, false, "a fresh session is not unread");
    assert.equal(typeof s.phaseSince, "number");
    assert.equal(s.backend, "ollama");
    await post("/msg", { sid: id, text: "hello" });
    s = await until(() => {
      const x = findSession(hub, id);
      return x?.lastTurnEndedAt && x.status === "idle" ? x : null;
    }, 2000, "turn end");
    assert.equal(s.unread, true);
    assert.equal(s.lastOutcome, "completed");

    const metaFile = path.join(dataDir, "sessions", id + ".meta.json");
    await until(() => fs.existsSync(metaFile) && JSON.parse(fs.readFileSync(metaFile, "utf8")).lastTurnEndedAt, 4000, "saved turn end");

    await post("/sessions/seen", { id });
    s = findSession(hub, id);
    assert.equal(s.unread, false);
    assert.ok(s.lastVisitedAt >= s.lastTurnEndedAt);
    assert.equal(JSON.parse(fs.readFileSync(metaFile, "utf8")).lastVisitedAt, s.lastVisitedAt, "seen is persisted at once");

    await post("/sessions/unread", { id });
    s = findSession(hub, id);
    assert.equal(s.unread, true);
    assert.equal(s.lastVisitedAt, s.lastTurnEndedAt - 1);

    await post("/sessions/pin", { id, pinned: true });
    assert.equal(typeof findSession(hub, id).pinnedAt, "number");
    assert.equal(typeof JSON.parse(fs.readFileSync(metaFile, "utf8")).pinnedAt, "number");
    await post("/sessions/pin", { id, pinned: false });
    assert.equal(findSession(hub, id).pinnedAt, undefined);

    for (const ep of ["/sessions/seen", "/sessions/unread", "/sessions/pin", "/sessions/archive"]) {
      const r = await post(ep, { id: "nope" });
      assert.equal(r.status, 400);
      assert.match(r.error, /unknown session/);
    }
  } finally {
    hub.close();
  }
});

test("hub: /sessions/unread on a session that never finished a turn uses its updatedAt", async () => {
  const dataDir = tmpdir("smol-side-unread2-");
  const store = new SessionStore(dataDir);
  store.saveMeta({ id: "ff01", workspace: dataDir, title: "stored", createdAt: 5, updatedAt: 500 });
  const { hub, post } = await startHub(dataDir);
  try {
    assert.equal(findSession(hub, "ff01").unread, false);
    await post("/sessions/unread", { id: "ff01" });
    const s = findSession(hub, "ff01");
    assert.deepEqual([s.unread, s.lastTurnEndedAt, s.lastVisitedAt], [true, 500, 499]);
    const disk = new SessionStore(dataDir).listMetas().find((m) => m.id === "ff01");
    assert.deepEqual([disk.lastTurnEndedAt, disk.lastVisitedAt], [500, 499]);
  } finally {
    hub.close();
  }
});

test("hub: archiving a live session closes it and keeps archivedAt; restoring clears it", async () => {
  const dataDir = tmpdir("smol-side-archive-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const { hub, post } = await startHub(dataDir);
  try {
    const { id } = await post("/sessions/new", { workspace: ws });
    await until(() => findSession(hub, id)?.status === "idle", 2000, "idle");
    await post("/msg", { sid: id, text: "do a thing" });
    const metaFile = path.join(dataDir, "sessions", id + ".meta.json");
    await until(() => fs.existsSync(metaFile), 4000, "saved");
    const r = await post("/sessions/archive", { id, archived: true });
    assert.equal(r.status, 200);
    assert.equal(r.worktreeRemoved, undefined, "no worktree, nothing to report");
    await until(() => findSession(hub, id)?.live === false, 3000, "closed");
    const s = findSession(hub, id);
    assert.equal(s.status, "stored");
    assert.equal(typeof s.archivedAt, "number");
    await sleep(50);
    assert.equal(JSON.parse(fs.readFileSync(metaFile, "utf8")).archivedAt, s.archivedAt, "the final save on exit keeps archivedAt");
    await post("/sessions/archive", { id, archived: false });
    assert.equal(findSession(hub, id).archivedAt, undefined);
    assert.equal(JSON.parse(fs.readFileSync(metaFile, "utf8")).archivedAt, undefined);
  } finally {
    hub.close();
  }
});

test("hub: workspace pin and order show up in the snapshot with addedAt/lastOpened", async () => {
  const dataDir = tmpdir("smol-side-wspin-");
  const a = path.join(dataDir, "a");
  const b = path.join(dataDir, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const { hub, post } = await startHub(dataDir);
  try {
    await post("/workspaces/add", { path: a });
    await post("/workspaces/add", { path: b });
    let ga = findGroup(hub, a);
    assert.equal(ga.pinnedAt, undefined);
    assert.equal(typeof ga.addedAt, "number");
    assert.equal(typeof ga.lastOpened, "number");
    assert.equal(ga.icon, false);
    assert.equal(ga.git, null, "not a repository");
    assert.equal((await post("/workspaces/pin", { path: a, pinned: true })).status, 200);
    assert.equal(typeof findGroup(hub, a).pinnedAt, "number");
    await post("/workspaces/order", { paths: [b, a] });
    assert.deepEqual([findGroup(hub, b).order, findGroup(hub, a).order], [0, 1]);
    await post("/workspaces/pin", { path: a, pinned: false });
    assert.equal(findGroup(hub, a).pinnedAt, undefined);
    await post("/workspaces/order", { paths: [] });
    assert.equal(findGroup(hub, b).order, undefined);
    assert.equal((await post("/workspaces/pin", {})).status, 400);
  } finally {
    hub.close();
  }
});

// ---- search --------------------------------------------------------------------

test("hub: search lists title hits first, then transcript hits with a snippet", async () => {
  const dataDir = tmpdir("smol-side-search-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const store = new SessionStore(dataDir);
  const body = (events) => ({ snapshot: { messages: [], plan: [] }, events });
  store.saveMeta({ id: "s001", workspace: ws, title: "Redirect bug", createdAt: 1, updatedAt: 1 });
  await store.saveBody("s001", body([{ t: "user", s: "nothing here" }]));
  store.saveMeta({ id: "s002", workspace: ws, title: "Login form", createdAt: 2, updatedAt: 2, archivedAt: 3 });
  const long = "x".repeat(80);
  await store.saveBody("s002", body([
    { t: "user", s: "please fix the login form" },
    { t: "tool", name: "read", summary: "redirect in a tool row is not searched" },
    { t: "token", s: long + " I changed the\n\n  handler so the REDIRECT   works after sign in, and " + long },
  ]));
  store.saveMeta({ id: "s003", workspace: ws, title: "Other", createdAt: 3, updatedAt: 3 });
  await store.saveBody("s003", body([{ t: "user", s: "unrelated" }]));
  const { hub, get } = await startHub(dataDir);
  try {
    const search = async (q) => JSON.parse((await get("/sessions/search", "&q=" + encodeURIComponent(q))).body).hits;
    const hits = await search("  redirect ");
    assert.deepEqual(hits.map((h) => [h.id, h.where]), [["s001", "title"], ["s002", "text"]]);
    assert.deepEqual(hits[0], { id: "s001", title: "Redirect bug", workspace: ws, where: "title", archived: false });
    const t = hits[1];
    assert.equal(t.archived, true);
    assert.equal(t.workspace, ws);
    assert.equal(t.snippet.slice(t.match[0], t.match[0] + t.match[1]), "REDIRECT");
    assert.ok(t.snippet.startsWith("…") && t.snippet.endsWith("…"), "cut ends are marked");
    assert.ok(!/\s\s/.test(t.snippet), "whitespace is collapsed");
    assert.ok(t.snippet.length < 120);
    assert.deepEqual(await search(""), []);
    assert.deepEqual(await search("no such words"), []);
    // A changed body is read again (the cache is keyed by mtime).
    await sleep(20);
    await store.saveBody("s003", body([{ t: "token", s: "now it mentions a redirect too" }]));
    fs.utimesSync(path.join(dataDir, "sessions", "s003.json"), new Date(), new Date(Date.now() + 5000));
    assert.deepEqual((await search("redirect")).map((h) => h.id), ["s001", "s003", "s002"]);
  } finally {
    hub.close();
  }
});

test("search helpers: snippet bounds and the match position", () => {
  assert.deepEqual(side.snippetAt("abc def", 4, 3), { snippet: "abc def", match: [4, 3] });
  const s = side.snippetAt("a".repeat(100) + "HIT" + "b".repeat(100), 100, 3);
  assert.equal(s.snippet, "…" + "a".repeat(40) + "HIT" + "b".repeat(60) + "…");
  assert.deepEqual(s.match, [41, 3]);
});

// ---- icons ------------------------------------------------------------------------

test("hub: project icon endpoint serves a known workspace's favicon with a CSP for SVG", async () => {
  const dataDir = tmpdir("smol-side-icon-");
  const ws = path.join(dataDir, "site");
  fs.mkdirSync(path.join(ws, "public"), { recursive: true });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
  fs.writeFileSync(path.join(ws, "public", "favicon.svg"), svg);
  const stranger = path.join(dataDir, "stranger");
  fs.mkdirSync(stranger);
  fs.writeFileSync(path.join(stranger, "favicon.ico"), "ico");
  const plain = path.join(dataDir, "plain");
  fs.mkdirSync(plain);
  const { hub, post, get } = await startHub(dataDir);
  try {
    await post("/workspaces/add", { path: ws });
    await post("/workspaces/add", { path: plain });
    const r = await get("/workspaces/icon", "&path=" + encodeURIComponent(ws));
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/svg+xml");
    assert.equal(r.headers["cache-control"], "private, max-age=300");
    assert.match(r.headers["content-security-policy"], /default-src 'none'.*sandbox/);
    assert.equal(r.body, svg);
    assert.equal((await get("/workspaces/icon", "&path=" + encodeURIComponent(stranger))).status, 404, "not a known workspace");
    assert.equal((await get("/workspaces/icon", "&path=" + encodeURIComponent(plain))).status, 404, "no icon");
    assert.equal((await get("/workspaces/icon")).status, 404);
    assert.equal(findGroup(hub, ws).icon, true);
    assert.equal(findGroup(hub, plain).icon, false);
  } finally {
    hub.close();
  }
});

test("findProjectIcon: first candidate wins and oversized files are skipped", () => {
  const dir = tmpdir("smol-side-icon2-");
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "favicon.png"), Buffer.alloc(600 * 1024));
  fs.writeFileSync(path.join(dir, "app", "icon.png"), "png");
  fs.writeFileSync(path.join(dir, "logo.svg"), "<svg/>");
  assert.equal(side.findProjectIcon(dir), path.join(dir, "app", "icon.png"));
});

// ---- git ----------------------------------------------------------------------------

test("git: branch from HEAD (and detached), shortstat parsing", { skip: !hasGit && "git is not on PATH" }, async () => {
  const repo = makeRepo("smol-side-git-");
  assert.equal(side.readGitBranch(repo), "main");
  assert.equal(side.readGitBranch(tmpdir("smol-side-nogit-")), null);
  assert.deepEqual(side.parseShortstat(" 2 files changed, 10 insertions(+), 1 deletion(-)\n"), { added: 10, removed: 1 });
  assert.deepEqual(side.parseShortstat(" 1 file changed, 1 insertion(+)"), { added: 1, removed: 0 });
  assert.deepEqual(side.parseShortstat(""), { added: 0, removed: 0 });

  fs.writeFileSync(path.join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
  let changes = 0;
  const info = new side.GitInfo(() => changes++);
  assert.deepEqual(info.get(repo), { branch: "main", added: 0, removed: 0 }, "the first read never waits for git");
  await until(() => info.get(repo).added === 2, 5000, "shortstat");
  assert.deepEqual(info.get(repo), { branch: "main", added: 2, removed: 1 });
  assert.ok(changes >= 1);

  const sha = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "-q", "--detach");
  assert.equal(side.readGitBranch(repo), sha.slice(0, 7));
});

test("hub: snapshot carries the workspace git info and refreshes it after a turn", { skip: !hasGit && "git is not on PATH" }, async () => {
  const dataDir = tmpdir("smol-side-gitsnap-");
  const repo = makeRepo("smol-side-gitsnap-repo-");
  const { hub, post } = await startHub(dataDir);
  try {
    await post("/workspaces/add", { path: repo });
    await until(() => findGroup(hub, repo).git?.branch === "main", 3000, "branch");
    const { id } = await post("/sessions/new", { workspace: repo });
    await until(() => findSession(hub, id)?.status === "idle", 2000, "idle");
    fs.appendFileSync(path.join(repo, "a.txt"), "four\nfive\n");
    await post("/msg", { sid: id, text: "edit it" });
    await until(() => findGroup(hub, repo).git?.added === 2, 5000, "refreshed +N after the turn");
    assert.equal(findSession(hub, id).worktree, undefined);
  } finally {
    hub.close();
  }
});

// ---- worktrees -------------------------------------------------------------------------

test("hub: a session on a branch gets its own worktree; archive keeps it, resume restores a missing one, delete removes it only when clean", { skip: !hasGit && "git is not on PATH" }, async () => {
  const dataDir = tmpdir("smol-side-wt-");
  const repo = makeRepo("smol-side-wt-repo-");
  const calls = [];
  const { hub, post } = await startHub(dataDir, fakeFactory(calls));
  try {
    assert.match((await post("/sessions/new", { workspace: repo, branch: "-bad" })).error, /not a valid branch/);
    assert.match((await post("/sessions/new", { workspace: repo, branch: "a..b" })).error, /not a valid branch/);
    assert.match((await post("/sessions/new", { workspace: dataDir, branch: "ok" })).error, /not a git repository/);

    const r = await post("/sessions/new", { workspace: repo, branch: "feature/x" });
    assert.equal(r.status, 200, r.error);
    const id = r.id;
    const wt = path.join(dataDir, "worktrees", `${path.basename(repo)}-${id}`);
    assert.ok(fs.existsSync(path.join(wt, "a.txt")), "the worktree is checked out");
    await until(() => calls.length === 1, 2000, "factory");
    assert.equal(calls[0].workspace, wt, "the session runs in the worktree");
    await until(() => findSession(hub, id)?.status === "idle", 2000, "idle");
    let s = findSession(hub, id);
    assert.equal(workspaceKey(s.group), workspaceKey(repo), "listed under its project");
    assert.deepEqual(s.worktree, { path: wt, branch: "feature/x" });
    await until(() => findSession(hub, id).git?.branch === "feature/x", 3000, "worktree git info");
    assert.equal(hub.snapshot().workspaces.length, 1, "the worktree is not a workspace of its own");

    // Saved with its project and worktree.
    await post("/msg", { sid: id, text: "work on it" });
    const metaFile = path.join(dataDir, "sessions", id + ".meta.json");
    await until(() => fs.existsSync(metaFile), 4000, "saved");
    const saved = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    assert.equal(saved.project, repo);
    assert.deepEqual(saved.worktree, { path: wt, branch: "feature/x" });

    // Archive is undoable: the worktree stays exactly as it is.
    const arch = await post("/sessions/archive", { id, archived: true });
    assert.equal(arch.status, 200, arch.error);
    await until(() => !hub.live.has(id), 5000, "closed by archive");
    assert.ok(fs.existsSync(path.join(wt, "a.txt")), "archive keeps the worktree");

    // A worktree folder deleted by hand comes back on resume.
    await post("/sessions/archive", { id, archived: false });
    git(repo, "worktree", "remove", wt);
    await post("/sessions/resume", { id });
    await until(() => calls.length === 2, 5000, "resumed");
    assert.ok(fs.existsSync(path.join(wt, "a.txt")), "resume re-creates the worktree");
    await until(() => findSession(hub, id)?.status === "idle", 2000, "resumed idle");

    // Delete of a clean worktree removes it; the branch stays.
    const del = await post("/sessions/delete", { id });
    assert.equal(del.status, 200, del.error);
    assert.equal(del.kept, undefined, "nothing kept");
    assert.equal(fs.existsSync(wt), false, "worktree removed on delete");
    await until(() => !git(repo, "worktree", "list").includes(path.basename(wt)), 3000, "unregistered");
    assert.ok(git(repo, "rev-parse", "--verify", "refs/heads/feature/x").trim(), "the branch is still kept");

    // An existing branch: checked out instead of created.
    const r2 = await post("/sessions/new", { workspace: repo, branch: "feature/x" });
    assert.equal(r2.status, 200, r2.error);
    const wt2 = path.join(dataDir, "worktrees", `${path.basename(repo)}-${r2.id}`);
    assert.equal(side.readGitBranch(wt2), "feature/x");
    // A worktree with uncommitted work survives delete, and the answer says where.
    fs.writeFileSync(path.join(wt2, "a.txt"), "changed\n");
    const del2 = await post("/sessions/delete", { id: r2.id });
    assert.deepEqual(del2.kept, { path: wt2, reason: "it has changes" });
    assert.equal(fs.readFileSync(path.join(wt2, "a.txt"), "utf8"), "changed\n", "the work is still there");
  } finally {
    hub.close();
  }
});

// ---- folders -----------------------------------------------------------------------------

test("completeDir: prefix matching in the parent, plain listing for a folder or a trailing separator", async () => {
  const dir = tmpdir("smol-side-complete-");
  for (const n of ["Alpha", "alpine", "beta", ".alhidden"]) fs.mkdirSync(path.join(dir, n));
  fs.writeFileSync(path.join(dir, "alfile.txt"), "x");
  const c = completeDir(path.join(dir, "al"));
  assert.equal(c.path, dir);
  assert.equal(c.prefix, "al");
  assert.deepEqual(c.dirs.map((d) => d.name), ["Alpha", "alpine"]);
  const whole = completeDir(dir);
  assert.equal(whole.prefix, "");
  assert.deepEqual(whole.dirs.map((d) => d.name), ["Alpha", "alpine", "beta"]);
  assert.equal(completeDir(dir + path.sep).prefix, "");
  assert.deepEqual(completeDir(path.join(dir, "zz")).dirs, []);

  const { hub, get } = await startHub(tmpdir("smol-side-complete-hub-"));
  try {
    const r = JSON.parse((await get("/fs", "&complete=1&path=" + encodeURIComponent(path.join(dir, "AL")))).body);
    assert.deepEqual([r.path, r.prefix, r.dirs.map((d) => d.name)], [dir, "AL", ["Alpha", "alpine"]]);
    const plain = JSON.parse((await get("/fs", "&path=" + encodeURIComponent(path.join(dir, "al")))).body);
    assert.match(plain.error, /not a folder/, "without complete=1 the old behaviour stays");
  } finally {
    hub.close();
  }
});

test("hub: /workspaces/suggest lists project siblings of known workspaces, newest first", async () => {
  const parent = tmpdir("smol-side-suggest-");
  const mk = (name, marker) => {
    const d = path.join(parent, name);
    fs.mkdirSync(d);
    if (marker === ".git") fs.mkdirSync(path.join(d, ".git"));
    else if (marker) fs.writeFileSync(path.join(d, marker), "{}");
    return d;
  };
  const known = mk("known", "package.json");
  const older = mk("older", "package.json");
  const newer = mk("newer", ".git");
  mk("notes", null);
  mk(".dotproj", "package.json");
  fs.utimesSync(older, new Date(), new Date(Date.now() - 100_000));
  fs.utimesSync(newer, new Date(), new Date(Date.now() - 1_000));
  const { hub, post, get } = await startHub(tmpdir("smol-side-suggest-hub-"));
  try {
    assert.deepEqual(JSON.parse((await get("/workspaces/suggest")).body), { dirs: [] });
    await post("/workspaces/add", { path: known });
    const { dirs } = JSON.parse((await get("/workspaces/suggest")).body);
    assert.deepEqual(dirs.map((d) => d.name), ["newer", "older"]);
    assert.equal(dirs[0].path, newer);
    assert.equal(typeof dirs[0].display, "string");
  } finally {
    hub.close();
  }
});
