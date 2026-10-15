// Chat-only mode: an Ollama model whose /api/show capabilities lack "tools"
// runs as plain chat. The user is told so wherever the model is chosen, the
// model gets a chat prompt instead of tool instructions, the pickers mark it,
// and a headless --verify run stops before spending a single model call.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Must be set before dist/config is loaded: a session saves its model choice.
const CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smol-chat-")), "config.json");
process.env.SMOLCODER_CONFIG = CONFIG;

const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { withCapabilities } = require("../dist/detect");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { buildSystemPrompt } = require("../dist/prompt");
const { modelNotes, modelOptions, Session } = require("../dist/session");
const { TaskManager } = require("../dist/tools/tasks");

const TOOLS = "smoltest-tools:8b";
const CHAT = "smoltest-chat:4b";
const CANT = /can't use tools: it can chat, but can't read, edit or run anything here/;

/** A fake Ollama serving one tool-capable model and one chat-only model.
 * `capabilities: null` plays an Ollama too old to report them. Records every
 * real chat request (not the empty preload). */
async function serveOllama({ capabilities = { [TOOLS]: ["completion", "tools"], [CHAT]: ["completion", "vision"] } } = {}) {
  const chats = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") {
        res.end(JSON.stringify({ models: Object.keys(capabilities ?? { [TOOLS]: 1, [CHAT]: 1 }).map((name) => ({ name })) }));
      } else if (req.url === "/api/show") {
        res.end(JSON.stringify({ ...(capabilities ? { capabilities: capabilities[json.model] } : {}), model_info: { "x.context_length": 32768 } }));
      } else if (req.url === "/api/ps") {
        res.end(JSON.stringify({ models: [TOOLS, CHAT].map((name) => ({ name, model: name, context_length: 8192 })) }));
      } else if (req.url === "/api/chat" && !json.messages?.length) {
        res.end("{}"); // preload
      } else if (req.url === "/api/chat") {
        chats.push(json);
        res.setHeader("content-type", "application/x-ndjson");
        res.write(JSON.stringify({ message: { role: "assistant", content: "Paste the file and I will explain it." }, done: false }) + "\n");
        res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 60, eval_count: 9 }) + "\n");
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { port, base: `http://127.0.0.1:${port}`, chats, close: () => new Promise((resolve) => server.close(resolve)) };
}

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smol-chat-ws-"));
}

// ---- notes, picker rows, the prompt ------------------------------------------

test("a chat-only model is announced and marked in the picker; others are not", () => {
  const chat = { id: "gemma3:4b", backend: "ollama", baseUrl: "http://127.0.0.1:11434", contextWindow: 8192, toolsSupported: false };
  const tools = { ...chat, id: "qwen3:8b", toolsSupported: true };
  const unknown = { ...chat, id: "old-ollama-model", toolsSupported: undefined };
  const [warning, ...rest] = modelNotes(chat);
  assert.match(warning, CANT);
  assert.match(warning, /^gemma3:4b /);
  assert.deepEqual(rest, []);
  assert.deepEqual(modelNotes(tools), []);
  assert.deepEqual(modelNotes(unknown), [], "an Ollama too old to say keeps the old behaviour");
  // The chat-only line comes after why the model was chosen and what its backend said.
  const notes = modelNotes({ ...chat, fallbackNote: "x is not available any more", note: "older Ollama" });
  assert.equal(notes.length, 3);
  assert.match(notes[2], CANT);

  const rows = modelOptions([tools, chat, { ...chat, host: "gpu-box" }, unknown]);
  assert.deepEqual(rows.map((r) => r.hint), ["ollama", "ollama · chat only", "ollama · gpu-box · chat only", "ollama"]);
});

test("the chat-only prompt drops tool instructions, forbids claimed work and keeps AGENTS.md", () => {
  const base = { workspace: "/w", mode: "edit", shellLabel: "bash", agentsMd: "Use tabs." };
  const coding = buildSystemPrompt(base);
  const chat = buildSystemPrompt({ ...base, chatOnly: true });
  assert.match(coding, /tool call/);
  assert.doesNotMatch(chat, /tool call|plan checkpoint|Read relevant files before editing|run the build/i);
  assert.match(chat, /cannot read, search, create or edit files, or run commands/);
  assert.match(chat, /Never say or imply that you read, changed, created or ran anything/);
  assert.match(chat, /Workspace instructions from AGENTS\.md — follow these:\nUse tabs\./);
  assert.ok(chat.length < coding.length);
  // The mode does not change what a chat-only model can do.
  assert.equal(buildSystemPrompt({ ...base, mode: "bypass", chatOnly: true }), chat);
});

// ---- capabilities for the pickers ---------------------------------------------

