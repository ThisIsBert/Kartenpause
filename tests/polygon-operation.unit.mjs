import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combinePolygons, operatePolygons } from '../src/drawing/polygon-operation.js';
import { toFeature } from '../src/drawing/geometry.js';
const rect = (x, y, w, h) => ({ kind: 'polygon', vertices: [[x,y], [x+w,y], [x+w,y+h], [x,y+h]] });
const ringArea = ring => Math.abs(ring.reduce((sum,p,i) => { const q=ring[(i+1)%ring.length]; return sum+p[0]*q[1]-q[0]*p[1]; },0))/2;
const area = object => { if (!object) return 0; const g=toFeature(object,p=>p).geometry; return (g.type==='Polygon'?[g.coordinates]:g.coordinates).reduce((sum,rings)=>sum+ringArea(rings[0])-rings.slice(1).reduce((n,r)=>n+ringArea(r),0),0); };

test('polygon operations dissolve overlapping and touching boundaries, keep sources unchanged', () => {
  const a=rect(0,0,10,10), b=rect(5,0,10,10), before=structuredClone([a,b]);
  assert.equal(area(combinePolygons(a,b,'union')),150);
  assert.equal(area(combinePolygons(a,b,'difference')),50);
  const reversed=combinePolygons(b,a,'difference');
  assert.equal(area(reversed),50); assert.ok(reversed.vertices.every(p=>p[0]>=10));
  assert.equal(combinePolygons(a,rect(10,0,10,10),'union').kind,'polygon');
  assert.deepEqual([a,b],before);
});
test('polygon operations preserve separate parts and can split a polygon', () => {
  const a=rect(0,0,10,10), b=rect(20,0,10,10);
  const joined=combinePolygons(a,b,'union'); assert.equal(joined.kind,'multiPolygon'); assert.equal(joined.parts.length,2); assert.equal(area(joined),200);
  assert.equal(area(combinePolygons(a,b,'difference')),100);
  const split=combinePolygons(a,rect(4,-1,2,12),'difference'); assert.equal(split.kind,'multiPolygon'); assert.equal(area(split),80);
  assert.equal(area(combinePolygons(joined,rect(1,1,2,2),'difference')),196);
});
test('polygon subtraction creates holes and union can fill them', () => {
  const a=rect(0,0,10,10), b=rect(2,2,6,6), cut=combinePolygons(a,b,'difference');
  assert.equal(cut.holes.length,1); assert.equal(area(cut),64);
  const filled=combinePolygons(cut,b,'union'); assert.equal(filled.holes.length,0); assert.equal(area(filled),100);
});
test('complete subtraction is empty and identical union stays a single area', () => {
  const a=rect(0,0,10,10);
  assert.equal(combinePolygons(a,a,'difference'),null);
  assert.equal(combinePolygons(a,rect(-1,-1,12,12),'difference'),null);
  assert.equal(area(combinePolygons(a,a,'union')),100);
});
test('polygon operations follow the sampled curved boundary', () => {
  const a={...rect(0,0,10,10),kind:'curvePolygon'}, before=structuredClone(a);
  const result=combinePolygons(a,rect(30,0,10,10),'union');
  assert.ok(Math.abs(area(result)-area(a)-100)<1e-8); assert.deepEqual(a,before);
});
test('invalid boundaries, non-area objects and unknown operations are rejected atomically', () => {
  const a=rect(0,0,10,10), invalid={kind:'polygon',vertices:[[0,0],[10,10],[0,10],[10,0]]};
  assert.throws(()=>combinePolygons(a,invalid,'union'),/ungültigen Rand/);
  assert.throws(()=>combinePolygons(a,{kind:'line',vertices:[[0,0],[1,1]]},'union'),/zwei Flächen/);
  assert.throws(()=>combinePolygons(a,a,'invalid'),/Unbekannte/);
});

test('multiple polygons support union, first minus all others, intersection and parity XOR', () => {
  const objects=[rect(0,0,10,10),rect(2,0,10,10),rect(4,0,10,10)];
  assert.equal(area(operatePolygons(objects,'union')),140);
  assert.equal(area(operatePolygons(objects,'difference')),20);
  assert.equal(area(operatePolygons(objects,'intersection')),60);
  assert.equal(area(operatePolygons(objects,'xor')),100);
  assert.equal(area(operatePolygons([objects[0],objects[0]],'xor')),0);
  assert.equal(operatePolygons([rect(0,0,1,1),rect(1,0,1,1)],'intersection'),null);
  assert.equal(operatePolygons([rect(0,0,1,1),rect(10,0,1,1)],'intersection'),null);
});
