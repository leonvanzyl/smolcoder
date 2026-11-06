#!/usr/bin/env node
// Screenshots of the TUI: drives the real Tui through scenarios into the VT
// emulator in test/vt.js, renders each final screen to HTML with its exact
// colours, and (when Playwright is at hand) screenshots it.
//
//   npm run build
//   node scripts/tui-shots.cjs <out-dir>
//
// PLAYWRIGHT_PATH points at a playwright package folder and CHROME_PATH at a
// Chromium binary; without them only the .html files are written.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { VT, toHTML } = require("../test/vt");
const { Tui } = require("../dist/tui/tui");
const { setTheme, theme } = require("../dist/tui/theme");
const { BUILTIN_COMMANDS } = require("../dist/commands");

const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), "smol-tui-shots"));
fs.mkdirSync(OUT, { recursive: true });
const ONLY = process.env.SHOTS_ONLY ? process.env.SHOTS_ONLY.split(",") : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "#" + n.toString(16).padStart(6, "0");

function fakeIn() {
  const e = new EventEmitter();
  e.isTTY = false; // no colour query: nothing answers it
  e.setRawMode = () => {};
  e.resume = () => {};
  e.pause = () => {};
  e.setEncoding = () => {};
  return e;
}

const D = "\x1b[2m";
const R = "\x1b[0m";
const STATUS = `\x1b[36;1medit${R} · qwen3-coder-30b-a3b-instruct ${D}LM Studio${R} · \x1b[33mhigh${R} · ${D}12.3k (34%)${R}`;

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-shot-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "src", "parse.ts"),
    [
      "// ISO 8601 dates: calendar, ordinal and week forms.",
      "import { DateParts } from './types';",
      "",
      "const CALENDAR = /^(\\d{4})-?(\\d{2})-?(\\d{2})$/;",
      "const WEEK = /^(\\d{4})-?W(\\d{2})-?(\\d)?$/;",
      "",
      "export function parseWeek(s: string): DateParts | null {",
      "  const m = WEEK.exec(s);",
      "  if (!m) return null;",
      "  const [, y, w, d = '1'] = m;",
      "  const jan4 = new Date(Date.UTC(+y, 0, 4));",
      "  const offset = (jan4.getUTCDay() + 6) % 7;",
      "  const day = (+w - 1) * 7 + (+d - 1) - offset + 3;",
      "  return fromUtc(Date.UTC(+y, 0, 1 + day));",
      "}",
      "",
    ].join("\n")
  );
  return dir;
}

function commands() {
  return BUILTIN_COMMANDS.map((c) =>
    c.name === "models"
      ? { ...c, args: () => [{ label: "next", hint: "switch to the next recent model" }, { label: "qwen3-coder-30b-a3b-instruct", hint: "LM Studio", current: true }] }
      : c
  );
}

async function setup(cols, rows, light) {
  const mode = process.env.SHOTS_MODE || "";
  setTheme({ color: mode !== "nocolor", truecolor: mode !== "256", ascii: mode === "ascii", light, bg: light ? 0xffffff : 0x101216 });
  const vt = new VT(cols, rows);
  const stdin = fakeIn();
  const tui = new Tui({ historyFile: null, stdout: vt.stdout(), stdin });
  tui.version = "0.8.0";
  tui.hintLeft = "~/projects/datekit";
  tui.slashCommands = commands();
  tui.getStatus = () => STATUS;
  const ws = workspace();
  tui.workspace = ws;
  tui.start();
  const keys = async (s, wait = 5) => {
    stdin.emit("data", s);
    await sleep(wait);
  };
  return { vt, tui, keys, ws };
}

const PARSE_BEFORE = "  const [, y, w, d = '1'] = m;\n  const jan4 = new Date(Date.UTC(+y, 0, 4));\n  const offset = jan4.getUTCDay();\n  const day = (+w - 1) * 7 + +d - offset;";
const PARSE_AFTER = "  const [, y, w, d = '1'] = m;\n  const jan4 = new Date(Date.UTC(+y, 0, 4));\n  const offset = (jan4.getUTCDay() + 6) % 7;\n  const day = (+w - 1) * 7 + (+d - 1) - offset + 3;";

