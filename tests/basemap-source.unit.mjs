import test from 'node:test';
import assert from 'node:assert/strict';
import { createBasemapRaster, createBasemapCoordinates } from '../src/drawing/basemap-source.js';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { createReferenceStyle, referenceColors } from '../src/maps/reference-style.js';
import { selectColor } from '../src/drawing/selection.js';

test('reference styles validate against the renderer specification in both languages', () => {
  for (const language of ['de', 'en']) {
    const errors = validateStyleMin(createReferenceStyle(language));
    assert.deepEqual(errors.map(e => e.message), []);
  }
});

test('water and land remain separate at the default wand tolerance', () => {
  const rgba = hex => [...hex.match(/\w\w/g).map(v => parseInt(v, 16)), 255];
  const raster = { width: 2, height: 1, data: new Uint8ClampedArray([...rgba(referenceColors.water), ...rgba(referenceColors.land)]) };
  assert.deepEqual([...selectColor(raster, [0, 0], 18, false)], [1, 0]);
  assert.deepEqual([...selectColor(raster, [1, 0], 18, false)], [0, 1]);
});

function fixture(t) {
  const calls = [];
  const ctx = { drawImage: (...args) => calls.push(args), getImageData: () => ({ width: 100, height: 80 }) };
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ctx }) };
  t.after(() => { globalThis.document = previous; });
  let zoom = 2, origin = { x: 530, y: 280 };
  const map = {
    getZoom: () => zoom, getSize: () => ({ x: 100, y: 80 }),
    containerPointToLatLng: () => ({ lng: origin.x / 2 ** zoom, lat: origin.y / 2 ** zoom }),
    project: (ll, z) => ({ x: ll.lng * 2 ** z, y: ll.lat * 2 ** z }),
    unproject: (p, z) => ({ lng: p[0] / 2 ** z, lat: p[1] / 2 ** z })
  };
  const image = { complete: true, naturalWidth: 256 };
  const layer = { isLoading: () => false, _tileZoom: 2, getTileSize: () => ({ x: 256, y: 256 }),
    _tiles: { current: { coords: { x: 2, y: 1, z: 2 }, el: image },
      oldZoom: { coords: { x: 2, y: 1, z: 1 }, el: image },
      offscreen: { coords: { x: 4, y: 1, z: 2 }, el: image } } };
  return { map, layer, ctx, calls, move: (z = 6, x = 20, y = 30) => { zoom = z; origin = { x, y }; layer._tileZoom = z; } };
}
test('basemap snapshot uses visible current-zoom tiles and retains geographic coordinates after pan/zoom', t => {
  const f = fixture(t), source = createBasemapRaster(f.map, f.layer);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].slice(1), [-18, -24, 256, 256]);
  const ll = source.pixelToLatLng([25, 30]);
  assert.deepEqual(ll, { lng: 555.5 / 4, lat: 310.5 / 4 });
  assert.deepEqual(source.latLngToPixel(ll), [25, 30]);
  f.move();
  assert.deepEqual(source.latLngToPixel(ll), [25, 30]);
  assert.deepEqual(source.pixelToLatLng([25, 30]), ll);
  assert.equal(source.latLngToPixel(source.pixelToLatLng([-1, 30])), null);
  assert.deepEqual(source.latLngToPixel(source.pixelToLatLng([-.25, 30]), .5), [0, 30]);
});
test('basemap source reports pending, missing, failed, and unreadable tiles', t => {
  const f = fixture(t);
  f.layer.isLoading = () => true;
  assert.throws(() => createBasemapRaster(f.map, f.layer), /lädt noch/);
  f.layer.isLoading = () => false;
  f.layer._tiles.current.el.naturalWidth = 0;
  assert.throws(() => createBasemapRaster(f.map, f.layer), /fehlen Kartenkacheln/);
  f.layer._tiles.current.el.naturalWidth = 256;
  f.ctx.getImageData = () => { throw new Error('SecurityError'); };
  assert.throws(() => createBasemapRaster(f.map, f.layer), /keinen Pixelzugriff/);
  delete f.layer._tiles.current;
  assert.throws(() => createBasemapRaster(f.map, f.layer), /keine Basiskartenkacheln/);
});

test('vector basemap snapshots scale device pixels and reject incomplete or stale frames', t => {
  const f = fixture(t);
  const frame = { width: 200, height: 160, clientWidth: 100, clientHeight: 80 };
  const gl = { loaded: () => true, getZoom: () => 1, getCanvas: () => frame, project: () => ({ x: 0, y: 0 }) };
  const layer = { getMaplibreMap: () => gl, options: { isBasemap: true } };
  const source = createBasemapRaster(f.map, layer);
  assert.deepEqual(f.calls[0], [frame, 0, 0, 100, 80]);
  const anchor = source.pixelToLatLng([25, 30]);
  layer._basemapFailed = true;
  assert.throws(() => createBasemapRaster(f.map, layer), /fehlen Kartenkacheln/);
  layer._basemapFailed = false;
  f.move();
  assert.deepEqual(source.latLngToPixel(anchor), [25, 30]);
  assert.throws(() => createBasemapRaster(f.map, layer), /lädt noch/);
  f.move(2, 530, 280);
  gl.loaded = () => false;
  assert.throws(() => createBasemapRaster(f.map, layer), /lädt noch/);
  gl.loaded = () => true;
  gl.project = () => ({ x: 20, y: 0 });
  assert.throws(() => createBasemapRaster(f.map, layer), /lädt noch/);
  gl.project = () => ({ x: 0, y: 0 });
  frame.clientWidth = 200;
  assert.throws(() => createBasemapRaster(f.map, layer), /lädt noch/);
  assert.throws(() => createBasemapRaster(f.map, { ...layer, getMaplibreMap: () => null }), /lädt noch/);
});

test('drawing coordinates accept newly exposed areas and preserve old points across new snapshots', t => {
  const f = fixture(t), first = createBasemapRaster(f.map, f.layer);
  const drawing = createBasemapCoordinates(first), anchor = [25, 30];
  const ll = drawing.pixelToLatLng(anchor);
  f.move(2, 580, 280);
  const panned = createBasemapRaster(f.map, f.layer);
  const newPoint = panned.pixelToLatLng([80, 30]);
  assert.equal(first.latLngToPixel(newPoint), null);
  assert.deepEqual(drawing.latLngToPixel(newPoint), [130, 30]);
  assert.deepEqual(drawing.pixelToLatLng(drawing.latLngToPixel(newPoint)), newPoint);
  assert.deepEqual(drawing.pixelToLatLng(anchor), ll);
  f.move(1, 270, 128);
  f.layer._tiles = { zoomed: { coords: { x: 1, y: 0, z: 1 }, el: { complete: true, naturalWidth: 256 } } };
  const zoomed = createBasemapRaster(f.map, f.layer);
  const inNewRaster = zoomed.latLngToPixel(newPoint);
  assert.ok(inNewRaster);
  assert.deepEqual(drawing.latLngToPixel(zoomed.pixelToLatLng(inNewRaster)), [130, 30]);
  assert.deepEqual(drawing.pixelToLatLng(anchor), ll);
});
