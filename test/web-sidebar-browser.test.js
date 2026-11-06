// The sidebar in a real browser, driven by a fake event stream and a fake hub
// (no model, no server): status labels, folders, the context menu, inline
// rename, archive and the undo notice, delete, the archive shelf, search,
// pins, the resize rail, the Alt shortcuts, filter, folder reorder and the
// add-project picker. Skipped unless Playwright can be loaded: set
// PLAYWRIGHT_PATH (and CHROME_PATH) as for test/web-browser.test.js.
// SIDEBAR_SHOTS=<folder> also saves screenshots there (light and dark).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let chromium = null;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright"));
} catch {
  /* not installed: skipped */
}
const { PAGE_HTML } = require("../dist/web/page");

// DESIGN.md's token block, so screenshots show the intended theme even
// before styles.ts defines the tokens.
function designTokens() {
  try {
    const md = fs.readFileSync(path.join(__dirname, "..", "DESIGN.md"), "utf8");
    const m = /## Quick Start[\s\S]*?```css\n([\s\S]*?)```/.exec(md.replace(/\r\n/g, "\n"));
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

const NOW = Date.now();
function hubSnapshot(over = {}) {
  const ws = [
    {
      path: "/w/smolcoder", name: "smolcoder", display: "~/smolcoder", last: NOW, lastOpened: NOW, icon: true,
      git: { branch: "feat/sidebar-rebuild", added: 128, removed: 37 },
      sessions: [
        { id: "a1", title: "Rebuild the sidebar", live: true, status: "busy", phaseSince: NOW - 72000, updatedAt: NOW, model: "qwen3.6:27b", terminals: [] },
        { id: "a2", title: "Approve the npm install", live: true, status: "waiting", updatedAt: NOW - 60e3, model: "qwen3.6:27b", terminals: [] },
        { id: "a3", title: "Fix login redirect", live: true, status: "idle", unread: true, lastOutcome: "completed", lastTurnEndedAt: NOW - 30e3, updatedAt: NOW - 30e3, model: "gemma4:12b", terminals: [],
          worktree: { path: "/data/worktrees/smolcoder-a3", branch: "fix/login" }, git: { branch: "fix/login", added: 4, removed: 1 } },
        { id: "a4", title: "Port the store to SQLite", live: false, status: "stored", unread: true, lastOutcome: "error", updatedAt: NOW - 3600e3, model: "qwen3.6:27b", terminals: [] },
        { id: "a5", title: "Old refactor notes", live: false, status: "stored", updatedAt: NOW - 3 * 86400e3, terminals: [] },
      ],
    },
    {
      path: "/w/webapp", name: "webapp", display: "~/webapp", last: NOW - 7200e3, lastOpened: NOW - 7200e3, pinnedAt: NOW - 1000, git: { branch: "main", added: 0, removed: 0 },
      sessions: [
        { id: "b1", title: "Landing page copy", live: true, status: "idle", updatedAt: NOW - 600e3, model: "gemma4:12b", terminals: [] },
        { id: "b2", title: "Pinned: release checklist", live: false, status: "stored", pinnedAt: NOW - 5000, updatedAt: NOW - 86400e3, terminals: [] },
        { id: "b3", title: "Archived spike", live: false, status: "stored", archivedAt: NOW - 3000, updatedAt: NOW - 5 * 86400e3, terminals: [] },
      ],
    },
    {
      path: "/w/notes", name: "notes", display: "~/notes", last: NOW - 86400e3, lastOpened: NOW - 86400e3, git: null,
      sessions: [
        { id: "c1", title: "Weekly summary", live: true, status: "error", updatedAt: NOW - 86400e3, terminals: [] },
        ...Array.from({ length: 12 }, (_, i) => ({ id: "z" + i, title: "Archived thing " + (i + 1), live: false, status: "stored", archivedAt: NOW - 10000 - i, updatedAt: NOW - 9 * 86400e3, terminals: [] })),
      ],
    },
  ];
  return Object.assign({ t: "hub", home: "/w", sep: "/", version: "test", workspaces: ws }, over);
}
const state = (sid) => ({ t: "state", sid, s: { mode: "edit", model: "fixture", backend: "ollama", workspace: "/w/smolcoder", commands: [], queued: [] } });

test("sidebar in a browser", { skip: chromium ? false : "Playwright not available (set PLAYWRIGHT_PATH)", timeout: 180000 }, async (t) => {
  const shots = process.env.SIDEBAR_SHOTS || "";
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [], dialogs = [], posts = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.addInitScript((css) => {
    window.EventSource = class { constructor() { window.sessionEvents = this; } };
    if (css) document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = css; document.head.prepend(s); });
  }, shots ? designTokens() : "");
  const replies = {
    "/sessions/new": { id: "new1" },
    "/workspaces/add": { path: "/w/fresh", id: "new2" },
  };
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#1b4ed8"/><path d="M4 11 8 4l4 7z" fill="#fff"/></svg>';
  await page.route("http://smol.test/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}");
      posts.push({ path: url.pathname, body });
      const r = replies[url.pathname] || {};
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(r) });
    }
    if (url.pathname === "/sessions/search") {
      const q = url.searchParams.get("q") || "";
      const hits = /redirect/i.test(q) ? [
        { id: "a3", title: "Fix login redirect", workspace: "/w/smolcoder", where: "title", archived: false },
        { id: "a5", title: "Old refactor notes", workspace: "/w/smolcoder", where: "text", snippet: "…then the redirect loop came back after", match: [10, 8], archived: false },
      ] : [];
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ hits }) });
    }
    if (url.pathname === "/fs") {
      const p = url.searchParams.get("path") || "";
      const d = p === "/w/fresh/" ? { path: "/w/fresh", display: "~/fresh", parent: "/w", prefix: "", dirs: [], project: true }
        : p === "/w/" || p === "/w"
        ? { path: "/w", display: "~", parent: "/", prefix: "", dirs: [{ name: "fresh", path: "/w/fresh", project: true }, { name: "other", path: "/w/other", project: false }] }
        : p.startsWith("/w/fr") ? { path: "/w", display: "~", prefix: "fr", dirs: [{ name: "fresh", path: "/w/fresh", project: true }] }
        : { path: p.replace(/\/$/, ""), display: p, parent: "/w", prefix: "", dirs: [], project: true };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(d) });
    }
    if (url.pathname === "/workspaces/suggest") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ dirs: [{ name: "api", path: "/w/api", display: "~/api" }] }) });
    if (url.pathname === "/workspaces/icon") return route.fulfill({ contentType: "image/svg+xml", body: SVG });
    return route.fulfill({ contentType: "text/html", body: PAGE_HTML });
  });
  const emit = (events) => page.evaluate((evs) => { for (const e of evs) window.sessionEvents.onmessage({ data: JSON.stringify(e) }); }, events);
  const settle = (ms = 120) => page.waitForTimeout(ms);
  const postsTo = (p) => posts.filter((x) => x.path === p);
  const lastPost = (p) => postsTo(p).pop();
  const row = (id) => page.locator('#wslist .sess[data-sid="' + id + '"]');
  const shot = async (name, opts) => { if (shots) await page.waitForTimeout(260), await page.screenshot(Object.assign({ path: path.join(shots, "sidebar-" + name + ".png") }, opts || {})); };
  const boot = async (hubEv) => {
    await page.goto("about:blank");
    await page.goto("http://smol.test/?k=key#a1");
    await emit([{ t: "reset" }, hubEv || hubSnapshot(), ...["a1", "a2", "a3", "b1", "c1"].map(state), { t: "synced" }]);
    await settle();
  };

  try {
    await boot();

    await t.test("status labels, unread and git line", async () => {
      assert.match(await row("a1").textContent(), /Working/, "busy shows Working");
      assert.match(await row("a1").locator(".sb-status").getAttribute("title"), /Working for 1m 1\ds/, "and how long, as the slot's tooltip");
      assert.match(await row("a2").textContent(), /Needs you/);
      assert.match(await row("a3").textContent(), /Done/, "finished since last seen");
      assert.match(await row("a4").textContent(), /Failed/, "an unread failed turn survives as Failed on a stored session");
      assert.match(await row("c1").textContent(), /Failed/, "a failed start");
      // One rhythm: every row is a single line of the same height, whatever its state.
      const heights = await page.evaluate(() => [...document.querySelectorAll("#wslist .sess")].map((e) => Math.round(e.getBoundingClientRect().height)));
      assert.ok(heights.length >= 6 && heights.every((h) => h === heights[0]), "rows share one height: " + heights.join(","));
      // Titles in a folder line up with the folder's name.
      const nameX = await page.locator(".sb-folder", { hasText: "smolcoder" }).locator(".wsname").evaluate((e) => e.getBoundingClientRect().left);
      const titleX = await row("a2").locator(".stitle").evaluate((e) => e.getBoundingClientRect().left);
      assert.ok(Math.abs(nameX - titleX) <= 1, "session title indented to the folder name (" + nameX + " vs " + titleX + ")");
      // The branch and +N −M of the current checkout are in the top bar.
      assert.match(await page.locator("#crumb .crumb-git").textContent(), /feat\/sidebar-rebuild.*\+128.*−37/);
      assert.equal(await row("a3").locator(".sb-wtmark").count(), 1, "a worktree session is marked in its row");
      assert.equal(await row("a2").locator(".sb-wtmark").count(), 0);
      assert.equal(await row("a5").evaluate((e) => e.classList.contains("recede")), true, "stored and seen rows recede");
      assert.equal(await row("a1").evaluate((e) => e.classList.contains("recede")), false);
      assert.equal(await row("a1").getAttribute("aria-current"), "page");
      // The project favicon, and a monogram where there is none.
      assert.equal(await page.locator(".sb-folder", { hasText: "smolcoder" }).locator("img.sb-favicon").count(), 1);
      assert.ok(await page.locator(".sb-mono").count() >= 1);
      await shot("light");
    });

    await t.test("opening an unread session marks it seen on the hub", async () => {
      await row("a3").click();
      await settle();
      assert.deepEqual(lastPost("/sessions/seen").body, { id: "a3" });
      await row("a1").click();
    });

    await t.test("pins: pinned projects first, pinned sessions on their own shelf", async () => {
      assert.equal(await page.locator(".sb-folder .wsname").first().textContent(), "webapp", "the pinned project leads");
      assert.equal(await page.locator(".sb-pinned .sess").count(), 1);
      assert.match(await page.locator(".sb-pinned").textContent(), /release checklist/);
      await row("a5").click({ button: "right" });
      await page.locator(".sb-menu .sb-menu-item", { hasText: /^Pin$/ }).click();
      assert.deepEqual(lastPost("/sessions/pin").body, { id: "a5", pinned: true });
      await page.locator(".sb-fhdr", { hasText: "notes" }).click({ button: "right" });
      await page.locator(".sb-menu .sb-menu-item", { hasText: "Pin project" }).click();
      assert.deepEqual(lastPost("/workspaces/pin").body, { path: "/w/notes", pinned: true });
    });

    await t.test("folders collapse with a count and the most urgent status, remembered", async () => {
      const hdr = page.locator(".sb-fhdr", { hasText: "smolcoder" });
      await hdr.click();
      await settle();
      assert.equal(await hdr.getAttribute("aria-expanded"), "false");
      assert.equal(await hdr.locator(".sb-count").textContent(), "5");
      assert.equal(await hdr.locator(".sb-dot.warning").count(), 1, "Needs you beats Working, Failed and Done");
      assert.match(await hdr.locator(".sr-only").last().textContent(), /needs you/);
      assert.equal(await row("a2").count(), 0);
      await shot("collapsed");
      await boot();
      assert.equal(await page.locator(".sb-fhdr", { hasText: "smolcoder" }).getAttribute("aria-expanded"), "false", "survives a reload");
      await page.locator(".sb-fhdr", { hasText: "smolcoder" }).click();
      assert.equal(await row("a2").count(), 1);
    });

    await t.test("context menu, inline rename with Enter, Esc and double-click", async () => {
      await row("a3").click({ button: "right" });
      const menu = page.locator(".sb-menu");
      assert.equal(await menu.count(), 1);
      const labels = await menu.locator(".sb-menu-label").allTextContents();
      for (const l of ["Pin", "Rename", "Mark unread", "Copy path", "Copy session id", "Archive", "Delete"]) assert.ok(labels.includes(l), l + " in the menu");
      await shot("menu");
      await menu.locator(".sb-menu-item", { hasText: "Rename" }).click();
      const field = row("a3").locator("input.renaming");
      await field.fill("Fix the login redirect");
      await page.keyboard.press("Enter");
      assert.deepEqual(lastPost("/sessions/rename").body, { id: "a3", title: "Fix the login redirect" });
      const before = postsTo("/sessions/rename").length;
      await row("b1").dblclick();
      await row("b1").locator("input.renaming").fill("nope");
      await page.keyboard.press("Escape");
      assert.equal(postsTo("/sessions/rename").length, before, "Esc cancels");
      assert.equal(await row("b1").locator("input.renaming").count(), 0);
      await row("b1").focus();
      await page.keyboard.press("F2");
      assert.equal(await row("b1").locator("input.renaming").count(), 1, "F2 renames the focused row");
      await page.keyboard.press("Escape");
      await row("a3").click({ button: "right" });
      await page.locator(".sb-menu .sb-menu-item", { hasText: "Mark unread" }).click();
      assert.deepEqual(lastPost("/sessions/unread").body, { id: "a3" });
    });

    await t.test("archive with undo (button and ctrl+z); delete waits for the notice", async () => {
      await row("b1").hover();
      await row("b1").getByRole("button", { name: "Archive session" }).click();
      assert.deepEqual(lastPost("/sessions/archive").body, { id: "b1", archived: true });
      const undo = page.locator("#sbundo");
      assert.match(await undo.textContent(), /Archived 'Landing page copy'/);
      await shot("undo");
      await undo.getByRole("button", { name: "Undo" }).click();
      assert.deepEqual(lastPost("/sessions/archive").body, { id: "b1", archived: false });
      await row("a5").hover();
      await row("a5").getByRole("button", { name: "Archive session" }).click();
      await page.locator("#crumb").click();
      await page.keyboard.press("Control+z");
      assert.deepEqual(lastPost("/sessions/archive").body, { id: "a5", archived: false }, "ctrl+z undoes");

      await row("a5").click({ button: "right" });
      await page.locator(".sb-menu .sb-menu-item.danger", { hasText: "Delete" }).click();
      assert.equal(await row("a5").count(), 0, "gone from the list at once");
      assert.equal(postsTo("/sessions/delete").length, 0, "but not deleted yet");
      await page.locator("#sbundo").getByRole("button", { name: "Undo" }).click();
      assert.equal(await row("a5").count(), 1, "undo brings it back");
      await row("a5").click({ button: "right" });
      await page.locator(".sb-menu .sb-menu-item.danger", { hasText: "Delete" }).click();
      await page.waitForTimeout(6300);
      assert.deepEqual(lastPost("/sessions/delete").body, { id: "a5" }, "sent once the notice expires");
      assert.deepEqual(dialogs, [], "no alert, confirm or prompt");
      await boot();
    });

    await t.test("archived shelf: collapsed, 10 rows, then more; restore", async () => {
      const shelf = page.locator(".sb-shelf");
      assert.match(await shelf.locator(".sb-shelfhdr").textContent(), /Archived\s*13/);
      assert.equal(await shelf.locator(".sess").count(), 0, "collapsed by default");
      await shelf.locator(".sb-shelfhdr").click();
      assert.equal(await shelf.locator(".sess").count(), 10);
      await shelf.locator(".sb-more").click();
      assert.equal(await shelf.locator(".sess").count(), 13);
      await shot("archived", { clip: { x: 0, y: 0, width: 300, height: 860 } });
      await shelf.locator(".sess").first().hover();
      await shelf.locator(".sess").first().getByRole("button", { name: "Restore session" }).click();
      assert.equal(lastPost("/sessions/archive").body.archived, false);
      await shelf.locator(".sb-shelfhdr").click();
    });

    await t.test("search: titles at once, transcript matches with a snippet, keys", async () => {
      const field = page.locator("#sbsearch");
      await field.click();
      await field.fill("redirect");
      await settle(400);
      const results = page.locator(".sb-result");
      assert.equal(await results.count(), 2);
      assert.match(await results.nth(0).textContent(), /Fix login redirect/);
      assert.equal(await results.nth(1).locator(".sb-snippet mark").textContent(), "redirect");
      await shot("search");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await settle();
      assert.deepEqual(lastPost("/sessions/resume").body, { id: "a5" }, "a stored hit resumes");
      assert.equal(await field.inputValue(), "", "the query clears");
      await field.fill("zzz-nothing");
      await settle(400);
      assert.match(await page.locator("#wslist").textContent(), /No sessions found/);
      await page.keyboard.press("Escape");
      assert.equal(await field.inputValue(), "");
    });

    await t.test("resize rail: drag, remembered, double-click resets", async () => {
      const rail = page.locator("#siderail");
      const box = await rail.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 300);
      await page.mouse.down();
      await page.mouse.move(400, box.y + 300, { steps: 6 });
      await page.mouse.up();
      const w = await page.locator("#side").evaluate((e) => Math.round(e.getBoundingClientRect().width));
      assert.ok(Math.abs(w - 400) <= 3, "dragged to " + w);
      assert.ok(Math.abs(Number(await page.evaluate(() => localStorage.getItem("smol.side.w"))) - 400) <= 3);
      await page.mouse.move(100, 100);
      const rb = await rail.boundingBox();
      await page.mouse.move(rb.x + rb.width / 2, rb.y + 50);
      await page.mouse.down(); await page.mouse.move(5000, 300, { steps: 3 }); await page.mouse.up();
      assert.ok(await page.locator("#side").evaluate((e) => e.getBoundingClientRect().width) <= 1280 - 640 + 1, "never wider than the viewport minus 640");
      const r2 = await rail.boundingBox();
      await page.mouse.dblclick(r2.x + r2.width / 2, r2.y + 200);
      assert.equal(await page.locator("#side").evaluate((e) => Math.round(e.getBoundingClientRect().width)), 256);
    });

    await t.test("keys: Alt hints, Alt+1…9, Alt+↑/↓, Alt+N", async () => {
      await page.locator("#logwrap").click();
      await page.keyboard.down("Alt");
      assert.equal(await page.locator("#side.alt-held").count(), 1);
      assert.ok(await page.locator(".sb-hint").first().isVisible(), "hints show while Alt is held");
      await shot("alt-hints", { clip: { x: 0, y: 0, width: 300, height: 860 } });
      await page.keyboard.press("Digit3");
      await page.keyboard.up("Alt");
      await settle();
      const order = await page.evaluate(() => [...document.querySelectorAll("#wslist .sess:not(.archived)")].map((e) => e.dataset.sid));
      assert.equal(await page.locator("#wslist .sess.active").getAttribute("data-sid"), order[2]);
      await page.keyboard.press("Alt+ArrowDown");
      await settle();
      assert.equal(await page.locator("#wslist .sess.active").getAttribute("data-sid"), order[3]);
      await page.keyboard.press("Alt+ArrowUp");
      await settle();
      assert.equal(await page.locator("#wslist .sess.active").getAttribute("data-sid"), order[2]);
      await row("a1").click();
      await page.keyboard.press("Alt+n");
      assert.deepEqual(lastPost("/sessions/new").body, { workspace: "/w/smolcoder" }, "a new session in the current project");
      await emit([hubSnapshot()]);
      await row("a1").click();
    });

    await t.test("filter by project, and dragging a folder sets a manual order", async () => {
      await page.locator("#sbfilter").click();
      await page.locator(".sb-filterpop .chooser-row", { hasText: "notes" }).click();
      assert.equal(await page.locator(".sb-folder").count(), 1);
      assert.match(await page.locator(".sb-filterbar").textContent(), /Only notes/);
      await page.locator(".sb-filterbar button").click();
      assert.equal(await page.locator(".sb-folder").count(), 3);
      await page.locator(".sb-fhdr", { hasText: "notes" }).dragTo(page.locator(".sb-fhdr", { hasText: "smolcoder" }));
      await settle();
      assert.deepEqual(lastPost("/workspaces/order").body, { paths: ["/w/webapp", "/w/notes", "/w/smolcoder"] });
      await page.evaluate(() => localStorage.setItem("smol.sb.sort", "recent"));
    });

    await t.test("add project: recent and suggested, typed path, Tab completes, Enter adds", async () => {
      await page.locator("#openfolder").click();
      const dlg = page.locator(".sb-addproj");
      assert.equal(await dlg.count(), 1);
      await settle(200);
      assert.match(await dlg.textContent(), /Recent[\s\S]*smolcoder[\s\S]*Suggested[\s\S]*api/);
      await shot("add-project");
      await page.keyboard.type("/w/fr");
      await settle(200);
      assert.match(await dlg.locator(".chooser-row.sel").textContent(), /fresh\//);
      await page.keyboard.press("Tab");
      await settle(200);
      assert.equal(await dlg.locator(".chooser-filter").inputValue(), "/w/fresh/");
      await page.keyboard.press("Enter");
      await settle();
      assert.deepEqual(lastPost("/workspaces/add").body, { path: "/w/fresh", start: true });
      assert.equal(await dlg.count(), 0);
    });

    await t.test("empty states keep the logo", async () => {
      await boot(hubSnapshot({ workspaces: [] }));
      await settle();
      assert.equal(await page.locator("#welcome").isVisible(), true);
      assert.match(await page.locator("#welcome h1").textContent(), /What should we work on\?/);
      assert.ok(await page.locator("#logo").isVisible(), "the SMOL logo stays");
      assert.match(await page.locator("#wslist").textContent(), /No projects yet/);
      await shot("empty");
      assert.deepEqual(errors, [], "browser errors");
    });

    await t.test("a fresh session keeps the logo under a note, until the first message", async () => {
      await boot();
      const log = () => page.locator(".log:not([hidden])");
      await emit([{ t: "line", sid: "a1", kind: "warn", s: "older Ollama: setting the context explicitly" }]);
      await settle();
      assert.equal(await log().evaluate((e) => e.classList.contains("fresh")), true, "a note does not end the fresh state");
      const before = await log().evaluate((e) => getComputedStyle(e, "::before").content);
      assert.match(before, /███/, "the SMOL logo shows");
      assert.match(await log().evaluate((e) => getComputedStyle(e, "::after").content), /What should we work on\?/);
      assert.ok(await log().locator(".line-warn").isVisible(), "the note shows too");
      await emit([{ t: "user", sid: "a1", s: "hello" }]);
      await settle();
      assert.equal(await log().evaluate((e) => e.classList.contains("fresh")), false, "the first message ends it");
      assert.equal(await log().evaluate((e) => getComputedStyle(e, "::before").content), "none");
    });

    if (shots) {
      await t.test("dark theme screenshot", async () => {
        await page.emulateMedia({ colorScheme: "dark" });
        await boot();
        await row("a3").hover();
        await shot("dark");
        await page.emulateMedia({ colorScheme: "light" });
      });
    }
  } finally {
    await browser.close();
  }
});
