// Page-side fixes in a real browser, against a fake event stream and a fake
// hub: Option typing on a Mac, the palette's "New session" from a worktree
// session, sidebar rebuilds per snapshot, notifications for replays, the
// paused queue, folder completion debounce, toast placement, "thought
// briefly", the narrow-screen scrim, the /undo redraw and the kept-worktree
// notice. Skipped unless Playwright can be loaded (set PLAYWRIGHT_PATH and
// CHROME_PATH as for test/web-browser.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");

let chromium = null;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright"));
} catch {
  /* not installed: skipped */
}
const { PAGE_HTML } = require("../dist/web/page");

const NOW = Date.now();
function hubSnapshot(extra = 0) {
  return {
    t: "hub", home: "/w", sep: "/", version: "test",
    workspaces: [
      {
        path: "/w/proj", name: "proj", display: "~/proj", last: NOW + extra, lastOpened: NOW,
        sessions: [
          { id: "a1", title: "Main session", live: true, status: "idle", updatedAt: NOW + extra, terminals: [] },
          { id: "wt1", title: "On a branch", live: true, status: "idle", updatedAt: NOW - 1000, terminals: [], worktree: { path: "/data/worktrees/proj-wt1", branch: "feat" } },
          { id: "b1", title: "Background", live: true, status: "idle", updatedAt: NOW - 2000, terminals: [] },
        ],
      },
    ],
  };
}
const state = (sid, s = {}) => ({ t: "state", sid, s: Object.assign({ mode: "edit", model: "m", backend: "ollama", workspace: sid === "wt1" ? "/data/worktrees/proj-wt1" : "/w/proj", commands: [], queued: [] }, s) });
const rectsOverlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

async function openPage(browser, opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [], posts = [], fsCalls = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((mac) => {
    window.EventSource = class { constructor() { window.sessionEvents = this; } };
    window.__notes = [];
    window.Notification = class { constructor(title) { this.title = title; window.__notes.push(this); } close() {} };
    window.Notification.permission = "granted";
    localStorage.setItem("smol.notify", "1");
    if (mac) Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  }, !!opts.mac);
  const replies = Object.assign({ "/sessions/new": { id: "new1" } }, opts.replies || {});
  await page.route("http://smol.test/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "POST") {
      posts.push({ path: url.pathname, body: JSON.parse(req.postData() || "{}") });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(replies[url.pathname] || {}) });
    }
    if (url.pathname === "/fs") {
      const p = url.searchParams.get("path") || "";
      fsCalls.push(p);
      const d = p === "/w/fresh/" ? { path: "/w/fresh", display: "~/fresh", parent: "/w", prefix: "", dirs: [], project: true }
        : { path: "/w", display: "~", parent: "/", prefix: p.split("/").pop(), dirs: [{ name: "fresh", path: "/w/fresh", project: true }] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(d) });
    }
    if (url.pathname === "/workspaces/suggest") return route.fulfill({ contentType: "application/json", body: '{"dirs":[]}' });
    if (url.pathname === "/workspaces/icon") return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ contentType: "text/html", body: PAGE_HTML });
  });
  const emit = (events) => page.evaluate((evs) => { for (const e of evs) window.sessionEvents.onmessage({ data: JSON.stringify(e) }); }, events);
  await page.goto("http://smol.test/?k=key#" + (opts.sid || "a1"));
  await emit([{ t: "reset" }, hubSnapshot(), state("a1"), state("wt1"), state("b1"), { t: "synced" }]);
  await page.waitForTimeout(150);
  const postsTo = (p) => posts.filter((x) => x.path === p);
  return { context, page, errors, posts, postsTo, fsCalls, emit, settle: (ms = 150) => page.waitForTimeout(ms) };
}

