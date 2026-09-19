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
  assert.match(html, /<ul dir="auto">/);
  assert.match(html, /<ol dir="auto">/);
  assert.match(html, /<blockquote dir="auto">/);
  assert.match(html, /<table dir="auto">/);
});

test("rtl: text blocks follow their own first strong character, lists and quotes use logical sides", () => {
  assert.match(STYLES, /unicode-bidi:\s*plaintext/);
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
  for (const sel of [".user", ".thought-body", ".stitle", "#crumb .title", "#input"]) {
    const rule = STYLES.split("}").find((r) => r.includes(sel) && r.includes("unicode-bidi"));
    assert.ok(rule, sel + " should resolve its direction per paragraph");
  }
});
