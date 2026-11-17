// lookup_docs (Context7 search) and its /docs setting: the request, every
// failure turned into one line, the snippet-boundary cap, cancel, the key
// check, and the tool's presence following the setting. Never touches the
// network: fetch is always a fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smol-docs-")), "config.json");
process.env.SMOLCODER_CONFIG = CONFIG;
delete process.env.CONTEXT7_API_KEY;

const D = require("../dist/tools/docs");
const { buildToolSpecs, executeTool } = require("../dist/tools/index");
const { BUILTIN_COMMANDS, findCommand } = require("../dist/commands");
const C = require("../dist/config");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");
const { Session } = require("../dist/session");
const { buildSystemPrompt, DOCS_PROMPT_LINE } = require("../dist/prompt");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const resetConfig = () => fs.rmSync(CONFIG, { force: true });

/** A fake fetch that answers from `replies` in turn (a reply may be a
 * function, or an Error to throw) and records every request. */
function fakeFetch(...replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: new URL(url), headers: init.headers, signal: init.signal });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r(url, init);
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

const netError = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
const SNIPPET = (title, n = 300) => `### ${title}\n\nSource: https://example.com/${encodeURIComponent(title)}\n\n${"word ".repeat(n / 5)}\n\n\`\`\`js\nconst x = 1;\n\`\`\``;

// ---- the request -------------------------------------------------------------

test("url: the query, one library per param (comma lists split, at most four), none when absent", async () => {
  const f = fakeFetch({ body: "Library: /vercel/next.js\n\n" + SNIPPET("Middleware") });
  await D.lookupDocs({ query: "next.js 15 middleware redirect" }, { fetchImpl: f });
  await D.lookupDocs({ query: "routing", library: "next.js" }, { fetchImpl: f });
  await D.lookupDocs({ query: "hooks", library: " react, /vercel/next.js ,, vue, svelte, solid " }, { fetchImpl: f });
  const [none, one, many] = f.calls.map((c) => c.url);
  assert.equal(none.origin + none.pathname, D.CONTEXT7_SEARCH_URL);
  assert.equal(none.searchParams.get("query"), "next.js 15 middleware redirect");
  assert.deepEqual(none.searchParams.getAll("library"), []);
  assert.deepEqual(one.searchParams.getAll("library"), ["next.js"]);
  assert.deepEqual(many.searchParams.getAll("library"), ["react", "/vercel/next.js", "vue", "svelte"]);
  assert.equal(many.searchParams.get("type"), null, "the default txt answer");
  assert.equal(D.docsUrl("a b&c"), `${D.CONTEXT7_SEARCH_URL}?query=a+b%26c`);
});

test("auth: the Authorization header is sent only with a key; no custom user agent", async () => {
  const f = fakeFetch({ body: SNIPPET("x") });
  await D.lookupDocs({ query: "q" }, { fetchImpl: f });
  await D.lookupDocs({ query: "q" }, { fetchImpl: f, apiKey: "ctx7sk-secret-1234" });
  assert.equal(f.calls[0].headers.authorization, undefined);
  assert.equal(f.calls[1].headers.authorization, "Bearer ctx7sk-secret-1234");
  for (const c of f.calls) assert.equal(c.headers["user-agent"], undefined);
});

test("a missing query is a coaching error, and nothing is fetched", async () => {
  const f = fakeFetch({ body: "x" });
  for (const args of [{}, { query: "  " }, { query: 42 }]) {
    assert.equal(await D.lookupDocs(args, { fetchImpl: f }), 'Error: query is required. Example: {"query": "next.js 15 middleware redirect"}');
  }
  assert.equal(f.calls.length, 0);
});

// ---- answers and failures ----------------------------------------------------

