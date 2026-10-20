import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMagneticPath } from '../src/drawing/magnetic-path.js';

const paleBlue = [160, 198, 215], land = [245, 241, 232];
function image(width = 180, height = 160, background = land) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...background, 255], i * 4);
  return { width, height, data };
}
function stroke(raster, points, color = paleBlue, halfWidth = 3) {
  const { width, height, data } = raster;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
    for (let j = 0; j <= steps; j++) {
      const x = Math.round(a[0] + (b[0] - a[0]) * j / steps), y = Math.round(a[1] + (b[1] - a[1]) * j / steps);
      for (let dy = -halfWidth; dy <= halfWidth; dy++) for (let dx = -halfWidth; dx <= halfWidth; dx++) {
        if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height) data.set([...color, 255], ((y + dy) * width + x + dx) * 4);
      }
    }
  }
}
function meander() {
  const raster = image();
  stroke(raster, [[20,35],[70,35],[70,125],[90,125],[90,35],[150,35]]);
  return { raster, start: [20,35], end: [150,35], radius: 100, color: paleBlue };
}
function brokenLine(gaps, { color = [20,20,20], background = [255,255,255], vertical = false } = {}) {
  const raster = image(180, 180, background);
  stroke(raster, vertical ? [[80,15],[80,160]] : [[15,80],[160,80]], color, 1);
  for (const [from, to] of gaps) for (let p = from; p <= to; p++) for (let d = -2; d <= 2; d++) {
    const x = vertical ? 80 + d : p, y = vertical ? p : 80 + d;
    raster.data.set([...background,255], (y * raster.width + x) * 4);
  }
  return { raster, start: vertical ? [80,15] : [15,80], end: vertical ? [80,160] : [160,80], radius: 16, color };
}

test('connected pale river hairpins win over a land shortcut at every fidelity and bridge limit', () => {
  for (const color of [paleBlue, null]) for (const fidelity of [0,80,100]) for (const maxGap of [0,8,40]) {
    const result = findMagneticPath({ ...meander(), color, fidelity, maxGap });
    assert.ok(result.pixels.some(p => p[1] >= 120));
    assert.equal(result.bridges, 0); assert.equal(result.longestGap, 0);
    assert.deepEqual(result.pixels[0],[20,35]); assert.deepEqual(result.pixels.at(-1),[150,35]);
  }
});

test('a small corridor cannot silently cut a hairpin when bridging is disabled', () => {
  assert.throws(() => findMagneticPath({ ...meander(), radius: 32, maxGap: 0 }), /Keine ausreichend/);
  assert.throws(() => findMagneticPath({ ...meander(), radius: 32, maxGap: 8 }), /Keine ausreichend/);
});

test('diagonal interruptions consume their Euclidean length rather than a count of pixels',()=>{
  const raster=image(160,160,[255,255,255]),color=[20,20,20];
  stroke(raster,[[20,20],[130,130]],color,0);
  for(let i=60;i<=64;i++)raster.data.set([255,255,255,255],(i*160+i)*4);
  const request={raster,start:[20,20],end:[130,130],radius:16,color};
  assert.throws(()=>findMagneticPath({...request,maxGap:7}),/Keine ausreichend/);
  const result=findMagneticPath({...request,maxGap:8});
  assert.equal(result.bridges,1);assert.ok(Math.abs(result.longestGap-5*Math.SQRT2)<1e-9);
});

test('higher fidelity prefers a clear detour over a weaker connected shortcut', () => {
  const raster=image(180,160,[255,255,255]),color=[100,100,100];
  stroke(raster,[[40,35],[130,35]],[130,130,130],1);
  stroke(raster,[[15,35],[40,35],[40,105],[130,105],[130,35],[155,35]],color,1);
  const request={raster,start:[15,35],end:[155,35],radius:100,color,maxGap:0};
  const relaxed=findMagneticPath({...request,fidelity:0}),faithful=findMagneticPath({...request,fidelity:100});
  assert.ok(relaxed.pixels.every(p=>p[1]<40));
  assert.ok(faithful.pixels.some(p=>p[1]>=100));
});

test('gap budgets apply separately to each consecutive interruption and zero disables bridging', () => {
  const request = brokenLine([[50,55],[110,115]]);
  assert.throws(() => findMagneticPath({ ...request, maxGap: 0 }), /Keine ausreichend/);
  assert.throws(() => findMagneticPath({ ...request, maxGap: 5 }), /Keine ausreichend/);
  const result = findMagneticPath({ ...request, maxGap: 6 });
  assert.equal(result.bridges, 2); assert.equal(result.longestGap, 6);
  assert.ok(result.support > .9);
  assert.ok(result.pixels.every(p => Math.abs(p[1]-80)<=1));
});

test('a continuous alternative has priority even when a shorter route could be bridged', () => {
  const request = meander();
  const result = findMagneticPath({ ...request, maxGap: 40, fidelity: 0 });
  assert.equal(result.bridges,0); assert.ok(result.pixels.some(p=>p[1]>=120));
  // A second break makes bridging necessary, but the 14-pixel land cut is
  // still forbidden by a six-pixel limit. The small break must be taken.
  for(let x=67;x<=73;x++)for(let y=77;y<=82;y++)request.raster.data.set([...land,255],(y*request.raster.width+x)*4);
  const bridged=findMagneticPath({...request,maxGap:6});
  assert.ok(bridged.pixels.some(p=>p[1]>=120));assert.equal(bridged.bridges,1);assert.ok(bridged.longestGap<=6);
});

test('unpicked dark and light strokes do not treat background breaks as continuous lines', () => {
  for(const vertical of [false,true])for(const [color,background] of [[[20,20,20],[255,255,255]],[[240,240,240],[10,10,10]]]){
    const request={...brokenLine([[70,76]],{color,background,vertical}),color:null};
    assert.throws(()=>findMagneticPath({...request,maxGap:0}),/Keine ausreichend/);
    const result=findMagneticPath({...request,maxGap:8});
    assert.equal(result.bridges,1);assert.ok(result.longestGap<=8);
  }
});

test('transparent breaks cannot be bridged and oversized gap budgets are rejected',()=>{
  const request=brokenLine([]);
  for(let y=0;y<180;y++)for(let x=70;x<=72;x++)request.raster.data[(y*180+x)*4+3]=0;
  assert.throws(()=>findMagneticPath({...request,maxGap:40}),/Keine ausreichend|Kein Verlauf/);
  assert.throws(()=>findMagneticPath({...request,maxGap:Infinity}),/Ungültiger/);
  assert.throws(()=>findMagneticPath({...request,maxGap:100000}),/Ungültiger/);
});
