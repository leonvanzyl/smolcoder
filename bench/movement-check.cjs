const assert=require('node:assert/strict');
const normalize=([x,z])=>{const length=Math.hypot(x,z);assert.ok(length>.05,'Movement was blocked or missing');return [x/length,z/length];};
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1];
function validateHeading(vectors){
  const v=Object.fromEntries(Object.entries(vectors).map(([key,value])=>[key,normalize(value)]));
  assert.ok(dot(v.w,v.s)<-.95,'W and S must move in opposite directions: '+JSON.stringify(vectors));
  assert.ok(dot(v.a,v.d)<-.95,'A and D must move in opposite directions: '+JSON.stringify(vectors));
  assert.ok(Math.abs(dot(v.w,v.d))<.15,'Strafing must stay perpendicular to forward movement after turning. Check both sine signs in the camera-relative movement basis. Actual W/S/A/D displacements: '+JSON.stringify(vectors));
  return v.w;
}
async function inspectMovement(page,frame,snapshot,teleportAbove,point){
  const headings=[];
  for(let heading=0;heading<3;heading++){
    await page.mouse.move(450+180*heading,300);await page.waitForTimeout(100);
    const vectors={};
    for(const key of ['w','s','a','d']){
      await teleportAbove(24.5,24.5);const before=point((await snapshot()).player);
      await page.keyboard.down(key);await page.waitForTimeout(180);await page.keyboard.up(key);
      const after=point((await snapshot()).player);vectors[key]=[after[0]-before[0],after[2]-before[2]];
    }
    const forward=validateHeading(vectors);
    if(headings.length)assert.ok(dot(forward,headings.at(-1).forward)<.999,'Mouse turning must change the movement heading');
    headings.push({forward,vectors});
  }
  return headings;
}
module.exports={validateHeading,inspectMovement};
