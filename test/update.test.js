// The update notifier and the one-step updater: version compare, the
// 12-hour cache, the opt-out, install detection from fake paths, the command
// per package manager, the update runner (fake and real child processes),
// the restart helpers, a fake registry over HTTP, and both UIs: the TUI
// through the VT emulator, the web hub over HTTP including "Restart server".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");

// A scratch config file: the opt-out is saved there (never the real one).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "smol-update-"));
process.env.SMOLCODER_CONFIG = path.join(scratch, "config.json");

const U = require("../dist/update");
const { BUILTIN_COMMANDS, findCommand } = require("../dist/commands");
const { makeTui, sleep } = require("./tui-harness");
const { watchForUpdates, runUpdateFlow } = require("../dist/tui/updater");
const { WebHub } = require("../dist/web/hub");

function tmpdir(p) {
  return fs.mkdtempSync(path.join(scratch, p));
}
async function until(fn, ms = 4000, label = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + label);
    await sleep(20);
  }
}

/** A registry that announces `version` at /smolcoder/latest. */
function fakeRegistry(version) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/smolcoder/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "smolcoder", version }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() }))
  );
}

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// ---- versions -------------------------------------------------------------------

test("versions: semver precedence, prereleases and junk", () => {
  const cmp = U.compareVersions;
  assert.ok(cmp("0.9.1", "0.9.0") > 0);
  assert.ok(cmp("0.10.0", "0.9.9") > 0, "numeric, not string, compare");
  assert.ok(cmp("1.0.0", "0.99.99") > 0);
  assert.equal(cmp("v1.2.3", "1.2.3"), 0);
  assert.equal(cmp("1.2.3+build.5", "1.2.3"), 0, "build metadata is ignored");
  assert.ok(cmp("1.0.0-beta.1", "1.0.0") < 0, "a prerelease comes before its release");
  assert.ok(cmp("1.0.0-alpha", "1.0.0-alpha.1") < 0);
  assert.ok(cmp("1.0.0-alpha.1", "1.0.0-alpha.beta") < 0, "numeric identifiers sort first");
  assert.ok(cmp("1.0.0-beta.2", "1.0.0-beta.11") < 0);
  assert.ok(cmp("1.0.0-rc.1", "1.0.0-beta.11") > 0);
  assert.equal(cmp("nonsense", "1.0.0"), 0);
  assert.equal(U.parseVersion("1.2"), null);
});

test("versions: prereleases are only offered to prerelease users", () => {
  assert.equal(U.isNewer("0.9.1", "0.9.0"), true);
  assert.equal(U.isNewer("0.9.0", "0.9.0"), false);
  assert.equal(U.isNewer("0.8.9", "0.9.0"), false);
  assert.equal(U.isNewer("1.0.0-beta.1", "0.9.0"), false, "a stable user is not offered a beta");
  assert.equal(U.isNewer("1.0.0-beta.2", "1.0.0-beta.1"), true, "a beta user is");
  assert.equal(U.isNewer("1.0.0", "1.0.0-beta.1"), true);
  assert.equal(U.isNewer("garbage", "0.9.0"), false);
});

// ---- the check and its cache -------------------------------------------------------

test("check: cached for 12 hours, forced by /update, failures fall back silently", async () => {
  const dataDir = tmpdir("cache-");
  let calls = 0;
  let answer = "0.9.1";
  const fetchLatest = async () => {
    calls++;
    return answer;
  };
  const t0 = 1_000_000_000_000;
  const a = await U.checkForUpdate({ dataDir, current: "0.9.0", now: t0, fetchLatest });
  assert.deepEqual({ latest: a.latest, newer: a.newer, calls }, { latest: "0.9.1", newer: true, calls: 1 });
  assert.equal(U.readUpdateCache(dataDir).checkedAt, t0, "the answer and its time are cached in the data folder");
  assert.ok(fs.existsSync(path.join(dataDir, "update-check.json")));

  answer = "0.9.2";
  const b = await U.checkForUpdate({ dataDir, current: "0.9.0", now: t0 + 11 * 3600_000, fetchLatest });
  assert.equal(calls, 1, "within 12 hours the registry is not asked again");
  assert.equal(b.latest, "0.9.1");

  const c = await U.checkForUpdate({ dataDir, current: "0.9.0", now: t0 + 12 * 3600_000 + 1, fetchLatest });
  assert.equal(calls, 2, "after 12 hours it is");
  assert.equal(c.latest, "0.9.2");

  await U.checkForUpdate({ dataDir, current: "0.9.0", now: t0 + 12 * 3600_000 + 2, fetchLatest, force: true });
  assert.equal(calls, 3, "force skips the cache");

  // Offline: the last answer still counts; with no answer at all, null.
  const offline = async () => null;
  const d = await U.checkForUpdate({ dataDir, current: "0.9.2", now: t0 + 48 * 3600_000, fetchLatest: offline });
  assert.deepEqual({ latest: d.latest, newer: d.newer }, { latest: "0.9.2", newer: false });
  assert.equal(await U.checkForUpdate({ dataDir: tmpdir("empty-"), fetchLatest: async () => { throw new Error("boom"); } }), null);

  assert.equal(U.cacheFresh({ checkedAt: t0 + 5000, latest: "1.0.0" }, t0), false, "a cache time in the future is not trusted");
});

