// The TUI's building blocks: key decoding, cell widths, markdown lines, diffs,
// status fitting, and the pickers and live output driven through a fake
// terminal (stdout captured only inside synchronous sections).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { KeyDecoder } = require("../dist/tui/keys");
const { stringWidth, truncateWidth, wrapAnsi, middleTruncate, expandTabs, stripAnsi } = require("../dist/tui/width");
const { MarkdownStream, renderInline, renderTable } = require("../dist/tui/markdown");
const { renderDiff, lineDiff, diffCounts } = require("../dist/tui/diff");
const { fitStatus, fitSegments } = require("../dist/tui/status");
const { setTheme, makeTheme, oscIsLight, colorfgbgIsLight, needsAscii, detectOptions } = require("../dist/tui/theme");
const { LineEditor, layoutBuffer } = require("../dist/tui/editor");
const { PromptHistory } = require("../dist/tui/history");
const { FileIndex, gitignoreMatcher } = require("../dist/tui/files");
const { Tui } = require("../dist/tui/tui");

setTheme({ ascii: false, color: true, light: false, truecolor: false });

// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const types = (keys) => keys.map((k) => k.type + (k.text !== undefined ? ":" + k.text : ""));
// Wait for timers (esc, argument loading) with stdout swallowed meanwhile.
async function sleep(ms) {
  const real = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await new Promise((r) => setTimeout(r, ms));
  } finally {
    process.stdout.write = real;
  }
}

function capture(fn) {
  const real = process.stdout.write;
  let out = "";
  process.stdout.write = (s) => ((out += s), true);
  try {
    fn();
  } finally {
    process.stdout.write = real;
  }
  return out;
}
const keys = (s) => process.stdin.emit("data", s);

// ---- keys -------------------------------------------------------------------

test("keys: alt+enter, ctrl+j and CSI-u shift+enter are newlines; ESC+char is alt", () => {
  const d = new KeyDecoder();
  assert.deepEqual(types(d.decode("\x1b\r")), ["newline"]);
  assert.deepEqual(types(d.decode("\n")), ["newline"]);
  assert.deepEqual(types(d.decode("\x1b[13;2u")), ["newline"]);
  assert.deepEqual(types(d.decode("\r")), ["enter"]);
  assert.deepEqual(types(d.decode("\x1bb\x1bf\x1b\x7f\x1bd")), ["wordleft", "wordright", "wordbackspace", "worddelete"]);
  assert.deepEqual(types(d.decode("\x1bx")), ["alt:x"], "alt+x is not a bare esc");
  assert.deepEqual(types(d.decode("\x1b[1;5D\x1b[1;5C\x1b[1;3D")), ["wordleft", "wordright", "wordleft"]);
  assert.deepEqual(types(d.decode("\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[1~\x1b[4~")), ["pageup", "pagedown", "home", "end", "home", "end"]);
  assert.deepEqual(types(d.decode("\x0b\x0f\x10\x12\x06\x1bOQ")), ["ctrlk", "ctrlo", "ctrlp", "ctrlr", "ctrlf", "f2"]);
  assert.deepEqual(types(d.decode("a\r\nb")), ["char:a", "newline", "char:b"], "an unbracketed multi-line paste does not submit");
});

test("keys: a sequence split across reads is carried over; a lone ESC waits for flush", () => {
  const d = new KeyDecoder();
  assert.deepEqual(d.decode("ab\x1b[1;"), [{ type: "text", text: "ab" }]);
  assert.ok(d.hasPending());
  assert.deepEqual(types(d.decode("5D")), ["wordleft"]);
  assert.deepEqual(d.decode("\x1b"), []);
  assert.deepEqual(types(d.decode("[A")), ["up"], "ESC then [A in the next read is still an arrow");
  assert.deepEqual(d.decode("\x1b"), []);
  assert.deepEqual(types(d.flush()), ["esc"], "a lone ESC with nothing after it is the Esc key");
  // bracketed paste with the end marker split
  assert.deepEqual(d.decode("\x1b[200~line1\r\nline2\x1b[20"), []);
  assert.deepEqual(d.decode("1~x"), [{ type: "text", text: "line1\nline2" }, { type: "char", text: "x" }]);
});

