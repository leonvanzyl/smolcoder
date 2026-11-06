// run_command full logs (B5) and the TypeScript syntax check (B8).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runCommand, OUTPUT_LOG_DIR } = require("../dist/tools/shell");
const { readFile } = require("../dist/tools/fs-tools");
const { syntaxCheck } = require("../dist/tools/check");
const { executeTool } = require("../dist/tools/index");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    // Drop the linked compiler first, so cleanup can never reach the real one.
    const link = path.join(dir, "node_modules", "typescript");
    try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* not linked */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold it briefly */ }
  });
  return dir;
}

const script = (dir, name, body) => { fs.writeFileSync(path.join(dir, name), body); return `node ${name}`; };

test("cut command output points at a full log that read_file can open", async (t) => {
  const dir = tmp(t, "smol-core-log-");
  const cmd = script(dir, "noisy.cjs", "for (let i = 0; i < 3000; i++) console.log('line ' + i);");
  const out = await runCommand(cmd, dir, undefined, { maxChars: 2000, saveLog: true });
  assert.ok(out.length <= 2000, `result is ${out.length} chars`);
  const lines = out.split("\n");
  assert.match(lines.at(-1), /^\[exit code 0 in /, "the exit line stays last");
  const note = lines.at(-2);
  assert.equal(note, `[full output: ${OUTPUT_LOG_DIR}/1.log]`);
  const logPath = note.slice("[full output: ".length, -1);
  const full = fs.readFileSync(path.join(dir, logPath), "utf8");
  assert.match(full, /line 0\n[\s\S]*line 1500\n[\s\S]*line 2999/);
  assert.equal(fs.readFileSync(path.join(dir, OUTPUT_LOG_DIR, ".gitignore"), "utf8"), "*\n");
  // Reachable through the normal, sandboxed read_file.
  assert.match(readFile(dir, { path: logPath, offset: 1500, limit: 2 }), /^line 1499\nline 1500/);
  const second = await runCommand(cmd, dir, undefined, { maxChars: 2000, saveLog: true });
  assert.match(second, /\[full output: \.smolcoder\/out\/2\.log\]/);
});

test("output that fits gets no log, and checks without saveLog never write one", async (t) => {
  const dir = tmp(t, "smol-core-log-");
  const small = await runCommand(script(dir, "small.cjs", "console.log('hello')"), dir, undefined, { maxChars: 2000, saveLog: true });
  assert.doesNotMatch(small, /full output/);
  const big = await runCommand(script(dir, "big.cjs", "console.log('x'.repeat(20000))"), dir);
  assert.doesNotMatch(big, /full output/);
  assert.equal(fs.existsSync(path.join(dir, OUTPUT_LOG_DIR)), false);
});

test("run_command through the tool registry saves the log and keeps the exit line last", async (t) => {
  const dir = tmp(t, "smol-core-log-");
  // exitCode, not exit(): on Linux, writes to a pipe are async and exit() would cut them short.
  script(dir, "fail.cjs", "for (let i = 0; i < 2000; i++) console.error('err ' + i); process.exitCode = 3;");
  const ctx = { workspace: dir, plan: new Plan(), taskManager: new TaskManager(dir), filesTouched: new Set(), commandsRun: [], resultCharLimit: 3000 };
  const out = await executeTool("run_command", { command: "node fail.cjs" }, ctx);
  assert.match(out, /^Error: command exited with code 3/);
  assert.match(out, /\[full output: \.smolcoder\/out\/1\.log\]\n\[exit code 3 in [^\]]+\]$/);
  assert.match(ctx.commandsRun[0], /→ \[exit code 3/);
});

function linkTypeScript(t, dir) {
  const target = path.join(__dirname, "..", "node_modules", "typescript");
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  try { fs.symlinkSync(target, path.join(dir, "node_modules", "typescript"), "junction"); return true; }
  catch { t.skip("cannot link node_modules/typescript"); return false; }
}

test("TypeScript files get a syntax check from the project's own compiler", (t) => {
  const dir = tmp(t, "smol-core-ts-");
  if (!linkTypeScript(t, dir)) return;
  fs.mkdirSync(path.join(dir, "src"));
  const bad = path.join(dir, "src", "bad.ts");
  fs.writeFileSync(bad, "export function f(a: number) {\n  return a +;\n}\nconst x = ;\n");
  // The linked compiler lives outside the workspace: running it would need
  // the user's approval in edit mode, so the check stays silent there.
  assert.equal(syntaxCheck(bad, "src/bad.ts", dir), null);
  const allowed = () => true; // bypass mode
  const warning = syntaxCheck(bad, "src/bad.ts", dir, allowed);
  assert.match(warning, /^src\/bad\.ts has a TypeScript syntax error at line 2: Expression expected\.$/);
  // Type errors are not syntax errors: only parsing is checked.
  const typed = path.join(dir, "src", "typed.ts");
  fs.writeFileSync(typed, "const n: number = 'text';\nexport default n;\n");
  assert.equal(syntaxCheck(typed, "src/typed.ts", dir, allowed), null);
  const tsx = path.join(dir, "src", "view.tsx");
  fs.writeFileSync(tsx, "export const V = () => <div className=\"a\">hi</div>;\n");
  assert.equal(syntaxCheck(tsx, "src/view.tsx", dir, allowed), null);
  fs.writeFileSync(tsx, "export const V = () => <div>hi</span>;\n");
  assert.match(syntaxCheck(tsx, "src/view.tsx", dir, allowed), /TypeScript syntax error at line 1/);
});

test("without a project TypeScript the check stays silent", (t) => {
  const dir = tmp(t, "smol-core-ts-");
  const bad = path.join(dir, "bad.ts");
  fs.writeFileSync(bad, "const x = ;\n");
  assert.equal(syntaxCheck(bad, "bad.ts", dir), null);
  assert.equal(syntaxCheck(bad, "bad.ts"), null);
});

test("edit_file on a .ts file reports the first syntax error in its result", (t) => {
  const dir = tmp(t, "smol-core-ts-");
  if (!linkTypeScript(t, dir)) return;
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  // The linked compiler lives outside the workspace: allowed as in bypass mode.
  const ctx = { workspace: dir, plan: new Plan(), taskManager: new TaskManager(dir), filesTouched: new Set(), commandsRun: [], mayRunUnasked: () => true };
  return executeTool("edit_file", { path: "a.ts", old_text: "export const a = 1;", new_text: "export const a = (1;" }, ctx).then((out) => {
    assert.match(out, /^Edited a\.ts/);
    assert.match(out, /Warning: a\.ts has a TypeScript syntax error at line 1: '\)' expected\./);
    assert.deepEqual(ctx.lastChange.diff, { path: "a.ts", before: "export const a = 1;", after: "export const a = (1;" });
  });
});
