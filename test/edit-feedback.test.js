const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {editFile}=require('../dist/tools/fs-tools');
test('a failed edit points to a bounded source range without changing the file',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'smol-edit-feedback-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=Array.from({length:140},(_,i)=>`// line ${i+1}`).join('\n')+'\n}\n\nfunction actualTarget() {\n  return 42;\n}\n';
 fs.writeFileSync(path.join(root,'module.js'),source);
 const result=editFile(root,{path:'module.js',old_text:'}\n\nfunction actualTarget() {\n  return 41;\n}',new_text:'replacement'});
 assert.match(result,/^Error: old_text was not found/);
 assert.match(result,/"offset":141/);
 assert.match(result,/location hint, not the whole block/);
 assert.equal(fs.readFileSync(path.join(root,'module.js'),'utf8'),source);
});
