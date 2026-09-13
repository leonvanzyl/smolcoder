const test = require('node:test');
const assert = require('node:assert/strict');
const { Plan } = require('../dist/plan');
const { executeTool } = require('../dist/tools');

test('a local-model semicolon plan remains a checklist after the first done call', async () => {
  const plan = new Plan();
  const result = await executeTool('plan', { steps:'scaffold vite; implement world; add movement; verify gameplay' }, { plan });
  assert.match(result,/Plan set \(4 steps\)/);
  assert.match(plan.markDone(),/Next: 2. implement world/);
  assert.equal(plan.doneCount,1);
  plan.checkpoint('World.getBlock(x,y,z); next: collision');
  assert.match(plan.compactLine(),/World.getBlock/);
  const before=JSON.stringify(plan.steps);
  assert.match(await executeTool('plan',{action:'set',steps:['a','b']},{plan}),/^Error:/);
  assert.equal(JSON.stringify(plan.steps),before);
  plan.set('Inspect foo(); preserve API\nRun tests');
  assert.equal(plan.steps.length,2);
  assert.equal(plan.steps[0].text,'Inspect foo(); preserve API');
});

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