test("withCapabilities marks Ollama models before they are chosen; others are left alone", async () => {
  const ollama = await serveOllama();
  const old = await serveOllama({ capabilities: null });
  try {
    const listed = [
      { id: TOOLS, backend: "ollama", baseUrl: ollama.base, contextWindow: 0 },
      { id: CHAT, backend: "ollama", baseUrl: ollama.base, contextWindow: 0 },
      { id: CHAT, backend: "ollama", baseUrl: old.base, contextWindow: 0 },
      { id: "lm-model", backend: "lmstudio", baseUrl: "http://127.0.0.1:1", contextWindow: 4096 },
      { id: "gone", backend: "ollama", baseUrl: "http://127.0.0.1:1", contextWindow: 0 },
    ];
    const marked = await withCapabilities(listed);
    assert.deepEqual(marked.map((m) => m.toolsSupported), [true, false, undefined, undefined, undefined]);
    assert.equal(marked[1].vision, true, "vision is read in the same call");
    assert.equal(marked[3], listed[3], "LM Studio models are not asked");
    assert.deepEqual(modelOptions(marked).map((r) => /chat only/.test(r.hint)), [false, true, false, false, false]);
  } finally {
    await ollama.close();
    await old.close();
  }
});

// ---- the agent ------------------------------------------------------------------

function fakeUi() {
  const lines = [];
  return {
    lines,
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {},
    status(s) { lines.push(s); }, warn(s) { lines.push(s); }, error(s) { lines.push(s); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "yes"; },
    turnEnd() {}, planUpdated() {},
  };
}

function fakeProvider(toolsSupported, replies) {
  const seen = [];
  let i = 0;
  return {
    seen, toolsSupported,
    label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages, tools) {
      seen.push({ messages: messages.map((m) => ({ role: m.role, content: m.content })), tools: tools.map((t) => t.name) });
      return { content: "", toolCalls: [], promptTokens: 100, completionTokens: 10, ...replies[Math.min(i++, replies.length - 1)] };
    },
  };
}

function makeAgent(provider) {
  const ws = tmpWorkspace();
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  return new Agent(provider, "edit", "coding prompt", toolCtx, new ContextManager(8000, 2000), new EventBus(), fakeUi(), false, 20);
}

test("a chat-only provider gets no tool schemas, and is nudged to answer rather than report work", async () => {
  const provider = fakeProvider(false, [{ content: "" }, { content: "Here is the answer." }]);
  const agent = makeAgent(provider);
  assert.equal(agent.chatOnly, true);
  assert.deepEqual(agent.tools, []);
  await agent.runTurn("what does main.ts do?");
  assert.equal(agent.outcome, "completed");
  assert.deepEqual(provider.seen.map((s) => s.tools), [[], []]);
  const nudge = provider.seen[1].messages.at(-1);
  assert.equal(nudge.role, "user");
  assert.doesNotMatch(nudge.content, /summarize what you did|tool call/);
  // Changing mode keeps it tool-free.
  agent.setMode("bypass", "coding prompt");
  assert.deepEqual(agent.tools, []);
});

test("a tool call a chat-only model invents does not run", async () => {
  const provider = fakeProvider(false, [
    { toolCalls: [{ id: "c1", name: "write_file", args: { path: "x.txt", content: "hi" } }] },
    { content: "I can't write files here." },
  ]);
  const agent = makeAgent(provider);
  await agent.runTurn("write x.txt");
  assert.equal(fs.existsSync(path.join(agent.toolCtx.workspace, "x.txt")), false);
  const result = agent.messages.find((m) => m.role === "tool");
  assert.match(result.content, /no tools are available to this model, so "write_file" did not run/);
});

test("switching providers swaps the tools and, when given, the system prompt", () => {
  const agent = makeAgent(fakeProvider(true, [{ content: "ok" }]));
  assert.ok(agent.tools.some((t) => t.name === "write_file"));
  agent.setProvider(fakeProvider(false, [{ content: "ok" }]), "chat prompt");
  assert.deepEqual(agent.tools, []);
  assert.equal(agent.messages[0].content, "chat prompt");
  agent.setProvider(fakeProvider(undefined, [{ content: "ok" }]), "coding prompt");
  assert.ok(agent.tools.some((t) => t.name === "write_file"), "unknown capability keeps the tools");
  assert.equal(agent.messages[0].content, "coding prompt");
  agent.setProvider(fakeProvider(true, [{ content: "ok" }]));
  assert.equal(agent.messages[0].content, "coding prompt", "no prompt given: the current one stays");
});

// ---- a session switching models with /models ----------------------------------

/** A SessionUI that types `inputs` and picks options by label. */
function scriptedSessionUI({ inputs, picks }) {
  const shown = { selects: [], warnings: [], lines: [] };
  return {
    shown,
    slashCommands: [], getStatus: () => "", hintLeft: "", onModeCycle: null, onCancel: null, onExit: null,
    start() {}, close() {}, refresh() {},
    async readInput() { return inputs.shift() ?? "/exit"; },
    async select(title, options) {
      shown.selects.push({ title, options });
      const want = picks.shift();
      const idx = options.findIndex((o) => o.label === want);
      assert.notEqual(idx, -1, `no option ${want} in "${title}"`);
      return idx;
    },
    async prompt() { return null; },
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, turnEnd() {}, planUpdated() {}, resetResponse() {},
    println(s = "") { shown.lines.push(s); },
    status(s) { shown.lines.push(s); },
    warn(s) { shown.warnings.push(s); },
    error(s) { shown.warnings.push(s); },
    startSpinner() {}, stopSpinner() {},
    async confirmCommand() { return "no"; },
  };
}

