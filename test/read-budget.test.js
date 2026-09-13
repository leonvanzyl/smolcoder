const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFile } = require('../dist/tools/fs-tools');
const { executeTool } = require('../dist/tools');

test('a context-sized read returns contiguous lines and an accurate continuation offset', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'smol-read-budget-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  const lines = Array.from({length:200},(_,i)=>`line-${i+1}: ${'content '.repeat(8)}`);
  fs.writeFileSync(path.join(workspace,'source.txt'),lines.join('\n'));
  const ctx = {workspace,resultCharLimit:1200};
  let offset = 1;
  for (let page = 0; page < 3; page++) {
    const result = await executeTool('read_file',{path:'source.txt',offset},ctx);
    const range = result.match(/\[showing lines (\d+)-(\d+) of 200/);
    assert.ok(range);
    assert.equal(Number(range[1]),offset);
    const end = Number(range[2]);
    assert.equal(result.split('\n\n[showing')[0],lines.slice(offset-1,end).join('\n'));
    assert.match(result,new RegExp(`"offset": ${end+1}`));
    assert.ok(result.length < 1200);
    offset = end+1;
  }
  fs.writeFileSync(path.join(workspace,'long.txt'),'x'.repeat(4000));
  const long = readFile(workspace,{path:'long.txt'},400);
  assert.match(long,/first 400 characters only/);
  assert.doesNotMatch(long,/"offset"/);
});
