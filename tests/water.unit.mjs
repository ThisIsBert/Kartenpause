import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import { toFeature, polygonParts } from '../src/drawing/geometry.js';
import { waterTilePlan, decodeWaterTile, loadWaterPolygons, WORLD_SIZE } from '../src/drawing/water-data.js';
import { subtractWater } from '../src/drawing/water-geometry.js';

const ring = (x, y, w, h = w) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]];
const object = (x, y, w, h = w) => ({ kind: 'polygon', id: 'original', name: 'Coast', properties: { custom: 42 }, vertices: ring(x,y,w,h).slice(0,-1) });
const area = value => value ? new GeoJSONReader().read(toFeature(value, p => p).geometry).getArea() : 0;

// Minimal MVT with an ocean, a lake and a tunnel polygon. Independent of the
// decoder and of external services; exercises the actual protobuf wire format.
export function waterFixture() {
  const tile = new PbfWriter();
  tile.writeMessage(3, (_, layer) => {
    layer.writeStringField(1, 'water');
    for (let i = 0; i < 3; i++) layer.writeMessage(2, (_, feature) => {
      feature.writePackedVarint(2, i === 2 ? [0,1,1,2] : [0,i]);
      feature.writeVarintField(3, 3);
      // Rectangle 0,0 -> 2048,0 -> 2048,4096 -> 0,4096 -> close.
      feature.writePackedVarint(4, [9,0,0,26,4096,0,0,8192,4095,0,15]);
    });
    layer.writeStringField(3, 'class'); layer.writeStringField(3, 'brunnel');
    for (const value of ['ocean','lake','tunnel']) layer.writeMessage(4, (_, p) => p.writeStringField(1, value));
    layer.writeVarintField(5, 4096); layer.writeVarintField(15, 2);
  });
  return tile.finish();
}

test('resolution follows object size, is bounded, and covers every part', () => {
  const small = waterTilePlan(object(10000,10000,1000));
  const large = waterTilePlan(object(10000,10000,1000000));
  assert.ok(small.z > large.z);
  assert.ok(small.resolution < large.resolution);
  for (const width of [1, 1000, 100000, 1000000, WORLD_SIZE]) {
    const plan = waterTilePlan(object(-width/2,-width/2,width));
    assert.ok(plan.tiles.length <= 64); assert.ok(plan.z >= 0 && plan.z <= 14);
  }
  const multi = {kind:'multiPolygon', parts:[object(0,0,1000),object(1000000,1000000,1000)]};
  assert.deepEqual(waterTilePlan(multi).bounds, [0,0,1001000,1001000]);
  const wrapped = waterTilePlan(object(WORLD_SIZE/2-1000,0,2000));
  assert.ok(wrapped.tiles.some(tile => tile.x === 0 && tile.worldX > 0));
  assert.throws(() => waterTilePlan({kind:'line',vertices:[[0,0],[1,1]]}));
  assert.throws(() => waterTilePlan(object(0,WORLD_SIZE,1000)));
});

test('MVT decoding selects sea or all water, excludes tunnels and projects the tile grid', () => {
  const tile = {x:0,worldX:0,y:0,z:0};
  const ocean = decodeWaterTile(waterFixture(), tile, 'ocean');
  assert.equal(ocean.length, 1);
  assert.equal(decodeWaterTile(waterFixture(), tile, 'all').length, 2);
  assert.deepEqual(ocean[0][0][0], [-WORLD_SIZE/2,WORLD_SIZE/2]);
  assert.deepEqual(ocean[0][0][1], [0,WORLD_SIZE/2]);
  const wrapped = decodeWaterTile(waterFixture(), {...tile,worldX:1}, 'ocean');
  assert.deepEqual(wrapped[0][0][0], [WORLD_SIZE/2,WORLD_SIZE/2]);
});

test('subtraction preserves islands, existing holes, identity and metadata without mutating the source', () => {
  const source = object(0,0,100); source.holes = [ring(5,5,5).slice(0,-1)];
  const before = structuredClone(source);
  const { result, changed } = subtractWater(source, [[ring(40,-10,80,120),ring(60,40,10).reverse()]]);
  assert.ok(changed); assert.equal(result.kind,'multiPolygon');
  assert.equal(area(result), 4075);
  assert.equal(polygonParts(result).length, 2);
  assert.equal(result.id,source.id); assert.equal(result.name,source.name);
  assert.deepEqual(result.properties,source.properties); assert.deepEqual(source,before);
});

test('overlapping tile buffers form one cut and lakes create holes', () => {
  const source = object(0,0,100);
  const coast = subtractWater(source, [[ring(50,-10,60,70)],[ring(50,40,60,70)]]).result;
  assert.equal(area(coast), 5000); assert.equal(coast.kind,'polygon');
  const lake = subtractWater(source, [[ring(20,20,10)]]).result;
  assert.equal(area(lake), 9900); assert.equal(lake.holes.length, 1);
});

test('dry, empty and invalid masks never silently alter the object', () => {
  const source = object(0,0,100);
  assert.deepEqual(subtractWater(source, []).result, source);
  assert.deepEqual(subtractWater(source, [[ring(100,0,100)]]), {result:source,changed:false});
  assert.equal(subtractWater(source, [[ring(-10,-10,120)]]).result, null);
  assert.throws(() => subtractWater(source, [[[[0,0],[100,100],[0,100],[100,0],[0,0]]]]), /ungültigen Rand/);
});

test('loading resolves tile URLs, reports progress and fails on incomplete data', async () => {
  const source = object(0,0,1000000), calls = [], progress = [];
  const fetcher = async url => {
    calls.push(url);
    if (calls.length === 1) return {ok:true,json:async()=>({maxzoom:14,tiles:['https://example.test/{z}/{x}/{y}.pbf']})};
    return {ok:true,arrayBuffer:async()=>waterFixture()};
  };
  const loaded = await loadWaterPolygons(source, 'ocean', {fetcher,onProgress:p=>progress.push(p)});
  assert.equal(calls.length, loaded.plan.tiles.length+1);
  assert.ok(calls.slice(1).every(url => /\/\d+\/\d+\/\d+\.pbf$/.test(url)));
  assert.equal(progress.at(-1).finished,loaded.plan.tiles.length);
  assert.ok(loaded.polygons.length);
  await assert.rejects(loadWaterPolygons(source,'all',{fetcher:async()=>({ok:false,status:503})}), /503/);
  await assert.rejects(loadWaterPolygons(source,'all',{fetcher:async()=>({ok:true,json:async()=>({maxzoom:14,tiles:[]})})}), /gültigen/);
  let requests = 0;
  await assert.rejects(loadWaterPolygons(source, 'all', { fetcher: async () => ++requests === 1
    ? {ok:true,json:async()=>({maxzoom:14,tiles:['https://example.test/{z}/{x}/{y}.pbf']})}
    : {ok:false,status:404} }), /404/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadWaterPolygons(source,'all',{signal:controller.signal,fetcher}), {name:'AbortError'});
});
