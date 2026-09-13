// Independent behavioral checks for a fresh generated game. Never edits it.
// Contract: window.voxelDebug.snapshot(), getBlock(x,y,z), teleport(x,y,z).
// Usage: VOXEL_URL=http://127.0.0.1:4188 node bench/voxel-browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { openPreview } = require('./preview-harness.cjs');
const { confirmAction } = require('./confirmation.cjs');
const { installMeshAudit } = require('./mesh-audit.cjs');
const { inspectHUD, inspectSelection } = require('./hud-check.cjs');
const { observeErrors } = require('./browser-evidence.cjs');
const { inspectMovement } = require('./movement-check.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = path.resolve(process.env.VOXEL_LOG_DIR || 'playground/.voxel-browser');
const url = process.env.VOXEL_URL || 'http://127.0.0.1:4188';
const point = p => Array.isArray(p) ? p : p?.pos ? point(p.pos) : p?.position ? point(p.position) : [p?.x,p?.y,p?.z];
const target = s => point(s.targeted ?? s.target ?? s.targetedBlock);
const air = b => b == null || b === 0 || /^air$/i.test(String(b));
const distance = (a,b) => Math.hypot(a[0]-b[0],a[2]-b[2]);
let browser, preview;
(async () => {
  fs.mkdirSync(out,{recursive:true});
  const results=[];
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || undefined,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:900}}); page.setDefaultTimeout(8000);
  await page.addInitScript(installMeshAudit);
  const {errors,consoleErrors}=observeErrors(page);
  const check=async(name,fn)=>{
    if(process.env.VOXEL_FAIL_FAST==='1'&&results.some(r=>!r.passed))return false;
    try{results.push({name,passed:true,detail:await fn()});return true;}catch(e){results.push({name,passed:false,error:e.message});return false;}
  };
  let frame=page;
  if(process.env.VOXEL_PREVIEW==='1'){
    preview=await openPreview(page,url,path.join(out,'hub'));frame=preview.frame;
  }else await page.goto(url);
  const snapshot=async()=>{
    const s=await frame.evaluate(()=>window.voxelDebug.snapshot());
    return {...s,selected:s.selected??s.selectedBlock,editCount:s.editCount??s.edits};
  };
  const editedCells=[];
  let savedStorageKeys=[],mineVisibleBlock;
  const play=()=>frame.getByRole('button',{name:/\b(play|resume|start|enter)\b/i}).first().click();
  const block=p=>frame.evaluate(p=>window.voxelDebug.getBlock(...p),p);
  const blocks=cells=>frame.evaluate(cells=>cells.map(p=>window.voxelDebug.getBlock(...p)),cells);
  const teleportAbove=(x,z)=>frame.evaluate(([x,z])=>{
    let top=0;
    for(let y=0;y<256;y++){
      const b=window.voxelDebug.getBlock(Math.floor(x),y,Math.floor(z));
      if(b!=null&&b!==0&&!/^air$/i.test(String(b)))top=y;
    }
    window.voxelDebug.teleport(x,top+12,z);return top+12;
  },[x,z]);
  const settle=async(start)=>{
    let previous=Infinity,stable=0;const observed=[];
    for(let i=0;i<60;i++){
      await page.waitForTimeout(100);const y=point((await snapshot()).player)[1];
      observed.push(y);if(observed.length>8)observed.shift();
      if(y<start-1&&Math.abs(y-previous)<.001)stable++;else stable=0;
      if(stable>=3)return;
      previous=y;
    }
    throw Error(`Player did not land and settle within six seconds. Teleport start y=${start}; last observed player y values: ${JSON.stringify(observed)}`);
  };
  const ready=await check('startup exposes live game state without exceptions',async()=>{
    await frame.waitForFunction(()=>window.voxelDebug); assert.deepEqual(errors,[]);
    const s=await snapshot();assert.ok(point(s.player).every(Number.isFinite));return s;
  });
  if(ready){
    const started=await check('Play leaves the menu and acquires pointer lock',async()=>{
      await play();await frame.waitForFunction(()=>!!document.pointerLockElement);
      await page.waitForTimeout(1800);
      assert.equal(await frame.getByRole('button',{name:/\b(play|resume|start|enter)\b/i}).first().isVisible(),false,'The start/pause menu is still visible after Play');
      const s=await snapshot();assert.ok(point(s.player).every(Number.isFinite));return s;
    });
    if(started){
      await check('the game canvas renders terrain beyond the menu',async()=>{
        const canvas=frame.locator('canvas').first();
        const png=await canvas.screenshot({path:path.join(out,'rendered-game.png')});
        const detail=await frame.evaluate(async encoded=>{
          const img=new Image();img.src='data:image/png;base64,'+encoded;await img.decode();
          const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
          const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;
          const colors=new Map();let samples=0;
          for(let y=Math.floor(c.height*.15);y<c.height*.85;y+=8)for(let x=Math.floor(c.width*.1);x<c.width*.9;x+=8){
            const i=(y*c.width+x)*4,k=[data[i]>>4,data[i+1]>>4,data[i+2]>>4].join(',');colors.set(k,(colors.get(k)||0)+1);samples++;
          }
          return {width:c.width,height:c.height,colors:colors.size,largestColorFraction:Math.max(...colors.values())/samples};
        },png.toString('base64'));
        assert.ok(detail.width>=100&&detail.height>=100);assert.ok(detail.colors>=3&&detail.largestColorFraction<.97,'Canvas is essentially blank: '+JSON.stringify(detail));return detail;
      });
      await check('playing shows crosshair, FPS and five hotbar slots',()=>inspectHUD(frame));
      await check('rendered voxel triangles match their surface normals',async()=>{
        const mesh=await frame.evaluate(()=>window.__voxelMeshAudit);
        assert.ok(mesh?.triangles>0,'No lit mesh triangles were observed in actual WebGL draw calls');
        assert.equal(mesh.invalid,0,'Rendered terrain contains degenerate, reversed or non-planar faces. Triangle winding and positions must match their outward normals. Actual uploaded triangle examples: '+JSON.stringify(mesh.examples));return mesh;
      });
      await check('gravity lands on terrain and a grounded jump rises',async()=>{
        const start=await teleportAbove(24.5,24.5);await settle(start);
        const a=point((await snapshot()).player);assert.ok(a[1]>0&&a[1]<start-1,`landing y=${a[1]}`);
        await page.keyboard.down('Space');await page.waitForTimeout(100);await page.keyboard.up('Space');const b=point((await snapshot()).player);
        assert.ok(b[1]>a[1]+.1,`jump ${a[1]} -> ${b[1]}`);await page.waitForTimeout(1000);return {a,b};
      });
      await check('WASD stays opposite and perpendicular at three headings',()=>inspectMovement(page,frame,snapshot,teleportAbove,point));
      await check('five hotbar keys select five distinct blocks',async()=>{
        const values=[];for(const k of ['1','2','3','4','5']){
          await page.keyboard.press(k,{delay:50});
          // Inputs may be consumed by the next animation frame. Observe after
          // that frame rather than racing the game's update loop.
          await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          values.push((await snapshot()).selected);
          await inspectSelection(frame,Number(k)-1);
        }
        assert.equal(new Set(values).size,5,'Selections after keys 1-5: '+JSON.stringify(values));assert.ok(values.every(v=>v!==undefined));return values;
      });
      mineVisibleBlock=async()=>{
        const start=await teleportAbove(24.5,24.5);await settle(start);
        await page.mouse.move(500,6000);await page.waitForTimeout(100);
        let s,p;
        for(let i=0;i<=12;i++){
          await page.mouse.move(500,6000-i*75);await page.waitForTimeout(100);s=await snapshot();p=target(s);
          if(p.every(Number.isFinite))break;
        }
        assert.ok(p.every(Number.isFinite),'No finite target coordinates after scanning view angles. Last live snapshot: '+JSON.stringify(s)+'. snapshot().targeted must expose {x,y,z} for a hit, or null for a miss.');
        const before=await block(p);assert.equal(air(before),false);
        const geometryBefore=await frame.evaluate(()=>window.__voxelGeometryFrame);
        await frame.evaluate(()=>{
          window.__miningTrace=[];
          window.__miningObserver=e=>window.__miningTrace.push({type:e.type,button:e.button,trusted:e.isTrusted,locked:!!document.pointerLockElement});
          for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,window.__miningObserver,true);
        });
        let events;
        try{await page.mouse.down();await page.mouse.up();await page.waitForTimeout(300);}
        finally{events=await frame.evaluate(()=>{
          for(const type of ['mousedown','mouseup','click'])document.removeEventListener(type,window.__miningObserver,true);
          const events=window.__miningTrace;delete window.__miningObserver;delete window.__miningTrace;return events;
        });}
        const after=await block(p),afterState=await snapshot();
        assert.ok(air(after),`Left click did not remove targeted block ${JSON.stringify(p)}. Before: ${JSON.stringify(before)}; after: ${JSON.stringify(after)}. Actual input events: ${JSON.stringify(events)}. Player before click: ${JSON.stringify(s.player)}.`);
        assert.ok(afterState.editCount>s.editCount,`Mining changed the world but editCount did not increase: before ${s.editCount}, after ${afterState.editCount}.`);
        const geometryAfter=await frame.evaluate(()=>window.__voxelGeometryFrame);
        assert.ok(geometryBefore&&geometryAfter&&geometryAfter!==geometryBefore,`Mining changed live block ${JSON.stringify(p)} to air, but the actual rendered geometry did not change. Check that the renderer uses the same world as collision and editing after Play, reload and New World, and rebuilds the edited chunk. Identical uploads do not count as a visual change.`);
        editedCells.push(p);return p;
      };
      await check('mouse look targets terrain and left click visibly removes a real block',mineVisibleBlock);
      await check('right click places one adjacent block',async()=>{
        // Aim away from our body: a game SHOULD refuse a block under our feet.
        let s,p,found=false;
        for(const [x,z] of [[28.5,28.5],[8.5,8.5],[38.5,38.5]]){
          const start=await teleportAbove(x,z);await settle(start);
          await page.mouse.move(500,6000);await page.waitForTimeout(100);
          for(let i=1;i<=12;i++){
            await page.mouse.move(500,6000-i*75);await page.waitForTimeout(100);s=await snapshot();p=target(s);
            if(p.every(Number.isFinite)&&distance(p,point(s.player))>=2){found=true;break;}
          }
          if(found)break;
        }
        assert.ok(p.every(Number.isFinite)&&distance(p,point(s.player))>=2,'no targeted terrain outside the player body: '+JSON.stringify(s));
        const cells=[];for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)cells.push([p[0]+x,p[1]+y,p[2]+z]);
        const before=await blocks(cells);
        const geometryBefore=await frame.evaluate(()=>window.__voxelGeometryFrame);
        // Observe the real event sequence: some pointer-lock implementations
        // deliver a right-button click after mousedown. This can reveal a game
        // that places on press and accidentally mines again on release.
        await frame.evaluate(()=>{
          window.__voxelMouseTrace=[];
          window.__voxelMouseObserver=e=>window.__voxelMouseTrace.push({type:e.type,button:e.button,trusted:e.isTrusted});
          for(const type of ['mousedown','mouseup','click','auxclick'])document.addEventListener(type,window.__voxelMouseObserver,true);
        });
        let afterDown,events;
        try {
          await page.mouse.down({button:'right'});afterDown=await blocks(cells);
          await page.mouse.up({button:'right'});await page.waitForTimeout(300);
        } finally {
          events=await frame.evaluate(()=>{
            for(const type of ['mousedown','mouseup','click','auxclick'])document.removeEventListener(type,window.__voxelMouseObserver,true);
            const events=window.__voxelMouseTrace;delete window.__voxelMouseTrace;delete window.__voxelMouseObserver;return events;
          });
        }
        const after=await blocks(cells),changed=cells.filter((_,i)=>before[i]!==after[i]);
        assert.equal(changed.length,1,`Right click must leave one adjacent block changed. Changed cells after press: ${afterDown.filter((v,i)=>v!==before[i]).length}; after release: ${changed.length}. Actual mouse events: ${JSON.stringify(events)}. Target: ${JSON.stringify(p)}; selected: ${s.selected}`);
        assert.equal(await block(changed[0]),s.selected,'The placed block does not match the hotbar selection');
        assert.notEqual(await frame.evaluate(()=>window.__voxelGeometryFrame),geometryBefore,'Placement changed live terrain but the rendered geometry did not change. Rebuild from the same world used by editing, including after Play/reload/New World.');
        assert.ok((await snapshot()).editCount>0);editedCells.push(changed[0]);return changed[0];
      });
      await page.screenshot({path:path.join(out,'gameplay.png')});
      await check('pointer unlock pauses and Play resumes twice',async()=>{
        for(let i=0;i<2;i++){
          // Headless Chrome does not consistently implement the browser's
          // Escape accelerator. Use the real platform unlock API, not game state.
          await frame.evaluate(()=>document.exitPointerLock());await frame.waitForFunction(()=>!document.pointerLockElement);await page.waitForTimeout(100);
          const a=point((await snapshot()).player);await page.keyboard.down('w');await page.waitForTimeout(150);await page.keyboard.up('w');
          assert.deepEqual(point((await snapshot()).player),a);await play();await frame.waitForFunction(()=>!!document.pointerLockElement);
        }
      });
    }
    await frame.evaluate(()=>document.exitPointerLock());await page.waitForTimeout(100);
    await check('Save and reload preserve edits, selection and position',async()=>{
      // An unload auto-save must not hide a broken Save button. This is a fresh
      // isolated browser profile containing only this test's game state.
      await frame.evaluate(()=>localStorage.clear());
      await frame.getByRole('button',{name:/\bsave\b/i}).first().click();const a=await snapshot();
      await frame.waitForFunction(()=>localStorage.length>0).catch(()=>{throw Error('Clicking Save did not write localStorage before navigation; unload auto-save cannot satisfy manual Save');});
      savedStorageKeys=await frame.evaluate(()=>Object.keys(localStorage));
      const before=await Promise.all(editedCells.map(block));
      await frame.goto(url);await frame.waitForFunction(()=>window.voxelDebug);const b=await snapshot();
      assert.deepEqual(point(b.player),point(a.player),'Reload changed the saved player coordinates');
      assert.equal(b.selected,a.selected,'Reload changed the saved selected block');
      assert.equal(b.editCount,a.editCount,'Reload changed the saved editCount');
      assert.deepEqual(await Promise.all(editedCells.map(block)),before,'Reload changed the actual saved terrain cells at '+JSON.stringify(editedCells));
      assert.ok(Number.isFinite(b.editCount));
      await play();await frame.waitForFunction(()=>!!document.pointerLockElement);await page.waitForTimeout(150);
      const resumed=await snapshot();assert.ok(distance(point(resumed.player),point(b.player))<.05,'Play reset the restored horizontal position');
      assert.equal(resumed.selected,b.selected,'Play changed the restored selected block');assert.equal(resumed.editCount,b.editCount,'Play changed the restored editCount');
      await inspectHUD(frame);
      await frame.evaluate(()=>document.exitPointerLock());await page.waitForTimeout(100);
      return {a,b,resumed};
    });
    await check('New World confirmation can be declined and accepted',async()=>{
      const a=await snapshot();
      await confirmAction(page,frame,frame.getByRole('button',{name:/new world/i}).first(),false);
      const declined=await snapshot();assert.deepEqual(point(declined.player),point(a.player));assert.equal(declined.editCount,a.editCount);assert.equal(declined.selected,a.selected);
      const fingerprint=()=>frame.evaluate(cells=>{
        let h=2166136261;
        for(let x=0;x<48;x++)for(let z=0;z<48;z++)for(let y=0;y<48;y++){
          const s=String(window.voxelDebug.getBlock(x,y,z));
          for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);
          h=Math.imul(h^255,16777619);
        }
        for(const p of cells){const s=String(window.voxelDebug.getBlock(...p));for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);h=Math.imul(h^255,16777619);}
        return h>>>0;
      },editedCells);
      const editedWorld=await fingerprint();
      await confirmAction(page,frame,frame.getByRole('button',{name:/new world/i}).first(),true);
      await frame.waitForFunction(()=>{const s=window.voxelDebug?.snapshot();return s&&(s.editCount??s.edits)===0;});
      const b=await snapshot();assert.equal(b.editCount,0);assert.ok(point(b.player).every(Number.isFinite));
      assert.notEqual(await fingerprint(),editedWorld,'New World cleared the counter but left the edited terrain unchanged');
      if(!await frame.evaluate(()=>!!document.pointerLockElement))await play();
      await frame.waitForFunction(()=>!!document.pointerLockElement);await page.waitForTimeout(500);
      let moved=false;
      for(const key of ['w','a','s','d']){
        const before=point((await snapshot()).player);await page.keyboard.down(key);await page.waitForTimeout(150);await page.keyboard.up(key);
        if(distance(before,point((await snapshot()).player))>.05)moved=true;
      }
      assert.ok(moved,'After New World, pointer lock is active but WASD does not move the live player. Position: '+JSON.stringify(point((await snapshot()).player)));await inspectHUD(frame);
      await mineVisibleBlock();await page.screenshot({path:path.join(out,'new-world.png')});return b;
    });
    await check('invalid saved data recovers to a playable world',async()=>{
      assert.ok(savedStorageKeys.length,'No saved game keys observed');
      for(const value of ['{"truncated":',JSON.stringify({seed:'invalid',pos:{x:null}})]){
        await frame.evaluate(()=>document.exitPointerLock());await page.waitForTimeout(100);
        await frame.evaluate(([keys,value])=>{for(const key of keys)localStorage.setItem(key,value);},[savedStorageKeys,value]);
        await frame.goto(url);await frame.waitForFunction(()=>window.voxelDebug);
        assert.ok(point((await snapshot()).player).every(Number.isFinite),'Invalid save produced a non-finite player');
        await play();await frame.waitForFunction(()=>document.pointerLockElement);await page.waitForTimeout(650);await inspectHUD(frame);
      }
    });
  }
  await check('no browser exceptions during the lifecycle',async()=>assert.deepEqual(errors,[]));
  const hash=require('node:crypto').createHash('sha256');
  for(const name of ['voxel-browser.cjs','voxel-acceptance.cjs','preview-harness.cjs','confirmation.cjs','mesh-audit.cjs','hud-check.cjs','browser-evidence.cjs','movement-check.cjs'])hash.update(name).update(fs.readFileSync(path.join(__dirname,name)));
  const checkerHash=hash.digest('hex');
  const result={url,preview:!!preview,checkerHash,passed:results.length===15&&results.every(r=>r.passed),results,errors,consoleErrors};
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  await browser.close();preview?.close();if(!result.passed)process.exitCode=1;
})().catch(async e=>{console.error(e);await browser?.close();preview?.close();process.exitCode=1;});
