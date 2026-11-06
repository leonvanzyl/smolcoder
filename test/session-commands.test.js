// The command registry (slash menu, palettes, /help), argument values for
// commands that take one, custom commands from .smolcoder/commands/*.md, /undo
// and the status row.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smol-cmd-")), "config.json");
process.env.SMOLCODER_CONFIG = CONFIG;

const { BUILTIN_COMMANDS, commandHelp, findCommand, KEYBOARD } = require("../dist/commands");
const { expandTemplate, loadCustomCommands, parseCommandFile, splitArgs } = require("../dist/custom-commands");
const { Session, SLASH_COMMANDS, parseSlash } = require("../dist/session");

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A fake Ollama with one tool-capable model; records chat requests. */
async function serveOllama(model = "smoltest:8b") {
  const chats = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") res.end(JSON.stringify({ models: [{ name: model }] }));
      else if (req.url === "/api/show") res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "x.context_length": 32768 } }));
      else if (req.url === "/api/ps") res.end(JSON.stringify({ models: [{ name: model, model, context_length: 8192 }] }));
      else if (req.url === "/api/chat" && !json.messages?.length) res.end("{}");
      else if (req.url === "/api/chat") {
        chats.push(json);
        res.setHeader("content-type", "application/x-ndjson");
        res.write(JSON.stringify({ message: { role: "assistant", content: "Done." }, done: false }) + "\n");
        res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 50, eval_count: 3 }) + "\n");
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { model, port, base: `http://127.0.0.1:${port}`, chats, close: () => new Promise((r) => server.close(r)) };
}

/** A SessionUI that types `inputs`, answers prompts and picks by label. */
function scriptedUI({ inputs = [], picks = [], prompts = [] } = {}) {
  const shown = { selects: [], lines: [], warnings: [], prompts: [] };
  return {
    shown,
    slashCommands: [], getStatus: () => "", hintLeft: "", onModeCycle: null, onCancel: null, onExit: null,
    start() {}, close() {}, refresh() {},
    async readInput() { return inputs.shift() ?? "/exit"; },
    async select(title, options, opts) {
      shown.selects.push({ title, options, opts });
      const want = picks.shift();
      if (want === undefined) return null;
      const idx = options.findIndex((o) => o.label === want);
      assert.notEqual(idx, -1, `no option ${want} in "${title}"`);
      return idx;
    },
    async prompt(title) { shown.prompts.push(title); return prompts.length ? prompts.shift() : null; },
    token(s) { shown.lines.push(s); }, thinking() {}, toolCall() {}, toolResult() {}, turnEnd() {}, planUpdated() {}, resetResponse() {},
    println(s = "") { shown.lines.push(strip(s)); },
    status(s) { shown.lines.push(strip(s)); },
    warn(s) { shown.warnings.push(strip(s)); },
    error(s) { shown.warnings.push(strip(s)); },
    startSpinner() {}, stopSpinner() {},
    async confirmCommand() { return "no"; },
  };
}

function makeSession(ui, extra = {}) {
  const workspace = extra.workspace ?? tmp("smol-cmd-ws-");
  const chosen = extra.chosen ?? { id: "fake:1b", backend: "ollama", baseUrl: "http://127.0.0.1:9", contextWindow: 8192, toolsSupported: true };
  return new Session(ui, { workspace, chosen, prefs: {}, cfg: {}, dataDir: extra.dataDir ?? tmp("smol-cmd-data-") });
}

// ---- the registry and /help ------------------------------------------------------

test("registry: every command has a group, names are unique, SLASH_COMMANDS is the registry", () => {
  assert.equal(SLASH_COMMANDS, BUILTIN_COMMANDS);
  const names = BUILTIN_COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const cmd of BUILTIN_COMMANDS) {
    assert.ok(cmd.group, `/${cmd.name} has a group`);
    assert.ok(cmd.desc);
  }
  for (const n of ["models", "mode", "effort", "sessions", "undo", "commands", "logs", "stop", "help", "exit"]) assert.ok(names.includes(n), n);
  assert.equal(BUILTIN_COMMANDS.find((c) => c.name === "mode").key, "shift+tab");
  // Typed names: own names and the old aliases; search words are not names.
  assert.equal(findCommand("model", BUILTIN_COMMANDS).name, "models");
  assert.equal(findCommand("q", BUILTIN_COMMANDS).name, "exit");
  assert.equal(findCommand("resume", BUILTIN_COMMANDS).name, "sessions");
  assert.equal(findCommand("switch", BUILTIN_COMMANDS), undefined);
  assert.deepEqual(parseSlash("/logs  t1 20"), { name: "logs", rest: "t1 20", args: ["t1", "20"] });
});

