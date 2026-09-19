// Right-to-left text (Hebrew, Arabic) in the web transcript: every block
// picks its own direction from its first strong character, so mixed-language
// sessions stay readable and English renders exactly as before.
const test = require("node:test");
const assert = require("node:assert/strict");
const { CLIENT_JS } = require("../dist/web/client");
const { STYLES } = require("../dist/web/styles");

// The markdown renderer lives inside the page script; lift it out to call it.
const from = CLIENT_JS.indexOf("function esc(");
const to = CLIENT_JS.indexOf("// ---- ANSI");
const renderMarkdown = new Function(CLIENT_JS.slice(from, to) + "\nreturn renderMarkdown;")();

test("rtl: lists, quotes and tables resolve their direction from their content", () => {
  const html = renderMarkdown("- אחד\n- two\n\n1. שלוש\n\n> ציטוט\n\n| שם | גיל |\n|---|---|\n| דני | 3 |");
  assert.match(html, /<ul dir="rtl">/);
  assert.match(html, /<ol dir="rtl">/);
  assert.match(html, /<blockquote dir="rtl">/);
  assert.match(html, /<table dir="rtl">/);
});

test("rtl: a Hebrew block that opens with an English word or code is still RTL", () => {
  assert.match(renderMarkdown("Git היא מערכת בקרת גרסאות (Distributed Version Control System) שמאפשרת לעקוב אחר שינויים."), /^<p dir="rtl">/);
  const list = renderMarkdown("- `git init` – יוצא מאגר חדש.\n- `git add .` – מוסיף שינויים.");
  assert.match(list, /^<ul dir="rtl"><li>/, "bullets sit on the same side as the text");
  assert.match(renderMarkdown("| מושג | תיאור |\n|---|---|\n| Repository | המאגר שמכיל את הקבצים |"), /^<table dir="rtl">/);
});

test("rtl: English stays exactly as it was, even when it quotes Hebrew", () => {
  assert.equal(renderMarkdown("The word שלום means peace."), "<p>The word שלום means peace.</p>");
  assert.equal(renderMarkdown("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
  // A mixed list: the English item keeps its own direction inside an RTL list.
  assert.match(renderMarkdown("- פריט ראשון\n- The second item"), /<ul dir="rtl"><li>פריט ראשון<\/li><li dir="ltr">The second item<\/li><\/ul>/);
});

test("rtl: text blocks follow their own first strong character, lists and quotes use logical sides", () => {
  // Inline code keeps its own order inside a Hebrew sentence: parseDate(), not ()parseDate.
  assert.match(STYLES, /\.md code \{ unicode-bidi: plaintext; \}/);
  // Physical left-side spacing would put markers and quote bars on the wrong
  // edge of an RTL block.
  for (const rule of [".md ul, .md ol", ".md blockquote", ".md th, .md td"]) {
    const body = STYLES.slice(STYLES.indexOf(rule + " {")).split("}")[0];
    assert.doesNotMatch(body, /(padding|border|margin)-left|text-align:\s*left/, rule);
  }
});

test("rtl: the message box, user messages and session titles follow what is typed", () => {
  const { PAGE_HTML } = require("../dist/web/page");
  assert.match(PAGE_HTML, /<textarea id="input"[^>]*dir="auto"/);
  assert.match(CLIENT_JS, /d\.dir = dirOf\(/, "user messages by majority");
  assert.match(CLIENT_JS, /input\.dir = dirOf\(/, "the message box follows what is typed");
  for (const sel of [".thought-body", ".stitle", "#crumb .title"]) {
    const rule = STYLES.split("}").find((r) => r.includes(sel) && r.includes("unicode-bidi"));
    assert.ok(rule, sel + " should resolve its direction per paragraph");
  }
});
