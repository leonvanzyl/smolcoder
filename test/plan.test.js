const test = require('node:test');
const assert = require('node:assert/strict');
const { Plan } = require('../dist/plan');

test('working checkpoints survive a JSON session round trip and do not complete a step', () => {
  const p = new Plan();
  assert.match(p.checkpoint('x'), /^Error/);
  p.set('wire entry point\nverify build');
  p.checkpoint('save.js: makeSaver(storage, size); next: replace missing imports');
  const restored = new Plan();
  restored.steps = JSON.parse(JSON.stringify(p.steps));
  assert.equal(restored.doneCount, 0);
  assert.match(restored.compactLine(), /makeSaver\(storage, size\)/);
  assert.match(restored.checkpoint('x'.repeat(1001)), /^Error/);
  assert.match(restored.modelView(), /makeSaver/);
  restored.checkpoint('replacement checkpoint');
  assert.doesNotMatch(restored.modelView(), /makeSaver/);
  restored.markDone();
  assert.doesNotMatch(restored.modelView(), /replacement checkpoint/);
  assert.equal(restored.steps[0].note, 'replacement checkpoint');
});
