const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OllamaProvider } = require('../dist/providers/ollama');
const { LmStudioProvider } = require('../dist/providers/lmstudio');
const { ContextManager } = require('../dist/context');
const { Agent } = require('../dist/agent');
const { Plan } = require('../dist/plan');
const { EventBus } = require('../dist/events');
const { SessionChannel } = require('../dist/web/channel');
const { searchFilesBounded } = require('../dist/tools/search-worker');
const { resolveInWorkspace } = require('../dist/sandbox');
const { scheduleInference } = require('../dist/providers/scheduler');
const { abortableDelay } = require('../dist/providers/transport');
const { parseArgs } = require('../dist/providers/types');
const { resolveContextWindow } = require('../dist/detect');
const { runCommand } = require('../dist/tools/shell');
const { pickShell } = require('../dist/tools/shell');

test('a failing Bash pipeline remains a failed tool result', async t => {
  if (!pickShell().label.includes('bash')) return t.skip('Bash is not available');
  const result = await runCommand('node -e "process.exit(7)" | node -e "process.stdin.resume()"',process.cwd());
  assert.match(result,/^Error: command exited with code 7/);
});

test('long command output retains the final failure details', async () => {
  const result = await runCommand('node -e "console.log(\'BEGIN_LOG\'); for(let i=0;i<2000;i++) console.log(\'x\'.repeat(80)); setTimeout(()=>{console.error(\'FINAL_FAILURE_DETAIL\'); process.exitCode=1;},30)"',process.cwd());
  assert.match(result,/^Error: command exited with code 1/);
  assert.match(result,/BEGIN_LOG/);
  assert.match(result,/FINAL_FAILURE_DETAIL/);
  assert.ok(result.length<9000);
});

const state = { originalRequest: 'Build the app; preserve keyboard support.', currentRequest: 'Fix the editor.', filesTouched: new Set(['editor.js']), commandsRun: ['npm test'], planLine: 'Plan: verify editor' };
const messages = [{ role: 'system', content: 'code' }, { role: 'user', content: 'hello' }];
const ui = () => ({ token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {}, warn() {}, error() {}, startSpinner() {}, stopSpinner() {}, turnEnd() {}, planUpdated() {}, async confirmCommand() { return 'yes'; } });
const fake = (fn) => ({ label: 'fake', modelId: 'fake', contextWindow: 8000, maxOutputTokens: 2000, setEffort() {}, effortLabel() { return null; }, chat: fn });
function agentFor(provider, view = ui(), max = 10) {
  const ctx = { workspace: process.cwd(), plan: new Plan(), taskManager: { runningSummary() { return []; } }, filesTouched: new Set(), commandsRun: [] };
  return new Agent(provider, 'ro', 'sys', ctx, new ContextManager(8000, 2000), new EventBus(), view, false, max);
}

test('providers reject incomplete, malformed and error streams; complete streams preserve usage', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  for (const backend of ['ollama', 'lmstudio']) {
    const provider = backend === 'ollama' ? new OllamaProvider('http://test', 'm', 8000) : new LmStudioProvider('http://test', 'm', 8000);
    const partial = backend === 'ollama' ? '{"message":{"content":"partial"}}\n' : 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
    global.fetch = async () => new Response(partial);
    await assert.rejects(provider.chat(messages, []), /stream ended before completion/);
    global.fetch = async () => new Response(backend === 'ollama' ? '{bad}\n' : 'data: {bad}\n');
    await assert.rejects(provider.chat(messages, []), /malformed JSON/);
    global.fetch = async () => new Response(backend === 'ollama' ? '{"error":"runner crashed"}\n' : 'data: {"error":{"message":"runner crashed"}}\n');
    await assert.rejects(provider.chat(messages, []), /runner crashed/);
    const ending = backend === 'ollama' ? '{"done":true,"prompt_eval_count":42,"eval_count":2}' : 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":42,"completion_tokens":2}}';
    global.fetch = async () => new Response(partial + ending);
    const result = await provider.chat(messages, []);
    assert.equal(result.content, 'partial'); assert.equal(result.promptTokens, 42);
  }
});

test('a silent backend hits its deadline and releases the request', async (t) => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  global.fetch = (_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
  await assert.rejects(new OllamaProvider('http://silent', 'm', 8000).chat(messages, [], { idleTimeoutMs: 20 }), /timed out waiting for data/);
});

test('coding preempts optional work and inference never overlaps on a server', async () => {
  const order = [];
  const optional = scheduleInference('shared', { background: true }, async (opts) => { order.push('background'); await abortableDelay(1000, opts.signal); });
  const caught = assert.rejects(optional, { name: 'AbortError' });
  await new Promise(setImmediate);
  const primary = scheduleInference('shared', {}, async () => { order.push('coding'); return 7; });
  assert.equal(await primary, 7); await caught;
  assert.deepEqual(order, ['background', 'coding']);
});

