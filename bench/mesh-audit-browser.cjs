// Independent positive/negative fixtures for the read-only WebGL observer.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const { installMeshAudit } = require('./mesh-audit.cjs');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined,args:['--enable-unsafe-swiftshader']});
  try {
    for (const mode of ['arrays','indexed','interleaved','instanced','wrong-normal','reversed','degenerate']) {
      const page=await browser.newPage();await page.addInitScript(installMeshAudit);await page.goto('about:blank');
      const result=await page.evaluate(mode=>{
        const gl=document.createElement('canvas').getContext('webgl2');
        const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
        const p=gl.createProgram();
        gl.attachShader(p,shader(gl.VERTEX_SHADER,'#version 300 es\nin vec3 position; in vec3 normal; out vec3 color; void main(){gl_Position=vec4(position,1.0);color=normal*.5+.5;}'));
        gl.attachShader(p,shader(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float; in vec3 color; out vec4 fragColor; void main(){fragColor=vec4(color,1.0);}'));
        gl.linkProgram(p);gl.useProgram(p);
        const positions=mode==='degenerate'?[-1,-1,0,-1,-1,0,0,1,0]:[-1,-1,0,1,-1,0,0,1,0];
        const normals=mode==='wrong-normal'?[0,1,0,0,1,0,0,1,0]:[0,0,1,0,0,1,0,0,1];
        const buffer=data=>{const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,data.length*4,gl.STATIC_DRAW);gl.bufferSubData(gl.ARRAY_BUFFER,0,new Float32Array(data));return b;};
        const attribute=(name,b,stride=0,offset=0)=>{gl.bindBuffer(gl.ARRAY_BUFFER,b);const i=gl.getAttribLocation(p,name);gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,3,gl.FLOAT,false,stride,offset);};
        if(mode==='interleaved') {
          const values=[];for(let i=0;i<9;i+=3)values.push(...positions.slice(i,i+3),...normals.slice(i,i+3));
          const b=buffer(values);attribute('position',b,24,0);attribute('normal',b,24,12);
        } else {attribute('position',buffer(positions));attribute('normal',buffer(normals));}
        if(['indexed','instanced','reversed'].includes(mode)) {
          const b=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,b);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(mode==='reversed'?[0,2,1]:[0,1,2]),gl.STATIC_DRAW);
          if(mode==='instanced')gl.drawElementsInstanced(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0,2);
          else gl.drawElements(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0);
        } else gl.drawArrays(gl.TRIANGLES,0,3);
        return {audit:window.__voxelMeshAudit,error:gl.getError()};
      },mode);
      assert.equal(result.error,0,mode);assert.equal(result.audit.triangles,1,mode);
      assert.equal(result.audit.invalid,['wrong-normal','reversed','degenerate'].includes(mode)?1:0,mode);
      console.log('PASS '+mode);await page.close();
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
