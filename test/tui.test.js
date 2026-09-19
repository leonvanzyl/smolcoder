// The TUI's pickers, driven by feeding keys to stdin and reading the frames it
// draws. stdout is only captured inside synchronous sections so the test
// runner's own output is never swallowed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Tui } = require("../dist/tui/tui");

function capture(fn) {
  const real = process.stdout.write;
  let out = "";
  process.stdout.write = (s) => ((out += s), true);
  try {
    fn();
  } finally {
    process.stdout.write = real;
  }
  // eslint-disable-next-line no-control-regex
  return out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}
const keys = (s) => process.stdin.emit("data", s);
const DOWN = "\x1b[B";
const UP = "\x1b[A";

test("tui: a text prompt edits one line, submits on enter and cancels on ctrl+c", async () => {
  const tui = new Tui();
  let p;
  const frame = capture(() => {
    tui.start();
    tui.start(); // startup may open it before the session does
    p = tui.prompt("Address of the machine", "192.168.1.50");
  });
  assert.match(frame, /Address of the machine/);
  assert.match(frame, /192\.168\.1\.50/, "the placeholder shows while empty");
  const typed = capture(() => keys("gpu-bx"));
  assert.match(typed, /gpu-bx/);
  const echoed = capture(() => {
    keys("\x7f"); // backspace
    keys("ox.local\r");
  });
  assert.equal(await p, "gpu-box.local", "start() twice did not double the keystrokes");
  assert.match(echoed, /Address of the machine: gpu-box\.local/);

  let cancelled, empty;
  capture(() => {
    cancelled = tui.prompt("Name");
    keys("half\x03");
  });
  assert.equal(await cancelled, null);
  capture(() => {
    empty = tui.prompt("Name");
    keys("  \r");
  });
  assert.equal(await empty, null);
  capture(() => tui.close());
});

test("tui: a long list scrolls with the selection, so rows past the tenth can be reached", async () => {
  const tui = new Tui();
  const options = Array.from({ length: 15 }, (_, i) => ({ label: `model-${String(i + 1).padStart(2, "0")}` }));
  options.push({ label: "+ Find models on another machine…" });
  let p;
  const first = capture(() => {
    tui.start();
    p = tui.select("Select model", options);
  });
  assert.match(first, /model-10/);
  assert.doesNotMatch(first, /model-11/);
  assert.match(first, /↓ 6 more/);

  const scrolled = capture(() => keys(DOWN.repeat(12)));
  const last = scrolled.slice(scrolled.lastIndexOf("Select model"));
  assert.match(last, /model-13/);
  assert.doesNotMatch(last, /model-03/);
  assert.match(last, /↑ 3 more/);
  assert.match(last, /↓ 3 more/);

  // Up from the top wraps to the bottom: the network row is one keypress away.
  const wrapped = capture(() => {
    keys(UP.repeat(13));
  });
  assert.match(wrapped.slice(wrapped.lastIndexOf("Select model")), /Find models on another machine/);
  capture(() => keys("\r"));
  assert.equal(await p, 15);
  capture(() => tui.close());
});