test("check: a fake registry over HTTP via SMOLCODER_REGISTRY, 3s timeout, junk ignored", async () => {
  const reg = await fakeRegistry("0.9.1");
  try {
    const env = { SMOLCODER_REGISTRY: reg.url + "/" };
    assert.equal(U.registryBase(env), reg.url);
    assert.equal(await U.fetchLatestVersion(env), "0.9.1");
    const info = await U.checkForUpdate({ dataDir: tmpdir("reg-"), current: "0.9.0", env });
    assert.equal(info.newer, true);
    assert.deepEqual(reg.hits, ["/smolcoder/latest", "/smolcoder/latest"]);
  } finally {
    reg.close();
  }
  assert.equal(U.registryBase({}), "https://registry.npmjs.org");
  assert.equal(U.CHECK_TIMEOUT_MS, 3000);
  // Nothing listening: null, quickly.
  const t0 = Date.now();
  assert.equal(await U.fetchLatestVersion({ SMOLCODER_REGISTRY: "http://127.0.0.1:9" }, 500), null);
  assert.ok(Date.now() - t0 < 3000);
});

test("opt-out: updateCheck false, CI and NO_UPDATE_NOTIFIER stop the automatic check", () => {
  assert.equal(U.autoCheckAllowed({}, true), true);
  assert.equal(U.autoCheckAllowed({}, false), false);
  assert.equal(U.autoCheckAllowed({ CI: "true" }, true), false);
  assert.equal(U.autoCheckAllowed({ CI: "1" }, true), false);
  assert.equal(U.autoCheckAllowed({ CI: "false" }, true), true);
  assert.equal(U.autoCheckAllowed({ NO_UPDATE_NOTIFIER: "1" }, true), false);
  assert.equal(U.updateChecksSetting(), true, "on by default");
  U.setUpdateChecks(false);
  assert.equal(JSON.parse(fs.readFileSync(process.env.SMOLCODER_CONFIG, "utf8")).updateCheck, false);
  assert.equal(U.updateChecksSetting(), false);
  assert.equal(U.autoCheckAllowed({}), false);
  U.setUpdateChecks(true);
  assert.equal(U.updateChecksSetting(), true);
});

test("commands: /update and /update-check are in the registry (palettes, /help)", () => {
  const upd = findCommand("update", BUILTIN_COMMANDS);
  assert.ok(upd && !upd.args, "/update runs straight away");
  assert.equal(findCommand("upgrade", BUILTIN_COMMANDS).name, "update");
  const chk = findCommand("update-check", BUILTIN_COMMANDS);
  assert.deepEqual(chk.args().map((o) => o.label), ["on", "off"]);
  const { updateCheckArgs } = require("../dist/commands");
  assert.deepEqual(updateCheckArgs(false).map((o) => !!o.current), [false, true]);
});

test("session: /update goes to the host, /update-check on|off saves the setting; nothing reaches the model", async () => {
  const { Session } = require("../dist/session");
  const inputs = ["/update", "/update-check off", "/upgrade", "/update-check", "/exit"];
  const lines = [];
  const ui = {
    slashCommands: [], getStatus: () => "", hintLeft: "", onModeCycle: null, onCancel: null, onExit: null,
    start() {}, close() {}, refresh() {},
    async readInput() { return inputs.shift() ?? "/exit"; },
    async select() { return null; }, async prompt() { return null; },
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, turnEnd() {}, planUpdated() {}, resetResponse() {},
    println(s) { lines.push(String(s)); }, status(s) { lines.push(String(s)); }, warn(s) { lines.push(String(s)); }, error(s) { lines.push(String(s)); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "no"; },
  };
  const session = new Session(ui, {
    workspace: tmpdir("sess-ws-"),
    chosen: { id: "fake:1b", backend: "ollama", baseUrl: "http://127.0.0.1:9", contextWindow: 8192, toolsSupported: true },
    prefs: {}, cfg: {}, dataDir: tmpdir("sess-data-"),
  });
  let runs = 0;
  const notices = [];
  session.updateHost = { run: async () => void runs++, noticesChanged: (on) => notices.push(on) };
  const argsOf = () => session.commandList().find((c) => c.name === "update-check").args();
  assert.equal(argsOf().find((o) => o.current).label, "on");
  await session.run();
  assert.equal(runs, 2, "/update and its alias /upgrade");
  assert.deepEqual(notices, [false, true], "off, then a bare /update-check toggles back on");
  assert.ok(lines.some((l) => /update notices off/.test(l)));
  assert.equal(U.updateChecksSetting(), true);
  assert.equal(session.agent.messages.length, 1, "only the system prompt: no update text in the model's context");
});

// ---- install detection ----------------------------------------------------------------