const SUMMARY = [
  "## Fixed ISO week dates",
  "",
  "The week branch used Sunday as day 0 and forgot the **Thursday rule**, so `2026-W05-3` landed two days early. Now:",
  "",
  "- the weekday offset counts from Monday (`(getUTCDay() + 6) % 7`)",
  "- the day index is shifted by 3, so week 1 is the week with the year's first Thursday",
  "- all 48 parser tests pass",
  "",
  "```ts",
  "const offset = (jan4.getUTCDay() + 6) % 7;",
  "const day = (+w - 1) * 7 + (+d - 1) - offset + 3; // Thursday rule",
  "```",
  "",
  "| Input | Before | After |",
  "|---|---|---|",
  "| `2026-W05-3` | 2026-01-26 | 2026-01-28 |",
  "| `2026W011` | 2025-12-27 | 2025-12-29 |",
  "| `2020-W53-7` | Invalid date | 2021-01-03 |",
  "",
].join("\n");

async function session(t, opts = {}) {
  const { tui, keys } = t;
  const input = tui.readInput();
  await keys("The week-date parser is off by a couple of days. Fix it and make sure the tests pass.");
  await keys("\r");
  await input;
  tui.startSpinner("thinking");
  tui.thinking("The user says week dates are off by two days. ISO weeks start on Monday and week 1 contains the first Thursday. ");
  tui.thinking("Let me read the parser and check how the offset is computed.");
  // Pretend the reasoning took a few seconds.
  for (const b of tui["blocks"]) if (b.kind === "reasoning") b.start -= 3400;
  await sleep(5);
  const plan = { steps: [{ text: "Read the week-date parser", done: false }, { text: "Fix the weekday offset", done: false }, { text: "Run the tests", done: false }], get currentIndex() { return this.steps.findIndex((s) => !s.done); }, get doneCount() { return this.steps.filter((s) => s.done).length; } };
  tui.toolCall("plan", { action: "set", steps: "a\nb\nc" });
  tui.planUpdated(plan);
  tui.toolCall("read_file", { path: "src/parse.ts" });
  tui.toolResult("1 // ISO 8601 dates…", { ok: true, durationMs: 8 });
  tui.toolCall("search", { pattern: "parseWeek", path: "src" });
  tui.toolResult("src/parse.ts:7: export function parseWeek", { ok: true, durationMs: 21 });
  plan.steps[0].done = true;
  tui.toolCall("plan", { action: "done", step: 1 });
  tui.planUpdated(plan);
  tui.token("The offset uses `getUTCDay()` directly, which treats **Sunday** as day 0, and the Thursday rule is missing. ");
  tui.token("I'll fix both lines.\n");
  tui.toolCall("edit_file", { path: "src/parse.ts" });
  tui.toolResult("Edited src/parse.ts", { ok: true, durationMs: 12, diff: { path: "src/parse.ts", before: PARSE_BEFORE, after: PARSE_AFTER } });
  tui.toolCall("run_command", { command: "npm test -- parse" });
  tui.toolResult(
    "Error: command exited with code 1\n> datekit@1.4.0 test\n> node --test test/parse.test.js\n✔ calendar dates (2ms)\n✔ ordinal dates (1ms)\n✖ week dates (4ms)\n  AssertionError: expected 2020-12-29, got 2020-12-28\n    at test/parse.test.js:41:12\n[exit code 1 in 1.9s]",
    { ok: false, durationMs: 1940 }
  );
  tui.token("One case left: `d` defaults to the string `'1'`; the year boundary is right now. Re-running after rebuilding.\n");
  tui.toolCall("run_command", { command: "npm run build && npm test" });
  tui.toolResult("> datekit@1.4.0 test\n> node --test\n✔ calendar dates (2ms)\n✔ ordinal dates (1ms)\n✔ week dates (3ms)\nℹ tests 48\nℹ pass 48\n[exit code 0 in 3.2s]", { ok: true, durationMs: 3240 });
  plan.steps[1].done = true;
  plan.steps[2].done = true;
  tui.toolCall("plan", { action: "done", step: 3 });
  tui.planUpdated(plan);
  if (opts.stopBeforeSummary) return;
  tui.token(SUMMARY);
  tui.println("");
  tui.turnEnd("14.2s · 6 tools · 1.4k tok @ 52 tok/s");
}