test("keys: OSC and DA replies are swallowed, never typed", () => {
  // A split reply waits for its end only while the query is outstanding.
  const d = new KeyDecoder(() => true);
  const k = d.decode("\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?62;22cq");
  assert.deepEqual(types(k), ["osc:11;rgb:ffff/ffff/ffff", "da", "char:q"]);
  // ST-terminated and split
  assert.deepEqual(d.decode("\x1b]11;rgb:0000/00"), []);
  assert.deepEqual(types(d.decode("00/0000\x1b\\z")), ["osc:11;rgb:0000/0000/0000", "char:z"]);
  assert.deepEqual(d.decode("\x1b[12;40R"), [], "cursor reports are dropped");
});

// ---- widths -----------------------------------------------------------------

test("cell widths: CJK and emoji are wide, combining marks and joiners zero, tabs expand", () => {
  assert.equal(stringWidth("abc"), 3);
  assert.equal(stringWidth("日本語"), 6);
  assert.equal(stringWidth("🙂"), 2);
  assert.equal(stringWidth("👩‍💻"), 2, "a ZWJ sequence is one glyph");
  assert.equal(stringWidth("é"), 1);
  assert.equal(stringWidth("\x1b[31mred\x1b[0m"), 3);
  assert.equal(expandTabs("a\tb"), "a   b");
  assert.equal(stringWidth("a\tb"), 5);
  assert.equal(stripAnsi(truncateWidth("日本語テキスト", 7, "…")), "日本語…");
  const cut = truncateWidth("\x1b[1mbold text\x1b[0m", 4);
  assert.equal(stripAnsi(cut), "bold");
  assert.ok(cut.endsWith("\x1b[0m"), "escape codes are kept so colors still reset");
  assert.equal(middleTruncate("qwen3-coder-30b-a3b-instruct-q4_k_m", 15), "qwen3-c…-q4_k_m");
});

test("word wrap breaks at spaces, keeps the indent and fits the width", () => {
  const rows = wrapAnsi("one two three four five six seven", 12, "  ");
  for (const r of rows) assert.ok(stringWidth(r) <= 12, r);
  assert.deepEqual(rows.map(strip), ["one two", "  three four", "  five six", "  seven"]);
  const long = wrapAnsi("x".repeat(25), 10);
  assert.deepEqual(long.map((r) => r.length), [10, 10, 5]);
});

test("editor: word motions, ctrl+k and a width-aware layout", () => {
  const ed = new LineEditor();
  ed.set("hello big world");
  ed.wordLeft();
  assert.equal(ed.cursor, 10);
  ed.wordLeft();
  assert.equal(ed.cursor, 6);
  ed.killToLineEnd();
  assert.equal(ed.buffer, "hello ");
  ed.set("日本🙂x");
  ed.left();
  ed.left();
  assert.equal(ed.buffer.slice(0, ed.cursor), "日本", "the cursor steps over a whole emoji");
  ed.backspace();
  assert.equal(ed.buffer, "日🙂x");
  const lay = layoutBuffer("日本語日本語", 6, 5);
  assert.deepEqual(lay.rows, ["日本", "語日", "本語"]);
  assert.deepEqual([lay.curRow, lay.curCol], [2, 4]);
});

// ---- markdown ---------------------------------------------------------------

