// Live local-model benchmark using the production agent, providers and tools.
// Usage: node bench/lifecycle-runner.cjs WORKSPACE PROMPT_FILE LOG_DIR [--resume] [--ctx=8192] [--backend=ollama] [--model=NAME] [--effort=off] [--max-minutes=15]
// Logs stay outside the generated project. No global preferences are changed.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
// The same driver can compare an older checkout without modifying its agent.
const harness = path.resolve(process.argv.find(s => s.startsWith('--harness='))?.slice(10) || path.join(__dirname, '..'));
const fromHarness = name => require(path.join(harness, 'dist', name));
const codeHash = createHash('sha256');
function hashCode(dir) {
  for (const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file=path.join(dir,e.name);
    if(e.isDirectory())hashCode(file);
    else if(e.name.endsWith('.js'))codeHash.update(path.relative(harness,file)).update(fs.readFileSync(file));
  }
}
hashCode(path.join(harness,'dist'));
const harnessHash=codeHash.digest('hex');
const { Agent } = fromHarness('agent');
const { ContextManager } = fromHarness('context');
const { EventBus } = fromHarness('events');
const { Plan } = fromHarness('plan');
const { buildSystemPrompt, loadAgentsMd } = fromHarness('prompt');
const { makeProvider, prepareModel } = fromHarness('session');
const { pickShell } = fromHarness('tools/shell');
const { TaskManager } = fromHarness('tools/tasks');

