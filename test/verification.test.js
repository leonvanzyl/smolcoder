const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../dist/agent');
const { ContextManager } = require('../dist/context');
const { EventBus } = require('../dist/events');
const { Plan } = require('../dist/plan');
const { TaskManager } = require('../dist/tools/tasks');
const { projectVerification } = require('../dist/verification');

function setup(t, chat, verification) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'smol-verify-'));
  const ctx = {workspace,plan:new Plan(),taskManager:new TaskManager(workspace),filesTouched:new Set(),commandsRun:[]};
  t.after(()=>{ctx.taskManager.killAll();fs.rmSync(workspace,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const ui = {token(){},thinking(){},toolCall(){},toolResult(){},println(){},status(){},warn(){},error(){},startSpinner(){},stopSpinner(){},turnEnd(){},planUpdated(){}};
  const provider = {label:'fake',modelId:'fake',contextWindow:8000,maxOutputTokens:2000,setEffort(){},effortLabel(){return null;},chat};
  const bus=new EventBus(), manager=new ContextManager(8000,2000);
  const agent=new Agent(provider,'edit','sys',ctx,manager,bus,ui,false,30,verification);
  return {agent,workspace,bus,manager};
}
const answer = () => ({content:'Done',toolCalls:[]});

test('a repeated acceptance failure refreshes facts and discards stale hypotheses without another inference',async t=>{
  let calls=0,compactions=0;
  const {agent,workspace,bus}=setup(t,async messages=>{
    calls++;
    if(calls===1)agent.messages.push({role:'user',compactNote:true,content:'Hand-over notes:\nUNSUPPORTED_HYPOTHESIS from this investigation.'});
    if(calls<=2)return {content:'UNSUPPORTED_HYPOTHESIS: this platform cannot run the required behavior.',toolCalls:[]};
    if(calls===3){
      const context=JSON.stringify(messages);
      assert.doesNotMatch(context,/UNSUPPORTED_HYPOTHESIS/);
      assert.match(context,/Keep the original application working/);
      assert.match(context,/expected a paused player; observed movement/);
      assert.match(context,/movement 2\.25/,'raw evidence must not be normalized');
      assert.ok(messages.some(m=>m.compactNote));
      return {content:'',toolCalls:[{id:'fix',name:'write_file',args:{path:'ready.txt',content:'fixed'}}]};
    }
    return answer();
  },{command:'node verify.cjs',maxAttempts:3});
  fs.writeFileSync(path.join(workspace,'verify.cjs'),`const fs=require('fs');if(!fs.existsSync('ready.txt')){const n=Number(fs.existsSync('attempt.txt')?fs.readFileSync('attempt.txt','utf8'):0)+1;fs.writeFileSync('attempt.txt',String(n));console.error('expected a paused player; observed movement '+n+'.25');process.exit(1)}`);
  bus.on('post_compact',r=>{if(r.action==='compacted')compactions++;});
  await agent.runTurn('Keep the original application working');
  assert.equal(agent.outcome,'completed');assert.equal(calls,4);assert.equal(compactions,1);
  assert.equal(agent.verificationResult.attempts,3);assert.equal(agent.verificationResult.passed,true);
});

test('progress to a different acceptance failure retains the working context',async t=>{
  let calls=0,compactions=0;
  const {agent,workspace,bus}=setup(t,async messages=>{
    calls++;
    if(calls<=2)return {content:'KEEP_API_CONTRACT while repairing this behavior.',toolCalls:[]};
    if(calls===3){
      assert.match(JSON.stringify(messages),/KEEP_API_CONTRACT/);
      return {content:'',toolCalls:[{id:'fix',name:'write_file',args:{path:'ready.txt',content:'fixed'}}]};
    }
    return answer();
  },{command:'node verify.cjs',maxAttempts:3});
  fs.writeFileSync(path.join(workspace,'verify.cjs'),`const fs=require('fs');if(!fs.existsSync('ready.txt')){const second=fs.existsSync('attempt.txt');fs.writeFileSync('attempt.txt','1');console.error(second?'Save did not persist':'Entry point missing');process.exit(1)}`);
  bus.on('post_compact',r=>{if(r.action==='compacted')compactions++;});
  await agent.runTurn('Build');assert.equal(agent.outcome,'completed');assert.equal(compactions,0);
});

test('repeated failures never discard summaries containing earlier user decisions',async t=>{
  let compactions=0;
  const {agent,bus}=setup(t,async()=>answer(),{command:'node -e "process.exit(9)"',maxAttempts:3});
  agent.originalRequest='An earlier user task';
  agent.messages.push({role:'user',compactNote:true,content:'Hand-over notes:\nPRIOR_USER_DECISION: use only local APIs.'});
  bus.on('post_compact',r=>{if(r.action==='compacted')compactions++;});
  await assert.rejects(agent.runTurn('Fix a new issue'),/Acceptance checks still fail after 3/);
  assert.equal(compactions,0);assert.match(JSON.stringify(agent.messages),/PRIOR_USER_DECISION/);
});

test('private acceptance command stays in the host instead of becoming an inaccessible model instruction',async t=>{
  const command='node -e "process.exit(9)"';
  const {agent}=setup(t,async messages=>{
    assert.ok(!JSON.stringify(messages).includes('process.exit(9)'));
    return answer();
  },{command,maxAttempts:2});
  await assert.rejects(agent.runTurn('Build'),/Acceptance checks still fail after 2/);
  await agent.compactNow(true,true);
  assert.ok(!JSON.stringify(agent.messages).includes('process.exit(9)'));
  assert.match(agent.messages[1].content,/exit code 9/);
});

test('recovery from failed edits uses known project failures without spending final acceptance attempts',async t=>{
  let calls=0,progressChecks=0;
  const {agent,workspace,bus}=setup(t,async()=>{
    calls++;
    if(calls===1)return {content:'',toolCalls:Array.from({length:24},(_,i)=>({id:'w'+i,name:'write_file',args:{path:'app.txt',content:'revision '+i}}))};
    if(calls===2)return {content:'',toolCalls:Array.from({length:6},(_,i)=>({id:'bad'+i,name:'edit_file',args:{path:'app.txt',old_text:'not in the file',new_text:'fixed'}}))};
    if(calls===3)return {content:'',toolCalls:[{id:'fix',name:'write_file',args:{path:'ready.txt',content:'ready'}}]};
    return answer();
  },{command:'node verify.cjs',maxAttempts:1});
  fs.writeFileSync(path.join(workspace,'verify.cjs'),`if(!require('fs').existsSync('ready.txt'))process.exit(42)`);
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({scripts:{test:'node verify.cjs'}}));
  bus.on('post_progress_check',()=>progressChecks++);
  await agent.runTurn('Build');
  assert.equal(agent.outcome,'completed');assert.equal(progressChecks,2);
  assert.equal(agent.verificationResult.attempts,1);
});

test('failed acceptance returns real feedback and repairs within a single runTurn',async t=>{
  let calls=0;
  const {agent,workspace,bus}=setup(t,async messages=>{
    if(++calls===1)return answer();
    if(calls===2){
      assert.match(messages.at(-1).content,/Acceptance failed/);
      assert.match(messages.at(-1).content,/application must produce ready.txt/);
      return {content:'',toolCalls:[{id:'w',name:'write_file',args:{path:'ready.txt',content:'working'}}]};
    }
    return answer();
  },{command:'node verify.cjs'});
  fs.writeFileSync(path.join(workspace,'verify.cjs'),`const fs=require('fs');if(!fs.existsSync('ready.txt')){console.error('application must produce ready.txt');process.exit(1)}`);
  const checks=[];bus.on('post_verify',r=>checks.push(r.passed));
  await agent.runTurn('Build it');
  assert.equal(agent.outcome,'completed');assert.deepEqual(checks,[false,true]);
  assert.equal(agent.verificationResult.attempts,2);assert.equal(calls,3);
});

test('repeated claims of completion cannot bypass a failing acceptance command',async t=>{
  const {agent}=setup(t,async()=>answer(),{command:'node -e "process.exit(9)"',maxAttempts:2});
  await assert.rejects(agent.runTurn('Build'),/Acceptance checks still fail after 2/);
  assert.equal(agent.outcome,'error');assert.equal(agent.verificationResult.passed,false);
  await agent.compactNow(true,true);
  assert.match(agent.messages[1].content,/Last acceptance failure/);
  assert.match(agent.messages[1].content,/exit code 9/);
  assert.doesNotMatch(agent.messages[1].content,/Current request \(what/,'verification must not duplicate the entire original request');
});

test('cancellation during acceptance terminates the command and does not start a repair',async t=>{
  let calls=0;
  const {agent}=setup(t,async()=>{calls++;return answer();},{command:'node -e "setInterval(()=>{},1000)"'});
  const timer=setTimeout(()=>agent.cancel(),200);
  try {await agent.runTurn('Build');}finally{clearTimeout(timer);}
  assert.equal(agent.outcome,'cancelled');assert.equal(calls,1);
});

test('reads evicted by the harness do not count as retained unchanged-read loops',async t=>{
  let calls=0;
  const {agent,workspace,bus}=setup(t,async()=>{
    if(++calls>7)return answer();
    return {content:'',toolCalls:[{id:'r'+calls,name:'read_file',args:{path:'a.txt'}}]};
  });
  fs.writeFileSync(path.join(workspace,'a.txt'),'module a');fs.writeFileSync(path.join(workspace,'b.txt'),'module b');
  bus.on('pre_request',()=>{for(const m of agent.messages)if(m.role==='tool'){m.content='[evicted]';m.evicted=true;}});
  await agent.runTurn('Investigate');assert.equal(agent.outcome,'completed');assert.equal(calls,8);
});

test('stalled reads trigger acceptance feedback and an automatic repair',async t=>{
  let calls=0;
  const {agent,workspace}=setup(t,async messages=>{
    calls++;
    if(messages.at(-1).content.includes('Acceptance failed'))return {content:'',toolCalls:[{id:'fix',name:'write_file',args:{path:'ready.txt',content:'working'}}]};
    if(fs.existsSync(path.join(workspace,'ready.txt')))return answer();
    return {content:'',toolCalls:[{id:'r'+calls,name:'read_file',args:{path:calls%2?'a.txt':'b.txt'}}]};
  },{command:'node verify.cjs'});
  fs.writeFileSync(path.join(workspace,'a.txt'),'a');fs.writeFileSync(path.join(workspace,'b.txt'),'b');
  fs.writeFileSync(path.join(workspace,'verify.cjs'),`if(!require('fs').existsSync('ready.txt'))process.exit(1)`);
  await agent.runTurn('Build');assert.equal(agent.outcome,'completed');assert.equal(agent.verificationResult.attempts,2);
});

test('sustained investigation triggers real checks even when compaction evicts every read',async t=>{
  let calls=0,reads=0;
  const {agent,workspace,bus}=setup(t,async messages=>{
    calls++;
    if(calls===1)return {content:'',toolCalls:[{id:'start',name:'write_file',args:{path:'app.txt',content:'unfinished'}}]};
    if(messages.at(-1).content.includes('Acceptance failed'))return {content:'',toolCalls:[{id:'fix',name:'write_file',args:{path:'ready.txt',content:'working'}}]};
    if(fs.existsSync(path.join(workspace,'ready.txt')))return answer();
    reads++;return {content:'',toolCalls:[{id:'r'+calls,name:'read_file',args:{path:'app.txt'}}]};
  },{command:'node verify.cjs'});
  fs.writeFileSync(path.join(workspace,'verify.cjs'),`if(!require('fs').existsSync('ready.txt'))process.exit(1)`);
  bus.on('pre_request',()=>{for(const m of agent.messages)if(m.role==='tool'){m.content='[evicted]';m.evicted=true;}});
  await agent.runTurn('Build');
  assert.equal(reads,24);assert.equal(agent.outcome,'completed');assert.equal(agent.verificationResult.attempts,2);
});

test('periodic project checks break API investigation cycles with edits without spending acceptance attempts',async t=>{
  let calls=0,progressChecks=0;
  const {agent,workspace,bus}=setup(t,async messages=>{
    calls++;
    if(messages.at(-1).content.includes('Progress checks failed'))return {content:'',toolCalls:[{id:'fix',name:'write_file',args:{path:'ready.txt',content:'working'}}]};
    if(fs.existsSync(path.join(workspace,'ready.txt')))return answer();
    if(calls%6===1)return {content:'',toolCalls:[{id:'w'+calls,name:'write_file',args:{path:'app.txt',content:'revision '+calls}}]};
    return {content:'',toolCalls:[{id:'r'+calls,name:'read_file',args:{path:'app.txt'}}]};
  },{command:'node verify.cjs'});
  fs.writeFileSync(path.join(workspace,'verify.cjs'),`if(!require('fs').existsSync('ready.txt'))process.exit(42)`);
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({scripts:{test:'node verify.cjs'}}));
  bus.on('pre_request',()=>{for(const m of agent.messages)if(m.role==='tool'){m.content='[evicted]';m.evicted=true;}});
  bus.on('post_progress_check',async result=>{
    progressChecks++;assert.equal(result.passed,false);
    await agent.compactNow(true,true);
    assert.match(agent.messages[1].content,/Last project check failure/);
    assert.match(agent.messages[1].content,/exit code 42/);
  });
  await agent.runTurn('Build');
  assert.equal(progressChecks,1);assert.equal(calls,26);assert.equal(agent.outcome,'completed');
  assert.equal(agent.verificationResult.attempts,1);
});

test('after acceptance fails, periodic checks use that oracle and a final summary reuses its pass',async t=>{
  let calls=0,progressChecks=0;
  const {agent,workspace,bus}=setup(t,async()=>{
    calls++;
    if(calls===1||calls===26)return answer();
    if(calls===2)return {content:'',toolCalls:[{id:'app',name:'write_file',args:{path:'app.txt',content:'unfinished'}}]};
    if(calls===25)return {content:'',toolCalls:[{id:'fix',name:'write_file',args:{path:'ready.txt',content:'working'}}]};
    return {content:'',toolCalls:[{id:'r'+calls,name:'read_file',args:{path:'app.txt'}}]};
  },{command:'node verify.cjs',maxAttempts:2});
  fs.writeFileSync(path.join(workspace,'verify.cjs'),`if(!require('fs').existsSync('ready.txt'))process.exit(1)`);
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));
  bus.on('pre_request',()=>{for(const m of agent.messages)if(m.role==='tool'){m.content='[evicted]';m.evicted=true;}});
  bus.on('post_progress_check',()=>progressChecks++);
  await agent.runTurn('Build');
  assert.equal(agent.outcome,'completed');assert.equal(agent.verificationResult.attempts,2);
  assert.equal(progressChecks,0);assert.equal(calls,26);
});

