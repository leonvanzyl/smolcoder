// Independent post-run control check. Does not modify the generated app.
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const {inspectMovement}=require('./movement-check.cjs');
const fs=require('node:fs'),path=require('node:path');
const point=p=>[p.x,p.y,p.z];
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined,args:['--enable-unsafe-swiftshader']});
  const out=path.resolve(process.env.VOXEL_LOG_DIR||'playground/.movement-browser');fs.mkdirSync(out,{recursive:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    await page.goto(process.env.VOXEL_URL||'http://127.0.0.1:4188');
    await page.getByRole('button',{name:/\b(play|resume|start|enter)\b/i}).first().click();await page.waitForFunction(()=>document.pointerLockElement);
    const snapshot=()=>page.evaluate(()=>window.voxelDebug.snapshot());
    const teleportAbove=(x,z)=>page.evaluate(([x,z])=>{
      let top=0;for(let y=0;y<256;y++){const b=window.voxelDebug.getBlock(Math.floor(x),y,Math.floor(z));if(b!=null&&b!==0&&!/^air$/i.test(String(b)))top=y;}
      window.voxelDebug.teleport(x,top+12,z);
    },[x,z]);
    const result=await inspectMovement(page,page,snapshot,teleportAbove,point).then(headings=>({passed:true,headings}),e=>({passed:false,error:e.message}));
    await page.screenshot({path:path.join(out,'heading.png')});fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(result);
    if(!result.passed)process.exitCode=1;
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
