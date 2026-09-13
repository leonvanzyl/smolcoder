const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {runCommand,pickShell,killTree}=require('../dist/tools/shell');
const {TaskManager}=require('../dist/tools/tasks');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

for(const background of [false,true])test(`${background?'task stop':'command cancellation'} closes background descendants and inherited pipes`,async t=>{
  if(!/bash/.test(pickShell().exe)){t.skip('This regression uses bash background syntax');return;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'smol-process-'));
  let pid;
  t.after(()=>{if(pid&&alive(pid))killTree(pid);fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(root,'worker.cjs'),"require('fs').writeFileSync('worker.pid',String(process.pid)); setInterval(()=>{},1000);");
  const abort=new AbortController(),tasks=new TaskManager(root);
  const running=background?tasks.start('node worker.cjs &'):runCommand('node worker.cjs &',root,abort.signal);
  for(let i=0;i<100&&!fs.existsSync(path.join(root,'worker.pid'));i++)await delay(30);
  pid=Number(fs.readFileSync(path.join(root,'worker.pid'),'utf8'));
  await delay(250); // the original shell would have exited, leaving the pipe open
  if(background)tasks.stop(running);else {abort.abort();assert.match(await running,/cancelled/);}
  for(let i=0;i<50&&alive(pid);i++)await delay(30);
  assert.equal(alive(pid),false,'background child must terminate with its owner');
});

test('managed commands preserve the foreground exit code',async()=>{
  const result=await runCommand('node -e "process.exit(7)"',process.cwd());
  assert.match(result,/\[exit code 7 in /);
});
