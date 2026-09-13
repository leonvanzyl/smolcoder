// Independent behavioral checks for the local-model-generated playground app.
// npm run build (harness), then: node --test bench/block-meadow-checks.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../playground/block-meadow/src/world.js';
import { Player } from '../playground/block-meadow/src/player.js';
import { deserializeState, makeSaver } from '../playground/block-meadow/src/save.js';

function flat() {
  const w=new World({size:48,height:32,waterLevel:4,seed:1337});
  w.data.fill(0);
  for(let x=0;x<48;x++) for(let z=0;z<48;z++) w.setBlock(x,0,z,3);
  return w;
}
test('terrain is deterministic, includes trees/water and fills a valid default world',()=>{
  const a=new World({size:48,height:32,waterLevel:4,seed:1337});
  const b=new World({size:48,height:32,waterLevel:4,seed:1337});
  assert.deepEqual(a.data,b.data);
  for(const id of [1,2,3,4,5,6]) assert.ok(a.data.includes(id),`missing block ${id}`);
  const partial=new World({seed:1337});
  assert.ok(partial.size>=48 && partial.height>0 && partial.data.length>0,'partial options keep defaults');
});
test('block edits reject noninteger coordinates and invalid ids without corrupting data',()=>{
  const w=flat(),before=w.data.slice();
  for(const xyz of [[-1,1,1],[48,1,1],[1,32,1],[1.5,1,1],[NaN,1,1]]) assert.equal(w.setBlock(...xyz,2),false);
  for(const id of [-1,7,1.5,NaN]) assert.equal(w.setBlock(2,2,2,id),false);
  assert.deepEqual(w.data,before);
});
test('player body rejects placement inside it but allows adjacent space',()=>{
  const p=new Player(flat(),10.2,1,10.2);
  assert.equal(p.overlapsBlock(10,1,10),true);
  assert.equal(p.overlapsBlock(10,2,10),true);
  assert.equal(p.overlapsBlock(11,1,10),false);
});
test('player falls, lands and can jump only from supported ground',()=>{
  const w=flat(),p=new Player(w,10.2,6,10.2);
  for(let i=0;i<180;i++) p.step({forward:0,right:0,jump:false},0,1/60);
  assert.ok(Math.abs(p.position[1]-1)<.01); assert.equal(p.grounded,true);
  assert.equal(p.step({forward:0,right:0,jump:true},0,1/60),true);
  assert.equal(p.step({forward:0,right:0,jump:true},0,1/60),false);
  for(let i=0;i<180;i++) p.step({forward:0,right:0,jump:false},0,1/60);
  w.setBlock(10,0,10,0);
  p.step({forward:0,right:0,jump:false},0,1/60);
  assert.equal(p.grounded,false,'walking off an edge must remove grounded status');
});
test('fast falls cannot tunnel through a one-block floor',()=>{
  const p=new Player(flat(),10.2,2.2,10.2); p.vel[1]=-50;
  p.step({forward:0,right:0,jump:false},0,.05);
  assert.ok(p.position[1]>=1,`fell through floor to ${p.position[1]}`);
});
test('collision resolves against the exposed face of thick floors and ceilings',()=>{
  const w=flat();
  for(let y=1;y<4;y++) w.setBlock(10,y,10,3);
  const p=new Player(w,10.2,4.2,10.2);p.vel[1]=-50;
  p.step({forward:0,right:0,jump:false},0,.05);
  assert.ok(p.position[1]>=4,`buried in platform at ${p.position[1]}`);
  const ceiling=flat();ceiling.setBlock(10,4,10,3);ceiling.setBlock(10,5,10,3);
  const body={min:[10.2,1.2,10.2],halfW:.3,halfH:.9};
  ceiling.move(body,0,2.2,0);
  assert.ok(body.min[1]+1.8<=4.001,`inside ceiling at ${body.min[1]}`);
});
test('large frame gaps are clamped and collisions stop motion on X and Z',()=>{
  const w=flat(); for(let i=0;i<4;i++){w.setBlock(12,i,10,3);w.setBlock(10,i,12,3);}
  const p=new Player(w,10.2,1,10.2);
  p.step({forward:1,right:1,jump:false},0,30);
  assert.ok(p.position.every(Number.isFinite)); assert.ok(p.position[0]<11 && p.position[2]<11);
  for(let i=0;i<120;i++) p.step({forward:0,right:1,jump:false},0,1/60);
  assert.ok(p.position[0]>11 && p.position[0]+.6<=12.001);
  p.teleport(10.2,1,10.2);
  // Player now follows camera convention: yaw 0 forward is -Z, so back
  // approaches the +Z wall. Require travel as well as non-penetration.
  for(let i=0;i<120;i++) p.step({forward:-1,right:0,jump:false},0,1/60);
  assert.ok(p.position[2]>11 && p.position[2]+.6<=12.001);
});
test('save round trip retains block additions/removals and player; malformed saves recover',()=>{
  const memory=new Map(); const saver=makeSaver({getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},48);
  const state={seed:1337,size:48,height:32,waterLevel:4,edits:[[1,1,1,0],[2,8,2,4]],player:{pos:[10,5,10],yaw:1,pitch:-.3},selected:'wood'};
  saver.save(state); const saved=saver.load(); assert.deepEqual(saved.edits,state.edits); assert.deepEqual(saved.player,state.player); assert.equal(saved.selected,'wood');
  assert.equal(deserializeState('{bad',48),null); assert.equal(deserializeState('null',48),null);
  saver.clear();assert.equal(saver.load(),null);
});
