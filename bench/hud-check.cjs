const assert=require('node:assert/strict');
const selectors={
  Crosshair:'[aria-label="Crosshair" i], [id*="crosshair" i], .crosshair, [id*="reticle" i], .reticle',
  FPS:'[aria-label="FPS" i], [id*="fps" i], .fps',
  Hotbar:'[aria-label="Hotbar" i], [id*="hotbar" i], .hotbar',
};
async function visible(frame,name){
  const locator=frame.locator(selectors[name]).first();
  assert.ok(await locator.count(),`${name} HUD is missing; expose a visible HTML element labeled ${name}`);
  const state=await locator.evaluate(el=>{
    const r=el.getBoundingClientRect();let opacity=1;
    for(let n=el;n;n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);
    return {display:getComputedStyle(el).display,visibility:getComputedStyle(el).visibility,opacity,width:r.width,height:r.height,x:r.x,y:r.y,inViewport:r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight};
  });
  assert.ok(await locator.isVisible()&&state.opacity>.05&&state.inViewport,`${name} HUD is hidden while playing. Observed layout: ${JSON.stringify(state)}`);
  return locator;
}
async function slots(frame){
  const bar=await visible(frame,'Hotbar');
  const buttons=bar.locator('button, [role="button"]');
  if(await buttons.count()===5)return buttons;
  return bar.locator('.hotbar-slot, .hot-slot, .slot');
}
async function inspectHUD(frame){
  await visible(frame,'Crosshair');const fps=await visible(frame,'FPS');
  let text='';
  for(let i=0;i<20;i++){
    text=await fps.innerText();if(/\d/.test(text)&&Number(text.match(/\d+(?:\.\d+)?/)[0])>0)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(/\d/.test(text)&&Number(text.match(/\d+(?:\.\d+)?/)[0])>0,'FPS HUD never displayed a positive frame rate: '+JSON.stringify(text));
  const items=await slots(frame);assert.equal(await items.count(),5,'Hotbar must display five selectable slots');
  for(let i=0;i<5;i++)assert.ok(await items.nth(i).isVisible(),`Hotbar slot ${i+1} is hidden`);
  return {fps:text,slots:5};
}
async function inspectSelection(frame,index){
  const items=await slots(frame);
  const active=await items.evaluateAll(nodes=>nodes.map(n=>{
    const value=n.getAttribute('aria-pressed')??n.getAttribute('aria-selected');
    return value!==null?value==='true':n.matches('.active, .selected, [data-selected="true"]');
  }));
  assert.deepEqual(active,Array.from({length:5},(_,i)=>i===index),`Hotbar highlight must follow key ${index+1}. Set aria-pressed on the selected slot (or its active/selected class).`);
}
module.exports={inspectHUD,inspectSelection};
