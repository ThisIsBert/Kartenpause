import test from 'node:test';
import assert from 'node:assert/strict';
import osmtogeojson from 'osmtogeojson';
import { fullMultipolygon } from '../src/geodata/multipolygon.js';
import { importGeoJSON } from '../src/drawing/import.js';

const way = (ref, role, points) => ({ type: 'way', ref, role, geometry: points.map(([lon, lat]) => ({ lon, lat })) });
const relation = members => ({ type: 'relation', id: 100, tags: { type: 'multipolygon', name: 'Inseln', 'name:de': 'Testfläche' }, members });
const square = (x, y, size) => [[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]];
const rings = feature => feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : feature.geometry.coordinates.flat();
const normalized = feature => rings(feature).map(ring => JSON.stringify(ring.slice(0,-1).map(p=>p.join(',')).sort())).sort();

test('full multipolygons join reversed fragments and preserve holes, islands, tags and source coordinates', () => {
  const source = relation([
    way(1,'outer',[[0,0],[10,0],[10,10]]), way(2,'outer',[[0,0],[0,10],[10,10]]),
    way(3,'inner',square(2,2,2)), way(4,'outer',square(20,0,5)), way(5,'inner',square(21,1,1))
  ]);
  const before = JSON.stringify(source), feature = fullMultipolygon(source);
  assert.equal(JSON.stringify(source), before);
  assert.equal(feature.geometry.type, 'MultiPolygon');
  assert.deepEqual(feature.geometry.coordinates.map(p=>p.length), [2,2]);
  assert.deepEqual(feature.properties.tags, source.tags);
  const reference = osmtogeojson({ elements: structuredClone([source]) }, { flatProperties:false }).features.find(f=>f.id==='relation/100');
  assert.deepEqual(normalized(feature), normalized(reference));
  assert.deepEqual(importGeoJSON(feature,p=>p,()=> 'test'), importGeoJSON(JSON.stringify(feature),p=>p,()=> 'test'));
});

test('holes go to the enclosing exterior, including a touching boundary vertex', () => {
  const feature = fullMultipolygon(relation([
    way(1,'outer',square(0,0,10)), way(2,'outer',square(20,0,10)),
    way(3,'inner',[[20,5],[22,4],[22,6],[20,5]])
  ]));
  assert.equal(feature.geometry.coordinates[0].length,1);
  assert.equal(feature.geometry.coordinates[1].length,2);
});

test('large concave coastlines use the same hole assignment as the reference converter', () => {
  const outline = [[0,0],[20,0],[20,20],[12,20],[12,8],[8,8],[8,20],[0,20],[0,0]];
  const members=[way(1,'outer',outline),way(2,'outer',square(9,12,2))];
  let id=3;
  for(let x=1;x<19;x+=2) for(let y=1;y<19;y+=2) if(x<7 || x>12 || y<7) members.push(way(id++,'inner',square(x,y,.2)));
  members.push(way(id++,'inner',square(9.5,12.5,.3)));
  const source=relation(members), actual=fullMultipolygon(source);
  const expected=osmtogeojson({elements:structuredClone([source])},{flatProperties:false}).features.find(f=>f.id==='relation/100');
  assert.deepEqual(normalized(actual),normalized(expected));
});

test('incomplete, dangling and unassigned rings are rejected rather than silently lost', () => {
  for(const members of [
    [way(1,'outer',[[0,0],[1,0],[1,1]])],
    [way(1,'outer',square(0,0,3)),way(2,'inner',square(8,8,1))],
    [{type:'way',ref:1,role:'outer',geometry:[{lon:0,lat:0},null]}],
    [{type:'relation',ref:1,role:'outer'}]
  ]) assert.throws(()=>fullMultipolygon(relation(members)), /unvollständige/);
});

test('routes and ambiguous shared endpoints retain the general converter fallback', () => {
  assert.equal(fullMultipolygon({...relation([]), tags:{type:'route'}}),null);
  assert.equal(fullMultipolygon(relation([
    way(1,'outer',[[0,0],[1,0]]),way(2,'outer',[[0,0],[0,1]]),way(3,'outer',[[0,0],[-1,0]])
  ])),null);
});

test('many islands retain every vertex and hole without simplifying', () => {
  const members=[way(1,'outer',square(0,0,50))];
  for(let x=0;x<40;x++) for(let y=0;y<40;y++) members.push(way(2+x*40+y,'inner',square(x+.1,y+.1,.2)));
  const feature=fullMultipolygon(relation(members));
  assert.equal(feature.geometry.coordinates.length,1601);
  assert.equal(rings(feature).reduce((n,r)=>n+r.length,0),8005);
});