function existsIn(set) {
  const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
  const s = new Set([...set].map(norm));
  return (p) => s.has(norm(p));
}

test("detect: npm global on Windows and on Unix, at npm's root or another prefix", () => {
  const win = U.detectInstall({
    platform: "win32",
    packageDir: "C:\\Users\\leon\\AppData\\Roaming\\npm\\node_modules\\smolcoder",
    npmRoot: "C:\\Users\\leon\\AppData\\Roaming\\npm\\node_modules",
    exists: () => false,
    env: {},
  });
  assert.equal(win.kind, "npm");
  assert.equal(win.command.display, "npm install -g smolcoder@latest");
  assert.equal(win.manifest, "C:\\Users\\leon\\AppData\\Roaming\\npm\\node_modules\\smolcoder\\package.json");

  const nvm = U.detectInstall({ platform: "linux", packageDir: "/home/a/.nvm/versions/node/v20.1.0/lib/node_modules/smolcoder", npmRoot: "/home/a/.nvm/versions/node/v20.1.0/lib/node_modules", exists: () => false, env: {} });
  assert.equal(nvm.kind, "npm");
  assert.deepEqual(nvm.command.args, ["install", "-g", "smolcoder@latest"]);

  // Not npm's current root, but npm's global layout with its shim: --prefix.
  const other = U.detectInstall({ platform: "linux", packageDir: "/opt/tools/lib/node_modules/smolcoder", npmRoot: "/usr/local/lib/node_modules", exists: existsIn(["/opt/tools/bin/smol"]), env: {} });
  assert.equal(other.kind, "npm");
  assert.equal(other.prefix, "/opt/tools");
  assert.equal(other.command.display, "npm install -g --prefix /opt/tools smolcoder@latest");

  const spaced = U.detectInstall({ platform: "win32", packageDir: "D:\\My Tools\\node_modules\\smolcoder", npmRoot: null, exists: existsIn(["D:\\My Tools\\smol.cmd"]), env: {} });
  assert.equal(spaced.prefix, "D:\\My Tools");
  assert.equal(spaced.command.display, 'npm install -g --prefix "D:\\My Tools" smolcoder@latest', "paths with spaces are quoted");
});

test("detect: pnpm, yarn and bun globals, with their own commands", () => {
  const pnpmWin = U.detectInstall({
    platform: "win32",
    packageDir: "C:\\Users\\leon\\AppData\\Local\\pnpm\\global\\5\\node_modules\\.pnpm\\smolcoder@0.9.0\\node_modules\\smolcoder",
    exists: () => false,
    env: {},
  });
  assert.equal(pnpmWin.kind, "pnpm");
  assert.equal(pnpmWin.command.display, "pnpm add -g smolcoder@latest");
  assert.equal(pnpmWin.manifest, "C:\\Users\\leon\\AppData\\Local\\pnpm\\global\\5\\node_modules\\smolcoder\\package.json", "the version is read through the global link, not the old store folder");

  const pnpmMac = U.detectInstall({ platform: "darwin", packageDir: "/Users/a/Library/pnpm/global/5/node_modules/.pnpm/smolcoder@0.9.0/node_modules/smolcoder", exists: () => false, env: {} });
  assert.equal(pnpmMac.kind, "pnpm");
  // Only the user agent says pnpm (a custom PNPM_HOME).
  const pnpmHint = U.detectInstall({ platform: "linux", packageDir: "/srv/pn/5/node_modules/.pnpm/smolcoder@0.9.0/node_modules/smolcoder", exists: () => false, env: { npm_config_user_agent: "pnpm/9.1.0 npm/? node/v20.11.0 linux x64" } });
  assert.equal(pnpmHint.kind, "pnpm");

  const yarnLinux = U.detectInstall({ platform: "linux", packageDir: "/home/a/.config/yarn/global/node_modules/smolcoder", exists: () => false, env: {} });
  assert.equal(yarnLinux.kind, "yarn");
  assert.equal(yarnLinux.command.display, "yarn global add smolcoder@latest");
  const yarnWin = U.detectInstall({ platform: "win32", packageDir: "C:\\Users\\leon\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\smolcoder", exists: () => false, env: {} });
  assert.equal(yarnWin.kind, "yarn");

  const bun = U.detectInstall({ platform: "linux", packageDir: "/home/a/.bun/install/global/node_modules/smolcoder", exists: () => false, env: {} });
  assert.equal(bun.kind, "bun");
  assert.equal(bun.command.display, "bun add -g smolcoder@latest");
});

