// The TUI's building blocks: key decoding, cell widths, markdown rows, diffs,
// status fitting, the cell grid and its frame diff, and the full-screen TUI
// driven through fake streams into an emulated terminal.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { KeyDecoder } = require("../dist/tui/keys");
const { stringWidth, truncateWidth, wrapAnsi, middleTruncate, expandTabs, stripAnsi } = require("../dist/tui/width");
const { MarkdownStream, renderInline, renderTable } = require("../dist/tui/markdown");
const { renderDiffRows, lineDiff, diffCounts } = require("../dist/tui/diff");
const { fitStatus, parseStatus } = require("../dist/tui/status");
const { setTheme, makeTheme, oscIsLight, oscColor, colorfgbgIsLight, needsAscii, detectOptions, nearest256, theme } = require("../dist/tui/theme");
const { LineEditor, layoutBuffer } = require("../dist/tui/editor");
const { PromptHistory } = require("../dist/tui/history");
const { FileIndex, gitignoreMatcher } = require("../dist/tui/files");
const { Grid, diffFrames, PLAIN } = require("../dist/tui/screen");
const { rowText } = require("../dist/tui/rows");
const { VT } = require("./vt");
const { makeTui, sleep, DOWN } = require("./tui-harness");

setTheme({ ascii: false, color: true, light: false, truecolor: false });

// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const types = (keys) => keys.map((k) => k.type + (k.text !== undefined ? ":" + k.text : ""));
const rows = (rs) => rs.map(rowText);

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
  assert.deepEqual(types(d.decode("\x1b[1;2A\x1b[1;2B\x1b[1;5H\x1b[1;5F")), ["shiftup", "shiftdown", "ctrlhome", "ctrlend"]);
});