test('empty replies and a model-step limit are failures, never completed turns', async () => {
  const a = agentFor(fake(async () => ({ content: '', toolCalls: [] })));
  await assert.rejects(a.runTurn('build'), /repeatedly returned an empty/);
  assert.equal(a.outcome, 'error');
  const b = agentFor(fake(async () => ({ content: '', toolCalls: [{ id: 'r', name: 'plan', args: { action: 'show' } }] })), ui(), 1);
  await assert.rejects(b.runTurn('build'), /Paused after 1 model steps/);
  assert.equal(b.outcome, 'error');
});

test('oversized requests are not sent to a backend that might silently truncate them', async () => {
  let calls = 0;
  const a = agentFor(fake(async () => { calls++; return { content: 'summary', toolCalls: [] }; }));
  await assert.rejects(a.runTurn('constraint '.repeat(5000)), /Context budget exceeded/);
  assert.ok(calls <= 1, 'only a bounded summary may run, never the oversized coding request');
});

test('restore repairs incomplete tool groups without executing the interrupted command', () => {
  const a = agentFor(fake(async () => { throw Error('should not call'); }));
  a.restoreTranscript([{ role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'run_command', args: { command: 'deploy' } }] }], 'build', 'build');
  assert.equal(a.messages.at(-1).toolCallId, 'x');
  assert.match(a.messages.at(-1).content, /outcome is unknown/);
});

test('compaction retains earlier notes, current request and valid tool pairs', async () => {
  const cm = new ContextManager(4000, 500); let digest;
  const provider = fake(async (m) => { digest = m[1].content; return { content: 'Notes: preserve SECRET_DECISION_123.', toolCalls: [] }; });
  const input = [messages[0], { role: 'user', content: 'Hand-over notes:\nSECRET_DECISION_123', compactNote: true }, ...Array.from({ length: 10 }, () => ({ role: 'assistant', content: 'old '.repeat(1000) })), { role: 'assistant', content: '', toolCalls: [{ id: 'r', name: 'read_file', args: { path: 'a' } }] }, { role: 'tool', content: 'recent '.repeat(2000), toolCallId: 'r' }];
  const result = await cm.manage(input, [], provider, state, { force: true });
  assert.match(digest, /SECRET_DECISION_123/);
  assert.match(result.messages[1].content, /Fix the editor/);
  assert.match(result.messages[1].content, /SECRET_DECISION_123/);
  cm.assertFits(result.messages, []);
  assert.equal(result.messages.filter(m => m.compactNote).length, 1);
  for (let i = 0; i < result.messages.length; i++) if (result.messages[i].role === 'tool') assert.ok(result.messages[i - 1].toolCalls);
});

test('manual compaction works below the automatic threshold', async () => {
  const cm = new ContextManager(8000, 2000);
  const result = await cm.manage(messages, [], fake(async () => ({ content: 'Notes: Hello.', toolCalls: [] })), state, { force: true });
  assert.equal(result.report.action, 'compacted');
  assert.equal(result.messages[1].compactNote, true);
});

test('background compaction preserves appended results and rejects a changed prefix', async () => {
  const source = [{ role: 'system', content: 's' }, ...Array.from({ length: 12 }, () => ({ role: 'assistant', content: 'history '.repeat(240) }))];
  const cm = new ContextManager(8000, 2000);
  const p = fake(async () => ({ content: 'Notes: cached.', toolCalls: [] }));
  cm.prepareBackground(source, [], p, state, 0); await new Promise(resolve => setTimeout(resolve, 10));
  const live = [...source, { role: 'assistant', content: 'NEW_RESULT' }];
  const result = await cm.manage(live, [], p, state, { force: true });
  assert.ok(result.messages.some(m => m.content.includes('NEW_RESULT')));
  const cm2 = new ContextManager(8000, 2000); cm2.prepareBackground(source, [], p, state, 0); await new Promise(resolve => setTimeout(resolve, 10));
  const changed = source.map(m => ({ ...m })); changed[0].content = 'new system';
  const invalidated = await cm2.manage(changed, [], p, state, { force: true, deterministic: true });
  assert.equal(invalidated.messages[0].content, 'new system');
  assert.doesNotMatch(invalidated.messages[1].content, /cached/);
});