test("detect: source checkouts and npx never run anything, and say what to do", () => {
  const src = U.detectInstall({ platform: "linux", packageDir: "/home/a/code/smolcoder", exists: existsIn(["/home/a/code/smolcoder/.git"]), env: {} });
  assert.equal(src.kind, "source");
  assert.equal(src.command, undefined);
  assert.match(src.manual, /^Running from source: git pull && npm run build/);
  assert.equal(src.manualCommand, "git pull && npm run build");
  // npm link: the global folder is a link into a checkout (node resolves it).
  const linked = U.detectInstall({ platform: "win32", packageDir: "C:\\Projects\\smolcoder", npmRoot: "C:\\Users\\leon\\AppData\\Roaming\\npm\\node_modules", exists: existsIn(["C:\\Projects\\smolcoder\\src\\index.ts"]), env: {} });
  assert.equal(linked.kind, "source");

  const npx = U.detectInstall({ platform: "linux", packageDir: "/home/a/.npm/_npx/1a2b3c/node_modules/smolcoder", exists: () => false, env: {} });
  assert.equal(npx.kind, "npx");
  assert.equal(npx.command, undefined);
  assert.equal(npx.manualCommand, "npx smolcoder@latest");
  assert.match(npx.manual, /npx smolcoder@latest/);
  const npxWin = U.detectInstall({ platform: "win32", packageDir: "C:\\Users\\l\\AppData\\Local\\npm-cache\\_npx\\9f\\node_modules\\smolcoder", exists: () => false, env: {} });
  assert.equal(npxWin.kind, "npx");
  assert.equal(U.detectInstall({ platform: "linux", packageDir: "/x/y/node_modules/smolcoder", exists: () => false, env: { npm_command: "exec" } }).kind, "npx");
  assert.equal(U.detectInstall({ platform: "linux", packageDir: "/home/a/.cache/pnpm/dlx/abc/node_modules/smolcoder", exists: () => false, env: {} }).manualCommand, "pnpm dlx smolcoder@latest");

  const dep = U.detectInstall({ platform: "linux", packageDir: "/home/a/app/node_modules/smolcoder", npmRoot: "/usr/lib/node_modules", exists: existsIn(["/home/a/app/package.json"]), env: {} });
  assert.equal(dep.kind, "unknown");
  assert.match(dep.manual, /dependency of \/home\/a\/app/);
  const unknown = U.detectInstall({ platform: "linux", packageDir: "/somewhere/odd", exists: () => false, env: {} });
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.manualCommand, "npm install -g smolcoder@latest");
});

test("detect: this checkout is a source checkout", () => {
  assert.equal(U.detectInstall().kind, "source");
});

// ---- running the update ------------------------------------------------------------------

/** A package folder with a package.json at `version`. */
function fakePackage(version) {
  const dir = path.join(tmpdir("pkg-"), "node_modules", "smolcoder");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "smolcoder", version }));
  fs.writeFileSync(path.join(dir, "dist", "index.js"), "");
  return { dir, manifest: path.join(dir, "package.json") };
}

function npmInfo(pkg) {
  return { kind: "npm", label: "npm · global", packageDir: pkg.dir, manifest: pkg.manifest, command: { file: "npm", args: ["install", "-g", "smolcoder@latest"], display: "npm install -g smolcoder@latest" } };
}

/** A child process stand-in. */
function fakeChild(script) {
  return (c, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.opts = opts;
    setImmediate(() => script(child, opts));
    return child;
  };
}

test("run: streams output, then verifies the installed package.json", async () => {
  const pkg = fakePackage("0.9.0");
  const out = [];
  let seenEnv = null;
  const res = await U.runUpdate(npmInfo(pkg), {
    latest: "0.9.1",
    env: { SMOLCODER_REGISTRY: "http://127.0.0.1:1234", SMOLCODER_WEB_HANDOFF: "{}" },
    writable: () => true,
    onOutput: (s) => out.push(s),
    spawnFn: fakeChild((child, opts) => {
      seenEnv = opts.env;
      child.stdout.emit("data", "added 1 package\n");
      fs.writeFileSync(pkg.manifest, JSON.stringify({ name: "smolcoder", version: "0.9.1" }));
      child.stderr.emit("data", "npm notice\n");
      child.emit("close", 0);
    }),
  });
  assert.deepEqual({ ok: res.ok, version: res.version }, { ok: true, version: "0.9.1" });
  assert.equal(out[0], "$ npm install -g smolcoder@latest\n");
  assert.ok(out.includes("added 1 package\n") && out.includes("npm notice\n"));
  assert.equal(seenEnv.npm_config_registry, "http://127.0.0.1:1234/", "the package manager uses the same registry");
  assert.equal(seenEnv.SMOLCODER_WEB_HANDOFF, undefined, "the hub's key never reaches the package manager");
});

