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

test("global package installs are flagged", () => {
  outside("npm install -g typescript", /globally/);
  outside("npm i --global foo", /globally/);
  outside("yarn global add foo", /globally/);
  outside("pnpm add -g foo", /globally/);
  inside("npm install foo && npm run global-thing"); // 'global' inside a script name is not a flag
});