test("web page fixes in a browser", { skip: chromium ? false : "Playwright not available (set PLAYWRIGHT_PATH)", timeout: 180000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  try {
    await t.test("macOS: Option in the composer is typing; Ctrl+Option runs the shortcut, and the hints say so", async () => {
      const { context, page, postsTo, settle } = await openPage(browser, { mac: true });
      await page.evaluate(() => window.addEventListener("keydown", (e) => { if (e.altKey) window.__lastAlt = e.defaultPrevented; }));
      await page.locator("#input").focus();
      await page.keyboard.press("Alt+n");
      await page.keyboard.press("Alt+Digit2");
      await settle();
      assert.equal(postsTo("/sessions/new").length, 0, "Option+N in the composer does not start a session");
      assert.equal(await page.evaluate(() => window.__lastAlt), false, "and the key reaches the text field");
      assert.equal(await page.locator("#wslist .sess.active").getAttribute("data-sid"), "a1", "Option+2 did not switch sessions");
      await page.keyboard.press("Control+Alt+n");
      await settle();
      assert.equal(postsTo("/sessions/new").length, 1, "Ctrl+Option+N does");
      assert.match(await page.locator("#sbnew").getAttribute("title"), /ctrl\+alt\+n/);
      await context.close();
    });

    await t.test("elsewhere Alt+N still works in the composer", async () => {
      const { context, page, postsTo, settle } = await openPage(browser);
      await page.locator("#input").focus();
      await page.keyboard.press("Alt+n");
      await settle();
      assert.equal(postsTo("/sessions/new").length, 1);
      assert.match(await page.locator("#sbnew").getAttribute("title"), /\(alt\+n\)/);
      await context.close();
    });

    await t.test("palette New session from a worktree session starts in the project", async () => {
      const { context, page, postsTo, settle } = await openPage(browser, { sid: "wt1" });
      await page.keyboard.press("Control+k");
      await page.keyboard.type("New session");
      const row = page.locator(".palette .chooser-row", { hasText: /^New session~/ }).first();
      assert.match(await row.textContent(), /~\/proj/);
      await row.click();
      await settle();
      assert.deepEqual(postsTo("/sessions/new").pop().body, { workspace: "/w/proj" });
      await context.close();
    });

    await t.test("the sidebar is rebuilt only when a snapshot changes it, at most once a frame", async () => {
      const { context, page, emit, settle } = await openPage(browser);
      await page.evaluate(() => { window.__renders = 0; const real = window.renderSidebar; window.renderSidebar = function () { window.__renders++; return real.apply(this, arguments); }; });
      await emit(Array.from({ length: 10 }, () => hubSnapshot()));
      await settle();
      assert.equal(await page.evaluate(() => window.__renders), 0, "identical snapshots: no rebuild");
      await emit(Array.from({ length: 10 }, (_, i) => hubSnapshot(i + 1)));
      await settle();
      const n = await page.evaluate(() => window.__renders);
      assert.ok(n >= 1 && n <= 2, "ten different ones in a burst: one rebuild, got " + n);
      await context.close();
    });

    await t.test("replayed events never notify; live ones do", async () => {
      const { context, page, emit, settle } = await openPage(browser);
      await emit([{ t: "turnend", sid: "b1", label: "old turn", replay: true }, { t: "confirm", sid: "b1", id: 5, command: "rm x", replay: true }]);
      await settle();
      assert.equal(await page.evaluate(() => window.__notes.length), 0);
      await emit([{ t: "turnend", sid: "b1", label: "new turn" }]);
      assert.equal(await page.evaluate(() => window.__notes.length), 1);
      await context.close();
    });

    await t.test("after Stop the queue shows as paused, with Resume and Clear", async () => {
      const { context, page, emit, postsTo, settle } = await openPage(browser);
      await emit([state("a1", { queued: [{ id: 1, text: "later one" }, { id: 2, text: "later two" }], queuePaused: true })]);
      await settle();
      assert.match(await page.locator("#queuerow").textContent(), /Paused · Send to continue/);
      await page.locator("#queuerow .queue-resume").click();
      await page.locator("#queuerow .queue-clear").click();
      await settle();
      assert.deepEqual(postsTo("/queue/resume").map((p) => p.body), [{ sid: "a1" }]);
      assert.deepEqual(postsTo("/queue/clear").map((p) => p.body), [{ sid: "a1" }]);
      // Sending while paused shows the chip at once (it joins the queue).
      await page.locator("#input").fill("and this");
      await page.keyboard.press("Enter");
      assert.match(await page.locator("#queuerow").textContent(), /and this/);
      await emit([state("a1", { queued: [], queuePaused: false })]);
      assert.equal(await page.locator("#queuerow").isHidden(), true);
      await context.close();
    });

    await t.test("folder completion asks the hub once per pause in typing, and Enter waits for the fresh list", async () => {
      const { context, page, fsCalls, postsTo, settle } = await openPage(browser);
      await page.evaluate(() => openAddProject());
      await page.keyboard.type("/w/fresh/", { delay: 15 });
      await page.keyboard.press("Enter");
      await settle(400);
      assert.ok(fsCalls.length <= 2, "not one request per key: " + JSON.stringify(fsCalls));
      assert.equal(fsCalls[fsCalls.length - 1], "/w/fresh/");
      assert.deepEqual(postsTo("/workspaces/add").pop().body, { path: "/w/fresh", start: true }, "Enter added what was typed");
      await context.close();
    });

    await t.test("toasts never cover the palette or the queue chips", async () => {
      const { context, page, emit, settle } = await openPage(browser, { viewport: { width: 1000, height: 560 } });
      const queued = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, text: "queued message " + i }));
      await emit([state("a1", { queued })]);
      await settle();
      await page.evaluate(() => toast("Saved somewhere"));
      await settle(250);
      const chips = await page.locator("#queuerow").boundingBox();
      let box = await page.locator("#toasts").boundingBox();
      assert.ok(box.y + box.height <= chips.y, "above the chips: toast " + JSON.stringify(box) + " chips " + JSON.stringify(chips));
      await page.keyboard.press("Control+k");
      await settle(250);
      await page.evaluate(() => toast("While the palette is open"));
      await settle(250);
      const pal = await page.locator(".chooser.palette").boundingBox();
      box = await page.locator("#toasts").boundingBox();
      const r = (b) => ({ left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height });
      // Where they would overlap (no free spot in a short window) the palette is on top.
      if (rectsOverlap(r(box), r(pal))) {
        const x = Math.max(box.x, pal.x) + 2, y = Math.max(box.y, pal.y) + 2;
        assert.ok(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y).closest(".chooser.palette"), [x, y]), "the palette stays visible over the toasts");
      }
      await page.keyboard.press("Escape");
      await page.evaluate(() => { document.getElementById("toasts").innerHTML = ""; toast("one toast"); });
      await page.keyboard.press("Control+k");
      await settle(250);
      box = await page.locator("#toasts").boundingBox();
      const pal2 = await page.locator(".chooser.palette").boundingBox();
      assert.ok(!rectsOverlap(r(box), r(pal2)), "with room, moved clear of the palette: toast " + JSON.stringify(box) + " palette " + JSON.stringify(pal2));
      await context.close();
    });

    await t.test("a near-instant or replayed thought does not say 0.0s", async () => {
      const { context, page, emit } = await openPage(browser);
      await emit([{ t: "thinking", sid: "a1", s: "hmm" }, { t: "token", sid: "a1", s: "ok" }]);
      const last = () => page.locator("#logs .log:not([hidden]) .thought .thought-preview").last().textContent();
      assert.equal(await last(), "thought briefly");
      await emit([{ t: "reset" }, hubSnapshot(), state("a1"), { t: "thinking", sid: "a1", s: "long ago" }, { t: "token", sid: "a1", s: "x" }, { t: "synced" }]);
      assert.equal(await last(), "thought");
      await context.close();
    });

    await t.test("narrow screens: the open sidebar has a scrim; a click on it or Esc closes it", async () => {
      const { context, page, settle } = await openPage(browser, { viewport: { width: 800, height: 700 } });
      await page.locator("#sidetoggle").click();
      assert.equal(await page.locator("#sidescrim").isVisible(), true);
      await page.locator("#sidescrim").click({ position: { x: 700, y: 300 } });
      assert.equal(await page.locator("#side.collapsed").count(), 1);
      assert.equal(await page.locator("#sidescrim").isVisible(), false);
      await page.locator("#sidetoggle").click();
      await settle();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#side.collapsed").count(), 1, "Esc closes it");
      await context.close();
    });

    await t.test("an /undo redraw replaces the session's transcript", async () => {
      const { context, page, emit } = await openPage(browser);
      await emit([{ t: "user", sid: "a1", s: "first" }, { t: "token", sid: "a1", s: "one" }, { t: "user", sid: "a1", s: "second" }, { t: "token", sid: "a1", s: "two" }]);
      await emit([{ t: "session_reset", sid: "a1" }, { t: "user", sid: "a1", s: "first", replay: true }, { t: "token", sid: "a1", s: "one", replay: true }]);
      const users = await page.locator("#logs .log:not([hidden]) .user").allTextContents();
      assert.deepEqual(users, ["first"]);
      await context.close();
    });

    await t.test("a delete that keeps a worktree says where", async () => {
      const { context, page, settle } = await openPage(browser, { replies: { "/sessions/delete": { kept: { path: "/data/worktrees/proj-wt1", reason: "it has changes" } } } });
      await page.locator('#wslist .sess[data-sid="b1"]').click({ button: "right" });
      await page.locator(".sb-menu-item", { hasText: "Delete" }).click();
      await page.evaluate(() => flushUndo());
      await settle(300);
      assert.match(await page.locator("#toasts").textContent(), /Kept worktree at \/data\/worktrees\/proj-wt1 because it has changes/);
      await context.close();
    });
  } finally {
    await browser.close();
  }
});
