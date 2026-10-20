import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operatePolygons} from '../src/drawing/polygon-operation.js';
import {toFeature,objectRings,hasCurves,edgePoint,splitEdge,ringEntries,removeVertex} from '../src/drawing/geometry.js';
import {linearObject} from '../src/drawing/rework-geometry.js';
import {simplifyObject} from '../src/drawing/simplification.js';
import {importGeoJSON} from '../src/drawing/import.js';
import {materializeControls,vertexControls,controlsAligned,moveControl,alignControls} from '../src/drawing/bezier-handles.js';
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

test('materializing legacy curves preserves every segment; moving anchors translates only their own handles',()=>{
  const shape=structuredClone(curve), original=structuredClone(shape);
  materializeControls(shape);
  for(let i=0;i<4;i++)for(const t of [0,.2,.5,.8,1])near(edgePoint(shape,i,t),edgePoint(original,i,t));
  const before=Array.from({length:4},(_,i)=>vertexControls(shape,i));
  shape.vertices[1]=shape.vertices[1].map(v=>v+3);
  for(const side of ['incoming','outgoing'])near(vertexControls(shape,1)[side],before[1][side].map(v=>v+3));
  for(const i of [0,2,3])assert.deepEqual(vertexControls(shape,i),before[i]);
});

test('smooth handles rotate together but retain independent lengths; corners can be restored',()=>{
  const shape=structuredClone(curve), index=0;
  assert.ok(controlsAligned(shape,index));
  const controls=vertexControls(shape,index), otherLength=Math.hypot(...controls.incoming);
  moveControl(shape,index,'outgoing',[8,3]);
  near(vertexControls(shape,index).outgoing,[8,3]);assert.ok(controlsAligned(shape,index));
  assert.ok(Math.abs(Math.hypot(...vertexControls(shape,index).incoming)-otherLength)<1e-9);
  const incoming=vertexControls(shape,index).incoming;
  moveControl(shape,index,'outgoing',[1,5],{coupled:false});
  near(vertexControls(shape,index).incoming,incoming);assert.ok(!controlsAligned(shape,index));
  moveControl(shape,index,'outgoing',[2,6]); // Subsequent gestures keep the corner.
  near(vertexControls(shape,index).incoming,incoming);
  alignControls(shape,index);assert.ok(controlsAligned(shape,index));
});

test('two-anchor curves have editable end handles and no phantom closing segment',()=>{
  const shape={kind:'curve',vertices:[[0,0],[12,0]]};
  assert.equal(vertexControls(shape,0).incoming,null);assert.equal(vertexControls(shape,1).outgoing,null);
  moveControl(shape,0,'outgoing',[3,5]);
  assert.ok(edgePoint(shape,0,.5)[1]>0);assert.equal(shape.curveSegments.length,1);
  splitEdge(shape,0);assert.equal(shape.curveSegments.length,2);
  for(const endpoint of [0,2]){
    const copy=structuredClone(shape);removeVertex(copy,endpoint);
    assert.equal(copy.curveSegments.length,1);assert.equal(copy.vertices.length,2);
    assert.ok(edgePoint(copy,0,.5).every(Number.isFinite));
  }
});

test('legacy two-anchor curves import with handles, including collection members',()=>{
  const shape={kind:'curve',vertices:[[0,0],[12,0]]};
  const geometry={type:'LineString',coordinates:shape.vertices};
  const feature={type:'Feature',geometry,properties:{curveDefinition:{version:1,geometry:shape}}};
  assert.equal(importGeoJSON(feature,p=>p)[0].kind,'curve');
  const group={type:'Feature',geometry:{type:'GeometryCollection',geometries:[geometry]},properties:{curveDefinition:{version:1,geometry:{kind:'collection',parts:[shape]}}}};
  assert.equal(importGeoJSON(group,p=>p)[0].parts[0].kind,'curve');
  feature.geometry={type:'LineString',coordinates:[[1,0],[12,0]]};
  assert.equal(importGeoJSON(feature,p=>p)[0].kind,'line');
});

test('angle snapping preserves handle length and collapsed handles remain finite',()=>{
  const shape=structuredClone(curve);
  moveControl(shape,0,'outgoing',[8,7],{snap:true});
  const out=vertexControls(shape,0).outgoing;assert.ok(Math.abs(out[0]-out[1])<1e-9);
  assert.ok(Math.abs(Math.hypot(...out)-Math.hypot(8,7))<1e-9);
  moveControl(shape,0,'outgoing',[0,0]);
  assert.ok(Object.values(vertexControls(shape,0)).flat().every(Number.isFinite));
  alignControls(shape,0);assert.ok(controlsAligned(shape,0));
  moveControl(shape,0,'outgoing',[0,0]);moveControl(shape,0,'incoming',[0,0]);
  alignControls(shape,0);assert.ok(controlsAligned(shape,0));
});

test('edited handles round-trip for curved multipart boundaries and holes',()=>{
  const hole=operatePolygons([rect(-5,-5,20,20),curve],'difference');
  const object={kind:'multiPolygon',parts:[hole,structuredClone(curve)]};
  for(const entry of ringEntries(object).filter(entry=>hasCurves(entry.shape))){
    moveControl(entry.shape,0,'outgoing',[3,2],{coupled:false});
    assert.ok(!controlsAligned(entry.shape,0));
  }
  const feature=toFeature(object,p=>p), [restored]=importGeoJSON(feature,p=>p);
  assert.equal(count(restored),count(object));
  ringEntries(object).forEach((entry,i)=>assert.deepEqual(vertexControls(ringEntries(restored)[i].shape,0),vertexControls(entry.shape,0)));
});

test('new segment definitions on hole rings are persisted on the owning polygon',()=>{
  const object={...rect(0,0,20,20),holes:[[[2,2],[5,2],[5,5],[2,5]]]};
  const shape=ringEntries(object)[1].shape;
  materializeControls(shape);
  assert.equal(object.holeCurveSegments[0],shape.curveSegments);
});
