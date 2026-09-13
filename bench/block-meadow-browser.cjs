// Browser acceptance checks for the generated Block Meadow app. Requires Playwright.
// Optional: PLAYWRIGHT_PATH, CHROME_PATH, BLOCK_MEADOW_URL, BLOCK_MEADOW_LOG_DIR.
const path=require('node:path');
const out=path.resolve(process.env.BLOCK_MEADOW_LOG_DIR || 'playground/.block-meadow-browser');
require('node:fs').mkdirSync(out,{recursive:true});
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert=require('node:assert/strict');const fs=require('node:fs');
let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || undefined,args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[],results=[];
 page.setDefaultTimeout(8000);
 page.on('pageerror',e=>errors.push(e.message));
 const snapshot=()=>page.evaluate(()=>window.voxelDebug.snapshot());
 const step=async(name,fn)=>{try{const detail=await fn();results.push({name,passed:true,detail});}catch(e){results.push({name,passed:false,error:e.message});}};
 await page.goto(process.env.BLOCK_MEADOW_URL || 'http://127.0.0.1:4187');await page.waitForFunction(()=>window.voxelDebug);
 await step('play, gravity and safe landing',async()=>{
  await page.click('#btn-play');await page.waitForFunction(()=>!!document.pointerLockElement);await page.waitForTimeout(2200);
  const s=await snapshot();assert.equal(s.paused,false);assert.ok(s.player.y<15 && s.player.y>=0);return s;
 });
 await step('WASD follows camera across four view directions',async()=>{
  const checked=[];
  for(let turn=0;turn<4;turn++){
   await page.mouse.move(600+turn*700,400);await page.waitForTimeout(30);
   for(const key of ['w','s','a','d']){
    await page.evaluate(()=>window.voxelDebug.teleport(20,24,20));const a=await snapshot();
    await page.keyboard.down(key);await page.waitForTimeout(120);await page.keyboard.up(key);const b=await snapshot();
    const f=[-Math.sin(a.yaw),-Math.cos(a.yaw)],r=[Math.cos(a.yaw),-Math.sin(a.yaw)];
    const v=key==='w'?f:key==='s'?f.map(n=>-n):key==='d'?r:r.map(n=>-n);
    const dot=(b.player.x-a.player.x)*v[0]+(b.player.z-a.player.z)*v[1];assert.ok(dot>.04,`${key} at yaw ${a.yaw}: travel ${dot}`);checked.push({key,yaw:a.yaw,dot});
   }
  }
  return checked;
 });
 await step('grounded jump',async()=>{
  await page.evaluate(()=>window.voxelDebug.teleport(28.2,16,28.2));await page.waitForTimeout(1700);const a=await snapshot();
  await page.keyboard.press('Space');await page.waitForTimeout(140);const b=await snapshot();assert.ok(b.player.y>a.player.y+.2);await page.waitForTimeout(900);return {before:a.player,after:b.player};
 });
 await step('hotbar selection',async()=>{
  for(const [key,type] of [['1','grass'],['2','dirt'],['3','stone'],['4','wood'],['5','leaves']]){await page.keyboard.press(key);assert.equal((await snapshot()).selected,type);assert.equal(await page.locator('.hotbar-slot.selected').getAttribute('data-type'),type);}
 });
 let removed=null,placed=null;
 await step('target and remove block',async()=>{
  await page.mouse.move(560,790);await page.waitForTimeout(150);let s=await snapshot();
  if(!s.targeted){await page.mouse.move(560,1100);await page.waitForTimeout(100);s=await snapshot();}
  assert.ok(s.targeted,'no targeted block after looking down');removed=s.targeted;
  const was=await page.evaluate(p=>window.voxelDebug.getBlock(...p),removed);assert.notEqual(was,'air');
  await page.mouse.down();await page.mouse.up();await page.waitForTimeout(100);
  assert.equal(await page.evaluate(p=>window.voxelDebug.getBlock(...p),removed),'air');assert.ok((await snapshot()).editCount>0);return {removed,was};
 });
 await step('place adjacent block outside player',async()=>{
  const s=await snapshot();assert.ok(s.targeted,'no target after mining');const around=[];
  for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)around.push([s.targeted[0]+x,s.targeted[1]+y,s.targeted[2]+z]);
  const values=await page.evaluate(ps=>ps.map(p=>window.voxelDebug.getBlock(...p)),around);
  await page.mouse.down({button:'right'});await page.mouse.up({button:'right'});await page.waitForTimeout(100);
  const next=await page.evaluate(ps=>ps.map(p=>window.voxelDebug.getBlock(...p)),around);
  const changed=around.filter((p,i)=>values[i]!==next[i]);assert.equal(changed.length,1);placed=changed[0];assert.equal(await page.evaluate(p=>window.voxelDebug.getBlock(...p),placed),'leaves');
  const p=(await snapshot()).player;assert.ok(!(placed[0]<p.x+.6&&placed[0]+1>p.x&&placed[1]<p.y+1.8&&placed[1]+1>p.y&&placed[2]<p.z+.6&&placed[2]+1>p.z));return placed;
 });
 await step('resize',async()=>{await page.setViewportSize({width:1024,height:700});await page.waitForTimeout(100);assert.ok((await snapshot()).player.y>=0);});
 await page.screenshot({path:out+'/gameplay-validated.png'});
 await step('refuse placement inside player body',async()=>{
  const y=await page.evaluate(()=>{for(let y=31;y>=0;y--){const b=window.voxelDebug.getBlock(24,y,24);if(b!=='air'&&b!=='water')return y+1;}return 2;});
  await page.evaluate(y=>window.voxelDebug.teleport(24.1,y,24.1),y);await page.waitForTimeout(150);
  await page.mouse.move(560,2000);await page.waitForTimeout(100);const a=await snapshot();assert.ok(a.targeted);
  const candidate=[a.targeted[0],a.targeted[1]+1,a.targeted[2]];assert.equal(await page.evaluate(p=>window.voxelDebug.getBlock(...p),candidate),'air');
  await page.mouse.down({button:'right'});await page.mouse.up({button:'right'});await page.waitForTimeout(100);
  assert.equal(await page.evaluate(p=>window.voxelDebug.getBlock(...p),candidate),'air');assert.equal((await snapshot()).editCount,a.editCount);
 });
 await step('pause and resume twice',async()=>{
  for(let i=0;i<2;i++){await page.keyboard.press('Escape');await page.waitForTimeout(120);assert.equal((await snapshot()).paused,true);assert.equal(await page.locator('#menu').isVisible(),true);const a=(await snapshot()).player;await page.keyboard.down('w');await page.waitForTimeout(100);await page.keyboard.up('w');assert.deepEqual((await snapshot()).player,a);await page.click('#btn-play');await page.waitForTimeout(120);assert.equal((await snapshot()).paused,false);}
  await page.keyboard.press('Escape');await page.waitForTimeout(120);
 });
 // Clean up lock after a failed pause check so independent save checks can run.
 await page.evaluate(()=>document.exitPointerLock());await page.waitForTimeout(100);
 await step('save and reload restores live state',async()=>{
  await page.click('#btn-save');const a=await snapshot();await page.reload();await page.waitForFunction(()=>window.voxelDebug);const b=await snapshot();
  assert.deepEqual(b.player,a.player);assert.equal(b.selected,a.selected);assert.equal(b.seed,a.seed);assert.equal(b.editCount,a.editCount);assert.ok(Number.isFinite(a.yaw)&&Number.isFinite(a.pitch));assert.equal(b.yaw,a.yaw);assert.equal(b.pitch,a.pitch);
  if(placed)assert.equal(await page.evaluate(p=>window.voxelDebug.getBlock(...p),placed),'leaves');return {before:a,after:b};
 });
 await step('confirmed new world resets edits',async()=>{
  const old=await snapshot();page.once('dialog',d=>d.dismiss());await page.click('#btn-new');assert.deepEqual(await snapshot(),old);
  page.once('dialog',d=>d.accept());await page.click('#btn-new');const next=await snapshot();assert.equal(next.editCount,0);assert.notEqual(next.seed,old.seed);assert.ok(Number.isFinite(next.seed));return next;
 });
 await step('corrupt saved data recovers',async()=>{
  await page.evaluate(()=>localStorage.setItem('block-meadow:v1','{bad json'));await page.reload();await page.waitForFunction(()=>window.voxelDebug);assert.ok(Object.values((await snapshot()).player).every(Number.isFinite));
 });
 await step('no browser exceptions',async()=>assert.deepEqual(errors,[]));
 const result={time:new Date().toISOString(),passed:results.every(r=>r.passed),results,errors};fs.writeFileSync(out+'/browser-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close();if(!result.passed)process.exitCode=1;
})().catch(async e=>{console.error(e);await browser?.close();process.exitCode=1;});