test('stream coalescing keeps the user request and stale saved approvals cannot be reused', async () => {
  const sent = []; const host = { send(e) { sent.push(e); }, changed() {}, touched() {} };
  const ch = new SessionChannel('s', host); ch.handleMessage('build'); await ch.readInput();
  for (let i = 0; i < 2500; i++) ch.token('x');
  assert.ok(ch.replay.some(e => e.t === 'user')); assert.ok(ch.replay.length < 5);
  const restored = new SessionChannel('s', host);
  restored.restoreReplay([{ t: 'confirm', id: 40, command: 'old' }]);
  assert.equal(restored.replay.length, 0);
  const pending = restored.confirmCommand('new');
  assert.equal(sent.at(-1).id, 41);
  restored.handleAnswer(40, 'yes'); restored.cancel();
  assert.equal(await pending, 'no');
});

test('search timeouts are cancellable and do not block the event loop', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smol-search-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'.repeat(40) + '!');
  let ticked = false; setTimeout(() => { ticked = true; }, 10);
  const result = await searchFilesBounded(dir, { pattern: '(a+)+$' }, undefined, 150);
  assert.match(result, /timed out/); assert.ok(ticked);
});

test('dangling symlinks cannot create an outside file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smol-links-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root'); fs.mkdirSync(root);
  try { fs.symlinkSync(path.join(dir, 'absent'), path.join(root, 'link')); }
  catch (err) { if (err.code === 'EPERM') { t.skip('OS does not allow creating symlinks'); return; } throw err; }
  assert.throws(() => resolveInWorkspace(root, 'link'), /cannot resolve/);
});

test('arrays and null are not accepted as tool argument objects', () => {
  for (const value of [[], '[1]', null, 'null']) assert.ok(parseArgs(value).parseError);
});

test('LM Studio loads an unloaded model with an explicit context and trusts the returned allocation', async (t) => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  let body;
  global.fetch = async (url, opts) => { assert.match(url, /\/api\/v1\/models\/load$/); body = JSON.parse(opts.body); return Response.json({ instance_id: 'loaded-instance', load_config: { context_length: 8192 } }); };
  const model = { id: 'weights', backend: 'lmstudio', baseUrl: 'http://lm', loaded: false, contextWindow: 4096, maxContext: 32768 };
  const result = await resolveContextWindow(model, 16384);
  assert.equal(body.context_length, 16384); assert.equal(body.echo_load_config, true);
  assert.equal(result.contextWindow, 8192); assert.equal(result.id, 'loaded-instance');
  global.fetch = async () => { throw Error('must not reload'); };
  assert.equal((await resolveContextWindow({ ...model, loaded: true, contextWindow: 8192 }, 16384)).contextWindow, 8192);
});

test('loaded-window shrink is applied before inference, including its output reserve', async () => {
  let cap;
  const p = fake(async (_m, _t, opts) => { cap = opts.maxTokens; return { content: 'done', toolCalls: [] }; });
  p.loadedContextWindow = async () => 4096;
  const a = agentFor(p); await a.runTurn('hello');
  assert.equal(a.contextBudget().window, 4096); assert.equal(cap, 1024);
});

test('a mode downgrade while approval is pending prevents command execution', async () => {
  const view = ui(); let executions = 0; let a;
  view.confirmCommand = async () => { a.setMode('ro', 'read-only'); return 'yes'; };
  const p = fake(async () => ({ content: 'done', toolCalls: [] }));
  const ctx = { workspace: process.cwd(), plan: new Plan(), taskManager: { async startWithEarlyOutput() { executions++; return 'started'; } }, filesTouched: new Set(), commandsRun: [] };
  a = new Agent(p, 'edit', 'sys', ctx, new ContextManager(8000, 2000), new EventBus(), view, true);
  const result = await a.gateAndExecute('task', { action: 'start', command: 'npm install -g example' }, new AbortController().signal);
  assert.equal(executions, 0); assert.match(result, /no longer available/);
});

test('nonzero command exits produce errors instead of success checkmarks', async () => {
  const result = await runCommand('node -e "process.exit(7)"', process.cwd());
  assert.match(result, /^Error: command exited with code 7/);
});

test('LM Studio thinking is excluded from the context estimate', () => {
  const cm = new ContextManager(8000, 2000); cm.setReplayThinking(false);
  const history = [...messages, { role: 'assistant', content: 'a', thinking: 'reason '.repeat(5000) }];
  assert.ok(cm.estimateMessages(history) < 100);
});

test('file-scoped search never includes neighboring files', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smol-scope-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'needle'); fs.writeFileSync(path.join(dir, 'b.txt'), 'needle');
  const result = await searchFilesBounded(dir, { pattern: 'needle', path: 'a.txt' });
  assert.match(result, /a.txt:1/); assert.doesNotMatch(result, /b.txt/);
});
