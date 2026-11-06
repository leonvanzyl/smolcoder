// The web page in a real browser, driven by a fake event stream (no model,
// no server). Skipped unless Playwright can be loaded: set PLAYWRIGHT_PATH
// (and CHROME_PATH for an installed Chrome) as for the bench/*-browser.cjs
// scripts. Covers streaming markdown, scrolling, pickers, the palette, the
// composer menus, history and drafts, the queue, diffs, tool rows, toasts,
// SSE resume and notifications.
const test = require("node:test");
const assert = require("node:assert/strict");

let chromium = null;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright"));
} catch {
  /* not installed: skipped */
}
const { PAGE_HTML } = require("../dist/web/page");

const HUB = {
  t: "hub", home: "/w", version: "test", workspaces: [{ path: "/w/demo", name: "demo", sessions: [
    { id: "s1", title: "First session", live: true, status: "idle", updatedAt: 3, terminals: [] },
    { id: "s2", title: "Second session", live: true, status: "idle", updatedAt: 2, terminals: [] },
  ] }],
};
const COMMANDS = [
  { name: "models", desc: "Switch model", group: "Model" },
  { name: "effort", desc: "Set reasoning effort", group: "Model", args: true },
  { name: "help", desc: "Show help", group: "Session", key: "?" },
];
const state = (sid, extra) => ({ t: "state", sid, s: Object.assign({ mode: "edit", model: "fixture", backend: "ollama", workspace: "/w/demo", commands: COMMANDS, queued: [] }, extra || {}) });

