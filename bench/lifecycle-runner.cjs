// Live local-model benchmark using the production agent, providers and tools.
// Usage: node bench/lifecycle-runner.cjs WORKSPACE PROMPT_FILE LOG_DIR [--resume] [--ctx=8192] [--backend=ollama] [--model=NAME] [--effort=off] [--max-minutes=15]
// Logs stay outside the generated project. No global preferences are changed.
const fs = require('node:fs');
const path = require('node:path');
const { Agent } = require('../dist/agent');
const { ContextManager } = require('../dist/context');
const { EventBus } = require('../dist/events');
const { Plan } = require('../dist/plan');
const { buildSystemPrompt, loadAgentsMd } = require('../dist/prompt');
const { makeProvider, prepareModel } = require('../dist/session');
const { pickShell } = require('../dist/tools/shell');
const { TaskManager } = require('../dist/tools/tasks');

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
  const ui = {
    token() {}, thinking() {}, resetResponse() {emit('reset_response');},
    toolCall(name,args) {emit('tool_call',{name,args});console.log(`tool ${name} ${args.path || args.action || args.command || ''}`);},
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
  const agent = new Agent(provider,'edit',system,ctx,manager,bus,ui,false,1000);
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
  for(const event of ['post_tool','post_compact']) bus.on(event,payload=>{emit(event,{payload,budget:agent.contextBudget()});save();});
  const health = setInterval(()=>{emit('heartbeat',{outcome:agent.outcome,budget:agent.contextBudget(),planDone:ctx.plan.doneCount,planTotal:ctx.plan.steps.length,rss:process.memoryUsage().rss});console.log(`heartbeat ${agent.outcome}, context ${agent.contextTokens()}, plan ${ctx.plan.doneCount}/${ctx.plan.steps.length}`);},15000);
  process.on('SIGINT',()=>agent.cancel());
  process.on('SIGTERM',()=>agent.cancel());
  const deadline=setTimeout(()=>{emit('deadline',{maxMinutes});agent.cancel();},maxMinutes*60000);
  emit('start',{workspace,model:chosen.id,backend:chosen.backend,context:chosen.contextWindow,effort,maxMinutes,prompt});
  try {await agent.runTurn(prompt);}
  catch(e) {emit('failure',{error:String(e?.stack??e)});console.error(e);}
  finally {
    clearInterval(health);
    clearTimeout(deadline);
    save();
    taskManager.killAll();
    emit('finish',{outcome:agent.outcome,error:agent.lastError,stats:agent.lastTurnStats,plan:ctx.plan.steps});
    console.log(JSON.stringify({outcome:agent.outcome,stats:agent.lastTurnStats,eventsFile,stateFile},null,2));
    if(agent.outcome !== 'completed') process.exitCode=1;
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