test("markdown: finished lines are formatted; only the tail stays live", () => {
  const md2 = new MarkdownStream(() => 60);
  const rows = md2.push("# Title\n- one **bold** and `code`\nplain *it*").map(strip);
  assert.deepEqual(rows, ["Title", "• one bold and code"]);
  assert.deepEqual(md2.tail().map(strip), ["plain it"]);
  assert.deepEqual(md2.end().map(strip), ["plain it"]);
  assert.ok(md2.idle);
  assert.match(renderInline("**b**"), /\x1b\[1mb/);
});

test("markdown: fenced code gets a gutter and highlighting; tables align when complete", () => {
  const md = new MarkdownStream(() => 60);
  const rows = md.push("```ts\nconst x = 1; // hi\n```\n");
  const plain = rows.map(strip);
  assert.deepEqual(plain, ["╭─ ts", "│ const x = 1; // hi", "╰─"]);
  assert.match(rows[1], /\x1b\[38;5;176mconst/, "keywords are colored");
  assert.match(rows[1], /\x1b\[3;38;5;243m\/\/ hi/, "comments are colored");

  const t = new MarkdownStream(() => 60);
  assert.deepEqual(t.push("| a | long header |\n|---|--:|\n| xx | 1 |\n"), [], "table rows wait for the block to end");
  assert.equal(t.tail().length, 3);
  const table = t.push("after\n").map(strip);
  assert.deepEqual(table, ["a  │ long header", "───┼────────────", "xx │           1", "after"]);
  // too wide: falls back to wrapped text
  const narrow = renderTable(["| aaaaaaaaaa | bbbbbbbbbb |", "|---|---|", "| c | d |"], 12).map(strip);
  assert.ok(narrow.every((r) => stringWidth(r) <= 12));
});

test("markdown: reset drops the unfinished tail only", () => {
  const md = new MarkdownStream(() => 40);
  assert.equal(md.push("done line\nhalf").length, 1);
  md.reset();
  assert.deepEqual(md.tail(), []);
  assert.deepEqual(md.end(), []);
});

// ---- diffs ------------------------------------------------------------------

test("diff: a compact unified diff with line numbers, capped with +N more", () => {
  assert.deepEqual(diffCounts("a\nb\nc", "a\nB\nc\nd"), { added: 2, removed: 1 });
  const ops = lineDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(ops.map((o) => o.op + o.text), [" a", "-b", "+B", " c"]);
  const rows = renderDiff("a\nb\nc", "a\nB\nc", { width: 40, firstLine: 10 }).map(strip);
  assert.deepEqual(rows, ["  10   a", "  11 - b", "  11 + B", "  12   c"]);
  const before = Array.from({ length: 30 }, (_, i) => "old " + i).join("\n");
  const after = Array.from({ length: 30 }, (_, i) => "new " + i).join("\n");
  const big = renderDiff(before, after, { width: 40, maxRows: 12 }).map(strip);
  assert.equal(big.length, 13);
  assert.equal(big[12], "  … +48 more");
});

// ---- status -----------------------------------------------------------------

test("status: extras drop first, the model shortens in the middle, ctx % survives", () => {
  const s = "edit · qwen3-coder-30b-a3b-instruct-q4_k_m LM Studio · high · 12.3k (34%) · plan 2/5 · 1 task";
  assert.equal(fitStatus(s, 200), s);
  const mid = strip(fitStatus(s, 60));
  assert.ok(stringWidth(mid) <= 60, mid);
  assert.match(mid, /34%/);
  assert.match(mid, /^edit · /);
  assert.doesNotMatch(mid, /1 task/);
  const tight = strip(fitStatus(s, 30));
  assert.ok(stringWidth(tight) <= 30, tight);
  assert.match(tight, /34%/, "the context segment is the last to go");
  assert.match(tight, /…/, "the model name is middle-truncated");
  assert.match(fitStatus(s, 14), /34%/);
});

// ---- theme ------------------------------------------------------------------

test("theme: NO_COLOR, light detection, ASCII fallback", () => {
  assert.equal(detectOptions({ NO_COLOR: "1" }).color, false);
  assert.equal(detectOptions({}).color, true);
  const plain = makeTheme({ color: false, light: false, truecolor: false, ascii: false });
  assert.equal(plain.red("x"), "x");
  assert.equal(plain.add("+ x"), "+ x");
  assert.equal(oscIsLight("rgb:ffff/ffff/ffff"), true);
  assert.equal(oscIsLight("rgb:1e1e/1e1e/2020"), false);
  assert.equal(colorfgbgIsLight("0;15"), true);
  assert.equal(colorfgbgIsLight("15;0"), false);
  assert.equal(needsAscii({}, "win32"), true);
  assert.equal(needsAscii({ WT_SESSION: "x" }, "win32"), false);
  assert.equal(needsAscii({ TERM_PROGRAM: "vscode" }, "win32"), false);
  assert.equal(needsAscii({}, "darwin"), false);
  const tc = makeTheme({ color: true, light: false, truecolor: true, ascii: true });
  assert.match(tc.add("x"), /48;2;/, "24-bit diff tints");
  assert.equal(tc.g.spinner[0], "|");
});

// ---- history & files --------------------------------------------------------

test("prompt history persists, dedupes and keeps the last 200", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-hist-"));
  const file = path.join(dir, "h.jsonl");
  const h = new PromptHistory(file);
  h.load();
  for (let i = 0; i < 205; i++) h.add("p" + i);
  h.add("p100");
  const h2 = new PromptHistory(file);
  h2.load();
  assert.equal(h2.entries.length, 200);
  assert.equal(h2.entries[h2.entries.length - 1], "p100");
  assert.equal(h2.entries.filter((e) => e === "p100").length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("files: walks once, skips node_modules and .gitignore entries, ranks recent picks first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-files-"));
  fs.mkdirSync(path.join(dir, "src", "tui"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\n*.log\n");
  for (const f of ["src/app.ts", "src/tui/tui.ts", "src/tui/keys.ts", "README.md", "debug.log", "dist/app.js", "node_modules/x/i.js"]) fs.writeFileSync(path.join(dir, f), "");
  const idx = new FileIndex();
  const all = idx.list(dir).map((e) => e.path);
  assert.ok(all.includes("src/tui/keys.ts"));
  assert.ok(!all.some((p) => p.startsWith("node_modules") || p.startsWith("dist") || p.endsWith(".log")), all.join(","));
  assert.equal(idx.search(dir, "keys")[0].path, "src/tui/keys.ts");
  assert.deepEqual(idx.search(dir, "src/").map((e) => e.path), ["src/tui/", "src/app.ts"], "a folder query lists its children, folders first");
  idx.picked("README.md");
  assert.equal(idx.search(dir, "")[0].path, "README.md");
  assert.ok(gitignoreMatcher("/build\n")("build", true));
  assert.ok(!gitignoreMatcher("/build\n")("src/build", true));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the TUI, driven ----------------------------------------------------------

function newTui(extra = {}) {
  const tui = new Tui({ historyFile: null });
  Object.assign(tui, extra);
  return tui;
}

test("picker: starts on the current row, groups under headers, ctrl+f stars in place", async () => {
  const tui = newTui();
  let options = [
    { label: "alpha", group: "This computer" },
    { label: "beta", group: "This computer", current: true },
    { label: "gamma", group: "gpu-box" },
  ];
  let starredWith = null;
  const onStar = (i) => {
    starredWith = i;
    // The favorite moves to a new group at the top.
    const o = options[i];
    options = [{ ...o, group: "Favorites", starred: true }, ...options.filter((_, j) => j !== i)];
    return options;
  };
  let p;
  const first = strip(capture(() => {
    tui.start();
    p = tui.select("Select model", options, { onStar });
  }));
  assert.match(first, /This computer\n/);
  assert.match(first, /gpu-box\n/);
  assert.match(first, /ctrl\+f star/);
  const starred = strip(capture(() => keys("\x06")));
  assert.equal(starredWith, 1, "the highlighted (current) row was starred");
  const last = starred.slice(starred.lastIndexOf("Select model"));
  assert.match(last, /Favorites\n/);
  assert.match(last, /★ beta/);
  capture(() => keys("\r"));
  assert.equal(await p, 0, "the cursor stayed on beta, now first");

  // PgDn/End/Home, and fuzzy filtering over hints and keywords
  const many = Array.from({ length: 30 }, (_, i) => ({ label: `m${i}`, keywords: i === 7 ? "needle" : undefined }));
  let q;
  capture(() => (q = tui.select("Pick", many)));
  const end = strip(capture(() => keys("\x1b[F")));
  assert.match(end.slice(end.lastIndexOf("Pick")), /m29/);
  capture(() => keys("\x1b[H\x1b[6~"));
  capture(() => keys("\r"));
  assert.equal(await q, 10);
  capture(() => (q = tui.select("Pick", many)));
  capture(() => keys("needle\r"));
  assert.equal(await q, 7);
  capture(() => tui.close());
});

test("input: esc never wipes a draft on one press; alt+enter adds a line; slash menu fuzzy-matches aliases", async () => {
  const cmds = [
    { name: "models", desc: "Switch model", aliases: ["switch"], group: "Model", args: () => [{ label: "next", hint: "next recent" }] },
    { name: "help", desc: "Show help", group: "General" },
    ...Array.from({ length: 12 }, (_, i) => ({ name: `cmd${i}`, desc: `command ${i}` })),
  ];
  const tui = newTui({ slashCommands: cmds, getStatus: () => "edit · m · 1.2k (5%)" });
  let p;
  capture(() => {
    tui.start();
    p = tui.readInput();
  });
  capture(() => keys("draft"));
  capture(() => keys("\x1b"));
  await sleep(60);
  let f = strip(capture(() => keys("!")));
  assert.match(f, /draft!/, "one esc kept the draft");
  capture(() => keys("\x1b\rline2"));
  capture(() => keys("\x1b"));
  await sleep(60);
  capture(() => keys("\x1b"));
  await sleep(60);
  f = strip(capture(() => keys("x")));
  assert.doesNotMatch(f, /draft/, "a double esc clears");
  // ↑ restores what was cleared
  f = strip(capture(() => keys("\x7f\x1b[A")));
  assert.match(f, /draft!/);
  assert.match(f, /line2/);
  // slash menu: alias search, scrolling past 8 rows
  capture(() => keys("\x03")); // ctrl+c clears a non-empty draft
  f = strip(capture(() => keys("/switch")));
  assert.match(f, /\/models/);
  capture(() => keys("\x03"));
  f = strip(capture(() => keys("/")));
  assert.match(f, /↓ 6 more/);
  f = strip(capture(() => keys("\x1b[6~\x1b[6~")));
  assert.match(f.slice(f.lastIndexOf("/cmd")), /cmd11/);
  // args mode: Enter on /models inserts "/models " and lists the values
  capture(() => keys("\x15/models"));
  f = strip(capture(() => keys("\r")));
  await sleep(10);
  f = strip(capture(() => tui.refresh()));
  assert.match(f, /next recent/);
  capture(() => keys("\r"));
  assert.equal(await p, "/models next");
  capture(() => tui.close());
});

test("live output: footer, thought line, tool row replaced in place with a diff", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-ws-"));
  fs.writeFileSync(path.join(dir, "a.ts"), "line1\nline2\nconst y = 2;\nline4\n");
  const tui = newTui({ getStatus: () => "edit · m · 1.2k (5%)", workspace: dir });
  let p;
  capture(() => {
    tui.start();
    p = tui.readInput();
  });
  let out = capture(() => keys("fix it\r"));
  assert.equal(await p, "fix it");
  assert.match(strip(out), /▌ fix it/);
  out = capture(() => {
    tui.startSpinner("thinking");
    tui.thinking("Let me look at the file");
    tui["flush"]();
  });
  assert.match(strip(out), /✦ Let me look at the file/);
  assert.match(strip(out), /thinking · 0s · esc interrupt · ctx 5%/);
  assert.match(out, /\x1b\[\?2026h/, "repaints use synchronized output");
  out = strip(capture(() => {
    tui.token("Done **now**.\nTail");
    tui["flush"]();
  }));
  assert.match(out, /✦ thought for \d+\.\ds/);
  assert.match(out, /Done now\./);
  assert.match(out, /responding/);
  out = strip(capture(() => {
    tui.toolArgsProgress("write_file", 14200);
    tui["flush"]();
  }));
  assert.match(out, /writing a file · 14\.2k chars/);
  out = capture(() => {
    tui.toolCall("edit_file", { path: "a.ts" });
    tui.toolResult("Edited a.ts", { ok: true, durationMs: 1234, diff: { path: "a.ts", before: "const x = 1;", after: "const y = 2;" } });
  });
  assert.match(out, /•[\s\S]*edit_file[\s\S]*\x1b\[1A\r\x1b\[2K[\s\S]*✓/, "the running row is rewritten in place");
  const plain = strip(out);
  assert.match(plain, /✓ edit_file a\.ts · 1\.2s/);
  assert.match(plain, /3 - const x = 1;/);
  assert.match(plain, /3 \+ const y = 2;/);
  // Something printed in between: the result goes on a new line instead.
  out = capture(() => {
    tui.toolCall("run_command", { command: "npm test" });
    tui.status("· approved");
    tui.toolResult("Error: command exited with code 1\nok 1\nok 2\nnot ok 3\n[exit code 1 in 2.0s]", { ok: false, durationMs: 2000 });
  });
  assert.doesNotMatch(out.slice(out.indexOf("approved")), /\x1b\[1A/);
  assert.match(strip(out), /✗ run_command npm test · exit 1 · 2\.0s/);
  assert.match(strip(out), /│ not ok 3/);
  out = strip(capture(() => {
    tui.println("");
    tui.turnEnd("done");
  }));
  assert.match(out, /■ done/);
  assert.doesNotMatch(out.slice(out.indexOf("■ done")), /esc interrupt/, "the footer goes away when the turn ends");
  capture(() => tui.close());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("palette: ctrl+p lists grouped commands with keys; choosing one runs it", async () => {
  const cmds = [
    { name: "mode", desc: "Set mode", group: "Model", key: "shift+tab" },
    { name: "help", desc: "Show help", group: "General" },
  ];
  const tui = newTui({ slashCommands: cmds });
  let p;
  capture(() => {
    tui.start();
    p = tui.readInput();
  });
  const f = strip(capture(() => keys("\x10")));
  assert.match(f, /Commands/);
  assert.match(f, /Model\n/);
  assert.match(f, /shift\+tab/);
  capture(() => keys("help\r"));
  await sleep(5);
  assert.equal(await p, "/help");
  capture(() => {
    p = tui.readInput();
  });
  capture(() => keys("\x1bOQ"));
  assert.equal(await p, "/models next", "F2 sends /models next");
  capture(() => tui.close());
});

test("@ mentions insert the relative path only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-at-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "SECRET CONTENTS");
  const tui = newTui({ workspace: dir });
  let p;
  capture(() => {
    tui.start();
    p = tui.readInput();
  });
  let f = strip(capture(() => keys("look at @")));
  assert.match(f, /src\//);
  f = strip(capture(() => keys("\t")));
  assert.match(f, /src\/app\.ts/, "tab stepped into the folder");
  capture(() => keys("\r"));
  capture(() => keys("\r"));
  const text = await p;
  assert.equal(text, "look at src/app.ts");
  assert.doesNotMatch(text, /SECRET/);
  capture(() => tui.close());
  fs.rmSync(dir, { recursive: true, force: true });
});