test("run: permission errors give the exact sudo / Administrator command, never run sudo", async () => {
  const pkg = fakePackage("0.9.0");
  let spawned = 0;
  // Linux: a folder npm cannot write is caught before anything runs.
  const pre = await U.runUpdate(npmInfo(pkg), { platform: "linux", writable: () => false, spawnFn: fakeChild(() => spawned++) });
  assert.equal(pre.ok, false);
  assert.equal(pre.permission, true);
  assert.equal(spawned, 0);
  assert.match(pre.message, /\n  sudo npm install -g smolcoder@latest\n/);
  assert.match(pre.message, /npm config set prefix ~\/\.npm-global/);

  // EACCES in the output, as npm prints it.
  const eacces = await U.runUpdate(npmInfo(pkg), {
    platform: "darwin",
    writable: () => true,
    spawnFn: fakeChild((child) => {
      child.stderr.emit("data", "npm error code EACCES\nnpm error syscall rename\n");
      child.emit("close", 243);
    }),
  });
  assert.equal(eacces.permission, true);
  assert.match(eacces.message, /sudo npm install -g smolcoder@latest/);

  // Windows: EPERM (a locked folder) → Administrator terminal advice.
  const eperm = await U.runUpdate(npmInfo(pkg), {
    platform: "win32",
    spawnFn: fakeChild((child) => {
      child.stderr.emit("data", "npm ERR! code EPERM\n");
      child.emit("close", 1);
    }),
  });
  assert.equal(eperm.permission, true);
  assert.match(eperm.message, /Administrator/);
  assert.doesNotMatch(eperm.message, /sudo/);
});

test("run: other failures, an unchanged version and a missing package manager", async () => {
  const pkg = fakePackage("0.9.0");
  const failed = await U.runUpdate(npmInfo(pkg), { writable: () => true, spawnFn: fakeChild((c) => c.emit("close", 1)) });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /exited with code 1\.\nRun it yourself:\n  npm install -g smolcoder@latest/);

  const same = await U.runUpdate(npmInfo(pkg), { latest: "0.9.1", writable: () => true, spawnFn: fakeChild((c) => c.emit("close", 0)) });
  assert.equal(same.ok, false, "exit 0 is not enough: the package.json must say the new version");
  assert.match(same.message, /still says 0\.9\.0/);

  const missing = await U.runUpdate(npmInfo(pkg), {
    writable: () => true,
    spawnFn: fakeChild((c) => c.emit("error", Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }))),
  });
  assert.match(missing.message, /not found on PATH/);

  const manual = await U.runUpdate({ kind: "source", packageDir: pkg.dir, manifest: pkg.manifest, manual: "Running from source: git pull && npm run build" });
  assert.deepEqual({ ok: manual.ok, message: manual.message }, { ok: false, message: "Running from source: git pull && npm run build" });
});

test("run: a real child process stands in for the package manager", async () => {
  const pkg = fakePackage("0.9.0");
  const pm = path.join(tmpdir("pm-"), "fake-pm.js");
  fs.writeFileSync(
    pm,
    [
      "const fs = require('fs');",
      "console.log('resolving smolcoder@latest');",
      "process.stderr.write('npm warn deprecated nothing\\n');",
      "setTimeout(() => {",
      "  fs.writeFileSync(process.argv[2], JSON.stringify({ name: 'smolcoder', version: process.argv[3] }));",
      "  console.log('changed 1 package in 1s');",
      "}, 50);",
    ].join("\n")
  );
  const out = [];
  const res = await U.runUpdate(npmInfo(pkg), {
    latest: "0.9.1",
    writable: () => true,
    onOutput: (s) => out.push(s),
    spawnFn: (c, opts) => spawn(process.execPath, [pm, pkg.manifest, "0.9.1"], opts),
  });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.version, "0.9.1");
  const text = out.join("");
  assert.match(text, /resolving smolcoder@latest/);
  assert.match(text, /changed 1 package/);
});

// ---- restart helpers -------------------------------------------------------------------------

test("restart: same arguments plus --resume <id>, launched with inherited stdio", async () => {
  assert.deepEqual(U.restartArgs(["~/proj", "--mode", "ro"], "ab12cd34"), ["~/proj", "--mode", "ro", "--resume", "ab12cd34"]);
  assert.deepEqual(U.restartArgs(["--resume", "old", "--web", "8080"], null), ["--web", "8080"], "an earlier --resume is dropped");
  assert.deepEqual(U.restartArgs(["--resume", "old"], "new1"), ["--resume", "new1"]);
  assert.deepEqual(U.restartArgs(["~/proj", "-m", "ro"], "s1", "bypass"), ["~/proj", "--mode", "bypass", "--resume", "s1"], "the live mode (after shift+tab) replaces the launch one");

  const pkg = fakePackage("0.9.1");
  assert.equal(U.restartEntry({ manifest: pkg.manifest }), path.join(pkg.dir, "dist", "index.js"));
  assert.equal(U.restartEntry({ manifest: path.join(scratch, "nope", "package.json") }, "fallback.js"), "fallback.js");

  // A real relaunch: the child sees the arguments and the "updated from" marker.
  const dir = tmpdir("relaunch-");
  const entry = path.join(dir, "entry.js");
  const outFile = path.join(dir, "out.json");
  fs.writeFileSync(entry, `require('fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ argv: process.argv.slice(2), from: process.env.SMOLCODER_UPDATED_FROM })); process.exit(7);`);
  const code = await new Promise((resolve) => U.relaunch(entry, ["--resume", "ab12"], { exit: resolve, spawnFn: (f, a, o) => spawn(f, a, { ...o, stdio: "ignore" }) }));
  assert.equal(code, 7, "the parent exits with the child's code");
  const seen = JSON.parse(fs.readFileSync(outFile, "utf8"));
  assert.deepEqual(seen, { argv: ["--resume", "ab12"], from: U.CURRENT_VERSION });
});

