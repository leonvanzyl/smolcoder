// Exercise the real hub/client preview without making an inference request.
const fs = require('node:fs');
const path = require('node:path');
const { WebHub } = require('../dist/web/hub');

async function openPreview(page, url, dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const factory = async (ui, workspace) => ({
    chosen: { id: 'browser-fixture', backend: 'ollama' }, workspace,
    taskManager: { killAll() {}, runningSummary: () => [], recentUrls: () => [url] },
    state: () => ({ mode: 'edit', model: 'browser-fixture', backend: 'ollama', workspace, urls: [url], commands: [] }),
    announce() {}, restore() {}, snapshot: () => ({ messages: [], plan: [] }),
    async run() { while (await ui.readInput() !== '/exit') {} },
  });
  const hub = new WebHub({ port: 0, prefs: {}, help: '', version: 'browser-test', dataDir: path.resolve(dataDir), factory, quiet: true });
  await hub.start();
  try {
    const base = `http://127.0.0.1:${hub.port}`;
    const response = await fetch(`${base}/sessions/new?k=${hub.authToken}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: path.resolve(dataDir) }),
    });
    if (!response.ok) throw new Error('Could not create preview test session');
    await page.goto(`${base}/?k=${hub.authToken}`);
    await page.locator('.sess').first().click();
    await page.locator('#btnbrowser').click();
    const iframe = page.locator('iframe[title="App preview"]');
    await iframe.waitFor({ state: 'visible' });
    const frame = await (await iframe.elementHandle()).contentFrame();
    await frame.waitForLoadState();
    return { frame, close: () => hub.close() };
  } catch (e) { hub.close(); throw e; }
}
module.exports = { openPreview };
