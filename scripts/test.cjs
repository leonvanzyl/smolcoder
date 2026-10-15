// Explicit discovery keeps generated playground projects out of harness tests.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(root, 'test', f));
// An empty home: smolcoder reads oMLX's, MTPLX's and LM Studio's own settings
// and ~/.smolcoder from there, so a real one makes results depend on what is
// installed on this machine. USERPROFILE is Windows' home.
const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'smol-test-home-'));
const env = { ...process.env, HOME: home, USERPROFILE: home };
const run = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', env });
fs.rmSync(home, { recursive: true, force: true });
if (run.error) console.error(run.error);
process.exitCode = run.status ?? 1;
