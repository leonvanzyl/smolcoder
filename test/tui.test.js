// The TUI's pickers and prompts, driven by feeding keys to a fake stdin and
// reading the screen of an emulated terminal.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeTui, sleep, DOWN, UP } = require("./tui-harness");
// Unicode glyphs whatever console runs the tests (plain conhost gets ASCII).
require("../dist/tui/theme").setTheme({ ascii: false, color: true });

test("tui: a text prompt edits one line, submits on enter and cancels on ctrl+c", async () => {
  const t = makeTui();
  t.tui.start(); // startup may open it before the session does
  const p = t.tui.prompt("Address of the machine", "192.168.1.50");
  assert.ok(t.has("Address of the machine"));
  assert.ok(t.has("192.168.1.50"), "the placeholder shows while empty");
  t.keys("gpu-bx");
  assert.ok(t.has("gpu-bx"));
  t.keys("\x7f"); // backspace
  t.keys("ox.local\r");
  assert.equal(await p, "gpu-box.local", "start() twice did not double the keystrokes");
  assert.ok(t.has("Address of the machine: gpu-box.local"), "the answer is noted");

  const cancelled = t.tui.prompt("Name");
  t.keys("half\x03");
  assert.equal(await cancelled, null);
  const empty = t.tui.prompt("Name");
  t.keys("  \r");
  assert.equal(await empty, null);
  const secret = t.tui.prompt("API key", "", { secret: true });
  t.keys("sk-123");
  assert.ok(!t.has("sk-123"), "a secret is masked while typed");
  assert.ok(t.has("••••••"));
  t.keys("\r");
  assert.equal(await secret, "sk-123");
  assert.ok(!t.has("sk-123"));
  t.close();
});

test("tui: a long list scrolls with the selection, so rows past the tenth can be reached", async () => {
  const t = makeTui({ cols: 80, rows: 24 });
  const options = Array.from({ length: 15 }, (_, i) => ({ label: `model-${String(i + 1).padStart(2, "0")}` }));
  options.push({ label: "+ Find models on another machine…" });
  const p = t.tui.select("Select model", options);
  assert.ok(t.has("model-10"));
  assert.ok(!t.has("model-11"));
  assert.ok(t.has("↓ 6 more"));

  t.keys(DOWN.repeat(12));
  assert.ok(t.has("model-13"));
  assert.ok(!t.has("model-03"));
  assert.ok(t.has("↑ 3 more"));
  assert.ok(t.has("↓ 3 more"));

  // Up from the top wraps to the bottom: the network row is one keypress away.
  t.keys(UP.repeat(13));
  assert.ok(t.has("Find models on another machine"));
  t.keys("\r");
  assert.equal(await p, 15);
  t.close();
});

test("tui: /model + enter opens the model picker; values only after tab or a typed space", async () => {
  const cmds = [
    { name: "models", desc: "Switch model", aliases: ["model"], args: () => [{ label: "next" }] },
    { name: "help", desc: "Show help" },
  ];
  const submit = async (typed) => {
    const t = makeTui({ props: { slashCommands: cmds } });
    const p = t.tui.readInput();
    for (const k of typed) {
      t.keys(k);
      await sleep(30); // arg values load asynchronously
    }
    const text = await p;
    t.close();
    return String(text).trim();
  };
  assert.equal(await submit(["/model", "\r"]), "/models", "enter on the highlighted command runs it bare");
  assert.equal(await submit(["/models ", "\r"]), "/models", "a trailing space with no value still opens the picker");
  assert.equal(await submit(["/mod", "\t", "ne", "\r"]), "/models next", "tab completes, then a value can be picked");
});

test("tui: /model + enter opens the model picker; values only after tab or a typed space", async () => {
  const cmds = [
    { name: "models", desc: "Switch model", aliases: ["model"], args: () => [{ label: "next" }] },
    { name: "help", desc: "Show help" },
  ];
  const submit = async (typed) => {
    // Redraws also land on timers, so swallow output for the whole exchange.
    const real = process.stdout.write;
    process.stdout.write = () => true;
    try {
      return await submitQuiet(typed);
    } finally {
      process.stdout.write = real;
    }
  };
  const submitQuiet = async (typed) => {
    const tui = new Tui({ historyFile: null });
    tui.slashCommands = cmds;
    let p;
    capture(() => { tui.start(); p = tui.readInput(); });
    for (const k of typed) {
      capture(() => keys(k));
      await new Promise((r) => setTimeout(r, 60)); // arg values load asynchronously
    }
    const text = await p;
    capture(() => tui.close());
    return String(text).trim();
  };
  assert.equal(await submit(["/model", "\r"]), "/models", "enter on the highlighted command runs it bare");
  assert.equal(await submit(["/models ", "\r"]), "/models", "a trailing space with no value still opens the picker");
  assert.equal(await submit(["/mod", "\t", "ne", "\r"]), "/models next", "tab completes, then a value can be picked");
});
