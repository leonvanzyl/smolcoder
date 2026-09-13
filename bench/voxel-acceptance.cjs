// Caller-owned acceptance command for --verify. Run from the generated Vite
// workspace. Tests stay outside it; no implementation is seeded or repaired here.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {runCommand,killTree}=require('../dist/tools/shell');
const workspace=process.cwd();
const out=path.resolve(process.env.VOXEL_ACCEPTANCE_LOG_DIR || path.join(workspace,'..','.acceptance',path.basename(workspace)),new Date().toISOString().replace(/[:.]/g,'-'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let server;
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const build=await runCommand('npm test && npm run build',workspace);
  fs.writeFileSync(path.join(out,'checks.log'),build);
  if(build.startsWith('Error'))throw new Error(build);
  const vite=path.join(workspace,'node_modules/vite/bin/vite.js');
  if(!fs.existsSync(vite))throw new Error('Vite is missing. Install the project dependencies.');
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  let log='';
  server=spawn(process.execPath,[vite,'preview','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:workspace,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
  server.stdout.on('data',b=>{log=(log+b).slice(-8000);});server.stderr.on('data',b=>{log=(log+b).slice(-8000);});
  server.on('error',e=>{log+=e.message;});
  const url=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<60;i++){
    try{if((await fetch(url,{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}
    if(server.exitCode!==null)break;await pause(100);
  }
  fs.writeFileSync(path.join(out,'server.log'),log);
  if(!ready)throw new Error('Dev server did not become ready: '+log);
  const views=[];
  for(const name of ['preview','direct']){
    const dir=path.join(out,name);
    const child=spawn(process.execPath,[path.join(__dirname,'voxel-browser.cjs')],{cwd:workspace,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,VOXEL_URL:url,VOXEL_LOG_DIR:dir,VOXEL_PREVIEW:name==='preview'?'1':'0',VOXEL_FAIL_FAST:'1'}});
    let output='';child.stdout.on('data',b=>{output=(output+b).slice(-16000);});child.stderr.on('data',b=>{output=(output+b).slice(-16000);});
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    const resultFile=path.join(dir,'results.json');
    if(!fs.existsSync(resultFile))throw new Error(`Browser check (${name}) did not finish: `+output);
    const result=JSON.parse(fs.readFileSync(resultFile,'utf8'));
    views.push({name,report:result});
    const combined={url,checkerHash:result.checkerHash,passed:views.length===2&&views.every(v=>v.report.passed),views,
      results:views.flatMap(v=>v.report.results.map(r=>({...r,name:v.name+': '+r.name}))),
      errors:views.flatMap(v=>v.report.errors),consoleErrors:views.flatMap(v=>v.report.consoleErrors||[])};
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(combined,null,2));
    if(code!==0||!result.passed){
      const failure=result.results.find(r=>!r.passed);
      const consoleErrors=[...new Set((result.consoleErrors||[]).map(text=>text.split('\n')[0]))].join('; ').slice(0,800);
      const passed=result.results.filter(r=>r.passed).map(r=>r.name).join('; ');
      throw new Error(`Browser acceptance (${name}): ${failure?.name || 'incomplete lifecycle'}\n${failure?.error || output}\nConsole errors: ${consoleErrors || 'none'}\nUncaught exceptions: ${result.errors.join('; ') || 'none'}\nAlready passed in this view: ${passed || 'none'}. Preserve these behaviors.\nFix the game implementation. Both the embedded preview and direct browser must pass. The check uses real buttons, keyboard and mouse; debug teleport only arranges test positions. Diagnostic files are outside the project; use the failure above to repair project files.`);
    }
  }
  console.log(`PASS: project tests, production build, and all 15 gameplay checks in each of the embedded preview and direct browser (30 checks total).\nReport: ${path.join(out,'results.json')}`);
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>{if(server?.pid)killTree(server.pid);});
