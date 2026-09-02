// The post-write syntax check hook.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { syntaxCheck } = require("../dist/tools/check");
const { executeTool } = require("../dist/tools/index");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-check-"));
function file(name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

test("valid JS, module JS, JSON and HTML pass silently", () => {
  assert.equal(syntaxCheck(file("ok.js", "const a = 1;\nfunction f() { return a; }\n"), "ok.js"), null);
  assert.equal(syntaxCheck(file("esm.js", "import * as THREE from 'three';\nexport const x = 1;\n"), "esm.js"), null);
  assert.equal(syntaxCheck(file("ok.json", '{"a": [1, 2]}'), "ok.json"), null);
  assert.equal(
    syntaxCheck(
      file("ok.html", '<html><body><script type="importmap">{"imports":{}}</script><script type="module">import x from "y"; const z = 1;</script><script>var q = 2;</script></body></html>'),
      "ok.html"
    ),
    null
  );
  assert.equal(syntaxCheck(file("style.css", "body { color: red }"), "style.css"), null, "unknown types are ignored");
});

test("a JS syntax error is reported with its line", () => {
  const w = syntaxCheck(file("bad.js", "const a = 1;\nfunction f() {\n  return a;\n\n"), "bad.js");
  assert.ok(w, "expected a warning");
  assert.match(w, /bad\.js has a JavaScript syntax error/);
  assert.match(w, /Unexpected end of input|Unexpected token/);
});

test("an inline <script> error reports the HTML line number", () => {
  const html = "<html>\n<body>\n<script>\nconst a = 1;\nlet b = ;\n</script>\n</body>\n</html>\n";
  const w = syntaxCheck(file("bad.html", html), "bad.html");
  assert.ok(w);
  assert.match(w, /inline <script> has a JavaScript syntax error at line 5/);
});

test("invalid JSON is reported", () => {
  const w = syntaxCheck(file("bad.json", "{\"a\": }"), "bad.json");
  assert.match(w, /not valid JSON/);
});

test("write_file result carries the warning; edit_file that fixes it is clean", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ws-"));
  const ctx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  const r1 = await executeTool("write_file", { path: "game.js", content: "function go() {\n  console.log('hi';\n}\n" }, ctx);
  assert.match(r1, /^Created game\.js/);
  assert.match(r1, /Warning: game\.js has a JavaScript syntax error at line 2/);
  assert.match(r1, /Fix this before moving on/);
  const r2 = await executeTool("edit_file", { path: "game.js", old_text: "console.log('hi';", new_text: "console.log('hi');" }, ctx);
  assert.match(r2, /^Edited game\.js/);
  assert.doesNotMatch(r2, /Warning/);
});