test('acceptance commands cannot run after switching to read-only',async t=>{
  const {agent,workspace}=setup(t,async()=>answer(),{command:'node -e "require(\'fs\').writeFileSync(\'bad\',\'x\')"'});
  agent.setMode('ro','Read only');await assert.rejects(agent.runTurn('Inspect'),/unavailable in read-only/);
  assert.equal(fs.existsSync(path.join(workspace,'bad')),false);
});

test('short commands preempt background summaries before any model request',async()=>{
  const manager=new ContextManager(8000,2000);let calls=0;
  const messages=[{role:'system',content:'s'},...Array.from({length:12},()=>({role:'assistant',content:'history '.repeat(240)}))];
  manager.prepareBackground(messages,[],{chat:async()=>{calls++;return answer();}},{originalRequest:'Build',filesTouched:new Set(),commandsRun:[]});
  await manager.foreground();assert.equal(calls,0);
});

test('project checks run automatically after edits in the shared UI agent',async t=>{
  let calls=0;
  const {agent,workspace}=setup(t,async()=>++calls===1
    ? {content:'',toolCalls:[{id:'w',name:'write_file',args:{path:'app.txt',content:'ready'}}]}
    : answer());
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({scripts:{test:'node check.cjs'}}));
  fs.writeFileSync(path.join(workspace,'check.cjs'),`require('fs').writeFileSync('checked.txt','yes')`);
  await agent.runTurn('Implement');assert.equal(agent.verificationResult.passed,true);
  assert.equal(fs.readFileSync(path.join(workspace,'checked.txt'),'utf8'),'yes');
  fs.unlinkSync(path.join(workspace,'checked.txt'));await agent.runTurn('Explain it');
  assert.equal(fs.existsSync(path.join(workspace,'checked.txt')),false);
});

