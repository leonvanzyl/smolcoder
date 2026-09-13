// Exercise the real Ollama adapter and agent through a local fault proxy.
// Usage: node bench/live-recovery.cjs WORKSPACE [MODEL]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { Agent } = require('../dist/agent');
const { OllamaProvider } = require('../dist/providers/ollama');
const { ContextManager } = require('../dist/context');
const { EventBus } = require('../dist/events');
const { Plan } = require('../dist/plan');
const { TaskManager } = require('../dist/tools/tasks');
const { buildSystemPrompt } = require('../dist/prompt');
const { pickShell } = require('../dist/tools/shell');

(async()=>{
  const workspace = path.resolve(process.argv[2]);
  fs.mkdirSync(workspace,{recursive:true});
  const model = process.argv[3] || 'qwen3.8:latest';
  let calls=0;
  const thinkingSettings=[];
  let hold=false;
  let onHeld;
  const proxy=http.createServer(async(req,res)=>{
    try {
      const chunks=[]; for await(const chunk of req) chunks.push(chunk);
      const body=Buffer.concat(chunks);
      if(req.url==='/api/chat') {
        calls++;
        thinkingSettings.push(JSON.parse(body.toString('utf8')).think);
        if(hold) {res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.write('{"message":{"content":""}}\n');onHeld?.();return;}
        if(calls===1) {res.writeHead(503);res.end('Injected temporary model overload');return;}
        if(calls===2) {
          res.writeHead(200,{'Content-Type':'application/x-ndjson'});
          res.end(JSON.stringify({message:{role:'assistant',content:'',tool_calls:[{function:{name:'write_file',arguments:{path:'partial-must-not-exist.txt',content:'This incomplete stream must never execute.'}}}]}})+'\n');
          return;
        }
        if(calls===3) {
          res.writeHead(200,{'Content-Type':'application/x-ndjson'});
          res.end(JSON.stringify({message:{role:'assistant',content:'',thinking:'Injected reasoning that consumed the output budget.'},done:true,done_reason:'length',prompt_eval_count:100,eval_count:2048})+'\n');
          return;
        }
      }
      const controller=new AbortController();
      res.on('close',()=>controller.abort());
      const upstream=await fetch('http://127.0.0.1:11434'+req.url,{method:req.method,headers:{'Content-Type':'application/json'},body:body.length?body:undefined,signal:controller.signal});
      res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json'});
      for await(const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch(e) {if(!res.destroyed) res.destroy(e);}
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const warnings=[];
  const ui={token(){},thinking(){},toolCall(){},toolResult(){},println(){},status(s){warnings.push(s);},warn(s){warnings.push(s);},error(){},startSpinner(){},stopSpinner(){},turnEnd(){},planUpdated(){},confirmCommand:async()=> 'no'};
  const manager=new TaskManager(workspace);
  const ctx={workspace,taskManager:manager,plan:new Plan(),filesTouched:new Set(),commandsRun:[]};
  const provider=new OllamaProvider(`http://127.0.0.1:${proxy.address().port}`,model,8192,8192,2048);
  provider.setEffort('low');
  const agent=new Agent(provider,'edit',buildSystemPrompt({workspace,mode:'edit',shellLabel:pickShell().label}),ctx,new ContextManager(8192,2048),new EventBus(),ui,false,20);
  try {
    await agent.runTurn('Use write_file to create recovery.txt with exactly recovered, then finish with a short confirmation.');
    assert.equal(agent.outcome,'completed');
    assert.equal(fs.readFileSync(path.join(workspace,'recovery.txt'),'utf8').trim(),'recovered');
    assert.equal(fs.existsSync(path.join(workspace,'partial-must-not-exist.txt')),false);
    assert.ok(warnings.filter(s=>s.includes('retrying')).length>=2);
    assert.equal(thinkingSettings[0],true);
    assert.equal(thinkingSettings[3],false,'reasoning exhaustion gets one action-only request');
    assert.equal(thinkingSettings[4],true,'session effort is restored automatically');
    hold=true;
    const held=new Promise(resolve=>{onHeld=resolve;});
    const pending=agent.runTurn('Briefly confirm the file exists.');
    await held;
    const start=Date.now(); agent.cancel(); await pending;
    assert.equal(agent.outcome,'cancelled');
    const cancelMs=Date.now()-start;
    hold=false;
    await agent.runTurn('Read recovery.txt and confirm its contents.');
    assert.equal(agent.outcome,'completed');
    const result={passed:true,model,requests:calls,injected:['503','incomplete tool-call stream','exhausted reasoning budget','cancel during stalled response'],partialToolExecuted:false,actionOnlyRecovery:true,effortRestored:true,cancelMs,resumed:true};
    fs.writeFileSync(path.join(workspace,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  } finally {manager.killAll();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
