// Drives a Tui through fake terminal streams into the VT emulator, so tests
// read the screen the way a user would see it.
"use strict";
const { EventEmitter } = require("node:events");
const { VT } = require("./vt");
const { Tui } = require("../dist/tui/tui");

function fakeStdin() {
  const e = new EventEmitter();
  e.isTTY = false; // no colour query: nothing answers it
  e.setRawMode = () => {};
  e.resume = () => {};
  e.pause = () => {};
  e.setEncoding = () => {};
  return e;
}

/** A started Tui on a cols×rows emulated terminal. */
function makeTui(opts = {}) {
  const vt = new VT(opts.cols ?? 80, opts.rows ?? 24);
  const stdin = fakeStdin();
  const out = vt.stdout();
  const writes = [];
  const realWrite = out.write;
  out.write = (s) => {
    writes.push(String(s));
    return realWrite(s);
  };
  const tui = new Tui({ historyFile: null, stdout: out, stdin });
  Object.assign(tui, opts.props ?? {});
  if (opts.start !== false) tui.start();
  return {
    tui,
    vt,
    out,
    writes,
    /** Feed keys; the frame they cause is drawn synchronously. */
    keys: (s) => stdin.emit("data", s),
    /** Draw pending changes now (streamed output is drawn on a timer). */
    flush: () => tui["render"](),
    screen: () => vt.text(),
    has: (s) => vt.has(s),
    close: () => tui.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { makeTui, fakeStdin, sleep, DOWN: "\x1b[B", UP: "\x1b[A", ESC: "\x1b", ENTER: "\r" };