async function main() {
  const [workspaceArg, promptFile, logArg, ...flags] = process.argv.slice(2);
  if (!workspaceArg || !promptFile || !logArg) throw new Error('Usage: node bench/lifecycle-runner.cjs WORKSPACE PROMPT_FILE LOG_DIR [--resume] [--ctx=8192] [--backend=ollama] [--model=NAME]');
  const option = (name, fallback) => flags.find(s => s.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const maxMinutes = Number(option('max-minutes','15'));
  if(!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('--max-minutes must be positive');
  const workspace = fs.realpathSync(workspaceArg);
  const logDir = path.resolve(logArg);
  if (logDir === workspace || logDir.startsWith(workspace + path.sep)) throw new Error('Keep logs outside the model workspace');
  fs.mkdirSync(logDir, {recursive:true});
  const stateFile = path.join(logDir, 'state.json');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const eventsFile = path.join(logDir, runId + '.jsonl');
  const emit = (event, data = {}) => fs.appendFileSync(eventsFile, JSON.stringify({time:new Date().toISOString(),event,...data}) + '\n');
  const prompt = fs.readFileSync(promptFile, 'utf8');
  const chosen = await prepareModel({model:option('model', undefined),backend:option('backend','ollama'),ctx:Number(option('ctx','8192'))}, {});
  if (!chosen) throw new Error('No local model available');
  const provider = makeProvider(chosen);
  const effort = option('effort','off');
  if (!['off','low','medium','high'].includes(effort)) throw new Error('Invalid --effort');
  provider.setEffort(effort);
  let requestId = 0;
  const chat = provider.chat.bind(provider);
  provider.chat = async (messages, tools, opts = {}) => {
    const id = ++requestId;
    const started = Date.now();
    emit('request', {id,kind:tools.length ? 'coding' : 'summary',background:!!opts.background,messages:messages.length,maxTokens:opts.maxTokens});
    try {
      const r = await chat(messages, tools, opts);
      emit('response', {id,durationMs:Date.now()-started,promptTokens:r.promptTokens,generatedTokens:r.generatedTokens,truncated:!!r.truncated,tools:r.toolCalls.map(c=>({name:c.name,parseError:c.parseError})),content:r.content,ttftMs:r.ttftMs});
      return r;
    } catch (e) {emit('request_error',{id,durationMs:Date.now()-started,error:String(e?.message??e)});throw e;}
  };
  const bus = new EventBus();
  const taskManager = new TaskManager(workspace);
  const ctx = {workspace,taskManager,plan:new Plan(),filesTouched:new Set(),commandsRun:[]};
  const manager = new ContextManager(chosen.contextWindow,provider.maxOutputTokens);
  const system = buildSystemPrompt({workspace,mode:'edit',shellLabel:pickShell().label,agentsMd:loadAgentsMd(workspace)});
  let streamedTextChars = 0, streamedThinkingChars = 0;
  const ui = {
    token(text) {streamedTextChars += text.length;}, thinking(text) {streamedThinkingChars += text.length;}, resetResponse() {emit('reset_response');},
    toolCall(name,args) {emit('tool_call',{name,args});console.log(`tool ${name} ${String(args.path || args.action || args.command || '').slice(0,180)}`);},
    toolResult(output) {emit('tool_result',{output});if(output.startsWith('Error')) console.log(output.slice(0,350));},
    println(text) {if(text) emit('text',{text});},
    status(text) {emit('status',{text});console.log(text);},
    warn(text) {emit('warning',{text});console.log(text);},
    error(text) {emit('error',{text});console.error(text);},
    startSpinner() {}, stopSpinner() {},
    confirmCommand: async () => 'no',
    turnEnd(label) {emit('turn_end',{label});},
    planUpdated(plan) {emit('plan',{steps:plan.steps});console.log(`plan ${plan.doneCount}/${plan.steps.length}`);},
  };
  const verifyFile = option('verify-file',undefined);
  const verification = verifyFile ? { command: fs.readFileSync(verifyFile,'utf8').trim(), maxAttempts:Number(option('verify-attempts','6')) } : undefined;
  const agent = new Agent(provider,'edit',system,ctx,manager,bus,ui,false,1000,verification);
  let legacyOutcome = 'running';
  const outcome = () => agent.outcome ?? legacyOutcome;
  const budget = () => agent.contextBudget?.() ?? {prompt:agent.contextTokens(),window:chosen.contextWindow};
  const save = () => {
    fs.writeFileSync(stateFile + '.tmp',JSON.stringify({messages:agent.messages.slice(1),plan:ctx.plan.steps,filesTouched:[...ctx.filesTouched],commandsRun:ctx.commandsRun,originalRequest:agent.originalRequest,currentRequest:agent.currentRequest,model:chosen.id,backend:chosen.backend},null,2));
    fs.renameSync(stateFile + '.tmp',stateFile);
  };
  if (flags.includes('--resume')) {
    const state = JSON.parse(fs.readFileSync(stateFile,'utf8'));
    if(state.model !== chosen.id || state.backend !== chosen.backend) throw new Error('Resume model/backend differs from saved benchmark');
    agent.restoreTranscript(state.messages,state.originalRequest,state.currentRequest);
    ctx.plan.steps = state.plan;
    ctx.filesTouched = new Set(state.filesTouched);
    ctx.commandsRun = state.commandsRun;
  }
  for(const event of ['post_tool','post_compact','post_verify','post_progress_check']) bus.on(event,payload=>{emit(event,{payload,budget:budget()});save();});
  const health = setInterval(()=>{emit('heartbeat',{outcome:outcome(),budget:budget(),planDone:ctx.plan.doneCount,planTotal:ctx.plan.steps.length,rss:process.memoryUsage().rss,streamedTextChars,streamedThinkingChars});console.log(`heartbeat ${outcome()}, context ${agent.contextTokens()}, plan ${ctx.plan.doneCount}/${ctx.plan.steps.length}, streamed ${streamedTextChars} text / ${streamedThinkingChars} reasoning characters`);},15000);
  process.on('SIGINT',()=>agent.cancel());
  process.on('SIGTERM',()=>agent.cancel());
  const deadline=setTimeout(()=>{emit('deadline',{maxMinutes});legacyOutcome='cancelled';agent.cancel();},maxMinutes*60000);
  emit('start',{workspace,harness,harnessHash,promptHash:createHash('sha256').update(prompt).digest('hex'),model:chosen.id,backend:chosen.backend,context:chosen.contextWindow,effort,maxMinutes,prompt,verification});
  try {await agent.runTurn(prompt);if(legacyOutcome==='running')legacyOutcome='completed';}
  catch(e) {legacyOutcome='error';emit('failure',{error:String(e?.stack??e)});console.error(e);}
  finally {
    clearInterval(health);
    clearTimeout(deadline);
    save();
    taskManager.killAll();
    emit('finish',{outcome:outcome(),error:agent.lastError,verification:agent.verificationResult,stats:agent.lastTurnStats,plan:ctx.plan.steps});
    console.log(JSON.stringify({outcome:outcome(),stats:agent.lastTurnStats,eventsFile,stateFile},null,2));
    if(outcome() !== 'completed') process.exitCode=1;
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
