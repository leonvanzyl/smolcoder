// npm run build first. PLAYWRIGHT_PATH and CHROME_PATH may override local installs.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { openPreview } = require('./preview-harness.cjs');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = path.resolve(process.env.PREVIEW_LOG_DIR || 'playground/.preview-browser');
const html = `<!doctype html><button id="play">Play Game</button><button id="new">New World</button><canvas></canvas>
<script>window.changed = false;
document.querySelector('#play').onclick = () => document.querySelector('canvas').requestPointerLock();
document.querySelector('#new').onclick = () => { if(confirm('New world?')) window.changed = true; };
document.addEventListener('pointerlockchange', () => document.querySelector('#play').hidden = !!document.pointerLockElement);
</script>`;
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const app = http.createServer((_q, r) => { r.setHeader('Content-Type', 'text/html'); r.end(html); });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  let browser, preview;
  const errors = [], results = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    page.on('pageerror', e => errors.push(e.message));
    preview = await openPreview(page, `http://127.0.0.1:${app.address().port}`, path.join(out, 'hub'));
    const frame = preview.frame;
    const check = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch(e) { results.push({ name, passed: false, error: e.message }); } };
    await check('Play Game acquires pointer lock inside the real preview', async () => {
      await frame.click('#play'); await frame.waitForFunction(() => !!document.pointerLockElement);
      assert.equal(await frame.locator('#play').isVisible(), false);
    });
    await frame.evaluate(() => document.exitPointerLock());
    await check('confirmation reaches the user inside the preview', async () => {
      page.once('dialog', d => d.accept()); await frame.click('#new');
      await frame.waitForFunction(() => window.changed === true);
    });
    await check('preview cannot navigate to the hub origin', async () => {
      const before = frame.url(); const input = page.locator('.tabbody.browser input').first();
      await input.fill(new URL(page.url()).origin); await input.press('Enter');
      assert.equal(frame.url(), before); assert.equal(await input.evaluate(e => e.validity.valid), false);
    });
    await check('no browser exceptions', async () => assert.deepEqual(errors, []));
  } finally {
    await browser?.close(); preview?.close(); await new Promise(resolve => app.close(resolve));
    const result = { passed: results.length === 4 && results.every(r => r.passed), results, errors };
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
