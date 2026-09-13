// Positive and negative fixtures for the visible gameplay HUD contract.
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict');
const {inspectHUD,inspectSelection}=require('./hud-check.cjs');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined});
  try{
    const page=await browser.newPage();
    const content='<div id="hud"><span aria-label="Crosshair">+</span><span aria-label="FPS">FPS: 60</span><div aria-label="Hotbar">'+Array.from({length:5},(_,i)=>`<button aria-pressed="${i===0}">${i+1}</button>`).join('')+'</div></div>';
    await page.setContent(content);await inspectHUD(page);await inspectSelection(page,0);console.log('PASS visible HUD');
    for(const css of ['display:none','visibility:hidden','opacity:0','position:fixed;left:-10000px']){
      await page.locator('#hud').evaluate((el,css)=>el.style.cssText=css,css);
      await assert.rejects(()=>inspectHUD(page),/Crosshair HUD is hidden/);console.log('PASS rejects '+css);
    }
    await page.setContent(content);
    await page.getByLabel('FPS',{exact:true}).evaluate(el=>el.textContent='FPS: 0');
    await assert.rejects(()=>inspectHUD(page),/positive frame rate/);console.log('PASS rejects stopped FPS');
    await page.setContent(content);await assert.rejects(()=>inspectSelection(page,1),/Hotbar highlight/);console.log('PASS rejects stale selection');
    await page.getByRole('button').nth(0).evaluate(el=>el.remove());
    await assert.rejects(()=>inspectHUD(page),/five selectable slots/);console.log('PASS rejects missing slot');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
