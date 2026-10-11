import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combinePolygons, operatePolygons } from '../src/drawing/polygon-operation.js';
import { toFeature } from '../src/drawing/geometry.js';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
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

test('self-touching raster boundaries forming a hole work without losing area or changing inputs', () => {
  const touching = { id: 'wand', name: 'Zauberstab', kind: 'polygon',
    vertices: [[0,0],[4,0],[4,4],[0,4],[0,2],[1,3],[2,2],[1,1],[0,2]] };
  const enclosing = rect(-1,-1,6,6), before = structuredClone(touching);
  const expected = { union: 36, difference: 22, intersection: 14, xor: 22 };
  for (const [operation, expectedArea] of Object.entries(expected)) {
    const result = combinePolygons(enclosing, touching, operation);
    assert.equal(area(result), expectedArea);
    assert.equal(new IsValidOp(new GeoJSONReader().read(toFeature(result,p=>p).geometry)).isValid(), true);
  }
  assert.equal(combinePolygons(touching, touching, 'difference'), null);
  assert.deepEqual(touching, before);
});

test('real crossings and misplaced holes report the object, reason and exact location', () => {
  const crossing = { id: 'crossing', name: 'Kreuzung', kind: 'polygon', vertices: [[0,0],[4,4],[0,4],[4,0]] };
  assert.throws(() => combinePolygons(rect(-1,-1,6,6), crossing, 'difference'), error => {
    assert.match(error.message, /Kreuzung.*ungültigen Rand/);
    const [issue] = error.issues;
    assert.equal(issue.objectId, crossing.id); assert.equal(issue.objectName, crossing.name);
    assert.deepEqual(issue.point, [2,2]); assert.ok(issue.segments.length >= 2);
    assert.match(issue.reason, /kreuzen/); return true;
  });
  const outsideHole = { ...rect(0,0,4,4), name:'Falsches Loch', holes:[rect(5,5,1,1).vertices] };
  assert.throws(() => combinePolygons(rect(-1,-1,8,8), outsideHole, 'union'), error => {
    assert.match(error.message, /Loch liegt außerhalb/);
    assert.ok(error.issues[0].point); return true;
  });
});