test("200: the markdown comes back trimmed", async () => {
  const body = `\n\nLibrary: /websites/nextjs/15\n\n${SNIPPET("Implement Redirects")}\n\n\n\n`;
  const out = await D.lookupDocs({ query: "redirect" }, { fetchImpl: fakeFetch({ body }) });
  assert.match(out, /^Library: \/websites\/nextjs\/15\n\n### Implement Redirects\n\nSource: /);
  assert.doesNotMatch(out, /\n{3}/);
  assert.doesNotMatch(out, /^Error/);
});

test("404 (and an empty 200) is an empty result that suggests rewording or naming the library", async () => {
  const notFound = { status: 404, body: '{"error":"no_documentation_found","message":"No documentation library matched the request."}' };
  const out = await D.lookupDocs({ query: "frobnicate", library: "nope" }, { fetchImpl: fakeFetch(notFound) });
  assert.match(out, /^No documentation found for "frobnicate" in nope\. Reword the query, or name the library/);
  assert.match(await D.lookupDocs({ query: "x" }, { fetchImpl: fakeFetch({ body: "  " }) }), /^No documentation found/);
});

test("429: anonymous says 200 a month and /docs key; with a key it says so; both warn the user", async () => {
  const limited = { status: 429, body: "{}", headers: { "ratelimit-reset": "1796083200" } };
  const anon = await D.lookupDocs({ query: "q" }, { fetchImpl: fakeFetch(limited) });
  assert.match(anon, /^Error: Context7 rate limit reached/);
  assert.match(anon, /200 lookups a month, resets 2026-12-01/);
  assert.match(anon, /\/docs key/);
  assert.match(D.docsWarning(anon), /free limit \(200 lookups\/month\) is used up — add a free key with \/docs key/);
  const keyed = await D.lookupDocs({ query: "q" }, { fetchImpl: fakeFetch(limited), apiKey: "ctx7sk-abcdefgh" });
  assert.match(keyed, /^Error: Context7 rate limit reached for this API key \(resets 2026-12-01\)/);
  assert.match(D.docsWarning(keyed), /rate limit for your API key/);
  assert.equal(D.docsWarning("Library: /x\n\n### y"), null);
  assert.equal(D.docsWarning("Error: could not reach context7.com (offline?). Continue without the docs."), null);
});

test("401/403 with a key: rejected, fix it with /docs key; the user is warned", async () => {
  for (const status of [401, 403]) {
    const out = await D.lookupDocs({ query: "q" }, { fetchImpl: fakeFetch({ status, body: '{"error":"invalid_api_key"}' }), apiKey: "ctx7sk-bad" });
    assert.match(out, new RegExp(`^Error: Context7 rejected the API key \\(HTTP ${status}\\).*/docs key`));
    assert.match(D.docsWarning(out), /rejected your API key — fix or remove it with \/docs key/);
  }
});

test("503 is retried once: a second success is returned, a second 503 says try later", async () => {
  const ok = fakeFetch({ status: 503, body: '{"error":"search_failed"}' }, { body: SNIPPET("Second try") });
  assert.match(await D.lookupDocs({ query: "q" }, { fetchImpl: ok, retryDelayMs: 1 }), /### Second try/);
  assert.equal(ok.calls.length, 2);
  const down = fakeFetch({ status: 503, body: "{}" });
  assert.match(await D.lookupDocs({ query: "q" }, { fetchImpl: down, retryDelayMs: 1 }), /^Error: Context7 search is temporarily unavailable/);
  assert.equal(down.calls.length, 2, "only one retry");
  const bad = fakeFetch({ status: 400, body: '{"error":"bad_request","message":"version needs a library"}' });
  assert.match(await D.lookupDocs({ query: "q" }, { fetchImpl: bad, retryDelayMs: 1 }), /^Error: Context7 search failed \(HTTP 400: version needs a library\)/);
  assert.equal(bad.calls.length, 1, "other statuses are not retried");
});

test("a network error is retried once, then says context7.com could not be reached", async () => {
  const flaky = fakeFetch(netError(), { body: SNIPPET("Recovered") });
  assert.match(await D.lookupDocs({ query: "q" }, { fetchImpl: flaky, retryDelayMs: 1 }), /### Recovered/);
  const offline = fakeFetch(netError());
  assert.equal(await D.lookupDocs({ query: "q" }, { fetchImpl: offline, retryDelayMs: 1 }), "Error: could not reach context7.com (offline?). Continue without the docs.");
  assert.equal(offline.calls.length, 2);
});

/** A fetch that never answers until its signal aborts. */
function hangingFetch() {
  const calls = [];
  const fn = (url, init) => {
    calls.push(init);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
  };
  fn.calls = calls;
  return fn;
}

test("cancel: the user's abort ends the request at once, is not retried, and is reported as cancelled", async () => {
  const f = hangingFetch();
  const controller = new AbortController();
  const t0 = Date.now();
  const pending = D.lookupDocs({ query: "q" }, { fetchImpl: f, signal: controller.signal, retryDelayMs: 1 });
  setTimeout(() => controller.abort(), 20);
  assert.equal(await pending, "Error: docs lookup cancelled");
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal.aborted, true, "the request itself was aborted");
  // Already cancelled: nothing is sent. Through the registry too.
  const g = hangingFetch();
  const done = new AbortController();
  done.abort();
  assert.equal(await D.lookupDocs({ query: "q" }, { fetchImpl: g, signal: done.signal }), "Error: docs lookup cancelled");
  assert.equal(g.calls.length, 0);
  const real = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  try {
    const ctx = { workspace: tmp("smol-docs-ws-"), plan: new Plan(), taskManager: null, filesTouched: new Set(), commandsRun: [] };
    assert.equal(await executeTool("lookup_docs", { query: "q" }, ctx, done.signal), "Error: docs lookup cancelled");
  } finally {
    globalThis.fetch = real;
  }
});

test("timeout: a silent server is given up on, not retried", async () => {
  const f = hangingFetch();
  const out = await D.lookupDocs({ query: "q" }, { fetchImpl: f, timeoutMs: 30, retryDelayMs: 1 });
  assert.match(out, /^Error: context7\.com did not answer within/);
  assert.equal(f.calls.length, 1);
});

// ---- the cap ---------------------------------------------------------------------

test("cap: cut at a snippet boundary under the limit, never inside a snippet, with a note", () => {
  const apidoc = "### useState(initialState)\n\nSource: https://react.dev/x\n\n```APIDOC\n## useState\n\n### Description\nDeclares state.\n\n### Parameters\n- initial\n```";
  const groups = [];
  for (let g = 0; g < 6; g++) groups.push(`Library: /lib/${g}\n\n${apidoc}\n\n${SNIPPET("A" + g)}\n\n${SNIPPET("B" + g)}`);
  const doc = groups.join("\n\n---\n\n");
  for (const cap of [800, 1500, 2600, 4000]) {
    const out = D.capDocs(doc, cap);
    assert.ok(out.length <= cap, `${out.length} > ${cap}`);
    assert.match(out, /\n\n\[More documentation was cut\. A narrower query or a library name gives more focused results\.\]$/);
    const body = out.slice(0, out.lastIndexOf("\n\n[More"));
    assert.ok(doc.startsWith(body), "a prefix of the answer");
    const next = doc.slice(body.length);
    assert.match(next, /^\n+(---\n\n)?(Library: [^\n]*\n\n)?### [^\n]*\n\nSource: /, `cap ${cap} ends right before a snippet`);
    assert.equal((body.match(/^```/gm) ?? []).length % 2, 0, "no code fence left open");
    assert.doesNotMatch(body, /\n(---|Library: [^\n]*)$/, "no dangling separator or library header");
  }
  assert.equal(D.capDocs("short", 100), "short");
});

test("cap: one snippet longer than the cap keeps whole lines and closes its code fence", () => {
  const huge = "Library: /a\n\n### Big\n\nSource: https://a\n\n```js\n" + "const line = 1;\n".repeat(400) + "```";
  const out = D.capDocs(huge, 1000);
  assert.ok(out.length <= 1000);
  const body = out.slice(0, out.lastIndexOf("\n\n[More"));
  assert.match(body, /const line = 1;\n```$/);
});

test("cap: 6000 by default, and never more than the caller's limit (the agent's per-result cap)", async () => {
  const doc = Array.from({ length: 40 }, (_, i) => SNIPPET("S" + i)).join("\n\n");
  const f = fakeFetch({ body: doc });
  const full = await D.lookupDocs({ query: "q" }, { fetchImpl: f });
  assert.ok(full.length <= 6000 && full.length > 5000, String(full.length));
  assert.ok((await D.lookupDocs({ query: "q" }, { fetchImpl: f, maxChars: 1200 })).length <= 1200);
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    const ctx = { workspace: tmp("smol-docs-ws-"), plan: new Plan(), taskManager: null, filesTouched: new Set(), commandsRun: [], resultCharLimit: 1500 };
    const out = await executeTool("lookup_docs", { query: "q", library: "react" }, ctx);
    assert.ok(out.length <= 1500 - 256, String(out.length));
    assert.match(out, /More documentation was cut/);
  } finally {
    globalThis.fetch = real;
  }
});

// ---- the key ---------------------------------------------------------------------

test("verifyContext7Key: one search with the key; 401/403 rejected, 429 limited, offline unreachable", async () => {
  const f = fakeFetch({ status: 404, body: "{}" });
  assert.equal(await D.verifyContext7Key("ctx7sk-good", { fetchImpl: f }), "ok");
  assert.equal(f.calls[0].headers.authorization, "Bearer ctx7sk-good");
  assert.equal(f.calls[0].url.pathname, "/api/v3/search");
  assert.equal(await D.verifyContext7Key("k", { fetchImpl: fakeFetch({ body: "docs" }) }), "ok");
  assert.equal(await D.verifyContext7Key("k", { fetchImpl: fakeFetch({ status: 401 }) }), "rejected");
  assert.equal(await D.verifyContext7Key("k", { fetchImpl: fakeFetch({ status: 403 }) }), "rejected");
  assert.equal(await D.verifyContext7Key("k", { fetchImpl: fakeFetch({ status: 429 }) }), "limited");
  assert.equal(await D.verifyContext7Key("k", { fetchImpl: fakeFetch(netError()), retryDelayMs: 1 }), "unreachable");
  assert.equal(D.keyTail("ctx7sk-0123456789abcd"), "…abcd");
  assert.equal(D.keyTail("short"), "…");
});

test("config: the saved key wins over CONTEXT7_API_KEY; bad values are dropped on load", () => {
  resetConfig();
  assert.equal(C.context7Key({}), undefined);
  assert.equal(C.context7Key({ CONTEXT7_API_KEY: " ctx7sk-env " }), "ctx7sk-env");
  C.setContext7Key("ctx7sk-saved");
  assert.equal(C.context7Key({ CONTEXT7_API_KEY: "ctx7sk-env" }), "ctx7sk-saved");
  C.setContext7Key();
  assert.equal(C.loadConfig().context7Key, undefined);
  assert.equal(C.context7Key({ CONTEXT7_API_KEY: "ctx7sk-env" }), "ctx7sk-env");
  fs.writeFileSync(CONFIG, JSON.stringify({ docsTool: "no", context7Key: "  " }));
  assert.deepEqual([C.loadConfig().docsTool, C.loadConfig().context7Key], [undefined, undefined]);
  assert.equal(C.docsToolSetting(), true, "on by default");
  fs.writeFileSync(CONFIG, JSON.stringify({ docsTool: false, context7Key: " ctx7sk-trim " }));
  assert.equal(C.docsToolSetting(), false);
  assert.equal(C.loadConfig().context7Key, "ctx7sk-trim");
  resetConfig();
});

// ---- the schema and the setting --------------------------------------------------

test("schema: lookup_docs is in every mode, small and flat, and left out when the setting is off", () => {
  for (const mode of ["ro", "edit", "bypass"]) {
    const spec = buildToolSpecs(mode).find((t) => t.name === "lookup_docs");
    assert.ok(spec, mode);
    assert.deepEqual(Object.keys(spec.parameters.properties), ["query", "library"]);
    assert.deepEqual(spec.parameters.required, ["query"]);
    for (const p of Object.values(spec.parameters.properties)) assert.equal(p.type, "string");
    assert.ok(spec.description.length <= 250, `${spec.description.length} chars`);
    assert.match(spec.description, /Example: \{"query": /);
    assert.equal(buildToolSpecs(mode, { docs: false }).some((t) => t.name === "lookup_docs"), false);
  }
  assert.equal(buildToolSpecs("ro").length, 5);
  assert.equal(buildToolSpecs("edit").length, 9);
});

function fakeUi() {
  const warnings = [];
  return {
    warnings,
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {},
    warn(s) { warnings.push(s); }, error(s) { warnings.push(s); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "yes"; }, turnEnd() {}, planUpdated() {},
  };
}

function fakeProvider(replies) {
  const seen = [];
  const systems = [];
  let i = 0;
  return {
    seen, systems, toolsSupported: true, label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages, tools) {
      seen.push(tools.map((t) => t.name));
      systems.push(messages[0].content);
      return { content: "", toolCalls: [], promptTokens: 100, completionTokens: 10, ...replies[Math.min(i++, replies.length - 1)] };
    },
  };
}

function makeAgent(provider, ui = fakeUi()) {
  const ws = tmp("smol-docs-ws-");
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  return new Agent(provider, "edit", "coding prompt", toolCtx, new ContextManager(8000, 2000), new EventBus(), ui, false, 20);
}

test("agent: the tools follow the setting, refreshTools applies a change, and a new turn picks one up", async () => {
  resetConfig();
  const provider = fakeProvider([{ content: "ok" }]);
  const agent = makeAgent(provider);
  assert.ok(agent.tools.some((t) => t.name === "lookup_docs"));
  C.updateConfig({ docsTool: false });
  agent.refreshTools();
  assert.equal(agent.tools.some((t) => t.name === "lookup_docs"), false);
  agent.setMode("ro", "coding prompt");
  assert.equal(agent.tools.some((t) => t.name === "lookup_docs"), false);
  C.updateConfig({ docsTool: true }); // e.g. another web session turned it back on
  await agent.runTurn("hi");
  assert.ok(provider.seen[0].includes("lookup_docs"));
  resetConfig();
});

// ---- the prompt line ------------------------------------------------------------

const LINE = "Library APIs change after your training: before writing or explaining code that uses a third-party library, framework or API, call lookup_docs to check its current usage. If lookup_docs fails, is rate-limited or finds nothing, do not retry it; continue from your own knowledge.";
const OS = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
// The edit-mode prompt as it was before the docs line existed, byte for byte.
const PROMPT_BEFORE_DOCS = `You are smolcoder, a coding agent working in the workspace /w on ${OS}. Commands run in bash with the workspace as the working directory. File paths are relative to the workspace; you cannot access files outside it. Read, edit and run commands inside the workspace. Commands reaching outside it need approval; keep scratch files in .scratch/.\n\nFor multi-step work, first set a short plan of runnable increments; mark each step done as you finish it. The plan survives compaction. Use plan checkpoint to retain exact APIs, errors and your next edit during an investigation. Establish a working entry point early and run the build after wiring modules. Read relevant files before editing. Search narrowly and read small line ranges. Inspect a local module's actual exports before importing it. Make one tool call at a time; use small modules and write large files in parts. Read errors and change your approach when a call fails. Put test programs in files rather than long inline shell commands. Verify changes with the relevant test or command; a failed check is not success. Continue until the request is finished or explain the blocker. Summarize the result and verification briefly.`;

test("prompt: the docs line is in the tool prompt with docs on (every mode), just before the closing sentence", () => {
  assert.equal(DOCS_PROMPT_LINE, LINE);
  for (const mode of ["ro", "edit", "bypass"]) {
    for (const agentsMd of [null, "Use tabs."]) {
      const base = { workspace: "/w", mode, shellLabel: "bash", agentsMd };
      const on = buildSystemPrompt({ ...base, docs: true });
      assert.equal(on.split(LINE).length, 2, `${mode}: exactly once`);
      assert.ok(on.includes(`a failed check is not success. ${LINE} Continue until the request is finished`), mode);
      // The line is the only difference from the prompt without it.
      assert.equal(on.replace(`${LINE} `, ""), buildSystemPrompt({ ...base, docs: false }));
    }
  }
});

test("prompt: with docs off (or not given) it is byte for byte the prompt from before the docs line", () => {
  const base = { workspace: "/w", mode: "edit", shellLabel: "bash" };
  assert.equal(buildSystemPrompt(base), PROMPT_BEFORE_DOCS);
  assert.equal(buildSystemPrompt({ ...base, docs: false }), PROMPT_BEFORE_DOCS);
  for (const mode of ["ro", "bypass"]) {
    assert.doesNotMatch(buildSystemPrompt({ ...base, mode, docs: false }), /lookup_docs/);
    assert.equal(buildSystemPrompt({ ...base, mode, docs: false }), buildSystemPrompt({ ...base, mode }));
  }
});

test("prompt: a chat-only model never gets the docs line (it has no tools)", () => {
  for (const mode of ["ro", "edit"]) {
    const base = { workspace: "/w", mode, shellLabel: "bash", agentsMd: "Use tabs.", chatOnly: true };
    assert.doesNotMatch(buildSystemPrompt({ ...base, docs: true }), /lookup_docs/);
    assert.equal(buildSystemPrompt({ ...base, docs: true }), buildSystemPrompt(base));
  }
});

/** An agent whose prompt comes from the real builder, as a session's does. */
function makeBuiltAgent(provider) {
  const ws = tmp("smol-docs-ws-");
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  const builder = (mode, docs) => buildSystemPrompt({ workspace: ws, mode, shellLabel: "bash", docs });
  return new Agent(provider, "edit", builder, toolCtx, new ContextManager(8000, 2000), new EventBus(), fakeUi(), false, 20);
}

const toolOn = (agent) => agent.tools.some((t) => t.name === "lookup_docs");
const lineOn = (agent) => agent.messages[0].content.includes(LINE);

test("agent: the docs line and the tool move together on refreshTools, setMode and a turn after another session changed it", async () => {
  resetConfig();
  const provider = fakeProvider([{ content: "ok" }]);
  const agent = makeBuiltAgent(provider);
  assert.deepEqual([toolOn(agent), lineOn(agent)], [true, true], "on by default");
  C.updateConfig({ docsTool: false });
  agent.refreshTools(); // /docs off
  assert.deepEqual([toolOn(agent), lineOn(agent)], [false, false]);
  agent.setMode("ro");
  assert.deepEqual([toolOn(agent), lineOn(agent)], [false, false]);
  assert.match(agent.messages[0].content, /read-only mode/, "the builder made the read-only prompt");
  C.updateConfig({ docsTool: true });
  agent.refreshTools(); // /docs on
  assert.deepEqual([toolOn(agent), lineOn(agent)], [true, true]);
  assert.match(agent.messages[0].content, /read-only mode/);

  // Another session sharing the config turns it off: the next turn sends both changes.
  C.updateConfig({ docsTool: false });
  await agent.runTurn("hi");
  assert.equal(provider.seen.at(-1).includes("lookup_docs"), false);
  assert.equal(provider.systems.at(-1).includes(LINE), false);
  assert.deepEqual([toolOn(agent), lineOn(agent)], [false, false]);
  resetConfig();
});

test("agent: an unchanged setting leaves the system message alone between turns (the cached prefix holds)", async () => {
  resetConfig();
  const provider = fakeProvider([{ content: "ok" }]);
  const agent = makeBuiltAgent(provider);
  const system = agent.messages[0];
  const tools = agent.tools;
  await agent.runTurn("one");
  await agent.runTurn("two");
  assert.equal(agent.messages[0], system, "the same message object: not rebuilt");
  assert.equal(agent.tools, tools, "the same tool list: not rebuilt");
  assert.equal(provider.systems[0], provider.systems[1]);
  assert.ok(provider.systems[1].includes(LINE));
  resetConfig();
});

test("agent: a fixed prompt string is kept as given (callers without a builder)", () => {
  resetConfig();
  const agent = makeAgent(fakeProvider([{ content: "ok" }]));
  assert.equal(agent.messages[0].content, "coding prompt");
  C.updateConfig({ docsTool: false });
  agent.refreshTools();
  assert.equal(agent.messages[0].content, "coding prompt");
  agent.setMode("ro", "read-only prompt");
  assert.equal(agent.messages[0].content, "read-only prompt");
  resetConfig();
});

test("agent: a used-up limit is shown to the user once per session, the model still gets the result", async () => {
  resetConfig();
  const call = (id) => ({ toolCalls: [{ id, name: "lookup_docs", args: { query: "react hooks" } }] });
  const provider = fakeProvider([call("c1"), call("c2"), { content: "Continuing without docs." }]);
  const ui = fakeUi();
  const agent = makeAgent(provider, ui);
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch({ status: 429, body: "{}" });
  try {
    await agent.runTurn("use react hooks");
  } finally {
    globalThis.fetch = real;
  }
  const results = agent.messages.filter((m) => m.role === "tool");
  assert.equal(results.length, 2);
  for (const r of results) assert.match(r.content, /^Error: Context7 rate limit reached/);
  const shown = ui.warnings.filter((w) => /Context7/.test(w));
  assert.deepEqual(shown, ["· Context7's free limit (200 lookups/month) is used up — add a free key with /docs key (from context7.com/dashboard)"]);
});

// ---- /docs --------------------------------------------------------------------------

test("/docs is in the registry, found by 'settings', 'api key' and 'context7', with on/off/key values", () => {
  const cmd = findCommand("docs", BUILTIN_COMMANDS);
  assert.ok(cmd);
  assert.equal(cmd.group, "General");
  for (const a of ["settings", "api key", "context7", "documentation"]) assert.ok(cmd.aliases.includes(a), a);
  assert.deepEqual(cmd.args().map((o) => o.label), ["on", "off", "key"]);
  const { docsArgs } = require("../dist/commands");
  assert.deepEqual(docsArgs(false).map((o) => !!o.current), [false, true, false]);
  assert.match(docsArgs(true, null)[2].hint, /^no key: anonymous, 200 lookups a month — add a free key for more/);
  assert.match(docsArgs(true, { tail: "…abcd", fromEnv: false })[2].hint, /^key saved \(…abcd\) — change or remove$/);
  assert.match(docsArgs(true, { tail: "…wxyz", fromEnv: true })[2].hint, /CONTEXT7_API_KEY \(…wxyz\)/);
});

function scriptedUI({ inputs = [], picks = [], prompts = [] } = {}) {
  const shown = { lines: [], warnings: [], prompts: [], selects: [] };
  return {
    shown,
    slashCommands: [], getStatus: () => "", hintLeft: "", onModeCycle: null, onCancel: null, onExit: null,
    start() {}, close() {}, refresh() {},
    async readInput() { return inputs.shift() ?? "/exit"; },
    async select(title, options) {
      shown.selects.push({ title, options });
      const want = picks.shift();
      return want === undefined ? null : options.findIndex((o) => o.label === want);
    },
    async prompt(title, placeholder, opts) { shown.prompts.push({ title, placeholder, opts }); return prompts.length ? prompts.shift() : null; },
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, turnEnd() {}, planUpdated() {}, resetResponse() {},
    println(s = "") { shown.lines.push(strip(s)); }, status(s) { shown.lines.push(strip(s)); },
    warn(s) { shown.warnings.push(strip(s)); }, error(s) { shown.warnings.push(strip(s)); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "no"; },
  };
}

function makeSession(ui) {
  const chosen = { id: "fake:1b", backend: "ollama", baseUrl: "http://127.0.0.1:9", contextWindow: 8192, toolsSupported: true };
  return new Session(ui, { workspace: tmp("smol-docs-ws-"), chosen, prefs: {}, cfg: {}, dataDir: tmp("smol-docs-data-") });
}

test("/docs on|off saves the setting and changes the agent's tools now; bare /docs opens the picker", async () => {
  resetConfig();
  const ui = scriptedUI({ inputs: ["/docs off", "/docs", "/exit"], picks: ["on"] });
  const session = makeSession(ui);
  const has = () => session.agent.tools.some((t) => t.name === "lookup_docs");
  assert.ok(has());
  const argsOf = () => session.commandList().find((c) => c.name === "docs").args();
  assert.equal(argsOf().find((o) => o.current).label, "on");
  assert.match(argsOf()[2].hint, /^no key: anonymous/);
  const run = session.run();
  await run;
  assert.ok(ui.shown.lines.some((l) => /docs lookup off: the lookup_docs tool is removed/.test(l)));
  assert.ok(ui.shown.lines.some((l) => /docs lookup on: the agent can fetch current docs from context7\.com/.test(l)));
  assert.equal(ui.shown.selects[0].title, "Docs lookup (Context7)");
  assert.equal(ui.shown.selects[0].options.find((o) => o.current).label, "off", "the picker marks the current setting");
  assert.equal(C.docsToolSetting(), true);
  assert.ok(has());
  assert.equal(session.agent.messages.length, 1, "nothing reached the model");

  resetConfig();
  const off = scriptedUI({ inputs: ["/docs off", "/exit"] });
  const s2 = makeSession(off);
  await s2.run();
  assert.equal(C.docsToolSetting(), false);
  assert.equal(s2.agent.tools.some((t) => t.name === "lookup_docs"), false);
  resetConfig();
});

test("/docs on|off in a session changes the prompt line together with the tool; a mode change keeps them paired", async () => {
  resetConfig();
  const states = [];
  const ui = scriptedUI({ inputs: ["/docs off", "/mode ro", "/docs on", "/mode edit", "/exit"] });
  const session = makeSession(ui);
  const state = () => {
    const a = session.agent;
    return `${a.mode}:${a.tools.some((t) => t.name === "lookup_docs")}/${a.messages[0].content.includes(LINE)}`;
  };
  const read = ui.readInput;
  ui.readInput = async () => { states.push(state()); return read(); };
  await session.run();
  assert.deepEqual(states, ["edit:true/true", "edit:false/false", "ro:false/false", "ro:true/true", "edit:true/true"]);
  resetConfig();

  // A session started with the setting off has neither.
  C.updateConfig({ docsTool: false });
  const off = makeSession(scriptedUI({ inputs: ["/exit"] }));
  assert.equal(off.agent.tools.some((t) => t.name === "lookup_docs"), false);
  assert.equal(off.agent.messages[0].content.includes("lookup_docs"), false);
  await off.run();
  resetConfig();
});

test("/docs key: masked prompt, checked before saving, a rejected key is not saved, empty removes it", async () => {
  resetConfig();
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.authorization);
    return new Response("{}", { status: init.headers.authorization === "Bearer ctx7sk-good-key-abcd" ? 404 : 401 });
  };
  try {
    const ui = scriptedUI({ inputs: ["/docs key", "/docs key", "/docs key", "/docs key", "/exit"], prompts: ["ctx7sk-bad-key-0000", " ctx7sk-good-key-abcd ", "has spaces in it", ""] });
    const session = makeSession(ui);
    await session.run();
    assert.ok(ui.shown.prompts.every((p) => p.opts?.secret === true), "the key is typed into a masked field");
    assert.match(ui.shown.prompts[0].placeholder, /context7\.com\/dashboard/);
    assert.match(ui.shown.prompts[2].placeholder, /saved \(…abcd\)/);
    assert.deepEqual(seen, ["Bearer ctx7sk-bad-key-0000", "Bearer ctx7sk-good-key-abcd"], "one check per key; the malformed one is never sent");
    assert.ok(ui.shown.warnings.some((w) => /Context7 rejected this key — not saved/.test(w)));
    assert.ok(ui.shown.lines.some((l) => l === "· Context7 key saved and working (…abcd)"));
    assert.ok(ui.shown.warnings.some((w) => /does not look like an API key/.test(w)));
    assert.ok(ui.shown.lines.some((l) => /Context7 key removed — lookups are anonymous \(200 a month\)/.test(l)));
    assert.equal(C.loadConfig().context7Key, undefined);
    const everything = [...ui.shown.lines, ...ui.shown.warnings].join("\n");
    assert.doesNotMatch(everything, /good-key|bad-key/, "a key is never echoed");
  } finally {
    globalThis.fetch = real;
    resetConfig();
  }
});

test("/docs key: a key that cannot be checked (offline) is saved and says so", async () => {
  resetConfig();
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw netError(); };
  try {
    const ui = scriptedUI({ inputs: ["/docs key", "/exit"], prompts: ["ctx7sk-offline-9876"] });
    await makeSession(ui).run();
    assert.equal(C.loadConfig().context7Key, "ctx7sk-offline-9876");
    assert.ok(ui.shown.lines.some((l) => /Context7 key saved \(…9876\) — could not check it/.test(l)));
    assert.equal(C.context7Key({ CONTEXT7_API_KEY: "ctx7sk-env" }), "ctx7sk-offline-9876");
  } finally {
    globalThis.fetch = real;
    resetConfig();
  }
});
