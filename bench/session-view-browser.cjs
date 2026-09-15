// Real layout/scroll regression checks, with a fake event stream and no model.
// Run after npm run build: node bench/session-view-browser.cjs
// Uses Playwright, or PLAYWRIGHT_PATH / CHROME_PATH as in the other browser benches.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const { PAGE_HTML } = require('../dist/web/page');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.EventSource = class { constructor() { window.sessionEvents = this; } };
    });
    await page.route('http://smol.test/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }));
    await page.goto('http://smol.test/');
    const emit = (events) => page.evaluate((events) => {
      for (const event of events) window.sessionEvents.onmessage({ data: JSON.stringify(event) });
    }, events);
    const settle = () => page.waitForTimeout(150); // markdown timer + browser scroll/resize delivery
    const metrics = () => page.locator('#logwrap').evaluate((log) => ({
      top: log.scrollTop, gap: log.scrollHeight - log.scrollTop - log.clientHeight,
      jumpHidden: document.getElementById('jumpbottom').hidden,
    }));
    const bottom = async () => {
      await page.waitForFunction(() => {
        const log = document.getElementById('logwrap');
        return log.scrollHeight - log.scrollTop - log.clientHeight <= 2 && document.getElementById('jumpbottom').hidden;
      });
    };
    const lines = (sid, count, prefix) => Array.from({ length: count }, (_, i) => ({ t: 'line', sid, kind: 'status', s: prefix + ' ' + i }));
    await emit([{ t: 'hub', home: '/workspace', version: 'test', workspaces: [{ path: '/workspace/demo', name: 'demo', sessions: [
      { id: 's1', title: 'Scroll test', live: true, status: 'busy', updatedAt: 2 },
      { id: 's2', title: 'Other session', live: true, status: 'busy', updatedAt: 1 },
    ] }] }, ...['s1', 's2'].map((sid) => ({ t: 'state', sid, s: { mode: 'edit', model: 'fixture', backend: 'ollama', workspace: '/workspace/demo', commands: [] } })),
    ...lines('s1', 100, 'Earlier message'), ...lines('s2', 70, 'Background message')]);
    await settle();
    await bottom();

    // A small upward wheel gesture must disengage follow even inside the old
    // 120px threshold, while thinking/status updates continue arriving.
    await page.locator('#logwrap').hover();
    await page.mouse.wheel(0, -48);
    await page.waitForFunction(() => !document.getElementById('jumpbottom').hidden);
    const reading = await metrics();
    assert.ok(reading.gap > 2 && reading.gap < 120);
    await emit([{ t: 'busy', sid: 's1', label: 'thinking' }, { t: 'thinking', sid: 's1', s: 'Considering the change.' },
      ...lines('s1', 5, 'New message')]);
    await settle();
    assert.equal((await metrics()).top, reading.top, 'streaming pulled a small upward scroll back down');
    assert.equal((await metrics()).jumpHidden, false);
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
    await bottom();
    await emit([{ t: 'token', sid: 's1', s: 'New paragraph.\n\n'.repeat(20) }]);
    await settle();
    await bottom();
    console.log('PASS: small upward scroll stays put; jump button restores streaming follow');

    // Deliver a token before the pending native scroll event has fired.
    const queuedTop = await page.locator('#logwrap').evaluate((log) => {
      log.scrollTop -= 24;
      const top = log.scrollTop;
      window.sessionEvents.onmessage({ data: JSON.stringify({ t: 'thinking', sid: 's1', s: 'Another thought' }) });
      return top;
    });
    await settle();
    assert.equal((await metrics()).top, queuedTop, 'a queued scroll event lost to a token');
    await emit([{ t: 'tool', sid: 's1', name: 'read_file', summary: 'README.md' },
      { t: 'result', sid: 's1', body: 'Tool output\n'.repeat(40) },
      { t: 'plan', sid: 's1', steps: [{ text: 'Check the UI', done: false }], current: 0 },
      { t: 'turnend', sid: 's1', label: 'done' }, { t: 'busy', sid: 's1', label: null }]);
    await settle();
    assert.equal((await metrics()).top, queuedTop, 'tool/plan/turn completion moved the reading position');
    console.log('PASS: pending scroll events, tools, plans, and busy state preserve the reading position');

    // Switching must preserve both a reading position and bottom-follow mode.
    await page.locator('.sess').filter({ hasText: 'Other session' }).click();
    await settle();
    await bottom();
    await emit(lines('s1', 8, 'While away'));
    await page.locator('.sess').filter({ hasText: 'Scroll test' }).click();
    await settle();
    assert.equal((await metrics()).top, queuedTop, 'switching sessions forgot the reading position');
    assert.equal((await metrics()).jumpHidden, false);
    await emit(lines('s2', 8, 'While away'));
    await page.locator('.sess').filter({ hasText: 'Other session' }).click();
    await settle();
    await bottom();
    await page.locator('.sess').filter({ hasText: 'Scroll test' }).click();
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
    await bottom();
    console.log('PASS: each session retains its own reading/follow state');

    // Keep the whole trace (> the previous 4,000 character truncation), render
    // it as text, and preserve disclosure state across tokens and completion.
    const reasoning = 'START OF REASONING\n\n' + 'A full line of reasoning to review.\n'.repeat(180) + '<img src=x onerror=alert(1)>\nEND OF REASONING';
    await emit([{ t: 'thinking', sid: 's1', s: reasoning }]);
    await settle();
    await bottom();
    const thought = page.locator('.log:not([hidden]) details.thought').last();
    assert.equal(await thought.evaluate((node) => node.open), false);
    assert.equal(await thought.locator('.thought-body').textContent(), reasoning);
    assert.equal(await thought.locator('img').count(), 0, 'reasoning was interpreted as HTML');
    const beforeExpand = await metrics();
    await thought.locator('summary').click();
    await settle();
    assert.equal(await thought.evaluate((node) => node.open), true);
    assert.equal((await metrics()).top, beforeExpand.top, 'expanding reasoning scrolled past its beginning');
    await emit([{ t: 'thinking', sid: 's1', s: '\nStill streaming.' }]);
    await settle();
    assert.equal((await metrics()).top, beforeExpand.top, 'expanded reasoning interrupted reading');
    assert.equal(await thought.locator('.thought-body').textContent(), reasoning + '\nStill streaming.');
    // Keyboard activation should collapse and expand the native disclosure.
    await thought.locator('summary').focus();
    await page.keyboard.press('Enter');
    await settle();
    assert.equal(await thought.evaluate((node) => node.open), false);
    await bottom();
    await emit([{ t: 'thinking', sid: 's1', s: '\nCollapsed update.' }]);
    // A growing plan panel exercises following after a collapse without
    // ending the thought, just as an existing UI block can resize asynchronously.
    await page.locator('.log:not([hidden]) .plan').evaluate((plan) => { plan.style.minHeight = '400px'; });
    await settle();
    await bottom();
    await page.keyboard.press('Space');
    await settle();
    assert.equal(await thought.evaluate((node) => node.open), true);
    await emit([{ t: 'token', sid: 's1', s: 'Finished answer.' }, { t: 'turnend', sid: 's1', label: 'done' }]);
    await settle();
    assert.equal(await thought.evaluate((node) => node.open), true);
    assert.match(await thought.locator('summary').textContent(), /thought for/);
    assert.equal(await thought.locator('.thought-body').textContent(), reasoning + '\nStill streaming.\nCollapsed update.');
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    console.log('PASS: full reasoning expands/collapses with mouse and keyboard, streams safely, and survives completion');

    // Scroll manually to the end, then keep following as the viewport changes.
    await page.locator('#logwrap').evaluate((log) => { log.scrollTop = log.scrollHeight; });
    await settle();
    await bottom();
    await page.setViewportSize({ width: 750, height: 600 });
    await settle();
    await bottom();
    await emit([{ t: 'token', sid: 's1', s: 'More streamed text.\n\n'.repeat(20) }]);
    await settle();
    await bottom();
    await page.locator('#logwrap').evaluate((log) => { log.scrollTop -= 200; });
    await settle();
    const beforeResize = await metrics();
    await page.setViewportSize({ width: 750, height: 700 });
    await settle();
    assert.equal((await metrics()).top, beforeResize.top);
    const buttonBox = await page.locator('#jumpbottom').boundingBox();
    assert.ok(buttonBox.x >= 0 && buttonBox.x + buttonBox.width <= 750, 'jump button overflows narrow viewport');
    console.log('PASS: manual return resumes follow; resize respects follow/reading state and mobile layout');

    await emit([{ t: 'thinking', sid: 's1', s: 'Discard this partial attempt' }, { t: 'response_reset', sid: 's1' },
      { t: 'thinking', sid: 's1', s: 'Replacement reasoning' }, { t: 'tool', sid: 's1', name: 'read_file', summary: 'src/web/client.ts' }]);
    await settle();
    const lastThought = page.locator('.log:not([hidden]) details.thought').last();
    assert.equal(await lastThought.locator('.thought-body').textContent(), 'Replacement reasoning');
    assert.equal(await page.getByText('Discard this partial attempt', { exact: true }).count(), 0);
    assert.deepEqual(errors, [], 'browser errors');
    console.log('PASS: response reset clears partial reasoning; no browser errors');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
