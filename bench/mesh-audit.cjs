// Read-only WebGL observation for the voxel benchmark. Check the geometry
// actually submitted for drawing, independent of a game's debug API.
// Run before application scripts with Playwright's addInitScript.
function installMeshAudit() {
  const buffers = new WeakMap(), seen = new Map(), geometry = new Set(), frames = new WeakMap();
  const report = { triangles: 0, invalid: 0, examples: [], geometryChanges: 0 };
  window.__voxelMeshAudit = report;
  let version = 0;
  const fingerprint = data => {
    let h = 2166136261;
    for (const byte of data) h = Math.imul(h ^ byte, 16777619);
    return data.byteLength + ':' + (h >>> 0);
  };
  const copyBytes = (data, offset = 0, length) => {
    if (typeof data === 'number') return data <= 64 * 1024 * 1024 ? new Uint8Array(data) : null;
    if (!data) return null;
    const bytes = data.BYTES_PER_ELEMENT || 1;
    const start = (data.byteOffset || 0) + offset * bytes;
    const size = length === undefined ? data.byteLength - offset * bytes : length * bytes;
    return size <= 64 * 1024 * 1024 ? new Uint8Array(data.buffer || data, start, size).slice() : null;
  };
  for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Type) continue;
    const proto = Type.prototype;
    const clear = proto.clear;
    proto.clear = function(mask) {
      if (mask & this.COLOR_BUFFER_BIT) frames.set(this, new Set());
      return clear.call(this, mask);
    };
    for (const name of ['bufferData', 'bufferSubData']) {
      const original = proto[name];
      proto[name] = function(...args) {
        const result = original.apply(this, args);
        const target = args[0];
        if (target !== this.ARRAY_BUFFER && target !== this.ELEMENT_ARRAY_BUFFER) return result;
        const buffer = this.getParameter(target === this.ARRAY_BUFFER ? this.ARRAY_BUFFER_BINDING : this.ELEMENT_ARRAY_BUFFER_BINDING);
        try {
          if (name === 'bufferData') {
            const data = copyBytes(args[1], args[3], args[4]);
            if (data) buffers.set(buffer, { data, version: ++version, fingerprint: fingerprint(data) });
          } else {
            const old = buffers.get(buffer), data = copyBytes(args[2], args[3], args[4]);
            if (old && data) { old.data.set(data, args[1]); old.version = ++version; old.fingerprint = fingerprint(old.data); }
          }
        } catch { /* An unsupported buffer must not change application behavior. */ }
        return result;
      };
    }
    const observe = (gl, count, indexType, offset, first = 0, instances = 1) => {
      const program = gl.getParameter(gl.CURRENT_PROGRAM);
      const attribute = name => {
        const loc = gl.getAttribLocation(program, name);
        if (loc < 0 || !gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_ENABLED) || gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_TYPE) !== gl.FLOAT) return null;
        const buffer = buffers.get(gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING));
        if (!buffer) return null;
        const stride = gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_STRIDE) || gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_SIZE) * 4;
        const start = gl.getVertexAttribOffset(loc, gl.VERTEX_ATTRIB_ARRAY_POINTER), data = new DataView(buffer.data.buffer);
        return { version: buffer.version, fingerprint: buffer.fingerprint, start, stride, at: i => [0, 4, 8].map(n => data.getFloat32(start + i * stride + n, true)) };
      };
      const pos = attribute('position'), normal = attribute('normal');
      if (!pos || !normal) return;
      const indices = indexType ? buffers.get(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)) : null;
      if (indexType && !indices) return;
      const matrix = attribute('instanceMatrix');
      const key = [pos.version, pos.start, normal.version, normal.start, indices?.version, matrix?.version, count, indexType, offset, first, instances].join(':');
      const frame = frames.get(gl) || new Set();frames.set(gl, frame);
      const recordFrame = signature => {
        frame.add(signature);
        window.__voxelGeometryFrame = [...frame].sort().join('\n');
      };
      if (seen.has(key)) { recordFrame(seen.get(key)); return; }
      // Buffer identity/version alone is insufficient: rebuilding stale world
      // data uploads identical geometry. Count distinct content actually drawn,
      // including instance transforms, to observe visible mining/placement.
      const signature = [pos.fingerprint, pos.start, pos.stride, normal.fingerprint, normal.start, normal.stride,
        indices?.fingerprint, matrix?.fingerprint, matrix?.start, matrix?.stride, count, indexType, offset, first, instances].join('|');
      seen.set(key, signature);recordFrame(signature);
      if (!geometry.has(signature)) { geometry.add(signature); report.geometryChanges++; }
      const data = indices && new DataView(indices.data.buffer);
      const index = i => !data ? first + i : indexType === gl.UNSIGNED_INT ? data.getUint32(offset + i * 4, true) : indexType === gl.UNSIGNED_SHORT ? data.getUint16(offset + i * 2, true) : data.getUint8(offset + i);
      // Bound observer work for large worlds; each distinct draw is sampled.
      const step = Math.max(1, Math.ceil(count / 90000));
      for (let t = 0; t + 2 < count; t += 3 * step) {
        const ids = [index(t), index(t + 1), index(t + 2)], points = ids.map(pos.at), ns = ids.map(normal.at);
        const a = points[1].map((v,i)=>v-points[0][i]), b = points[2].map((v,i)=>v-points[0][i]);
        const cross = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
        const n = [0,1,2].map(i=>ns[0][i]+ns[1][i]+ns[2][i]);
        const area = Math.hypot(...cross), norm = Math.hypot(...n);
        const alignment = cross.reduce((s,v,i)=>s+v*n[i],0)/(area*norm);
        report.triangles++;
        if (area < 1e-8 || !Number.isFinite(alignment) || alignment < .5) {
          report.invalid++;
          if (report.examples.length < 4) report.examples.push({points,normals:ns,alignment:Number.isFinite(alignment)?alignment:null});
        }
      }
    };
    for (const name of ['drawElements', 'drawElementsInstanced', 'drawArrays', 'drawArraysInstanced']) {
      const original = proto[name]; if (!original) continue;
      proto[name] = function(...args) {
        if (args[0] === this.TRIANGLES) {
          try {
            if (name.startsWith('drawElements')) observe(this,args[1],args[2],args[3],0,args[4] ?? 1);
            else observe(this,args[2],0,0,args[1],args[3] ?? 1);
          } catch { /* Observations must never crash the application. */ }
        }
        return original.apply(this,args);
      };
    }
  }
}
module.exports = { installMeshAudit };