// ---- the terminal UI ----------------------------------------------------------------------

test("tui: a fake registry's newer version shows on the home screen, and once as a toast in a session", async () => {
  const reg = await fakeRegistry("0.9.1");
  const t = makeTui({ cols: 100, rows: 32, props: { version: "0.9.0" } });
  try {
    t.tui.readInput();
    const info = await watchForUpdates(t.tui, { current: "0.9.0", dataDir: tmpdir("tui-"), env: { SMOLCODER_REGISTRY: reg.url } });
    assert.equal(info.latest, "0.9.1");
    t.flush();
    assert.ok(t.has("coder v0.9.0"), t.screen());
    assert.ok(t.has("0.9.1 available") && t.has("/update"), "a line under the version on the home screen:\n" + t.screen());
    // In CI the startup check does not happen at all.
    const none = await watchForUpdates(t.tui, { current: "0.9.0", dataDir: tmpdir("tui-"), env: { SMOLCODER_REGISTRY: reg.url, CI: "true" } });
    assert.equal(none, null);
  } finally {
    t.close();
    reg.close();
  }

  const s = makeTui({ cols: 100, rows: 32, props: { version: "0.9.0" } });
  try {
    const p = s.tui.readInput();
    s.keys("hello\r");
    await p;
    s.tui.turnEnd("done");
    s.tui.setUpdateAvailable("0.9.1");
    s.flush();
    assert.ok(s.has("smolcoder 0.9.1 is available"), "a toast in a session:\n" + s.screen());
    s.tui["toasts"] = [];
    s.tui.setUpdateAvailable("0.9.1");
    s.flush();
    assert.ok(!s.has("is available"), "only once");
  } finally {
    s.close();
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("tui: /update streams the package manager's output, then offers a restart", async () => {
  const t = makeTui({ cols: 100, rows: 34, props: { version: "0.9.0" } });
  const pkg = fakePackage("0.9.0");
  const gate = deferred();
  let restarted = null;
  try {
    const flow = runUpdateFlow(t.tui, {
      current: "0.9.0",
      check: async (force) => ({ current: "0.9.0", latest: "0.9.1", newer: true, checkedAt: Date.now(), force }),
      detect: async () => npmInfo(pkg),
      run: async (info, o) => {
        o.onOutput("$ npm install -g smolcoder@latest\n");
        o.onOutput("changed 1 package in 2s\n");
        await gate.promise;
        return { ok: true, version: "0.9.1", message: "Updated to 0.9.1" };
      },
      restart: (info, version) => {
        restarted = { info, version };
        return new Promise(() => {});
      },
    });
    await until(() => (t.flush(), t.has("Update smolcoder")), 2000, "the panel");
    assert.ok(/0.9.0  (→|->)  0.9.1/.test(t.screen()), t.screen());
    assert.ok(t.has("github.com/leonvanzyl/smolcoder/releases/tag/v0.9.1"), t.screen());
    assert.ok(t.has("npm install -g smolcoder@latest"), "what will run is shown first");
    assert.ok(t.has("Update to 0.9.1") && t.has("Not now"));
    t.keys("\r");
    await until(() => (t.flush(), t.has("changed 1 package in 2s")), 2000, "streamed output");
    assert.ok(t.has("Installing 0.9.1"), t.screen());
    gate.resolve();
    await until(() => (t.flush(), t.has("Updated to 0.9.1")), 2000, "success");
    assert.ok(t.has("Restart now") && t.has("Later"), t.screen());
    assert.ok(t.has("reopens where you left off"), t.screen());
    t.keys("\r");
    await until(() => restarted, 2000, "restart");
    assert.equal(restarted.version, "0.9.1");
    assert.equal(restarted.info.kind, "npm");
    void flow;
  } finally {
    t.close();
  }
});

test("tui: /update says 'Later' leaves a note, source checkouts get the git command, up to date says so", async () => {
  const pkg = fakePackage("0.9.0");
  const newer = async () => ({ current: "0.9.0", latest: "0.9.1", newer: true, checkedAt: Date.now() });
  const later = makeTui({ cols: 100, rows: 34, props: { version: "0.9.0" } });
  try {
    later.tui.readInput();
    const flow = runUpdateFlow(later.tui, { current: "0.9.0", check: newer, detect: async () => npmInfo(pkg), run: async () => ({ ok: true, version: "0.9.1", message: "" }), restart: () => {} });
    await until(() => (later.flush(), later.has("Update to 0.9.1")), 2000, "panel");
    later.keys("\r");
    await until(() => (later.flush(), later.has("Restart now")), 2000, "restart offer");
    later.keys("\x1b");
    await flow;
    later.flush();
    assert.ok(later.has("0.9.1 is installed"), later.screen());
    assert.ok(later.has("0.9.1 installed") && later.has("restart smol to use it"), "the home line says so too:\n" + later.screen());
  } finally {
    later.close();
  }

  const src = makeTui({ cols: 100, rows: 34, props: { version: "0.9.0" } });
  try {
    let ran = false;
    const flow = runUpdateFlow(src.tui, {
      current: "0.9.0",
      check: newer,
      detect: async () => U.detectInstall({ platform: "linux", packageDir: "/home/a/smolcoder", exists: (p) => p.endsWith(".git"), env: {} }),
      run: async () => ((ran = true), { ok: true }),
    });
    await until(() => (src.flush(), src.has("Running from source")), 2000, "source message");
    assert.ok(src.has("git pull && npm run build"), src.screen());
    assert.ok(!src.has("Update to 0.9.1"), "nothing to run");
    src.keys("\x1b");
    await flow;
    assert.equal(ran, false);
  } finally {
    src.close();
  }

  const fail = makeTui({ cols: 100, rows: 34, props: { version: "0.9.0" } });
  try {
    const flow = runUpdateFlow(fail.tui, {
      current: "0.9.0",
      check: newer,
      detect: async () => npmInfo(pkg),
      run: async () => ({ ok: false, permission: true, version: "0.9.0", message: U.permissionMessage(npmInfo(pkg), "linux") }),
    });
    await until(() => (fail.flush(), fail.has("Update to 0.9.1")), 2000, "panel");
    fail.keys("\r");
    await until(() => (fail.flush(), fail.has("sudo npm install -g smolcoder@latest")), 2000, "sudo advice");
    fail.keys("\x1b");
    await flow;
  } finally {
    fail.close();
  }

  const latest = makeTui({ cols: 100, rows: 34, props: { version: "0.9.1" } });
  try {
    latest.tui.readInput();
    await runUpdateFlow(latest.tui, { current: "0.9.1", check: async () => ({ current: "0.9.1", latest: "0.9.1", newer: false, checkedAt: 1 }) });
    latest.flush();
    assert.ok(latest.has("smolcoder 0.9.1 is the latest version"), latest.screen());
  } finally {
    latest.close();
  }
});

// ---- the web hub ----------------------------------------------------------------------------

function fakeFactory() {
  return async (ui, workspace) => {
    const session = {
      chosen: { id: "fake-model", backend: "ollama" },
      workspace,
      onExit: null,
      updateHost: null,
      taskManager: { killAll() {}, runningSummary: () => [], recentUrls: () => [] },
      state: () => ({ mode: "edit", model: "fake-model", backend: "ollama", workspace, commands: [] }),
      announce() {},
      restore(s) { session.restored = s; },
      snapshot: () => ({ messages: [{ role: "user", content: "x" }], plan: [], filesTouched: [], commandsRun: [], originalRequest: "x", currentRequest: "x", mode: "edit", effort: null, model: "fake-model", backend: "ollama" }),
      async suggestTitle() { return null; },
      async run() {
        for (;;) {
          const input = await ui.readInput();
          if (input === "/exit") { ui.close(); session.onExit && session.onExit(); return; }
          if (input === "/update") { await session.updateHost.run(); continue; }
          ui.token("echo: " + input);
          ui.turnEnd("done");
        }
      },
    };
    return session;
  };
}

function request(port, p, k, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: `${p}${p.includes("?") ? "&" : "?"}k=${k}`, method: data ? "POST" : "GET", headers: data ? { "content-type": "application/json" } : {} }, (res) => {
      let s = "";
      res.on("data", (d) => (s += d));
      res.on("end", () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Read SSE events until `pred` matches one (or the timeout). */
function sseUntil(port, k, pred, ms = 4000) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const req = http.get({ host: "127.0.0.1", port, path: `/events?k=${k}` }, (res) => {
      let buf = "";
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          seen.push(ev);
          if (pred(ev)) {
            req.destroy();
            resolve({ ev, seen });
          }
        }
      });
    });
    req.on("error", () => {});
    setTimeout(() => {
      req.destroy();
      reject(new Error("no matching event; saw " + seen.map((e) => e.t).join(",")));
    }, ms);
  });
}

