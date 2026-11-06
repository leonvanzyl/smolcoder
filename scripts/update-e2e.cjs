#!/usr/bin/env node
// End-to-end check of /update, in temporary npm prefixes only (the real
// global install is never touched). Needs npm; part A also needs the
// network. Not part of `npm test`.
//
//   npm run build && node scripts/update-e2e.cjs
//
// A. The real registry: smolcoder@0.8.1 is installed into a temp prefix and
//    this build's updater (install detection + runUpdate) upgrades that copy
//    with the real `npm install -g --prefix <tmp> smolcoder@latest`.
// B. This build, end to end through the web UI: `npm pack` it as 0.9.0 and
//    a copy as 0.9.1, serve both from a fake registry, install 0.9.0 into a
//    temp prefix, start that copy's `smol --web`, then over HTTP: check,
//    update (while it runs), verify the package.json, "Restart server", and
//    see the successor answer on the same port with the same key as 0.9.1.
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const U = require(path.join(ROOT, "dist", "update"));
const WIN = process.platform === "win32";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "smol-update-e2e-"));
const npmCache = path.join(work, "npm-cache");
const log = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function npm(args, opts = {}) {
  // Windows runs npm.cmd through a shell: one quoted command line.
  const line = ["npm", ...args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))].join(" ");
  const r = spawnSync(WIN ? line : "npm", WIN ? [] : args, { encoding: "utf8", shell: WIN, env: { ...process.env, npm_config_cache: npmCache, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", ...opts.env }, cwd: opts.cwd });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
const pkgDir = (prefix) => (WIN ? path.join(prefix, "node_modules", "smolcoder") : path.join(prefix, "lib", "node_modules", "smolcoder"));
const version = (prefix) => JSON.parse(fs.readFileSync(path.join(pkgDir(prefix), "package.json"), "utf8")).version;

async function partA() {
  log("\nA. real registry: 0.8.1 in a temp prefix → latest");
  const prefix = path.join(work, "prefix-a");
  npm(["install", "-g", "--prefix", prefix, "smolcoder@0.8.1"]);
  assert.equal(version(prefix), "0.8.1");
  const latest = await U.fetchLatestVersion({});
  log(`   installed 0.8.1; the registry says latest is ${latest}`);
  const root = npm(["root", "-g"]);
  const info = U.detectInstall({ packageDir: pkgDir(prefix), npmRoot: root });
  log(`   detected: ${info.kind} · ${info.command && info.command.display}`);
  assert.equal(info.kind, "npm");
  assert.equal(path.resolve(info.prefix), path.resolve(prefix), "a prefix other than npm's own is passed with --prefix");
  const res = await U.runUpdate(info, { latest, env: { ...process.env, npm_config_cache: npmCache }, onOutput: (s) => process.stdout.write("   │ " + s.replace(/\n(?=.)/g, "\n   │ ")) });
  log(`   result: ${res.ok ? "ok" : "FAILED"} · ${res.message.split("\n")[0]}`);
  assert.equal(res.ok, true, res.message);
  assert.equal(version(prefix), latest);
  assert.equal(U.restartEntry(info), path.join(pkgDir(prefix), "dist", "index.js"));
}

/** A copy of this package at another version, packed. */
function packAs(ver, dest) {
  const src = path.join(work, `src-${ver}`);
  fs.mkdirSync(src, { recursive: true });
  for (const f of ["dist", "assets", "README.md", "LICENSE"]) if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(src, f), { recursive: true });
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  pj.version = ver;
  delete pj.scripts;
  delete pj.devDependencies;
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify(pj, null, 2));
  const name = npm(["pack", src, "--pack-destination", dest]).split(/\r?\n/).pop();
  return path.join(dest, name);
}

function registry(tarballs, latest) {
  const meta = (port) => {
    const versions = {};
    for (const [v, file] of Object.entries(tarballs)) {
      const buf = fs.readFileSync(file);
      versions[v] = {
        name: "smolcoder", version: v, bin: { smol: "dist/index.js", smolcoder: "dist/index.js" },
        dist: { tarball: `http://127.0.0.1:${port}/smolcoder/-/smolcoder-${v}.tgz`, shasum: crypto.createHash("sha1").update(buf).digest("hex"), integrity: "sha512-" + crypto.createHash("sha512").update(buf).digest("base64") },
      };
    }
    return { name: "smolcoder", "dist-tags": { latest }, versions };
  };
  const hits = [];
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    hits.push(req.url);
    const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(body); };
    if (req.url === "/smolcoder/latest") return send(200, JSON.stringify(meta(port).versions[latest]));
    if (req.url === "/smolcoder") return send(200, JSON.stringify(meta(port)));
    const m = /^\/smolcoder\/-\/smolcoder-(.+)\.tgz$/.exec(req.url);
    if (m && tarballs[m[1]]) return send(200, fs.readFileSync(tarballs[m[1]]), "application/octet-stream");
    send(404, "{}");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${server.address().port}`, server, hits })));
}

function req(port, p, k, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port, path: `${p}?k=${k}`, method: data ? "POST" : "GET", headers: data ? { "content-type": "application/json" } : {} }, (res) => {
      let s = "";
      res.on("data", (d) => (s += d));
      res.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    r.on("error", reject);
    r.setTimeout(3000, () => r.destroy(new Error("timeout")));
    if (data) r.write(data);
    r.end();
  });
}

async function partB() {
  log("\nB. this build through the web UI: 0.9.0 → 0.9.1 from a fake registry, then Restart server");
  const tgz = path.join(work, "tgz");
  fs.mkdirSync(tgz);
  const tarballs = { "0.9.0": packAs("0.9.0", tgz), "0.9.1": packAs("0.9.1", tgz) };
  const reg = await registry(tarballs, "0.9.1");
  const prefix = path.join(work, "prefix-b");
  npm(["install", "-g", "--prefix", prefix, tarballs["0.9.0"]]);
  assert.equal(version(prefix), "0.9.0");
  const shim = WIN ? path.join(prefix, "smol.cmd") : path.join(prefix, "bin", "smol");
  assert.ok(fs.existsSync(shim), "npm made the smol shim");
  const shimBefore = fs.readFileSync(shim, "utf8");
  log(`   installed 0.9.0 (this build) into ${prefix}`);

  const home = path.join(work, "home");
  fs.mkdirSync(home);
  const port = 17000 + Math.floor(Math.random() * 2000);
  const env = { ...process.env, HOME: home, USERPROFILE: home, SMOLCODER_CONFIG: path.join(home, ".smolcoder.json"), SMOLCODER_REGISTRY: reg.url, npm_config_cache: npmCache, CI: "" };
  delete env.npm_config_prefix;
  const entry = path.join(pkgDir(prefix), "dist", "index.js");
  const hubOut = [];
  const parent = spawn(process.execPath, [entry, "--web", String(port)], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  parent.stdout.on("data", (d) => hubOut.push(String(d)));
  parent.stderr.on("data", (d) => hubOut.push(String(d)));
  let parentExit = null;
  parent.on("exit", (code) => (parentExit = code));
  let successorPid = null;
  try {
    let rec = null;
    for (let i = 0; i < 100 && !rec; i++) {
      await sleep(100);
      try { rec = JSON.parse(fs.readFileSync(path.join(home, ".smolcoder", "web.json"), "utf8")); } catch {}
    }
    assert.ok(rec, "the hub started:\n" + hubOut.join(""));
    const k = rec.token;
    log(`   smol --web is up on ${port} (pid ${rec.pid})`);

    let st = await req(port, "/update/check", k, {});
    assert.deepEqual({ current: st.current, latest: st.latest, newer: st.newer }, { current: "0.9.0", latest: "0.9.1", newer: true });
    log(`   check: ${st.current} → ${st.latest}`);
    await req(port, "/update/run", k, {});
    for (let i = 0; i < 600; i++) {
      await sleep(200);
      st = await req(port, "/update/check", k, {});
      if (st.phase === "done" || st.phase === "failed" || st.phase === "manual") break;
    }
    log(`   install: ${st.install && st.install.label} · ${st.install && st.install.command}`);
    log("   " + st.log.trim().split("\n").join("\n   │ "));
    assert.equal(st.phase, "done", st.message);
    assert.equal(st.installed, "0.9.1");
    assert.equal(version(prefix), "0.9.1", "the copy in the prefix was upgraded while it was running");
    const shimAfter = fs.readFileSync(shim, "utf8");
    if (WIN) assert.match(shimAfter, /goto #_undefined_#/, "the .cmd shim stops reading itself after node exits, so rewriting it under a running smol is safe");
    log(`   the ${path.basename(shim)} shim ${shimAfter === shimBefore ? "is byte-identical after the update" : "was rewritten"}`);

    await req(port, "/update/restart", k, {});
    let ping = null;
    for (let i = 0; i < 100; i++) {
      await sleep(150);
      try { ping = await req(port, "/ping", k); } catch { ping = null; }
      if (ping && ping.version === "0.9.1") break;
    }
    assert.equal(ping && ping.version, "0.9.1", "the successor answers on the same port with the same key:\n" + hubOut.join(""));
    successorPid = ping.pid;
    assert.notEqual(ping.pid, rec.pid);
    assert.equal(parentExit, null, "the old process waits for its successor (it owns the terminal)");
    const rec2 = JSON.parse(fs.readFileSync(path.join(home, ".smolcoder", "web.json"), "utf8"));
    assert.deepEqual({ port: rec2.port, token: rec2.token, pid: rec2.pid }, { port, token: k, pid: ping.pid });
    log(`   restarted: pid ${rec.pid} → ${ping.pid}, v${ping.version}, same port and key`);
    const versionOut = (WIN ? spawnSync(`"${shim}" --version`, { encoding: "utf8", shell: true, env }) : spawnSync(shim, ["--version"], { encoding: "utf8", env })).stdout.trim();
    assert.equal(versionOut, "0.9.1");
    log(`   ${path.basename(shim)} --version → ${versionOut}`);
    // (The tarball itself may come from npm's cache: `npm pack` above put it there.)
    assert.ok(reg.hits.includes("/smolcoder"), "npm resolved smolcoder@latest from the fake registry: " + reg.hits.join(", "));
    log(`   fake registry served: ${[...new Set(reg.hits)].join(", ")}`);
  } finally {
    if (successorPid) try { process.kill(successorPid); } catch {}
    for (let i = 0; i < 50 && parentExit === null; i++) await sleep(100);
    if (parentExit === null) parent.kill();
    log(`   old process exited with ${parentExit} after its successor stopped`);
    reg.server.close();
  }
}

(async () => {
  try {
    if (!process.argv.includes("--skip-a")) await partA();
    await partB();
    log("\nupdate e2e: all passed");
  } catch (err) {
    console.error("\nupdate e2e FAILED:", err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
})();