test("/models: picking a chat-only model warns, marks the row and gives the model the chat prompt", async () => {
  const ollama = await serveOllama();
  const old = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = `127.0.0.1:${ollama.port}`;
  try {
    const workspace = tmpWorkspace();
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "Prefer small functions.");
    const ui = scriptedSessionUI({ inputs: ["/models", "explain the parser", "/models"], picks: [CHAT, TOOLS] });
    const chosen = { id: TOOLS, backend: "ollama", baseUrl: ollama.base, contextWindow: 8192, toolsSupported: true };
    const session = new Session(ui, { workspace, chosen, prefs: {}, cfg: {}, help: "" });
    session.announce();
    assert.deepEqual(ui.shown.warnings, [], "a tool-capable model starts quietly");
    assert.ok(session.agent.tools.length > 0);

    // Watch the transcript at each step: run() ends at the implicit /exit.
    await session.run();

    const rows = ui.shown.selects[0].options;
    assert.match(rows.find((r) => r.label === CHAT).hint, /chat only/);
    assert.doesNotMatch(rows.find((r) => r.label === TOOLS).hint, /chat only/);
    assert.equal(ui.shown.warnings.filter((w) => CANT.test(w)).length, 1, "warned once, on the switch to the chat-only model");
    assert.match(ui.shown.warnings.find((w) => CANT.test(w)), new RegExp(`^  ${CHAT.replace(/[.:]/g, "\\$&")} can't use tools`));

    // The chat turn went out with no tools and the chat prompt, AGENTS.md included.
    assert.equal(ollama.chats.length, 1);
    const [turn] = ollama.chats;
    assert.equal(turn.model, CHAT);
    assert.equal(turn.tools, undefined);
    assert.match(turn.messages[0].content, /This model has no tools here/);
    assert.match(turn.messages[0].content, /Prefer small functions\./);

    // Switching back restores the tools and the coding prompt.
    assert.equal(session.chosen.id, TOOLS);
    assert.ok(session.agent.tools.some((t) => t.name === "write_file"));
    assert.doesNotMatch(session.agent.messages[0].content, /This model has no tools here/);
    assert.match(session.agent.messages[0].content, /Prefer small functions\./);
  } finally {
    if (old === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = old;
    await ollama.close();
  }
});

test("a session that starts on a chat-only model says so and never sends tools", async () => {
  const workspace = tmpWorkspace();
  const ui = scriptedSessionUI({ inputs: [], picks: [] });
  const chosen = { id: "gemma3:4b", backend: "ollama", baseUrl: "http://127.0.0.1:1", contextWindow: 8192, toolsSupported: false };
  const session = new Session(ui, { workspace, chosen, prefs: {}, cfg: {}, help: "" });
  session.announce();
  assert.equal(ui.shown.warnings.length, 1);
  assert.match(ui.shown.warnings[0], CANT);
  assert.deepEqual(session.agent.tools, []);
  assert.match(session.agent.messages[0].content, /This model has no tools here/);
  await session.shutdown();
});

// ---- headless -------------------------------------------------------------------

/** Run the CLI against the fake Ollama; resolves with its exit code and output. */
function runCli(args, port, workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "dist", "index.js"), workspace, ...args], {
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, SMOLCODER_CONFIG: CONFIG, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`smol did not exit:\n${stdout}\n${stderr}`));
    }, 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("headless --verify with a chat-only model stops before any model call", async () => {
  const ollama = await serveOllama();
  try {
    const marker = path.join(tmpWorkspace(), "verify-ran");
    const check = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, '')"`;
    const r = await runCli(["-p", "fix the failing test", "--verify", check, "--model", CHAT], ollama.port, tmpWorkspace());
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, CANT);
    assert.match(r.stderr, new RegExp(`--verify needs a model that can use tools, and ${CHAT.replace(/[.:]/g, "\\$&")} can only chat`));
    assert.equal(ollama.chats.length, 0, "no model call was spent");
    assert.equal(fs.existsSync(marker), false, "no acceptance attempt was spent");
  } finally {
    await ollama.close();
  }
});

test("headless without --verify: a chat-only model answers as chat", async () => {
  const ollama = await serveOllama();
  try {
    const r = await runCli(["-p", "what does the parser do?", "--model", CHAT], ollama.port, tmpWorkspace());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, CANT);
    assert.match(r.stdout, /Paste the file and I will explain it\./);
    assert.equal(ollama.chats.length, 1);
    assert.equal(ollama.chats[0].tools, undefined);
    assert.match(ollama.chats[0].messages[0].content, /This model has no tools here/);
  } finally {
    await ollama.close();
  }
});