test("web page in a browser", { skip: chromium ? false : "Playwright not available (set PLAYWRIGHT_PATH)", timeout: 120000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [], dialogs = [], posts = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.addInitScript(() => {
    window.EventSource = class { constructor() { window.sessionEvents = this; } };
    window.__notes = [];
    window.Notification = class {
      constructor(title, opts) { this.title = title; this.opts = opts; window.__notes.push(this); }
      close() {}
    };
    window.Notification.permission = "granted";
    window.Notification.requestPermission = () => Promise.resolve("granted");
  });
  const replies = { "/command/args": { options: [{ label: "off" }, { label: "low" }, { label: "high", hint: "slow" }] } };
  await page.route("http://smol.test/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}");
      posts.push({ path: url.pathname, body });
      const r = typeof replies[url.pathname] === "function" ? replies[url.pathname](body) : replies[url.pathname] || {};
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(r) });
    }
    if (url.pathname === "/files") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ files: ["README.md", "src/cli.ts", "src/web/client.ts"], truncated: false }) });
    return route.fulfill({ contentType: "text/html", body: PAGE_HTML });
  });
  await page.goto("http://smol.test/?k=key");
  const emit = (events) => page.evaluate((evs) => { for (const e of evs) window.sessionEvents.onmessage({ data: JSON.stringify(e) }); }, events);
  const settle = (ms = 120) => page.waitForTimeout(ms);
  const lastPost = (p) => posts.filter((x) => x.path === p).pop();
  const log = () => page.locator(".log:not([hidden])");
  const metrics = () => page.locator("#logwrap").evaluate((l) => ({ top: l.scrollTop, gap: l.scrollHeight - l.scrollTop - l.clientHeight, reading: l.classList.contains("reading") }));
  const lines = (sid, n, p) => Array.from({ length: n }, (_, i) => ({ t: "line", sid, kind: "status", s: p + " " + i }));

  try {
    await emit([{ t: "reset" }, HUB, state("s1"), state("s2"), ...lines("s1", 60, "Earlier"), { t: "synced" }]);
    await settle();

    await t.test("streaming markdown freezes finished blocks, heals the tail and keeps a selection", async () => {
      await emit([{ t: "token", sid: "s1", s: "First paragraph with **bold** text.\n\nSecond **unclosed and `code" }]);
      await settle();
      const md = log().locator(".md").last();
      assert.equal(await md.locator("p").count(), 2);
      assert.equal(await md.locator(".mdtail strong").count(), 1, "an unclosed ** is healed in the tail");
      assert.equal(await md.locator(".mdtail code").count(), 1, "an unclosed backtick is healed");
      // Select inside the frozen first paragraph, then keep streaming.
      await md.locator("p").first().evaluate((p) => {
        p._marker = "frozen";
        const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 5);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      });
      await emit([{ t: "token", sid: "s1", s: " more** words\n\n```js\nconst a = 1;" }]);
      await settle();
      assert.equal(await md.locator("p").first().evaluate((p) => p._marker), "frozen", "finished blocks are not re-rendered");
      assert.equal(await page.evaluate(() => String(getSelection())), "First", "the selection survives streaming");
      assert.equal(await md.locator(".mdtail .codeblock .lang").textContent(), "js", "an open fence renders as code with its language");
      assert.equal(await md.locator(".mdtail .codeblock .copybtn").count(), 1);
      await page.evaluate(() => getSelection().removeAllRanges());
      await emit([{ t: "token", sid: "s1", s: "\n```\n\nDone." }, { t: "turnend", sid: "s1", label: "done" }]);
      await settle();
      assert.equal(await md.locator(".mdtail").innerHTML(), "", "the finished reply is fully frozen");
      assert.equal(await md.locator(".codeblock").count(), 1);
      assert.equal(await md.locator(".msgcopy").count(), 1, "messages have a copy action");
    });

    await t.test("selecting text pauses following; nested scrollers don't stop it; overflow-anchor follows the mode", async () => {
      await page.locator("#jumpbottom").evaluate((b) => b.hidden || b.click());
      await settle();
      assert.equal((await metrics()).reading, false, "following: anchoring off");
      await emit([{ t: "token", sid: "s1", s: "Streaming line.\n\n".repeat(5) }]);
      await settle();
      assert.ok((await metrics()).gap <= 2);
      await log().locator(".md").last().locator("p").first().evaluate((p) => {
        const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      });
      await settle();
      const before = await metrics();
      assert.equal(before.reading, true, "a selection pauses following");
      await emit([{ t: "token", sid: "s1", s: "More streamed text.\n\n".repeat(10) }]);
      await settle();
      assert.equal((await metrics()).top, before.top, "the selection did not scroll away");
      await page.evaluate(() => getSelection().removeAllRanges());
      await settle();
      assert.ok((await metrics()).gap <= 2, "clearing the selection resumes following");

      // A long tool result: wheel inside it does not stop following.
      await emit([{ t: "tool", sid: "s1", name: "run_command", summary: "npm test" }, { t: "result", sid: "s1", body: "output line\n".repeat(200), ms: 1500 },
        { t: "token", sid: "s1", s: "after\n\n" }, { t: "turnend", sid: "s1", label: "done" }]);
      await settle();
      const tool = log().locator("details.tool").last();
      await tool.locator("summary").click();
      await page.locator("#jumpbottom").evaluate((b) => b.hidden || b.click());
      await settle();
      const pre = tool.locator("pre.result");
      await pre.evaluate((p) => { p.scrollTop = p.scrollHeight; });
      await pre.hover();
      await page.mouse.wheel(0, -60);
      await settle();
      await emit(lines("s1", 5, "After wheel"));
      await settle();
      assert.ok((await metrics()).gap <= 2, "a wheel inside a nested scroller kept following");
      assert.equal(await tool.locator(".dur").textContent(), "1.5s", "the duration is shown");
    });

    await t.test("tool rows: live argument progress, running pulse, diffs, explored groups, lazy bodies", async () => {
      await emit([{ t: "toolargs", sid: "s1", name: "write_file", chars: 1234 }]);
      await settle();
      assert.match(await log().locator(".argsrow").textContent(), /writing.*1,234 chars/);
      await emit([{ t: "tool", sid: "s1", name: "write_file", summary: "src/a.ts (3 lines)" }]);
      await settle();
      assert.equal(await log().locator(".argsrow").count(), 0, "the progress row gives way to the call");
      assert.equal(await log().locator("details.tool").last().evaluate((d) => d.classList.contains("running")), true);
      // The running status glyph is a pulsing dot before the name.
      const anim = await log().locator("details.tool").last().locator("summary").evaluate((s) => getComputedStyle(s, "::before").animationName);
      assert.equal(anim, "pulse");
      const diff = { path: "src/a.ts", added: 2, removed: 1, lines: [[" ", "a"], ["-", "b"], ["+", "B"], ["+", "c"]] };
      await emit([{ t: "result", sid: "s1", body: "Wrote src/a.ts", ms: 12, diff }]);
      await settle();
      const w = log().locator("details.tool").last();
      assert.equal(await w.evaluate((d) => d.classList.contains("running")), false);
      assert.equal(await w.locator(".diffstat").textContent(), "+2−1");
      assert.equal(await w.evaluate((d) => d.open), true, "a short diff opens");
      assert.equal(await w.locator(".dl.add").count(), 2);
      assert.equal(await w.locator(".dl.del").count(), 1);
      const long = { path: "b.ts", added: 60, removed: 0, lines: Array.from({ length: 60 }, (_, i) => ["+", "line " + i]) };
      await emit([{ t: "tool", sid: "s1", name: "write_file", summary: "b.ts" }, { t: "result", sid: "s1", body: "Wrote b.ts", diff: long }]);
      await settle();
      const lw = log().locator("details.tool").last();
      assert.equal(await lw.evaluate((d) => d.open), false, "a long diff stays collapsed");
      assert.equal(await lw.locator(".diff").count(), 0, "and its body is not built until opened");
      await lw.locator("summary").click();
      await settle();
      assert.equal(await lw.locator(".dl.add").count(), 60, "filled on first expand");

      await emit([
        { t: "tool", sid: "s1", name: "read_file", summary: "a" }, { t: "result", sid: "s1", body: "x" },
        { t: "thinking", sid: "s1", s: "hmm" },
        { t: "tool", sid: "s1", name: "read_file", summary: "b" }, { t: "result", sid: "s1", body: "x" },
        { t: "tool", sid: "s1", name: "search", summary: "\"foo\"" }, { t: "result", sid: "s1", body: "x" },
        { t: "tool", sid: "s1", name: "read_file", summary: "c" }, { t: "result", sid: "s1", body: "x" },
        { t: "tool", sid: "s1", name: "search", summary: "\"bar\"" },
      ]);
      await settle();
      const g = log().locator("details.tool.explore").last();
      assert.equal(await g.locator(":scope > summary .tool-args").textContent(), "3 reads, 2 searches");
      assert.equal(await g.evaluate((d) => d.classList.contains("running")), true, "the group pulses while a lookup runs");
      assert.equal(await g.locator(".group-body > details.thought").count(), 1, "a thought between lookups stays inside, in order");
      await emit([{ t: "result", sid: "s1", body: "x" }, { t: "turnend", sid: "s1", label: "done" }]);
      await settle();
      assert.equal(await g.evaluate((d) => d.classList.contains("running")), false);
      const body = g.locator(".group-body > details.tool").first();
      assert.equal(await body.locator("pre").count(), 0, "result bodies fill in lazily");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await emit([{ t: "tool", sid: "s1", name: "run_command", summary: "sleep" }]);
      await settle();
      assert.equal(await log().locator("details.tool").last().locator("summary").evaluate((s) => getComputedStyle(s, "::before").animationName), "none", "no pulse with reduced motion");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await emit([{ t: "result", sid: "s1", body: "ok" }, { t: "turnend", sid: "s1", label: "done" }]);
    });

    await t.test("status-bar picker: anchored popover, fuzzy filter, keys, groups, stars", async () => {
      await page.locator("#status [data-via=models]").click();
      assert.deepEqual(lastPost("/msg").body, { sid: "s1", text: "/models", via: "models" });
      replies["/select/star"] = (b) => ({ options: [{ label: "qwen3:27b", group: "Favorites", starred: b.index === 0 }, { label: "llama3:8b", group: "localhost", current: true }, { label: "gemma3:12b", group: "localhost" }] });
      await emit([{ t: "select", sid: "s1", id: 7, title: "Select model", via: "models", star: true, options: [
        { label: "qwen3:27b", group: "localhost" }, { label: "llama3:8b", group: "localhost", current: true }, { label: "gemma3:12b", group: "localhost" }] }]);
      await settle();
      const pop = page.locator(".chooser.popover");
      assert.equal(await pop.count(), 1, "a status-bar select is a popover");
      assert.equal(await log().locator(".ask").count(), 0, "not a box in the transcript");
      const box = await pop.boundingBox(), btn = await page.locator("#status [data-via=models]").boundingBox();
      assert.ok(box.y + box.height <= btn.y + 1, "anchored above its button");
      assert.equal(await pop.locator(".chooser-row.sel .chooser-label").textContent(), "● llama3:8b", "starts on the current row");
      assert.equal(await pop.locator(".chooser-group").count(), 1);
      await pop.locator(".chooser-row").first().locator(".star").click();
      await settle();
      assert.deepEqual(lastPost("/select/star").body, { sid: "s1", id: 7, index: 0 });
      assert.equal(await pop.locator(".star.on").count(), 1, "the row is starred");
      assert.equal(await pop.locator(".chooser-group").first().textContent(), "Favorites");
      await page.keyboard.type("gma");
      assert.equal(await pop.locator(".chooser-row").count(), 1, "fuzzy filter");
      await page.keyboard.press("Enter");
      assert.deepEqual(lastPost("/select").body, { sid: "s1", id: 7, index: 2 });
      assert.equal(await pop.count(), 0);
      await emit([{ t: "answered", sid: "s1", id: 7 }]);
      // Esc cancels a popover and never cancels the turn.
      await emit([{ t: "select", sid: "s1", id: 8, title: "Select mode", via: "mode", options: [{ label: "ro" }, { label: "edit", current: true }] }]);
      await settle();
      await page.keyboard.press("Escape");
      assert.deepEqual(lastPost("/select").body, { sid: "s1", id: 8, index: null });
      assert.equal(posts.filter((p) => p.path === "/cancel").length, 0);
      // An agent-initiated select stays in the transcript, with groups and stars.
      await emit([{ t: "answered", sid: "s1", id: 8 }, { t: "select", sid: "s1", id: 9, title: "Agent asks", options: [{ label: "a", group: "G", starred: true }, { label: "b" }] }]);
      await settle();
      assert.equal(await page.locator(".chooser.popover").count(), 0);
      assert.equal(await log().locator(".ask .ask-group").textContent(), "G");
      await log().locator(".ask .opt").first().click();
      assert.deepEqual(lastPost("/select").body, { sid: "s1", id: 9, index: 0 });
    });

    await t.test("composer: slash args, @ files, Esc keeps the draft, IME Enter, growth", async () => {
      const input = page.locator("#input");
      await input.click();
      await input.fill("/eff");
      assert.match(await page.locator("#menu").textContent(), /\/effort/);
      await page.keyboard.press("Enter");
      await settle();
      assert.equal(await input.inputValue(), "/effort ", "a command with args inserts its name");
      assert.deepEqual(lastPost("/command/args").body, { sid: "s1", name: "effort" });
      assert.match(await page.locator("#menu").textContent(), /high/);
      await page.keyboard.type("hi");
      await page.keyboard.press("Enter");
      assert.deepEqual(lastPost("/msg").body, { sid: "s1", text: "/effort high", attachments: [] });

      await input.fill("look at @cli");
      await settle();
      assert.match(await page.locator("#menu").textContent(), /src\/cli\.ts/);
      await page.keyboard.press("Enter");
      assert.equal(await input.inputValue(), "look at src/cli.ts ", "only the path is inserted");

      await input.fill("/he");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#menu").evaluate((m) => m.style.display), "none", "Esc closes the menu");
      assert.equal(await input.inputValue(), "/he", "and keeps the draft");
      await page.keyboard.press("Escape");
      assert.equal(await input.inputValue(), "/he", "Esc never clears the draft");
      assert.equal(posts.filter((p) => p.path === "/cancel").length, 0, "nothing to cancel when idle");

      await input.fill("composing");
      const n = posts.length;
      await input.evaluate((i) => i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
      await input.evaluate((i) => i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true })));
      assert.equal(posts.length, n, "Enter during IME composition does not send");

      const h1 = await input.evaluate((i) => i.offsetHeight);
      await input.fill("a\nb\nc\nd\ne\nf\ng");
      const h2 = await input.evaluate((i) => i.offsetHeight);
      assert.ok(h2 > h1, "the textarea grows with its content");
      await input.fill("");
    });

    await t.test("history, drafts, queue chips and toasts", async () => {
      const input = page.locator("#input");
      await input.fill("my earlier prompt");
      await page.keyboard.press("Enter");
      await settle();
      assert.equal(await input.inputValue(), "");
      await page.keyboard.press("ArrowUp");
      assert.equal(await input.inputValue(), "my earlier prompt", "↑ recalls the last prompt");
      await page.keyboard.press("ArrowDown");
      assert.equal(await input.inputValue(), "");

      await input.fill("half-typed idea");
      await page.locator(".sess").filter({ hasText: "Second session" }).click();
      assert.equal(await input.inputValue(), "");
      await page.locator(".sess").filter({ hasText: "First session" }).click();
      assert.equal(await input.inputValue(), "half-typed idea", "drafts are per session");
      await settle(400);
      assert.equal(await page.evaluate(() => localStorage.getItem("smol.draft.s1")), "half-typed idea", "and survive a reload");
      await input.fill("");

      await emit([{ t: "busy", sid: "s1", label: "thinking" }]);
      await input.fill("send me later");
      await page.keyboard.press("Enter");
      assert.match(await page.locator("#queuerow").textContent(), /send me later/, "a message sent while busy shows at once");
      await emit([state("s1", { busy: "thinking", queued: [{ id: 4, text: "send me later" }] })]);
      await page.locator("#queuerow .qchip button").click();
      assert.deepEqual(lastPost("/queue/remove").body, { sid: "s1", id: 4 });
      await emit([state("s1", { busy: null, queued: [] }), { t: "busy", sid: "s1", label: null }]);
      assert.equal(await page.locator("#queuerow").isHidden(), true);

      replies["/msg"] = { error: "an attachment is no longer available — add it again" };
      await input.fill("this fails");
      await page.keyboard.press("Enter");
      await settle();
      assert.match(await page.locator("#toasts").textContent(), /no longer available/, "errors show as toasts");
      delete replies["/msg"];
      assert.deepEqual(dialogs, [], "no blocking dialogs");
    });

    await t.test("ctrl+k palette: commands, sessions, actions", async () => {
      await page.keyboard.press("Control+k");
      const pal = page.locator(".chooser.palette");
      assert.equal(await pal.count(), 1);
      assert.ok(await pal.locator(".chooser-group").filter({ hasText: "Sessions" }).count());
      assert.ok(await pal.locator(".chooser-key").filter({ hasText: "?" }).count(), "keys are shown");
      await page.keyboard.type("second");
      await page.keyboard.press("Enter");
      assert.equal(await pal.count(), 0);
      assert.equal(await page.locator(".sess.active .stitle").textContent(), "Second session");
      await page.keyboard.press("Control+k");
      await page.keyboard.type("notif");
      assert.match(await pal.locator(".chooser-row.sel").textContent(), /Desktop notifications: off/);
      await page.keyboard.press("Enter");
      await settle();
      assert.equal(await page.evaluate(() => localStorage.getItem("smol.notify")), "1");
      await page.keyboard.press("Control+k");
      await page.keyboard.press("Escape");
      assert.equal(await pal.count(), 0);
    });

    await t.test("notifications: live events in a session you are not looking at; clicking focuses it", async () => {
      await emit([{ t: "confirm", sid: "s1", id: 20, command: "rm -rf build" }, { t: "turnend", sid: "s2", label: "done" }]);
      const notes = await page.evaluate(() => window.__notes.map((n) => n.title));
      assert.deepEqual(notes, ["Approval needed · First session"], "only for the session not in view");
      await page.evaluate(() => window.__notes[0].onclick());
      assert.equal(await page.locator(".sess.active .stitle").textContent(), "First session");
      await emit([{ t: "reset" }, HUB, state("s1"), { t: "turnend", sid: "s2", label: "old" }, { t: "synced" }]);
      assert.equal(await page.evaluate(() => window.__notes.length), 1, "a replay never notifies");
    });

    await t.test("SSE resume keeps the DOM; a reset rebuilds it", async () => {
      await emit([{ t: "tool", sid: "s1", name: "run_command", summary: "ls" }, { t: "result", sid: "s1", body: "a\nb" }]);
      const d = log().locator("details.tool").last();
      await d.locator("summary").click();
      await d.evaluate((x) => { x._keep = 1; });
      // A clean resume: missed events arrive, no reset.
      await emit([HUB, { t: "line", sid: "s1", kind: "status", s: "missed while away" }, { t: "synced", resumed: true }]);
      assert.equal(await d.evaluate((x) => x._keep + ":" + x.open), "1:true", "open disclosures survive");
      await emit([{ t: "reset" }, HUB, state("s1"), { t: "line", sid: "s1", kind: "status", s: "replayed" }, { t: "synced" }]);
      assert.equal(await log().locator("details.tool").count(), 0, "a reset starts the view over");
      assert.deepEqual(errors, [], "browser errors");
    });
  } finally {
    await browser.close();
  }
});
