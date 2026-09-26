// The web UI is themed only through CSS variables: dark in :root, light in
// :root[data-theme="light"]. A stray hex color would stay dark in light mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const { STYLES } = require('../dist/web/styles');

const block = (selector) => {
  const start = STYLES.indexOf(selector + ' {');
  assert.notEqual(start, -1, `${selector} block missing`);
  const end = STYLES.indexOf('}', start);
  return { start, end: end + 1, text: STYLES.slice(start, end + 1) };
};
const dark = block(':root');
const light = block(':root[data-theme="light"]');
const defined = (b) => new Set([...b.text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

test('no literal hex color outside the two palette blocks', () => {
  const rest = STYLES.slice(0, dark.start) + STYLES.slice(dark.end, light.start) + STYLES.slice(light.end);
  assert.deepEqual(rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], []);
});

test('every var() used is defined in the dark :root', () => {
  const vars = defined(dark);
  const missing = [...new Set([...STYLES.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))].filter((v) => !vars.has(v));
  assert.deepEqual(missing, []);
});

test('the light palette overrides every dark variable', () => {
  const lightVars = defined(light);
  assert.deepEqual([...defined(dark)].filter((v) => !lightVars.has(v)), []);
  assert.match(light.text, /color-scheme:\s*light/);
  assert.match(dark.text, /color-scheme:\s*dark/);
});
