// Summarize captured runs without treating a model's final answer as a test pass.
// Usage: node bench/lifecycle-report.cjs LOG_ROOT
const fs=require('node:fs');
const path=require('node:path');
function collect(dir) {
 return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?collect(path.join(dir,e.name)):e.name.endsWith('.jsonl')?[path.join(dir,e.name)]:[]);
}
const rows=collect(path.resolve(process.argv[2])).map(file=>{
 const events=fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
 const start=events.find(e=>e.event==='start');if(!start)return null;
 const end=events.findLast(e=>e.event==='finish');
 const actions=events.filter(e=>e.event==='post_compact').map(e=>e.payload.action);
 return {run:path.relative(path.resolve(process.argv[2]),file),context:start.context,effort:start.effort,
  outcome:end?.outcome??'no final record',seconds:Math.round((new Date((end??events.at(-1)).time)-new Date(start.time))/1000),
  codingRequests:events.filter(e=>e.event==='request'&&e.kind==='coding').length,
  summaryRequests:events.filter(e=>e.event==='request'&&e.kind==='summary').length,
  tools:events.filter(e=>e.event==='tool_call').length,
  evictions:actions.filter(a=>a==='evicted').length,summariesApplied:actions.filter(a=>a==='compacted'||a==='floor').length,
  error:end?.error??null};
}).filter(Boolean);
console.log(JSON.stringify(rows,null,2));
