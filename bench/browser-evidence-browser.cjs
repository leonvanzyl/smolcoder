const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict');
const {observeErrors}=require('./browser-evidence.cjs');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined});
  try{
    const page=await browser.newPage(),evidence=observeErrors(page);
    await page.setContent('<button>Save</button><script>document.querySelector("button").onclick=()=>{try{({}).setItem("save","data")}catch(e){console.error("Save failed:",e)}};</script>');
    await page.getByRole('button',{name:'Save'}).click();
    assert.deepEqual(evidence.errors,[]);assert.match(evidence.consoleErrors.join('\n'),/setItem is not a function/);
    await page.getByRole('button',{name:'Save'}).click();assert.equal(evidence.consoleErrors.length,1);
    await page.evaluate(()=>{for(let i=0;i<20;i++)console.error('failure '+i)});
    assert.equal(evidence.consoleErrors.length,12);assert.equal(evidence.consoleErrors.at(-1),'failure 19');
    console.log('PASS caught console failure, duplicate suppression and bounded evidence');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
