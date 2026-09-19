// Command containment for edit mode: which commands run without asking, and
// which reach outside the workspace and go to the y/n prompt.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { commandEscapesWorkspace } = require("../dist/sandbox");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tc-sandbox-"));
fs.mkdirSync(path.join(ws, "src"));
const isWin = process.platform === "win32";

const inside = (cmd) => assert.equal(commandEscapesWorkspace(cmd, ws), null, `should run freely: ${cmd}`);
const outside = (cmd, why) => {
  const r = commandEscapesWorkspace(cmd, ws);
  assert.ok(r, `should be flagged: ${cmd}`);
  if (why) assert.match(r, why);
};

test("in-tree commands run without asking", () => {
  inside("npm install");
  inside("npm install lodash --save-dev");
  inside("node src/app.js");
  inside("node scripts/a.mjs && node scripts/b.mjs");
  inside("npm test | tail -n 20");
  inside("git status && git diff --stat");
  inside("mkdir -p .scratch && cat > .scratch/probe.mjs <<'EOF'\nconsole.log(1)\nEOF\nnode .scratch/probe.mjs");
  inside("python -m pytest tests/ -k 'foo' -v");
  inside("curl https://example.com/api");
  inside("cp src/a.js src/../src/b.js");
  if (isWin) inside("taskkill /pid 123 /f && dir /s"); // switches, not paths
});

test("absolute paths inside the workspace are fine", () => {
  inside(`node ${path.join(ws, "src", "app.js")}`);
  inside(`cd ${ws} && npm test`);
  if (isWin) {
    const msys = "/" + ws[0].toLowerCase() + ws.slice(2).replace(/\\/g, "/");
    inside(`node ${msys}/src/app.js`);
  }
});

test("paths outside the workspace are flagged", () => {
  outside("node /tmp/hdist.mjs && node /tmp/wtest.mjs", /outside/);
  outside("cat > /tmp/x.mjs <<'EOF'\nfoo\nEOF", /outside/);
  outside(`cp src/a.js ${path.join(os.tmpdir(), "a.js")}`, /outside/);
  outside("cat ../secrets.env", /above/);
  outside("cd .. && ls", /above/);
  outside("ls src/../../other", /above/);
  outside("cat ~/.ssh/id_rsa", /home/);
  outside("ls $HOME/x", /home/);
  outside("echo hi > $TMPDIR/x", /temp/);
  outside("--out=/etc/passwd", /outside/);
  if (isWin) {
    outside("type C:\\Windows\\win.ini", /outside/);
    outside("dir %TEMP%", /temp/);
    outside("dir %USERPROFILE%\\Desktop", /home/);
  } else {
    outside("cat /etc/hosts", /outside/);
  }
});

// macOS temp folders (/var → /private/var) and `smol /tmp/project` put the
// workspace behind a symlink. Built by hand here so it is tested on every OS.
test("a workspace reached through a symlink is still the workspace", (t) => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "tc-sandbox-real-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "tc-sandbox-else-"));
  const link = path.join(os.tmpdir(), `tc-sandbox-link-${process.pid}`);
  fs.mkdirSync(path.join(real, "src"));
  try {
    // "junction" needs no special rights on Windows and is ignored elsewhere.
    fs.symlinkSync(real, link, "junction");
    fs.symlinkSync(elsewhere, path.join(real, "exit"), "junction");
  } catch (err) {
    if (err.code === "EPERM") return t.skip("OS does not allow creating symlinks");
    throw err;
  }
  try {
    const free = (cmd) => assert.equal(commandEscapesWorkspace(cmd, link), null, `should run freely: ${cmd}`);
    free("cp src/a.js src/../src/b.js");
    free(`node ${path.join(link, "src", "app.js")}`);
    free(`node ${path.join(real, "src", "app.js")}`); // the same folder by its real name
    free(`node ${path.join(link, "src", "not-written-yet.js")}`);
    free(`cd ${link} && npm test`);
    assert.match(commandEscapesWorkspace(`cp src/a.js ${path.join(os.tmpdir(), "a.js")}`, link), /outside/);
    assert.match(commandEscapesWorkspace("cat ../secrets.env", link), /above/);
    // A link inside the workspace that leads out of it is outside.
    assert.match(commandEscapesWorkspace(`cat ${path.join(link, "exit", "secret.txt")}`, link), /outside/);
  } finally {
    fs.rmSync(link, { force: true, recursive: true });
    fs.rmSync(real, { force: true, recursive: true });
    fs.rmSync(elsewhere, { force: true, recursive: true });
  }
});

test("global package installs are flagged", () => {
  outside("npm install -g typescript", /globally/);
  outside("npm i --global foo", /globally/);
  outside("yarn global add foo", /globally/);
  outside("pnpm add -g foo", /globally/);
  inside("npm install foo && npm run global-thing"); // 'global' inside a script name is not a flag
});
