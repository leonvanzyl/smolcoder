// search: .gitignore, long/minified lines, per-file grouping, and ripgrep
// with the JS walk as its fallback. Both engines must give the same answer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { searchFiles, formatSearchHits, topLevelIgnore, ripgrepAvailable } = require("../dist/tools/fs-tools");

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-core-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put(".gitignore", "# build output\ngenerated/\n*.log\n/secret.txt\n!keep.log\n");
  put("src/app.js", "const needle = 1;\nfunction f() {}\nconsole.log(needle);\n");
  put("src/util.js", "export const needle2 = 2;\n");
  put("generated/out.js", "const needle = 'ignored dir';\n");
  put("debug.log", "needle in a log\n");
  put("secret.txt", "needle secret\n");
  put("nested/secret.txt", "needle not anchored\n");
  put("long.js", `const short = "needle";\nconst long = "${"x".repeat(500)}needle";\n`);
  put("bundle.min.js", "var needle=1;\n");
  put("dist2/bundle.js", `${Array.from({ length: 5 }, () => "var a=1;".repeat(80) + "needle").join("\n")}\n`);
  return root;
}

const EXPECTED = [
  "long.js:1: const short = \"needle\";",
  "nested/secret.txt:1: needle not anchored",
  "src/app.js:",
  "  1: const needle = 1;",
  "  3: console.log(needle);",
  "src/util.js:1: export const needle2 = 2;",
].join("\n");

test("the JS walk skips ignored, minified and very long lines and groups matches per file", (t) => {
  const root = project(t);
  assert.equal(searchFiles(root, { pattern: "needle" }, { rg: false }), EXPECTED);
});

test("ripgrep, when on PATH, gives the same result", { skip: !ripgrepAvailable() && "ripgrep is not on PATH" }, (t) => {
  const root = project(t);
  assert.equal(searchFiles(root, { pattern: "needle" }, { rg: true }), EXPECTED);
  // Patterns JS accepts but ripgrep's engine does not fall back to the walk.
  assert.equal(searchFiles(root, { pattern: "(?<=const )needle2" }, { rg: true }), "src/util.js:1: export const needle2 = 2;");
  // An invalid regex is searched as plain text by both.
  fs.writeFileSync(path.join(root, "src/paren.js"), "call(x\n");
  assert.equal(searchFiles(root, { pattern: "call(" }, { rg: true }), "src/paren.js:1: call(x");
  assert.equal(searchFiles(root, { pattern: "call(" }, { rg: false }), "src/paren.js:1: call(x");
  assert.match(searchFiles(root, { pattern: "nothing-here-at-all" }, { rg: true }), /^No matches/);
});

test("a subfolder or single-file search works with both engines", (t) => {
  const root = project(t);
  for (const rg of [false, ...(ripgrepAvailable() ? [true] : [])]) {
    assert.equal(searchFiles(root, { pattern: "needle", path: "src/util.js" }, { rg }), "src/util.js:1: export const needle2 = 2;");
    assert.equal(searchFiles(root, { pattern: "needle", path: "src" }, { rg }), EXPECTED.split("\n").slice(2).join("\n"));
  }
});

test("grouped output is never longer than the old one-line-per-match form", () => {
  const hits = [];
  for (let f = 0; f < 6; f++) for (let l = 1; l <= (f % 3) + 1; l++) hits.push({ file: `src/components/file${f}.tsx`, line: l * 10, text: `match ${f}.${l}` });
  const old = hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n");
  const grouped = formatSearchHits(hits);
  assert.ok(grouped.length <= old.length, `${grouped.length} > ${old.length}`);
  assert.equal(formatSearchHits([hits[0]]), `${hits[0].file}:${hits[0].line}: ${hits[0].text}`);
});

test("top-level .gitignore patterns: names, dirs, globs and anchors", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-core-ignore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".gitignore"), "build/\n*.tmp\n/top.txt\ndocs/**/draft.md\n");
  const ignored = topLevelIgnore(root);
  assert.equal(ignored("build", true), true);
  assert.equal(ignored("build", false), false);
  assert.equal(ignored("a/b/c.tmp", false), true);
  assert.equal(ignored("top.txt", false), true);
  assert.equal(ignored("sub/top.txt", false), false);
  assert.equal(ignored("docs/x/y/draft.md", false), true);
  assert.equal(ignored("src/app.ts", false), false);
});
