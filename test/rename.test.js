// Renaming a session from the sidebar: a visible pencil (and double-click)
// turns the title into a text field in place. The sidebar is rebuilt on every
// hub update and every 30 s, so the edit lives outside the DOM and survives.
const test = require("node:test");
const assert = require("node:assert/strict");
const { CLIENT_JS } = require("../dist/web/client");
const { PAGE_HTML } = require("../dist/web/page");

test("rename: a visible pencil, not a hidden double-click into the browser's prompt()", () => {
  assert.doesNotMatch(CLIENT_JS, /prompt\("Rename session"/, "the native prompt is gone");
  assert.match(CLIENT_JS, /setAttribute\("aria-label", "Rename session"\)/);
  assert.match(CLIENT_JS, /row\.ondblclick = \(\) => startRename\(/, "double-click still works, into the same field");
});

test("rename: typing survives the sidebar being rebuilt underneath it", () => {
  const render = CLIENT_JS.slice(CLIENT_JS.indexOf("function renderSidebar()"), CLIENT_JS.indexOf("function removeWorkspace("));
  assert.match(render, /renaming && renaming\.id === s\.id/, "the row being renamed is drawn as a field again");
  assert.match(CLIENT_JS, /renaming\.value = field\.value/, "what was typed is kept outside the DOM");
});

test("rename: Enter saves, Esc cancels without reaching the page (which would cancel the turn)", () => {
  const edit = CLIENT_JS.slice(CLIENT_JS.indexOf("function renameField("), CLIENT_JS.indexOf("function renameField(") + 1500);
  assert.match(edit, /e\.key === "Enter"\) \{ e\.preventDefault\(\); endRename\(true\)/);
  assert.match(edit, /e\.key === "Escape"\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); endRename\(false\)/);
  const end = CLIENT_JS.slice(CLIENT_JS.indexOf("function endRename("), CLIENT_JS.indexOf("function renameField("));
  assert.match(end, /if \(save && r && r\.value\.trim\(\)\) post\("\/sessions\/rename"/, "saving posts the name; an empty one is not sent");
  assert.match(edit, /field\.dir = "auto"/, "a Hebrew name types right to left");
  const script = PAGE_HTML.slice(PAGE_HTML.lastIndexOf("<script>") + 8, PAGE_HTML.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script), "the page script still parses");
});

test("rename: the sidebar rebuilding under the field is not a click away", () => {
  // Seen live: Chrome fires blur on a focused element as it is removed, so a
  // rebuild mid-typing used to save half a name and drop the rest.
  const render = CLIENT_JS.slice(CLIENT_JS.indexOf("function renderSidebar()"), CLIENT_JS.indexOf("function removeWorkspace("));
  assert.match(render, /sidebarRebuilding = true;\s*list\.innerHTML = "";\s*sidebarRebuilding = false;/);
  const edit = CLIENT_JS.slice(CLIENT_JS.indexOf("function renameField("), CLIENT_JS.indexOf("function renderSidebar()"));
  assert.match(edit, /field\.onblur = \(\) => \{ if \(sidebarRebuilding\) return;/);
});
