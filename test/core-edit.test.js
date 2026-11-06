// edit_file match tiers: exact, line-trimmed (re-indented), typographic,
// already-applied detection and the UI diff side channel.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { editFile, writeFile } = require("../dist/tools/fs-tools");

function ws(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-core-edit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return { root, read: (name) => fs.readFileSync(path.join(root, name), "utf8") };
}

test("a block copied at a shallower indent is re-indented to the depth it replaces", (t) => {
  const py = "class A:\n    def run(self):\n        if ready:\n            go()\n        return 1\n";
  const { root, read } = ws(t, { "a.py": py });
  const out = editFile(root, {
    path: "a.py",
    old_text: "if ready:\n    go()",
    new_text: "if ready:\n    prepare()\n    go()",
  });
  assert.match(out, /^Edited a\.py: .*whitespace differences/);
  assert.equal(read("a.py"), "class A:\n    def run(self):\n        if ready:\n            prepare()\n            go()\n        return 1\n");
});

test("a deeper copy is dedented, and a dedented closing line moves with the block", (t) => {
  const js = "function f() {\n  if (x) {\n    y();\n  }\n}\n";
  const { root, read } = ws(t, { "f.js": js });
  editFile(root, { path: "f.js", old_text: "      if (x) {\n        y();\n      }", new_text: "      if (x) {\n        y();\n        z();\n      }" });
  assert.equal(read("f.js"), "function f() {\n  if (x) {\n    y();\n    z();\n  }\n}\n");
});

test("only the first line's indent was dropped: only the first replacement line is fixed", (t) => {
  // Trailing spaces keep the exact tier from matching mid-line.
  const js = "class A {\n  run() {  \n    return 1;\n  }\n}\n";
  const { root, read } = ws(t, { "a.js": js });
  editFile(root, { path: "a.js", old_text: "run() {\n    return 1;\n  }", new_text: "start() {\n    return 2;\n  }" });
  assert.equal(read("a.js"), "class A {\n  start() {\n    return 2;\n  }\n}\n");
});

test("one trailing newline on old_text no longer defeats the line tier", (t) => {
  const { root, read } = ws(t, { "a.js": "  const a = 1;\n  const b = 2;\n  more();\n" });
  const out = editFile(root, { path: "a.js", old_text: "const a = 1;\nconst b = 2;\n", new_text: "const a = 3;\nconst b = 4;\n" });
  assert.match(out, /^Edited/);
  assert.equal(read("a.js"), "  const a = 3;\n  const b = 4;\n  more();\n");
});

test("old_text equal to new_text is an error that changes nothing", (t) => {
  const { root, read } = ws(t, { "a.js": "x = 1;\n" });
  assert.match(editFile(root, { path: "a.js", old_text: "x = 1;", new_text: "x = 1;" }), /^Error: old_text and new_text are identical/);
  assert.equal(read("a.js"), "x = 1;\n");
});

test("an edit that was already applied is a no-op success, not an error", (t) => {
  const { root, read } = ws(t, { "a.js": "function hello() {\n  return 'world';\n}\n" });
  const args = { path: "a.js", old_text: "return 'old value';", new_text: "return 'world';" };
  const out = editFile(root, args);
  assert.doesNotMatch(out, /^Error/);
  assert.match(out, /already applied/);
  assert.equal(read("a.js"), "function hello() {\n  return 'world';\n}\n");
});

test("a repeated append-style edit does not duplicate the appended part", (t) => {
  const { root, read } = ws(t, { "a.js": "line one\nline two\n" });
  const args = { path: "a.js", old_text: "line two", new_text: "line two\nline three\nline four" };
  assert.match(editFile(root, args), /^Edited/);
  const once = read("a.js");
  assert.match(editFile(root, args), /already applied/);
  assert.equal(read("a.js"), once);
  assert.equal(once, "line one\nline two\nline three\nline four\n");
});

test("typographic quotes, dashes and non-breaking spaces match their ASCII forms", (t) => {
  const src = "const msg = \u201cIt\u2019s done\u201d; // a \u2014 b\nconst nb = 'a\u00a0b';\n";
  const { root, read } = ws(t, { "q.js": src });
  const out = editFile(root, { path: "q.js", old_text: 'const msg = "It\'s done"; // a - b', new_text: 'const msg = "Finished";' });
  assert.match(out, /typographic/);
  assert.equal(read("q.js"), "const msg = \"Finished\";\nconst nb = 'a\u00a0b';\n");
  // With the indentation also off, the combined line tier still finds it.
  const { root: r2, read: read2 } = ws(t, { "q.js": "  say(\u201chi\u201d);\n  done();\n" });
  editFile(r2, { path: "q.js", old_text: 'say("hi");\ndone();', new_text: 'say("hello");\ndone();' });
  assert.equal(read2("q.js"), '  say("hello");\n  done();\n');
});

test("replacement text is written literally, even with $& or $1 in it", (t) => {
  const { root, read } = ws(t, { "a.js": "const price = 0;\n" });
  editFile(root, { path: "a.js", old_text: "const price = 0;", new_text: "const price = '$&$1';" });
  assert.equal(read("a.js"), "const price = '$&$1';\n");
});

test("an empty new_text in the line tier removes the lines instead of leaving a blank one", (t) => {
  const { root: r2, read: read2 } = ws(t, { "a.js": "a();\n  b();\n  c();\nd();\n" });
  editFile(r2, { path: "a.js", old_text: "b();\nc();", new_text: "" });
  assert.equal(read2("a.js"), "a();\nd();\n");
});

test("CRLF files keep CRLF through the line tier", (t) => {
  const { root, read } = ws(t, { "w.js": "  if (a) {\r\n    b();\r\n  }\r\n" });
  editFile(root, { path: "w.js", old_text: "if (a) {\n  b();\n}", new_text: "if (a) {\n  c();\n}" });
  assert.equal(read("w.js"), "  if (a) {\r\n    c();\r\n  }\r\n");
});

test("successful writes and edits describe their change for the UI only", (t) => {
  const { root } = ws(t, { "a.js": "one\n  two\nthree\n" });
  const change = {};
  const out = editFile(root, { path: "a.js", old_text: "two", new_text: "2" }, change);
  assert.deepEqual(change.diff, { path: "a.js", before: "two", after: "2" });
  assert.doesNotMatch(out, /two|2/); // nothing of the diff reaches the model
  const lineChange = {};
  editFile(root, { path: "a.js", old_text: "one\n2", new_text: "1\n2" }, lineChange);
  assert.deepEqual(lineChange.diff, { path: "a.js", before: "one\n  2", after: "1\n  2" });
  const created = {};
  writeFile(root, { path: "new.txt", content: "hello" }, created);
  assert.deepEqual(created.diff, { path: "new.txt", before: "", after: "hello" });
  const overwrote = {};
  writeFile(root, { path: "new.txt", content: "x".repeat(300 * 1024) }, overwrote);
  assert.equal(overwrote.diff.before, "hello");
  assert.equal(overwrote.diff.after.length, 200 * 1024);
  const failed = {};
  editFile(root, { path: "a.js", old_text: "missing text here", new_text: "y" }, failed);
  assert.equal(failed.diff, undefined);
});