test("keys: SGR mouse reports decode to presses, drags, releases and the wheel", () => {
  const d = new KeyDecoder();
  const [press, drag, release, up, down] = d.decode("\x1b[<0;10;5M\x1b[<32;12;6M\x1b[<0;12;6m\x1b[<64;1;1M\x1b[<65;1;1M");
  assert.deepEqual(press.mouse, { button: 0, x: 9, y: 4, action: "press", shift: false });
  assert.equal(drag.mouse.action, "drag");
  assert.equal(release.mouse.action, "release");
  assert.equal(up.mouse.button, 64);
  assert.equal(down.mouse.button, 65);
  // legacy X10 reports are swallowed, not typed
  assert.deepEqual(types(d.decode("\x1b[M !!x")), ["char:x"]);
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
  assert.equal(stringWidth("é"), 1);
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
  const rws = wrapAnsi("one two three four five six seven", 12, "  ");
  for (const r of rws) assert.ok(stringWidth(r) <= 12, r);
  assert.deepEqual(rws.map(strip), ["one two", "  three four", "  five six", "  seven"]);
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

// ---- the cell grid ------------------------------------------------------------

test("grid: SGR text keeps the panel background after a reset; wide glyphs take two cells", () => {
  const g = new Grid(20, 2);
  const panel = { fg: -1, bg: 0x1000000 | 0x222222, attrs: 0 };
  g.fill(0, 0, 20, 1, panel);
  g.text(1, 0, "a\x1b[1;31mB\x1b[0mc日本", panel);
  assert.equal(g.rowText(0).trimEnd(), " aBc日本");
  assert.equal(g.bg[3], panel.bg, "after the reset the panel colour is back");
  assert.equal(g.fg[2], 1, "the bold red cell is red");
  assert.equal(g.wd[4], 2);
  assert.equal(g.wd[5], 0, "the second half of a wide glyph");
  // Overwriting half of a wide glyph clears the other half.
  g.set(5, 0, "x", PLAIN);
  assert.equal(g.ch[4], " ");
  // a wide glyph never straddles the right edge
  assert.equal(g.text(18, 1, "日本", PLAIN), 20);
  assert.equal(g.rowText(1).trimEnd(), "                  日");
});

test("frames: only changed cells are written; an unknown screen gets everything", () => {
  const a = new Grid(10, 3);
  a.text(0, 0, "hello", PLAIN);
  const full = diffFrames(null, a, true);
  assert.match(full, /hello/);
  const b = new Grid(10, 3);
  b.text(0, 0, "help!", PLAIN);
  const d = diffFrames(a, b, true);
  assert.doesNotMatch(d, /hel/, "unchanged cells are not rewritten");
  assert.match(d, /\x1b\[1;4H\x1b\[0mp!/, "one move, then the changed run");
  assert.equal(diffFrames(b, b, true), "", "nothing changed: nothing written");
  // Replaying the frames on an emulator gives the same screen.
  const vt = new VT(10, 3);
  vt.feed(full + d);
  assert.equal(vt.lines()[0], "help!");
  // 256-colour fallback: no 24-bit sequences.
  const c = new Grid(4, 1);
  c.text(0, 0, "\x1b[38;2;56;189;248mx", PLAIN);
  assert.match(diffFrames(null, c, false), /38;5;\d+m/);
  assert.doesNotMatch(diffFrames(null, c, false), /38;2;/);
});

// ---- markdown ---------------------------------------------------------------

test("markdown: finished lines are laid out once; only the tail stays live", () => {
  const md2 = new MarkdownStream(() => 60);
  const out = rows(md2.push("# Title\n- one **bold** and `code`\nplain *it*"));
  assert.deepEqual(out, ["Title", "• one bold and code"]);
  assert.deepEqual(rows(md2.tail()), ["plain it"]);
  assert.deepEqual(rows(md2.end()), ["plain it"]);
  assert.ok(md2.idle);
  assert.match(renderInline("**b**"), /\x1b\[1mb/);
});

test("markdown: fenced code is a shaded panel with highlighting; tables are grids", () => {
  const md = new MarkdownStream(() => 40);
  const code = md.push("```ts\nconst x = 1; // hi\n```\n");
  assert.deepEqual(rows(code).map((r) => r.trimEnd()), ["                                    ts", "  const x = 1; // hi", ""]);
  const bg = code[1][0].style.bg;
  assert.ok(code[1][0].fill === 40 && bg !== -1, "code rows fill the width with the panel colour");
  const body = code[1][1].text;
  assert.match(body, new RegExp(`\\x1b\\[38;5;${nearest256(theme.p.kw)}mconst`), "keywords are coloured");
  assert.match(body, /\x1b\[3;38;5;\d+m\/\/ hi/, "comments are italic and coloured");

  const t = new MarkdownStream(() => 60);
  assert.deepEqual(t.push("| a | long header |\n|---|--:|\n| xx | 1 |\n"), [], "table rows wait for the block to end");
  assert.equal(t.tail().length, 5, "a held table is previewed as a grid");
  const table = rows(t.push("after\n"));
  assert.deepEqual(table, [
    "┌────┬─────────────┐",
    "│ a  │ long header │",
    "├────┼─────────────┤",
    "│ xx │           1 │",
    "└────┴─────────────┘",
    "after",
  ]);
  // too wide: columns shrink and cells are cut, never wider than the width
  const narrow = rows(renderTable(["| aaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbb |", "|---|---|", "| c | d |"], 24));
  assert.ok(narrow.every((r) => stringWidth(r) <= 24), narrow.join("\n"));
  assert.match(narrow[1], /…/);
});

test("markdown: reset drops the unfinished tail only", () => {
  const md = new MarkdownStream(() => 40);
  assert.equal(md.push("done line\nhalf").length, 1);
  md.reset();
  assert.deepEqual(md.tail(), []);
  assert.deepEqual(md.end(), []);
});

// ---- diffs ------------------------------------------------------------------

test("diff: rows with line numbers and tints, side by side when wide, capped", () => {
  assert.deepEqual(diffCounts("a\nb\nc", "a\nB\nc\nd"), { added: 2, removed: 1 });
  const ops = lineDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(ops.map((o) => o.op + o.text), [" a", "-b", "+B", " c"]);
  const uni = renderDiffRows("a\nb\nc", "a\nB\nc", { width: 40, firstLine: 10 });
  assert.deepEqual(rows(uni.rows), [" 10   a", " 11 - b", " 11 + B", " 12   c"]);
  assert.equal(uni.added, 1);
  // removed and added rows carry the diff backgrounds
  const tint = (r) => r.find((s) => s.fill && s.x > 0).style.bg;
  assert.equal(tint(uni.rows[1]) & 0xffffff, theme.p.diffDelBg);
  assert.equal(tint(uni.rows[2]) & 0xffffff, theme.p.diffAddBg);
  const split = renderDiffRows("a\nb\nc", "a\nB\nc", { width: 80, firstLine: 10, split: true });
  assert.equal(split.rows.length, 3, "a changed pair shares one row");
  assert.match(rowText(split.rows[1]), /11 - b\s+11 \+ B/);
  const before = Array.from({ length: 30 }, (_, i) => "old " + i).join("\n");
  const after = Array.from({ length: 30 }, (_, i) => "new " + i).join("\n");
  const big = renderDiffRows(before, after, { width: 40, maxRows: 12 });
  assert.equal(big.rows.length, 12);
  assert.equal(big.hidden, 48);
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

test("status: the session's status row parses into fields", () => {
  const s = "\x1b[36;1medit\x1b[0m · qwen3-coder \x1b[2mLM Studio\x1b[0m · \x1b[33mhigh\x1b[0m · \x1b[2m12.3k (34%)\x1b[0m · plan 2/5 · 1 task";
  const i = parseStatus(s);
  assert.deepEqual(
    { mode: i.mode, modeLabel: i.modeLabel, model: i.model, backend: i.backend, effort: i.effort, tokens: i.tokens, pct: i.pct, plan: i.plan, tasks: i.tasks },
    { mode: "edit", modeLabel: "Edit", model: "qwen3-coder", backend: "LM Studio", effort: "high", tokens: "12.3k", pct: 34, plan: "2/5", tasks: 1 }
  );
  assert.equal(parseStatus("read-only · m · 1k (5%)").modeLabel, "Read-only");
  assert.equal(parseStatus("bypass permissions · m ollama @ gpu-box · 1k (5%)").backend, "ollama @ gpu-box");
});

// ---- theme ------------------------------------------------------------------

test("theme: NO_COLOR, light detection, 24-bit or 256 colours, ASCII fallback", () => {
  assert.equal(detectOptions({ NO_COLOR: "1" }).color, false);
  assert.equal(detectOptions({}).color, true);
  const plain = makeTheme({ color: false, light: false, truecolor: false, ascii: false });
  assert.equal(plain.red("x"), "x");
  assert.equal(plain.add("+ x"), "+ x");
  assert.equal(plain.cell(0x123456), -1, "no colour: cells keep the terminal's defaults");
  assert.equal(oscIsLight("rgb:ffff/ffff/ffff"), true);
  assert.equal(oscIsLight("rgb:1e1e/1e1e/2020"), false);
  assert.equal(oscColor("rgb:ffff/8080/0000"), 0xff8000);
  assert.equal(colorfgbgIsLight("0;15"), true);
  assert.equal(colorfgbgIsLight("15;0"), false);
  assert.equal(needsAscii({}, "win32"), true);
  assert.equal(needsAscii({ WT_SESSION: "x" }, "win32"), false);
  assert.equal(needsAscii({ TERM_PROGRAM: "vscode" }, "win32"), false);
  assert.equal(needsAscii({}, "darwin"), false);
  const tc = makeTheme({ color: true, light: false, truecolor: true, ascii: true });
  assert.match(tc.add("x"), /38;2;/, "24-bit colours");
  assert.match(makeTheme({ color: true, light: false, truecolor: false, ascii: false }).add("x"), /38;5;/, "else the 256-colour cube");
  assert.equal(tc.g.spinner[0], "|");
  assert.equal(tc.g.bar, "|");
  // panels follow the terminal's own background
  const custom = makeTheme({ color: true, light: false, truecolor: true, ascii: false, bg: 0x002b36 });
  assert.notEqual(custom.p.panel, makeTheme({ color: true, light: false, truecolor: true, ascii: false }).p.panel);
  assert.equal(nearest256(0xffffff), 231);
  assert.equal(nearest256(0x000000), 16);
});

test("theme: the terminal's OSC 11 answer switches to a palette built on its background", () => {
  const { Tui } = require("../dist/tui/tui");
  const { fakeStdin } = require("./tui-harness");
  const vt = new VT(80, 24);
  const stdin = fakeStdin();
  stdin.isTTY = true;
  const tui = new Tui({ historyFile: null, stdout: vt.stdout(), stdin });
  tui.start();
  assert.ok(vt.osc.includes("11;?"), "asked for the background colour");
  stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?62;22c");
  assert.equal(theme.opts.light, true);
  assert.equal(theme.p.bg, 0xffffff);
  assert.ok(vt.has("Ask anything"), "drawn once the answer is in");
  tui.close();
  setTheme({ light: false, bg: undefined });
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

const STATUS = "edit · qwen3-coder \x1b[2mLM Studio\x1b[0m · high · 12.3k (34%)";

test("screen: the TUI runs on the alternate screen and restores the terminal on close", () => {
  const t = makeTui({ props: { getStatus: () => STATUS } });
  assert.ok(t.vt.altActive, "full screen on the alternate buffer");
  assert.ok(t.vt.modes.has(1006) && t.vt.modes.has(2004), "SGR mouse and bracketed paste on");
  assert.ok(!t.vt.modes.has(7), "no autowrap while drawing");
  assert.match(t.writes.join(""), /\x1b\[\?2026h/, "frames use synchronized output");
  t.close();
  assert.ok(!t.vt.altActive, "back on the normal screen");
  assert.ok(!t.vt.modes.has(1000) && !t.vt.modes.has(1006), "mouse reporting off");
  assert.ok(t.vt.modes.has(7) && t.vt.cursorVisible, "autowrap and the cursor are back");
  t.close(); // twice is fine
});

test("prompt box: mode, model, effort and context on its last row; it grows with the text", async () => {
  const t = makeTui({ props: { getStatus: () => STATUS } });
  const p = t.tui.readInput();
  const meta = t.vt.find("qwen3-coder");
  assert.ok(meta > 0);
  const line = t.vt.lines()[meta];
  assert.match(line, /┃\s+Edit · qwen3-coder LM Studio · high\s+12\.3k ━+─+ 34%/);
  t.keys("one\x1b\rtwo\x1b\rthree");
  const rowsNow = t.vt.lines();
  const one = rowsNow.findIndex((l) => l.includes("one"));
  assert.ok(rowsNow[one + 1].includes("two") && rowsNow[one + 2].includes("three"), "alt+enter adds lines");
  assert.equal(t.vt.find("qwen3-coder"), one + 4, "the meta row moved down under the text");
  assert.ok(t.vt.cursorVisible, "the cursor shows in the prompt");
  t.keys("\r");
  assert.equal(await p, "one\ntwo\nthree");
  t.close();
});

test("home screen: the SMOL logo, the prompt under it, hints and the version", () => {
  const { LOGO_ROWS } = require("../dist/logo");
  const t = makeTui({ cols: 80, rows: 24, props: { getStatus: () => STATUS, version: "9.9.9", hintLeft: "~/proj" } });
  t.tui.readInput();
  for (const r of LOGO_ROWS) assert.ok(t.has(r.trimEnd().replace(/[╗╔╝╚║═]/g, (c) => c)), "missing logo row: " + r);
  assert.ok(t.has("coder v9.9.9"));
  assert.ok(t.vt.find("Ask anything") > t.vt.find(LOGO_ROWS[5].trimEnd()), "the prompt is under the logo");
  assert.ok(t.has("ctrl+p palette"));
  assert.ok(t.has("~/proj"));
  t.close();
});

test("picker: starts on the current row, groups under headers, ctrl+f stars in place", async () => {
  const t = makeTui();
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
  const p = t.tui.select("Select model", options, { onStar });
  assert.ok(t.has("This computer"));
  assert.ok(t.has("gpu-box"));
  assert.ok(t.has("Favorite ctrl+f"));
  t.keys("\x06");
  assert.equal(starredWith, 1, "the highlighted (current) row was starred");
  assert.ok(t.has("Favorites"));
  const beta = t.vt.lines().find((l) => l.includes("● beta"));
  assert.match(beta, /● beta.*★/);
  t.keys("\r");
  assert.equal(await p, 0, "the cursor stayed on beta, now first");

  // PgDn/End/Home, and fuzzy filtering over hints and keywords
  const many = Array.from({ length: 30 }, (_, i) => ({ label: `m${i}`, keywords: i === 7 ? "needle" : undefined }));
  let q = t.tui.select("Pick", many);
  t.keys("\x1b[F");
  assert.ok(t.has("m29"));
  t.keys("\x1b[H\x1b[6~");
  t.keys("\r");
  assert.equal(await q, 10);
  q = t.tui.select("Pick", many);
  t.keys("needle\r");
  assert.equal(await q, 7);
  // the wheel moves the selection, a click picks a row
  q = t.tui.select("Pick", many);
  t.keys("\x1b[<65;10;10M\x1b[<65;10;10M");
  const y = t.vt.find("  m5");
  t.keys(`\x1b[<0;20;${y + 1}M`);
  assert.equal(await q, 5);
  t.close();
});

test("input: esc never wipes a draft on one press; alt+enter adds a line; slash menu fuzzy-matches aliases", async () => {
  const cmds = [
    { name: "models", desc: "Switch model", aliases: ["switch"], group: "Model", args: () => [{ label: "next", hint: "next recent" }] },
    { name: "help", desc: "Show help", group: "General" },
    ...Array.from({ length: 12 }, (_, i) => ({ name: `cmd${i}`, desc: `command ${i}` })),
  ];
  const t = makeTui({ props: { slashCommands: cmds, getStatus: () => STATUS } });
  const p = t.tui.readInput();
  t.keys("draft");
  t.keys("\x1b");
  await sleep(60);
  t.keys("!");
  assert.ok(t.has("draft!"), "one esc kept the draft");
  t.keys("\x1b\rline2");
  t.keys("\x1b");
  await sleep(60);
  assert.ok(t.has("Esc again to clear the draft"));
  t.keys("\x1b");
  await sleep(60);
  assert.ok(!t.has("draft!"), "a double esc clears");
  // ↑ restores what was cleared
  t.keys("\x1b[A");
  assert.ok(t.has("draft!"));
  assert.ok(t.has("line2"));
  // slash menu: alias search, scrolling past 8 rows
  t.keys("\x03"); // ctrl+c clears a non-empty draft
  t.keys("/switch");
  assert.ok(t.has("/models"));
  t.keys("\x03");
  t.keys("/");
  assert.ok(t.has("↓ 6 more"));
  t.keys("\x1b[6~\x1b[6~");
  assert.ok(t.has("/cmd11"));
  // args mode: tab on /models inserts "/models " and lists the values
  t.keys("\x15/models");
  t.keys("\t");
  await sleep(10);
  assert.ok(t.has("next recent"));
  t.keys("n");
  await sleep(10);
  t.keys("\r");
  assert.equal(await p, "/models next");
  t.close();
});

test("transcript: user panel, reasoning, markdown, tool rows with a diff, commands, plan and turn footer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-ws-"));
  fs.writeFileSync(path.join(dir, "a.ts"), "line1\nline2\nconst y = 2;\nline4\n");
  const t = makeTui({ cols: 100, rows: 40, props: { getStatus: () => STATUS, workspace: dir } });
  const tui = t.tui;
  const p = tui.readInput();
  t.keys("fix it\r");
  assert.equal(await p, "fix it");
  assert.match(t.vt.lines().find((l) => l.includes("fix it") && l.includes("┃")), /┃  fix it/, "the user message is a panel with a bar");
  tui.startSpinner("thinking");
  tui.thinking("Let me look at the file");
  t.flush();
  assert.ok(t.has("Thinking… Let me look at the file"));
  assert.match(t.screen(), /Thinking · \d+s · esc interrupt/, "the footer shows the action and esc");
  tui.token("Done **now**.\nTail");
  t.flush();
  assert.match(t.screen(), /Thought for \d+\.\ds/);
  assert.ok(t.has("Done now."));
  assert.ok(t.has("Tail"), "the unfinished line shows while it streams");
  tui.toolArgsProgress("write_file", 14200);
  t.flush();
  assert.ok(t.has("Writing a file · 14.2k chars"));
  tui.toolCall("read_file", { path: "a.ts" });
  t.flush();
  assert.match(t.screen(), /Read a\.ts/, "a running tool shows at once");
  tui.toolResult("1 line1", { ok: true, durationMs: 8 });
  tui.toolCall("edit_file", { path: "a.ts" });
  tui.toolResult("Edited a.ts", { ok: true, durationMs: 1234, diff: { path: "a.ts", before: "const x = 1;", after: "const y = 2;" } });
  t.flush();
  assert.match(t.screen(), /→ Read a\.ts\s+✓ 8ms/);
  assert.match(t.screen(), /← Edit a\.ts\s+\+1 -1\s+✓ 1\.2s/);
  assert.match(t.screen(), / 3 - const x = 1;/, "the diff is numbered from where the edit landed");
  assert.match(t.screen(), / 3 \+ const y = 2;/);
  tui.toolCall("run_command", { command: "npm test" });
  tui.status("· approved");
  tui.toolResult("Error: command exited with code 1\nok 1\nok 2\nnot ok 3\n[exit code 1 in 2.0s]", { ok: false, durationMs: 2000 });
  t.flush();
  assert.match(t.screen(), /\$ npm test\s+✗ exit 1 · 2\.0s/);
  assert.ok(t.has("not ok 3"));
  assert.ok(t.has("approved"), "a status line while busy stays in the transcript");
  tui.planUpdated({ steps: [{ text: "Read", done: true }, { text: "Fix", done: false }], currentIndex: 1, doneCount: 1 });
  tui.planUpdated({ steps: [{ text: "Read", done: true }, { text: "Fix", done: true }], currentIndex: -1, doneCount: 2 });
  t.flush();
  assert.equal(t.screen().split("Plan 2/2").length - 1, 1, "one plan per turn, the latest");
  assert.ok(!t.has("Plan 1/2"));
  tui.turnEnd("4.2s · 3 tools");
  t.flush();
  assert.match(t.screen(), /Edit · qwen3-coder · 4\.2s · 3 tools/);
  assert.doesNotMatch(t.screen(), /esc interrupt/, "the footer goes back to idle when the turn ends");
  tui.error("\nbackend error: boom");
  t.flush();
  assert.match(t.screen(), /┃  ✗ backend error: boom/);
  t.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scrolling: pgup leaves the bottom, new output shows a new-messages pill, end returns", async () => {
  const t = makeTui({ cols: 80, rows: 20, props: { getStatus: () => STATUS } });
  const tui = t.tui;
  const p = tui.readInput();
  t.keys("go\r");
  await p;
  for (let i = 0; i < 40; i++) tui.println(`line ${i}\nmore ${i}`);
  t.flush();
  assert.ok(t.has("more 39"), "stuck to the bottom");
  t.keys("\x1b[5~");
  assert.ok(!t.has("more 39"));
  assert.match(t.screen(), /↓ \d+ more lines/);
  tui.token("fresh reply\n");
  t.flush();
  assert.ok(t.has("New messages"));
  // the wheel scrolls back down to the bottom
  t.keys("\x1b[<65;5;5M".repeat(30));
  assert.ok(t.has("fresh reply"));
  assert.ok(!t.has("New messages"));
  t.close();
});

test("selection: dragging over the transcript copies the text with OSC 52 and says so", async () => {
  const t = makeTui({ cols: 80, rows: 20, props: { getStatus: () => STATUS } });
  const p = t.tui.readInput();
  t.keys("hello\r");
  await p;
  t.tui.token("The quick brown fox\njumps over the lazy dog\n");
  t.tui.turnEnd("1s");
  t.flush();
  const y = t.vt.find("The quick brown fox");
  const x = t.vt.lines()[y].indexOf("The");
  t.keys(`\x1b[<0;${x + 1};${y + 1}M\x1b[<32;${x + 10};${y + 2}M\x1b[<0;${x + 10};${y + 2}m`);
  const osc = t.vt.osc.find((o) => o.startsWith("52;c;"));
  assert.ok(osc, "copied with OSC 52");
  assert.equal(Buffer.from(osc.slice(5), "base64").toString("utf8"), "The quick brown fox\njumps over");
  assert.ok(t.has("Copied 30 characters"));
  t.close();
});

test("approval: a dialog with allow once, always and deny; keys and arrows answer it", async () => {
  const t = makeTui({ props: { getStatus: () => STATUS } });
  let r = t.tui.confirmCommand("rm -rf build", "deletes outside the workspace");
  assert.ok(t.has("Allow this command?"));
  assert.ok(t.has("$ rm -rf build"));
  assert.ok(t.has("deletes outside the workspace"));
  assert.ok(t.has("Always allow rm this session"));
  t.keys("a");
  assert.equal(await r, "always");
  r = t.tui.confirmCommand("ls");
  t.keys(DOWN + DOWN + "\r");
  assert.equal(await r, "no");
  r = t.tui.confirmCommand("ls");
  t.keys("\r");
  assert.equal(await r, "yes");
  r = t.tui.confirmCommand("ls");
  t.keys("\x1b");
  await sleep(60);
  assert.equal(await r, "no", "esc denies");
  t.close();
});

test("palette and help: ctrl+p lists grouped commands with keys; /help is a dialog; F2 sends /models next", async () => {
  const cmds = [
    { name: "mode", desc: "Set mode", group: "Model", key: "shift+tab" },
    { name: "help", desc: "Show help", group: "General", aliases: ["?"] },
    { name: "clear", desc: "Start a new conversation", group: "Session" },
  ];
  const t = makeTui({ props: { slashCommands: cmds } });
  let p = t.tui.readInput();
  t.keys("\x10");
  assert.ok(t.has("Commands"));
  assert.ok(t.has("Model"));
  assert.ok(t.has("shift+tab"));
  t.keys("clear\r");
  assert.equal(await p, "/clear");
  p = t.tui.readInput();
  t.keys("/help\r");
  await sleep(5);
  assert.ok(t.has("Help"), "/help opens a dialog instead of printing");
  t.keys("history");
  assert.ok(t.has("ctrl+r"), "the keyboard list is in it");
  t.keys("\x15mode\r");
  assert.equal(await p, "/mode", "choosing a command in help runs it");
  p = t.tui.readInput();
  t.keys("\x1bOQ");
  assert.equal(await p, "/models next", "F2 sends /models next");
  t.close();
});

test("@ mentions insert the relative path only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-at-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "SECRET CONTENTS");
  const t = makeTui({ props: { workspace: dir } });
  const p = t.tui.readInput();
  t.keys("look at @");
  assert.ok(t.has("src/"));
  assert.ok(t.has("Files"));
  t.keys("\t");
  assert.ok(t.has("src/app.ts"), "tab stepped into the folder");
  t.keys("\r");
  t.keys("\r");
  const text = await p;
  assert.equal(text, "look at src/app.ts");
  assert.doesNotMatch(text, /SECRET/);
  t.close();
});

test("type-ahead: text typed during a turn is queued and sent at the next prompt", async () => {
  const t = makeTui({ props: { getStatus: () => STATUS } });
  let p = t.tui.readInput();
  t.keys("first\r");
  await p;
  t.keys("second\r");
  assert.ok(t.has("Queued"));
  t.tui.turnEnd("1s");
  p = t.tui.readInput();
  assert.equal(await p, "second");
  t.close();
});

test("resize, NO_COLOR and ASCII: the layout follows the size; no colours or box glyphs when told", () => {
  const t = makeTui({ cols: 80, rows: 24, props: { getStatus: () => STATUS } });
  t.tui.readInput();
  t.out.resize(60, 20);
  t.flush();
  assert.ok(t.vt.lines().every((l) => stringWidth(l) <= 60));
  assert.ok(t.has("Ask anything"));
  t.close();
  setTheme({ color: false });
  const n = makeTui({ props: { getStatus: () => STATUS } });
  n.tui.readInput();
  assert.doesNotMatch(n.writes.join(""), /\x1b\[[0-9;]*(38|48);[25];/, "NO_COLOR: no colour escapes");
  n.close();
  setTheme({ color: true, ascii: true });
  const a = makeTui({ props: { getStatus: () => STATUS } });
  a.tui.readInput();
  assert.doesNotMatch(a.screen(), /[┃╹▀─━]/);
  assert.ok(a.has("Ask anything"));
  a.close();
  setTheme({ ascii: false });
});
