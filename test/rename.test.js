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

// The rename field and the press hold, lifted out of the page script and run
// against stand-ins for the DOM, so these tests exercise what the code does.
function loadSidebar() {
  const code = CLIENT_JS.slice(CLIENT_JS.indexOf("let renaming = null;"), CLIENT_JS.indexOf("function renderSidebar()"));
  const listeners = { list: {}, window: {} }, timers = [], posts = [];
  let renders = 0;
  const render = () => { renders++; };
  const on = (where) => ({ addEventListener: (type, fn, capture) => { listeners[where][type] = { fn, capture }; } });
  const list = on("list"), win = on("window");
  const el = (tag, className) => ({ tag, className, setAttribute() {}, focus() {}, select() {} });
  const api = new Function("$", "window", "document", "el", "post", "renderSidebar", "setTimeout",
    code + "\nreturn { startRename, renameField, sidebarHeld, renaming: () => renaming };")(
    () => list, win, { hasFocus: () => true }, el,
    (url, body) => posts.push([url, body]), render, (fn) => timers.push(fn));
  return { api, listeners, win, timers, posts, render, renders: () => renders };
}

function key(name, extra = {}) {
  const e = { key: name, keyCode: 0, isComposing: false, stopped: false, prevented: false, ...extra };
  e.stopPropagation = () => { e.stopped = true; };
  e.preventDefault = () => { e.prevented = true; };
  return e;
}

test("rename: keys an IME is composing with stay with the IME", () => {
  const { api, posts } = loadSidebar();
  api.startRename("s1", "old");
  const field = api.renameField({ id: "s1" });
  field.value = "新しい名前"; field.oninput();
  const pick = key("Enter", { isComposing: true, keyCode: 229 });
  field.onkeydown(pick);
  assert.equal(posts.length, 0, "the Enter that picks the characters does not save");
  assert.ok(pick.stopped);
  field.onkeydown(key("Enter", { keyCode: 229 })); // Safari: the closing Enter says only 229
  assert.equal(posts.length, 0);
  const drop = key("Escape", { isComposing: true });
  field.onkeydown(drop);
  assert.ok(drop.stopped, "the page reads a stray Esc as cancel the turn");
  assert.ok(api.renaming(), "dropping the characters is not cancelling the rename");
  field.onkeydown(key("Enter"));
  assert.deepEqual(posts, [["/sessions/rename", { id: "s1", title: "新しい名前" }]]);
});

test("rename: clicking another session while renaming opens it on the first click", () => {
  const { api, listeners, win, timers, posts, render, renders } = loadSidebar();
  const code = CLIENT_JS.slice(CLIENT_JS.indexOf("function renderSidebar()"), CLIENT_JS.indexOf("function removeWorkspace("));
  assert.match(code, /^function renderSidebar\(\) \{\s*if \(sidebarHeld\(\)\) return;/, "every rebuild asks first");
  api.startRename("s1", "old");
  const field = api.renameField({ id: "s1" });
  field.value = "new name"; field.oninput();
  const before = renders(), queued = timers.length; // renameField queues its own focus

  // The press on another row moves focus, and the blur saves the name.
  listeners.list.pointerdown.fn();
  field.onblur();
  assert.deepEqual(posts, [["/sessions/rename", { id: "s1", title: "new name" }]]);
  // Rebuilds wait while the button is down, so the row under it survives...
  assert.equal(api.sidebarHeld(), true);
  assert.equal(timers.length, queued);
  // ...and run once it comes up, queued behind the click.
  listeners.window.pointerup.fn();
  assert.equal(api.sidebarHeld(), false);
  assert.equal(timers.length, queued + 1);
  assert.equal(timers[queued], render);
  timers[queued]();
  assert.equal(renders(), before + 2, "endRename's own render, then the held one");

  // A release with nothing waiting queues nothing.
  listeners.list.pointerdown.fn();
  listeners.window.pointercancel.fn();
  assert.equal(timers.length, queued + 1);

  // Only the window's own blur releases a press: a captured listener would
  // also hear the field's blur, which happens during the press itself.
  assert.notEqual(listeners.window.blur.capture, true);
  listeners.list.pointerdown.fn();
  listeners.window.blur.fn({ target: field });
  assert.equal(api.sidebarHeld(), true);
  listeners.window.blur.fn({ target: win });
  assert.equal(api.sidebarHeld(), false);
});