test("help: generated from the registry, grouped, with a Keyboard section", () => {
  const help = strip(commandHelp());
  for (const cmd of BUILTIN_COMMANDS) assert.match(help, new RegExp(`/${cmd.name}\\b`));
  for (const g of ["Model", "Session", "Tasks", "General"]) assert.match(help, new RegExp(`^  ${g}$`, "m"));
  assert.ok(help.indexOf("Model") < help.indexOf("Session"));
  assert.match(help, /Keyboard:/);
  for (const k of ["shift+tab", "ctrl+p", "ctrl+k", "F2", "ctrl+r", "alt+enter", "ctrl+j", "@", "esc", "ctrl+f"]) assert.ok(help.includes(k), k);
  assert.ok(KEYBOARD.length >= 8);
  assert.match(help, /\/logs \[arg\]/, "commands that take a value say so");

  // smol --help shows the same generated section.
  const out = spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "index.js"), "--help"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(out.status, 0);
  assert.ok(strip(out.stdout).includes(help.split("\n").slice(0, 4).join("\n")));
  assert.match(strip(out.stdout), /Options:/);
});

// ---- argument values ------------------------------------------------------------

test("args: /mode, /effort, /models and /commands list their values; /logs and /stop list running tasks", async () => {
  const ui = scriptedUI();
  const session = makeSession(ui);
  const args = async (name) => (await session.commandList().find((c) => c.name === name).args()) ?? [];
  assert.deepEqual((await args("mode")).map((o) => o.label), ["ro", "edit", "bypass"]);
  assert.equal((await args("mode")).find((o) => o.current).label, "edit");
  assert.match((await args("mode"))[2].hint, /bypass permissions/);
  assert.deepEqual((await args("effort")).map((o) => o.label), ["default", "off", "low", "medium", "high"]);
  assert.equal((await args("effort")).find((o) => o.current).label, "default");
  assert.deepEqual((await args("models")).map((o) => o.label), ["next"]);
  assert.deepEqual((await args("commands")).map((o) => o.label), ["new", "list"]);
  assert.deepEqual(await args("logs"), []);
  const id = session.taskManager.start(`"${process.execPath}" -e "setTimeout(() => {}, 20000)"`);
  try {
    const logs = await args("logs");
    assert.deepEqual(logs.map((o) => o.label), [id]);
    assert.match(logs[0].hint, /setTimeout/);
    assert.deepEqual((await args("stop")).map((o) => o.label), [id]);
    // The web page gets the same values as data.
    const wire = session.state().commands;
    assert.deepEqual(wire.find((c) => c.name === "stop").args.map((o) => o.label), [id]);
    assert.equal(wire.find((c) => c.name === "mode").key, "shift+tab");
    assert.doesNotThrow(() => JSON.stringify(session.state()));
  } finally {
    session.taskManager.killAll();
  }
  // The UI's slash list is the session's list.
  assert.deepEqual(ui.slashCommands.map((c) => c.name), session.commandList().map((c) => c.name));
});

test("args: '/name value' typed or picked runs with the value", async () => {
  const ui = scriptedUI({ inputs: ["/mode ro", "/effort low", "/logs t1", "/stop t1", "/models next", "/help"] });
  const session = makeSession(ui);
  const id = session.taskManager.start(`"${process.execPath}" -e "setTimeout(() => {}, 20000)"`);
  assert.equal(id, "t1");
  try {
    await session.run();
  } finally {
    session.taskManager.killAll();
  }
  assert.equal(session.agent.mode, "ro");
  assert.equal(session.effort, "low");
  assert.equal(ui.shown.selects.length, 0, "no picker opened for a command given its value");
  assert.ok(ui.shown.lines.some((l) => /^Task t1 \[running\]/.test(l)), "/logs t1");
  assert.ok(ui.shown.lines.some((l) => /Task t1 stopped/.test(l)), "/stop t1");
  assert.ok(ui.shown.lines.some((l) => /no other recent model yet/.test(l)), "/models next with nothing recent");
  assert.ok(ui.shown.lines.some((l) => /Keyboard:/.test(l)), "/help");
});

// ---- custom commands --------------------------------------------------------------

test("custom commands: frontmatter, $ARGUMENTS and $1..$n (the last takes the rest)", () => {
  assert.deepEqual(parseCommandFile("---\ndescription: \"Review a file\"\nagent: build\n---\nReview $1 for $2\n"), {
    description: "Review a file",
    template: "Review $1 for $2",
  });
  assert.equal(parseCommandFile("Explain the code.\nMore.").description, "Explain the code.");
  assert.equal(expandTemplate("Review $1 for $2", "src/a.ts bugs and style"), "Review src/a.ts for bugs and style");
  assert.equal(expandTemplate("Fix: $ARGUMENTS", "  the login bug "), "Fix: the login bug");
  assert.equal(expandTemplate("A $1 B $2 C $3", "x"), "A x B  C");
  assert.equal(expandTemplate("Look at $1 and $ARGUMENTS", '"a b" c'), 'Look at a b c and "a b" c', "the only $n takes the rest");
  assert.equal(expandTemplate("$1 then $2", '"a b" c d'), "a b then c d", "quotes keep words together");
  assert.equal(expandTemplate("Explain the parser.", "briefly"), "Explain the parser.\n\nbriefly", "no placeholders: words appended");
  assert.equal(expandTemplate("Run $(rm -rf /) `id` !`x`", ""), "Run $(rm -rf /) `id` !`x`", "no shell interpolation");
  assert.deepEqual(splitArgs(`one "two words" 'three'`), ["one", "two words", "three"]);
});