test('project check discovery never interpolates package script bodies',t=>{
  const {workspace}=setup(t,async()=>answer());
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({scripts:{build:'untrusted body',test:'another body','test:e2e':'body',deploy:'do not execute'}}));
  assert.equal(projectVerification(workspace),'npm run build && npm run test && npm run test:e2e');
  fs.writeFileSync(path.join(workspace,'package.json'),'{broken');assert.equal(projectVerification(workspace),'npm run build --if-present');
});

test('automatic repairs discover added checks and cannot bypass a required script by deleting it',async t=>{
  let calls=0;
  const pkg=scripts=>({content:'',toolCalls:[{id:'pkg'+calls,name:'write_file',args:{path:'package.json',content:JSON.stringify({scripts})}}]});
  const {agent}=setup(t,async messages=>{
    calls++;
    if(calls===1)return pkg({test:'node -e "process.exit(1)"'});
    if(calls===3)return pkg({test:'node -e "process.exit(0)"','test:e2e':'node -e "process.exit(9)"'});
    if(calls===5){assert.match(messages.at(-1).content,/exit code 9/);return pkg({'test:e2e':'node -e "process.exit(0)"'});}
    if(calls===7){assert.match(messages.at(-1).content,/Missing script/);return pkg({test:'node -e "process.exit(0)"','test:e2e':'node -e "process.exit(0)"'});}
    return answer();
  });
  await agent.runTurn('Implement');
  assert.equal(agent.outcome,'completed');assert.equal(agent.verificationResult.attempts,4);
});
