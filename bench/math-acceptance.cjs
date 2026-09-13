// Caller-owned behavior checks for bench/context-smoke.txt. No source writes.
const assert=require('node:assert/strict'),path=require('node:path');
const index=require(path.join(process.cwd(),'index.js'));
const cases={add:[[2,3,5],[-2,3,1]],subtract:[[7,2,5],[-2,3,-5]],multiply:[[3,4,12],[-2,3,-6]],divide:[[12,3,4],[5,2,2.5]],clamp:[[5,0,10,5],[-1,0,10,0],[12,0,10,10]],sum:[[[1,2,3],6],[[],0],[[-2,3],1]]};
let checks=0;
for(const [name,examples] of Object.entries(cases)){
  const module=require(path.join(process.cwd(),name+'.js'));
  for(const fn of [typeof module==='function'?module:module[name],index[name]]){
    assert.equal(typeof fn,'function',name+' must be exported from its module and index.js');
    for(const example of examples){assert.equal(fn(...example.slice(0,-1)),example.at(-1),name);checks++;}
    if(name==='divide'){assert.throws(()=>fn(1,0),'divide must reject zero');checks++;}
  }
}
console.log(`PASS: ${checks} independent arithmetic/export/error checks`);