test("custom commands: workspace beats global, built-in names are skipped, they list under Custom", () => {
  const ws = tmp("smol-cc-ws-");
  const data = tmp("smol-cc-data-");
  fs.mkdirSync(path.join(ws, ".smolcoder", "commands"), { recursive: true });
  fs.mkdirSync(path.join(data, "commands"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".smolcoder", "commands", "review.md"), "---\ndescription: local review\n---\nReview $ARGUMENTS");
  fs.writeFileSync(path.join(data, "commands", "review.md"), "global review");
  fs.writeFileSync(path.join(data, "commands", "explain.md"), "Explain $1");
  fs.writeFileSync(path.join(data, "commands", "help.md"), "would shadow /help");
  fs.writeFileSync(path.join(data, "commands", "notes.txt"), "not markdown");
  const cmds = loadCustomCommands(ws, data, ["help"]);
  assert.deepEqual(cmds.map((c) => [c.name, c.scope]), [["review", "workspace"], ["explain", "global"]]);
  assert.equal(cmds[0].description, "local review");

  const ui = scriptedUI();
  const session = makeSession(ui, { workspace: ws, dataDir: data });
  const custom = session.commandList().filter((c) => c.group === "Custom");
  assert.deepEqual(custom.map((c) => c.name), ["review", "explain"]);
  assert.match(strip(session.helpText()), /Custom\n {4}\/review +local review/);
  assert.equal(session.commandList().filter((c) => c.name === "help").length, 1);
});

test("custom commands: running one sends the expanded text as the user turn; the system prompt is untouched", async () => {
  const ollama = await serveOllama();
  try {
    const ws = tmp("smol-cc-run-");
    fs.mkdirSync(path.join(ws, ".smolcoder", "commands"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".smolcoder", "commands", "review.md"), "---\ndescription: review\n---\nReview $1 and focus on $2");
    const ui = scriptedUI({ inputs: ["/review src/app.ts error handling"] });
    const chosen = { id: ollama.model, backend: "ollama", baseUrl: ollama.base, contextWindow: 8192, toolsSupported: true };
    const session = makeSession(ui, { workspace: ws, chosen });
    const system = session.agent.messages[0].content;
    await session.run();
    assert.equal(ollama.chats.length, 1);
    const sent = ollama.chats[0].messages;
    assert.equal(sent[0].content, system);
    assert.doesNotMatch(sent[0].content, /Review \$1/);
    const user = sent.filter((m) => m.role === "user");
    assert.equal(user.at(-1).content, "Review src/app.ts and focus on error handling");
    assert.ok(!ui.shown.warnings.some((w) => /Unknown command/.test(w)));
  } finally {
    await ollama.close();
  }
});

test("/commands new: asks for a name and text, writes the file, and the command is there at once", async () => {
  const ws = tmp("smol-cc-new-");
  const data = tmp("smol-cc-new-data-");
  const ui = scriptedUI({
    inputs: ["/commands new", "/commands new", "/commands new", "/commands"],
    prompts: ["/Write Tests", "Write tests for $ARGUMENTS\\nKeep them small.", "help", "explain", "Explain $1"],
    picks: ["This workspace", "All workspaces"],
  });
  const session = makeSession(ui, { workspace: ws, dataDir: data });
  await session.run();
  const file = path.join(ws, ".smolcoder", "commands", "write-tests.md");
  assert.equal(fs.readFileSync(file, "utf8"), "Write tests for $ARGUMENTS\nKeep them small.\n");
  assert.ok(ui.shown.warnings.some((w) => /\/help is a built-in command/.test(w)));
  assert.ok(fs.existsSync(path.join(data, "commands", "explain.md")));
  assert.deepEqual(session.customCommands.map((c) => c.name).sort(), ["explain", "write-tests"]);
  assert.ok(ui.slashCommands.some((c) => c.name === "write-tests" && c.group === "Custom"));
  assert.ok(ui.shown.lines.some((l) => /\/write-tests +Write tests for/.test(l)), "/commands lists them");
});

// ---- /undo and the status row -------------------------------------------------------

test("/undo prints the agent's summary, or that there is nothing to undo", async () => {
  const ui = scriptedUI({ inputs: ["/undo", "/undo"] });
  const session = makeSession(ui);
  const answers = ["Reverted 2 files: a.ts, b.ts", null];
  session.agent.undoLastTurn = async function () {
    assert.equal(this, session.agent);
    return answers.shift();
  };
  await session.run();
  assert.ok(ui.shown.lines.includes("Reverted 2 files: a.ts, b.ts"));
  assert.ok(ui.shown.lines.includes("Nothing to undo"));
});

test("status row: segments joined by ' · ', the context % always there", () => {
  const session = makeSession(scriptedUI());
  const parts = strip(session.statusLine()).split(" · ");
  assert.equal(parts[0], "edit");
  assert.match(parts[1], /^fake:1b ollama$/);
  assert.ok(parts.some((p) => /^\S+ \(\d+%\)$/.test(p)), parts.join(" | "));
});
