// The web page's update UI in a real browser, driven by a fake event stream:
// the "Update available" row above the sidebar footer, its popover (versions,
// What's new, Update, streamed output, Restart server), the reconnect after a
// restart, and the palette's update actions. Skipped unless Playwright can be
// loaded (PLAYWRIGHT_PATH, CHROME_PATH as for the other browser suites).
// UPDATE_SHOTS_DIR=<dir> also writes screenshots, light and dark.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

let chromium = null;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright"));
} catch {
  /* not installed: skipped */
}
const { PAGE_HTML } = require("../dist/web/page");

const UPD = { current: "0.9.0", latest: "0.9.1", newer: true, checkedAt: 1, enabled: true, phase: "idle", message: "", log: "", installed: null, url: "https://github.com/leonvanzyl/smolcoder/releases/tag/v0.9.1", install: null, canRestart: true };
const hubEv = (update, version = "0.9.0") => ({
  t: "hub", home: "/w", version, update,
  workspaces: [{ path: "/w/datekit", name: "datekit", sessions: [
    { id: "s1", title: "Fix ISO week dates", live: true, status: "idle", updatedAt: Date.now() - 60000, terminals: [] },
    { id: "s2", title: "Add a CLI flag for --utc", live: false, status: "stored", updatedAt: Date.now() - 3600000, terminals: [] },
  ] }],
});
const state = { t: "state", sid: "s1", s: { mode: "edit", model: "qwen3-coder-30b", backend: "lmstudio", workspace: "/w/datekit", commands: [
  { name: "models", desc: "Switch model", group: "Model" },
  { name: "update", desc: "Update smolcoder to the latest version, then restart", group: "General" },
  { name: "update-check", desc: "Turn update notices on or off", group: "General", args: true },
], queued: [] } };
const NPM = { kind: "npm", label: "npm · global", command: "npm install -g smolcoder@latest", manualCommand: null, reason: null };
const LOG = "$ npm install -g smolcoder@latest\nnpm warn deprecated inflight@1.0.6: not supported\n\nchanged 1 package in 3s\n\n1 package is looking for funding\n  run `npm fund` for details\n";

