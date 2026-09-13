const test=require('node:test'),assert=require('node:assert/strict');
const {validateHeading}=require('./movement-check.cjs');
test('movement basis stays orthogonal at three headings and rejects a mirrored sine',()=>{
  for(const yaw of [0,.4,1.1]){
    const s=Math.sin(yaw),c=Math.cos(yaw);
    assert.doesNotThrow(()=>validateHeading({w:[s,-c],s:[-s,c],a:[-c,-s],d:[c,s]}));
  }
  const s=Math.sin(.4),c=Math.cos(.4);
  assert.throws(()=>validateHeading({w:[s,-c],s:[-s,c],a:[-c,s],d:[c,-s]}),/perpendicular/);
  assert.throws(()=>validateHeading({w:[0,-1],s:[0,-1],a:[-1,0],d:[1,0]}),/opposite/);
});
