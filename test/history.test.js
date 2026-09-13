const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {writeFile,editFile}=require('../dist/tools/fs-tools');

test('legacy history placeholders cannot create, overwrite, or replace source code', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'smol-history-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const marker='[1900 characters already applied to game.js. Read the file for current code.]';
  assert.match(writeFile(root,{path:'missing.js',content:marker}),/^Error: this is a history placeholder/);
  assert.equal(fs.existsSync(path.join(root,'missing.js')),false);
  writeFile(root,{path:'game.js',content:'export const game = 42;'});
  assert.match(writeFile(root,{path:'game.js',content:marker}),/^Error:/);
  assert.match(editFile(root,{path:'game.js',old_text:'42',new_text:marker}),/^Error:/);
  assert.equal(fs.readFileSync(path.join(root,'game.js'),'utf8'),'export const game = 42;');
  assert.match(writeFile(root,{path:'notes.md',content:'Example legacy marker:\n'+marker}),/^Created/);
});