test("web update UI in a browser", { skip: chromium ? false : "Playwright not available (set PLAYWRIGHT_PATH)", timeout: 120000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  const shots = process.env.UPDATE_SHOTS_DIR;
  try {
    for (const scheme of shots ? ["light", "dark"] : ["light"]) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 760 }, colorScheme: scheme });
      const page = await context.newPage();
      const errors = [], posts = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        window.EventSource = class { constructor() { window.sessionEvents = this; } };
      });
      await page.route("http://smol.test/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === "POST") {
          posts.push({ path: url.pathname, body: JSON.parse(req.postData() || "{}") });
          return route.fulfill({ contentType: "application/json", body: "{}" });
        }
        if (url.pathname.startsWith("/fonts/")) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({ contentType: "text/html", body: PAGE_HTML });
      });
      await page.goto("http://smol.test/?k=key#s1");
      const emit = (events) => page.evaluate((evs) => { for (const e of evs) window.sessionEvents.onmessage({ data: JSON.stringify(e) }); }, events);
      const settle = (ms = 150) => page.waitForTimeout(ms);
      const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `upd-web-${name}-${scheme}.png`) }); };
      const lastPost = (p) => posts.filter((x) => x.path === p).pop();
      const pill = page.locator("#updpill");
      const pop = page.locator(".upd-pop");

      await emit([{ t: "reset" }, hubEv(UPD), state,
        { t: "user", sid: "s1", s: "The week-date parser is off by a couple of days. Fix it and make sure the tests pass." },
        { t: "token", sid: "s1", s: "Fixed: the weekday offset now counts from Monday and the Thursday rule is applied. All 48 parser tests pass." },
        { t: "turnend", sid: "s1", label: "14.2s · 6 tools" }, { t: "synced" }]);
      await settle();

      await t.test(`${scheme}: the row above the footer says a new version is out`, async () => {
        assert.equal(await pill.isVisible(), true);
        assert.equal(await pill.locator(".sb-updlabel").textContent(), "Update available");
        assert.equal(await pill.locator(".sb-updver").textContent(), "0.9.1");
        assert.equal(await pill.getAttribute("aria-label"), "Update available: 0.9.1");
        assert.equal(await page.locator("#ver").textContent(), "v0.9.0", "next to the version");
        const box = await pill.boundingBox(), foot = await page.locator(".sidefoot").boundingBox();
        assert.ok(box.y + box.height <= foot.y + 1 && foot.y - (box.y + box.height) < 12, "just above the footer");
        await shot("pill");
      });

      await t.test(`${scheme}: notices off hides it`, async () => {
        await emit([hubEv({ ...UPD, enabled: false })]);
        await settle();
        assert.equal(await pill.isVisible(), false);
        await emit([hubEv(UPD)]);
        await settle();
        assert.equal(await pill.isVisible(), true);
      });

      await t.test(`${scheme}: the popover: current → latest, What's new, Update`, async () => {
        await pill.click();
        await settle();
        assert.equal(await pop.isVisible(), true);
        assert.equal(await pop.locator(".upd-title").textContent(), "Update available");
        assert.equal((await pop.locator(".upd-vers").textContent()).replace(/\s+/g, ""), "v0.9.0→v0.9.1");
        const link = pop.locator("a.upd-link");
        assert.equal(await link.getAttribute("href"), "https://github.com/leonvanzyl/smolcoder/releases/tag/v0.9.1");
        assert.equal(await link.getAttribute("target"), "_blank");
        assert.equal(await pop.locator(".upd-opt input").isChecked(), true);
        const pb = await pop.boundingBox(), rb = await pill.boundingBox();
        assert.ok(pb.y + pb.height <= rb.y, "opens above the row");
        await shot("popover");
        await pop.locator("button.primary").click();
        assert.ok(lastPost("/update/run"), "Update asks the hub to run it");
      });

      await t.test(`${scheme}: output streams in while it runs, then Restart server`, async () => {
        await emit([hubEv({ ...UPD, phase: "running", install: NPM, log: LOG.split("\n").slice(0, 4).join("\n") })]);
        await settle();
        assert.equal(await pop.locator(".upd-title").textContent(), "Updating smolcoder");
        assert.match(await pop.locator(".upd-log").textContent(), /npm warn deprecated/);
        assert.match(await pop.locator(".upd-busy").textContent(), /Installing 0\.9\.1/);
        assert.equal(await pill.locator(".sb-updlabel").textContent(), "Updating");
        await shot("running");
        await emit([hubEv({ ...UPD, phase: "done", install: NPM, log: LOG, installed: "0.9.1", message: "Updated to 0.9.1" })]);
        await settle();
        assert.equal(await pop.locator(".upd-title").textContent(), "Update installed");
        assert.equal(await pill.locator(".sb-updlabel").textContent(), "Restart to update");
        assert.equal(await pop.locator("button.primary").textContent(), "Restart server");
        await shot("done");
      });

      await t.test(`${scheme}: Restart server: "Restarting…", then the new server's snapshot`, async () => {
        await pop.locator("button.primary").click();
        await settle();
        assert.ok(lastPost("/update/restart"));
        assert.equal(await pop.locator(".upd-title").textContent(), "Restarting…");
        assert.match(await pop.locator(".upd-busy").textContent(), /reconnects by itself/);
        await emit([hubEv({ ...UPD, phase: "restarting", install: NPM, installed: "0.9.1" })]);
        await page.evaluate(() => window.sessionEvents.onerror && window.sessionEvents.onerror());
        await settle();
        assert.equal(await page.locator("#status").textContent(), "reconnecting…");
        await shot("restarting");
        // The successor: a reset, its snapshot (new version, no update), the replay.
        await emit([{ t: "reset" }, hubEv({ ...UPD, current: "0.9.1", latest: "0.9.1", newer: false, url: null }, "0.9.1"), state,
          { t: "user", sid: "s1", s: "The week-date parser is off by a couple of days. Fix it and make sure the tests pass.", replay: true },
          { t: "synced" }]);
        await settle();
        assert.equal(await pop.count(), 0, "the popover closed");
        assert.equal(await pill.isVisible(), false);
        assert.equal(await page.locator("#ver").textContent(), "v0.9.1");
        assert.match(await page.locator("#toasts").textContent(), /Updated to v0\.9\.1/);
        assert.equal(await page.evaluate(() => location.hash), "#s1", "still on the same session");
        assert.match(await page.locator(".log:not([hidden])").textContent(), /week-date parser/, "its transcript is back");
        await shot("restarted");
      });

      await t.test(`${scheme}: palette actions, manual installs and failures`, async () => {
        await page.keyboard.press("Control+k");
        await settle();
        const labels = await page.locator(".chooser.palette .opt, .chooser.palette [role=option]").allTextContents();
        const text = labels.join("\n");
        assert.match(text, /Check for updates/);
        assert.match(text, /Update notices: on/);
        assert.doesNotMatch(text, /\/update-check/, "the session commands are not listed twice");
        await page.keyboard.type("Update notices");
        await page.keyboard.press("Enter");
        await settle();
        assert.deepEqual(lastPost("/update/notices").body, { on: false });

        await emit([hubEv({ ...UPD, phase: "manual", install: { kind: "source", label: "source checkout", command: null, manualCommand: "git pull && npm run build", reason: "Running from source (in /home/a/smolcoder)" } })]);
        await pill.click();
        await settle();
        assert.match(await pop.textContent(), /Running from source/);
        assert.equal(await pop.locator(".upd-code code").textContent(), "git pull && npm run build");
        await shot("manual");
        await page.keyboard.press("Escape");
        await settle();
        assert.equal(await pop.count(), 0, "esc closes it");

        const sudo = "npm cannot write to /usr/local/lib. Run it yourself with sudo:\n  sudo npm install -g smolcoder@latest\nor give npm a folder you own: npm config set prefix ~/.npm-global (then add ~/.npm-global/bin to PATH)";
        await emit([hubEv({ ...UPD, phase: "failed", install: NPM, log: "$ npm install -g smolcoder@latest\nnpm error code EACCES\n", message: sudo })]);
        await pill.click();
        await settle();
        assert.equal(await pop.locator(".upd-title").textContent(), "Update failed");
        assert.equal(await pop.locator(".upd-code code").textContent(), "sudo npm install -g smolcoder@latest");
        await shot("failed");
      });

      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
