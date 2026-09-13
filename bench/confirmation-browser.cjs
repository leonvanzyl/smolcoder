const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const {confirmAction}=require('./confirmation.cjs');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || undefined});
  try {
    const page=await browser.newPage();
    for(const kind of ['native','html']){
      await page.setContent(kind==='native'
        ? `<button onclick="if(confirm('Reset?'))document.body.dataset.edits='0'">New World</button>`
        : `<button onclick="document.querySelector('#confirm').hidden=false">New World</button><div id="confirm" hidden><p>Create new world?</p><div><button onclick="document.querySelector('#confirm').hidden=true">Cancel</button><button onclick="document.body.dataset.edits='0';document.querySelector('#confirm').hidden=true">New World</button></div></div>`);
      await page.evaluate(()=>document.body.dataset.edits='2');
      const trigger=page.getByRole('button',{name:'New World'}).first();
      await confirmAction(page,page,trigger,false);
      assert.equal(await page.evaluate(()=>document.body.dataset.edits),'2');
      await confirmAction(page,page,trigger,true);
      assert.equal(await page.evaluate(()=>document.body.dataset.edits),'0');
      assert.equal(page.listenerCount('dialog'),0);
      console.log(`PASS: ${kind} confirmation declines, accepts, and removes its handler`);
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
