// Verify that visible edits require new drawn geometry, not just new buffers.
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert=require('node:assert/strict');
const {installMeshAudit}=require('./mesh-audit.cjs');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined,args:['--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage();await page.addInitScript(installMeshAudit);await page.goto('about:blank');
    const result=await page.evaluate(()=>{
      const gl=document.createElement('canvas').getContext('webgl2');
      const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
      const program=gl.createProgram();
      gl.attachShader(program,shader(gl.VERTEX_SHADER,'#version 300 es\nin vec3 position; in vec3 normal; in mat4 instanceMatrix; out vec3 color; void main(){gl_Position=instanceMatrix*vec4(position,1.0);color=normal*.5+.5;}'));
      gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float; in vec3 color; out vec4 fragColor; void main(){fragColor=vec4(color,1.0);}'));
      gl.linkProgram(program);gl.useProgram(program);
      const upload=(name,data)=>{
        const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);
        const loc=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,0,0);return b;
      };
      const positions=[-1,-1,0,1,-1,0,0,1,0];
      upload('position',positions);upload('normal',[0,0,1,0,0,1,0,0,1]);
      const matrices=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
      const matrix=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,matrix);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(matrices),gl.STATIC_DRAW);
      const loc=gl.getAttribLocation(program,'instanceMatrix');
      for(let i=0;i<4;i++){gl.enableVertexAttribArray(loc+i);gl.vertexAttribPointer(loc+i,4,gl.FLOAT,false,64,i*16);gl.vertexAttribDivisor(loc+i,1);}
      const indices=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2]),gl.STATIC_DRAW);
      const draw=(count=1)=>{gl.clear(gl.COLOR_BUFFER_BIT);gl.drawElementsInstanced(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0,count);return window.__voxelMeshAudit.geometryChanges;};
      const observed={initial:draw(),sameFrame:draw()};
      const initialFrame=window.__voxelGeometryFrame;
      const position=upload('position',positions);observed.identicalRebuild=draw();
      const rebuiltFrame=window.__voxelGeometryFrame;
      gl.bindBuffer(gl.ARRAY_BUFFER,position);gl.bufferSubData(gl.ARRAY_BUFFER,0,new Float32Array([-.8,-1,0]));observed.position=draw();
      const changedFrame=window.__voxelGeometryFrame;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER,0,new Uint16Array([1,2,0]));observed.indices=draw();
      gl.bindBuffer(gl.ARRAY_BUFFER,matrix);gl.bufferSubData(gl.ARRAY_BUFFER,12*4,new Float32Array([.1,0,0,1]));observed.instanceMatrix=draw();
      observed.instanceCount=draw(2);
      gl.bindBuffer(gl.ARRAY_BUFFER,position);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(positions),gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2]),gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER,matrix);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(matrices),gl.STATIC_DRAW);draw();
      return {observed,stableRebuild:initialFrame===rebuiltFrame,changedFrame:initialFrame!==changedFrame,restoredFrame:initialFrame===window.__voxelGeometryFrame,error:gl.getError(),invalid:window.__voxelMeshAudit.invalid};
    });
    assert.equal(result.error,0);assert.equal(result.invalid,0);
    assert.equal(result.stableRebuild,true);assert.equal(result.changedFrame,true);assert.equal(result.restoredFrame,true);
    assert.deepEqual(result.observed,{initial:1,sameFrame:1,identicalRebuild:1,position:2,indices:3,instanceMatrix:4,instanceCount:5});
    console.log('PASS: unchanged frame and identical rebuild rejected; position, index, instance transform and instance count changes observed');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
