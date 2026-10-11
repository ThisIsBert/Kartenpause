import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operatePolygons} from '../src/drawing/polygon-operation.js';
import {toFeature,objectRings,hasCurves,edgePoint,splitEdge,ringEntries,removeVertex} from '../src/drawing/geometry.js';
import {linearObject} from '../src/drawing/rework-geometry.js';
import {simplifyObject} from '../src/drawing/simplification.js';
import {importGeoJSON} from '../src/drawing/import.js';
const curve={kind:'curvePolygon',vertices:[[0,0],[10,0],[10,10],[0,10]]};
const rect=(x,y,w,h)=>({kind:'polygon',vertices:[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]});
const count=o=>objectRings(o).reduce((n,r)=>n+r.length,0);
const near=(a,b)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-7));

test('intact curved contours keep their original anchors through union and subtraction',()=>{
  const result=operatePolygons([curve,rect(30,0,10,10)],'union');
  assert.equal(result.kind,'multiPolygon');assert.equal(count(result),8);assert.ok(hasCurves(result));assert.ok(!result.curveFallback);
  const retained=operatePolygons([curve,rect(30,0,10,10)],'difference');assert.equal(count(retained),4);assert.ok(hasCurves(retained));
  const hole=operatePolygons([rect(-5,-5,20,20),curve],'difference');assert.equal(hole.holes.length,1);assert.equal(hole.holes[0].length,4);assert.ok(hole.holeCurveSegments[0].every(Boolean));
});
test('clipped curved boundaries are compact Bézier runs, not sampled vertex chains',()=>{
  for(const operation of ['union','difference','intersection','xor']){
    const result=operatePolygons([curve,rect(5,-5,10,20)],operation);
    assert.ok(result);assert.ok(hasCurves(result),operation);assert.ok(!result.curveFallback,operation);assert.ok(count(result)<=16,operation+': '+count(result));
  }
});
test('curve insertion splits the exact cubic without moving other edges; edits keep segment arrays aligned',()=>{
  const shape=structuredClone(curve), original=structuredClone(curve);
  splitEdge(shape,0);assert.equal(shape.vertices.length,5);assert.equal(shape.curveSegments.length,5);
  for(const t of [0,.1,.5,.9,1])near(edgePoint(original,0,t),t<=.5?edgePoint(shape,0,t*2):edgePoint(shape,1,t*2-1));
  near(edgePoint(original,1,.4),edgePoint(shape,2,.4));
  removeVertex(shape,1);assert.equal(shape.vertices.length,4);assert.equal(shape.curveSegments.length,4);
});
test('curved features round-trip in projected coordinates, including multipolygons and curved holes',()=>{
  const R=6378137, project=([lon,lat])=>[R*lon*Math.PI/180,R*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))], inverse=([x,y])=>[x/R*180/Math.PI,(2*Math.atan(Math.exp(y/R))-Math.PI/2)*180/Math.PI];
  const world={kind:'curvePolygon',vertices:[[8,48],[12,48],[12,52],[8,52]].map(project)};
  const outer={kind:'polygon',vertices:[[6,46],[14,46],[14,54],[6,54]].map(project)};
  const far={kind:'polygon',vertices:[[20,48],[24,48],[24,52],[20,52]].map(project)};
  const forms=[world,operatePolygons([world,far],'union'),operatePolygons([outer,world],'difference'),operatePolygons([world,{kind:'polygon',vertices:[[10,46],[14,46],[14,54],[10,54]].map(project)}],'union')];
  for(const form of forms){
    const feature=toFeature({...form,id:'source',name:'Kurve',properties:{custom:42}},inverse), [restored]=importGeoJSON(feature,project,()=> 'copy');
    assert.ok(hasCurves(restored));assert.equal(count(restored),count(form));assert.equal(restored.properties.custom,42);
    const again=toFeature(restored,inverse); assert.equal(again.geometry.type,feature.geometry.type);
    const a=objectRings(form),b=objectRings(restored);a.forEach((r,i)=>r.forEach((p,j)=>near(p,b[i][j])));
  }
});
test('legacy Catmull–Rom metadata is restored; stale or malformed curve definitions cannot replace geometry',()=>{
  const feature=toFeature({...curve,name:'Kurve'},p=>p);delete feature.properties.curveDefinition;
  assert.equal(importGeoJSON(feature,p=>p)[0].kind,'curvePolygon');
  feature.properties.curveDefinition={version:1,geometry:{...curve,vertices:[[40,40],[50,40],[50,50],[40,50]]}};
  assert.equal(importGeoJSON(feature,p=>p)[0].kind,'polygon');
  feature.properties.curveDefinition.geometry.curveSegments=[[[0,0],[1,1]]];
  assert.equal(importGeoJSON(feature,p=>p)[0].kind,'polygon');
});
test('explicit simplification and section editing use the actual curve outline without stale segment data',()=>{
  const result=operatePolygons([curve,rect(5,-5,10,20)],'union'), linear=linearObject(result);
  assert.ok(!hasCurves(linear));assert.ok(count(linear)>count(result));
  const simplified=simplifyObject(result,30);assert.ok(!hasCurves(simplified));
  for(const entry of ringEntries(simplified))assert.ok(!entry.shape.curveSegments);
  assert.deepEqual(simplifyObject(result,0),result);
});

test('inserting a point on an original curved multipart leaf stores its segment definition on the object',()=>{
  const object={kind:'multiPolygon',parts:[structuredClone(curve),rect(30,0,10,10)]};
  splitEdge(ringEntries(object)[0].shape,0);
  assert.equal(object.parts[0].vertices.length,5);assert.equal(object.parts[0].curveSegments.length,5);
  near(edgePoint(curve,0,.25),edgePoint(object.parts[0],0,.5));
});
