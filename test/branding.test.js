// The SMOL logo must open every interactive terminal session and greet the
// web UI. It was lost once in an unrelated refactor; this pins it down.
const test = require('node:test');
const assert = require('node:assert/strict');
const { LOGO_ROWS, LOGO_TEXT, terminalLogo } = require('../dist/logo');
const { PAGE_HTML } = require('../dist/web/page');
const { STYLES } = require('../dist/web/styles');

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('logo rows spell SMOL in equal-width block letters', () => {
  assert.equal(LOGO_ROWS.length, 6);
  for (const r of LOGO_ROWS) assert.equal(r.length, LOGO_ROWS[0].length, 'row width differs: ' + r);
  assert.ok(LOGO_ROWS[0].startsWith('███████╗ ███╗   ███╗  ██████╗  ██╗'), 'first row is not the S M O L cap');
});

test('terminal session banner shows the block logo on a normal-width terminal', () => {
  const lines = terminalLogo(80, '9.9.9').map(strip);
  for (const r of LOGO_ROWS) assert.ok(lines.some((l) => l.includes(r.trimEnd())), 'missing row: ' + r);
  assert.ok(lines.some((l) => l.includes('coder v9.9.9')), 'version tail missing');
});

test('terminal banner keeps the art and drops the tail to its own line when only the art fits', () => {
  const lines = terminalLogo(45, '9.9.9').map(strip);
  for (const r of LOGO_ROWS) assert.ok(lines.some((l) => l.includes(r.trimEnd())), 'missing row: ' + r);
  assert.ok(lines.some((l) => l.trim() === 'coder v9.9.9'), 'tail should be on its own line');
});

test('terminal banner falls back to the plain name on a narrow terminal', () => {
  const lines = terminalLogo(30, '9.9.9').map(strip);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /smolcoder v9\.9\.9/);
  for (const r of LOGO_ROWS) assert.ok(!lines[0].includes(r.trimEnd()));
});

test('web welcome screen and sidebar header carry the logo', () => {
  assert.ok(PAGE_HTML.includes('<div id="logo"'), 'welcome logo element missing');
  assert.ok(PAGE_HTML.includes(LOGO_TEXT), 'welcome logo text missing');
  assert.ok(PAGE_HTML.includes('coder — web'));
  const side = PAGE_HTML.slice(PAGE_HTML.indexOf('<aside id="side">'), PAGE_HTML.indexOf('</aside>'));
  assert.ok(side.includes(LOGO_TEXT), 'sidebar header logo missing');
  assert.ok(side.includes('role="img" aria-label="smolcoder"'), 'sidebar logo needs an accessible name');
  assert.ok(!side.includes('smol<span'), 'the old text wordmark should be gone');
});

test('a fresh, empty web session opens on the logo', () => {
  assert.ok(STYLES.includes('.log:empty::before'), 'empty-session rule missing');
  const rule = STYLES.slice(STYLES.indexOf('.log:empty::before'), STYLES.indexOf('.log:empty::after'));
  for (const r of LOGO_ROWS) assert.ok(rule.includes(r.trimEnd()), 'empty-session logo missing row: ' + r);
  assert.ok(rule.includes(String.fromCharCode(92) + 'A '), 'rows must be separated by CSS newlines');
});