test("web: the hub checks a fake registry, runs the updater, then restarts on the same port and key", async () => {
  const reg = await fakeRegistry("0.9.1");
  const dataDir = tmpdir("hub-");
  const ws = tmpdir("ws-");
  const pkg = fakePackage("0.9.0");
  const gate = deferred();
  let handoff = null;
  const hub = new WebHub({
    port: 0,
    prefs: {},
    help: "",
    version: "0.9.0",
    dataDir,
    quiet: true,
    factory: fakeFactory(),
    updates: {
      auto: true,
      env: { SMOLCODER_REGISTRY: reg.url },
      detect: async () => npmInfo(pkg),
      run: async (info, o) => {
        o.onOutput("$ npm install -g smolcoder@latest\n");
        o.onOutput("changed 1 package in 1s\n");
        await gate.promise;
        fs.writeFileSync(pkg.manifest, JSON.stringify({ name: "smolcoder", version: "0.9.1" }));
        return { ok: true, version: "0.9.1", message: "Updated to 0.9.1" };
      },
    },
    onRestart: (h) => (handoff = h),
  });
  let next = null;
  try {
    await hub.start();
    const k = hub.authToken;
    await until(() => hub.updateState().latest === "0.9.1", 3000, "the startup check");
    const st = hub.updateState();
    assert.deepEqual({ current: st.current, newer: st.newer, enabled: st.enabled, url: st.url, canRestart: st.canRestart }, {
      current: "0.9.0", newer: true, enabled: true, url: "https://github.com/leonvanzyl/smolcoder/releases/tag/v0.9.1", canRestart: true,
    });
    // The sidebar snapshot carries it to the page.
    const first = await sseUntil(hub.port, k, (e) => e.t === "hub");
    assert.equal(first.ev.update.latest, "0.9.1");

    // A session; /update typed in it opens the page's popover.
    const id = (await request(hub.port, "/sessions/new", k, { workspace: ws })).body.id;
    await until(() => hub.snapshot().workspaces.some((w) => w.sessions.some((s) => s.id === id && s.status === "idle")), 3000, "session ready");
    await request(hub.port, "/msg", k, { sid: id, text: "hello there" });
    const opened = sseUntil(hub.port, k, (e) => e.t === "update_open");
    await sleep(50);
    await request(hub.port, "/msg", k, { sid: id, text: "/update" });
    await opened;

    // Run: the output streams into the snapshot's log.
    await request(hub.port, "/update/run", k, {});
    await until(() => hub.updateState().phase === "running" && /changed 1 package/.test(hub.updateState().log), 2000, "streamed log");
    gate.resolve();
    await until(() => hub.updateState().phase === "done", 2000, "done");
    assert.equal(hub.updateState().installed, "0.9.1");

    // The opt-out is reachable from the page.
    const off = await request(hub.port, "/update/notices", k, { on: false });
    assert.equal(off.body.enabled, false);
    assert.equal(JSON.parse(fs.readFileSync(process.env.SMOLCODER_CONFIG, "utf8")).updateCheck, false);
    await request(hub.port, "/update/notices", k, { on: true });

    // Restart: saved, stopped, handed over with the same key and port.
    const port = hub.port;
    await request(hub.port, "/update/restart", k, {});
    await until(() => handoff, 2000, "handoff");
    assert.equal(handoff.token, k);
    assert.equal(handoff.port, port);
    assert.equal(handoff.from, "0.9.0");
    assert.equal(handoff.entry, path.join(pkg.dir, "dist", "index.js"), "the updated copy's entry point");
    assert.deepEqual(handoff.sessions, [{ id }]);
    await assert.rejects(request(port, "/ping", k), "the old hub let go of the port");

    // The successor: same port, same key, the session is back.
    next = new WebHub({ port: handoff.port, token: handoff.token, prefs: {}, help: "", version: "0.9.1", dataDir, quiet: true, factory: fakeFactory() });
    await next.start();
    next.restoreSessions(handoff.sessions);
    const ping = await request(port, "/ping", k);
    assert.deepEqual({ status: ping.status, version: ping.body.version }, { status: 200, version: "0.9.1" });
    await until(() => next.snapshot().workspaces.some((w) => w.sessions.some((s) => s.id === id && s.live)), 3000, "the session reopened");
    // A page coming back resets and replays: the transcript is there.
    const replay = await sseUntil(port, k, (e) => e.t === "synced");
    assert.ok(replay.seen.some((e) => e.t === "reset"));
    assert.ok(replay.seen.some((e) => e.sid === id && e.t === "user" && e.s === "hello there"), "the session's transcript replays");
  } finally {
    hub.close();
    next?.close();
    reg.close();
  }
});

test("web: a hub that cannot restart says so; a checkout run reports the manual command", async () => {
  const dataDir = tmpdir("hub2-");
  const hub = new WebHub({
    port: 0, prefs: {}, help: "", version: "0.9.0", dataDir, quiet: true, factory: fakeFactory(),
    updates: {
      check: async () => ({ current: "0.9.0", latest: "0.9.1", newer: true, checkedAt: Date.now() }),
      detect: async () => U.detectInstall({ platform: "linux", packageDir: "/home/a/smolcoder", exists: (p) => p.endsWith(".git"), env: {} }),
    },
  });
  try {
    await hub.start();
    const k = hub.authToken;
    assert.equal(hub.updateState().latest, null, "no automatic check unless the CLI asks for one");
    const st = (await request(hub.port, "/update/check", k, {})).body;
    assert.equal(st.newer, true);
    assert.equal(st.canRestart, false);
    await request(hub.port, "/update/run", k, {});
    await until(() => hub.updateState().phase === "manual", 2000, "manual");
    assert.equal(hub.updateState().install.manualCommand, "git pull && npm run build");
    const r = await request(hub.port, "/update/restart", k, {});
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cannot restart itself/);
  } finally {
    hub.close();
  }
});