const SCENARIOS = {
  async home(t) {
    t.tui.readInput();
    await sleep(5);
  },
  async session(t) {
    await session(t);
    t.tui.readInput();
    await sleep(5);
  },
  async slash(t) {
    await session(t);
    t.tui.readInput();
    await t.keys("/m");
  },
  async models(t) {
    await session(t);
    t.tui.readInput();
    const opts = [
      { label: "qwen3-coder-30b-a3b-instruct", hint: "LM Studio · 128k · tools", group: "Favorites", starred: true, current: true },
      { label: "gpt-oss-20b", hint: "Ollama · 128k · tools · reasoning", group: "Favorites", starred: true },
      { label: "devstral-small-2507", hint: "LM Studio · 128k · tools", group: "Recent" },
      { label: "qwen3:8b", hint: "Ollama · 40k · tools", group: "This computer" },
      { label: "llama3.2:3b", hint: "Ollama · 128k · tools", group: "This computer" },
      { label: "glm-4.7-flash", hint: "Ollama @ gpu-box · 200k · tools", group: "gpu-box" },
      { label: "qwen3-coder-480b", hint: "Ollama @ gpu-box · 256k · tools", group: "gpu-box" },
      { label: "↻ Refresh / find on network", hint: "look again here and on added machines", group: "Network" },
      { label: "+ Find models on another machine…", hint: "search my network or enter an address", group: "Network" },
    ];
    t.tui.select("Select model", opts, { onStar: () => opts });
    await sleep(5);
    await t.keys("\x1b[B");
    await t.keys("\x1b[B");
  },
  async palette(t) {
    await session(t);
    t.tui.readInput();
    await t.keys("\x10");
  },
  async approval(t) {
    await session(t, { stopBeforeSummary: true });
    t.tui.toolCall("run_command", { command: "curl -fsSL https://get.pnpm.io/install.sh | sh -" });
    t.tui.confirmCommand("curl -fsSL https://get.pnpm.io/install.sh | sh -", "Pipes a downloaded script into a shell and reaches outside the workspace.");
    await sleep(5);
  },
  async toast(t) {
    await session(t);
    t.tui.readInput();
    await sleep(5);
    // Drag across two transcript rows: the selection is copied.
    const y = t.vt.find("Fixed ISO week dates");
    await t.keys(`\x1b[<0;6;${y + 1}M`);
    await t.keys(`\x1b[<32;40;${y + 3}M`);
    await t.keys(`\x1b[<0;40;${y + 3}m`);
  },
  async scrolled(t) {
    await session(t);
    const input = t.tui.readInput();
    await t.keys("Also handle lowercase w, like 2026-w05-3.\r");
    await input;
    await t.keys("\x1b[5~");
    await t.keys("\x1b[5~");
    t.tui.token("Good catch: the regex is case-sensitive. I'll add the `i` flag and a test for it.\n\n");
    t.tui.toolCall("edit_file", { path: "src/parse.ts" });
    await sleep(5);
  },
  async help(t) {
    t.tui.readInput();
    await t.keys("/help");
    await t.keys("\r", 10);
  },
  async prompt(t) {
    await session(t);
    t.tui.prompt("Address of the machine", "e.g. 192.168.1.50 or gpu-box.local");
    await sleep(5);
    await t.keys("gpu-box.lo");
  },
};

async function main() {
  const sizes = [
    [120, 36],
    [80, 24],
  ];
  const made = [];
  for (const name of Object.keys(SCENARIOS)) {
    if (ONLY && !ONLY.includes(name)) continue;
    for (const light of [false, true]) {
      const list = name === "session" ? [...sizes, [160, 44]] : sizes;
      for (const [cols, rows] of list) {
        const t = await setup(cols, rows, light);
        await SCENARIOS[name](t);
        t.tui["render"]();
        const file = `tui2-${name}-${cols}x${rows}-${light ? "light" : "dark"}${process.env.SHOTS_MODE ? "-" + process.env.SHOTS_MODE : ""}`;
        const html = toHTML(t.vt, { fg: hex(theme.p.text), bg: hex(theme.p.bg), frame: light ? "#e8e8ed" : "#000000" });
        fs.writeFileSync(path.join(OUT, file + ".html"), html);
        fs.writeFileSync(path.join(OUT, file + ".txt"), t.vt.text());
        made.push({ file, cols, rows });
        t.tui.close();
        fs.rmSync(t.ws, { recursive: true, force: true });
      }
    }
  }
  const pw = process.env.PLAYWRIGHT_PATH;
  if (!pw) {
    console.log(`wrote ${made.length} html files to ${OUT}`);
    return;
  }
  const { chromium } = require(pw);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const m of made) {
    await page.setViewportSize({ width: m.cols * 9 + 56, height: m.rows * 19 + 56 });
    await page.goto("file:///" + path.join(OUT, m.file + ".html").replace(/\\/g, "/"));
    await page.screenshot({ path: path.join(OUT, m.file + ".png") });
  }
  await browser.close();
  console.log(`wrote ${made.length} screenshots to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
