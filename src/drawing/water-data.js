import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { isClosed, objectRings } from './geometry.js';
import { linearObject } from './rework-geometry.js';
import { t, tr } from '../i18n.js';

export const WATER_SOURCE = 'https://tiles.openfreemap.org/planet';
export const WORLD_SIZE = 2 * Math.PI * 6378137;

// About 2–4 tiles (1024–2048 display pixels) along the longest dimension.
// This depends only on the object's extent, never on the current map view.
export function waterTilePlan(object, { minzoom = 0, maxzoom = 14 } = {}) {
  if (!object || !isClosed(object.kind)) throw new Error(t('Bitte eine Fläche auswählen.'));
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of objectRings(linearObject(object))) for (const [x, y] of ring) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(t('Ungültige Koordinate'));
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
  }
  const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]);
  if (!(span > 0) || bounds.some(v => !Number.isFinite(v)) || bounds[1] < -WORLD_SIZE / 2 || bounds[3] > WORLD_SIZE / 2 || span > WORLD_SIZE) {
    throw new Error(t('Die Fläche liegt außerhalb des unterstützten Kartenbereichs.'));
  }
  const z = Math.max(minzoom, Math.min(maxzoom, Math.floor(Math.log2(4 * WORLD_SIZE / span))));
  const count = 2 ** z, size = WORLD_SIZE / count;
  const x0 = Math.floor((bounds[0] + WORLD_SIZE / 2) / size);
  const x1 = Math.floor((bounds[2] + WORLD_SIZE / 2) / size);
  const y0 = Math.max(0, Math.floor((WORLD_SIZE / 2 - bounds[3]) / size));
  const y1 = Math.min(count - 1, Math.floor((WORLD_SIZE / 2 - bounds[1]) / size));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) throw new Error(t('Für diese Fläche werden zu viele Wasserkacheln benötigt.'));
  const tiles = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    tiles.push({ z, x: ((x % count) + count) % count, y, worldX: x });
  }
  const latitudeScale = 1 / Math.cosh((bounds[1] + bounds[3]) / 2 / 6378137);
  return { z, tiles, bounds, resolution: size / 512 * latitudeScale };
}

export function decodeWaterTile(buffer, tile, mode = 'ocean') {
  const layer = new VectorTile(new PbfReader(new Uint8Array(buffer))).layers.water;
  const polygons = [];
  if (!layer) return polygons;
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 3 || feature.properties.brunnel === 'tunnel' || (mode === 'ocean' && feature.properties.class !== 'ocean')) continue;
    // Global tile-grid arithmetic gives identical coordinates at shared seams,
    // including buffered features and repeated worlds at the date line.
    const scale = WORLD_SIZE / (2 ** tile.z * feature.extent);
    const convert = p => [(tile.worldX * feature.extent + p.x) * scale - WORLD_SIZE / 2,
      WORLD_SIZE / 2 - (tile.y * feature.extent + p.y) * scale];
    for (const rings of classifyRings(feature.loadGeometry())) polygons.push(rings.map(ring => ring.map(convert)));
  }
  return polygons;
}

export async function loadWaterPolygons(object, mode, { signal, onProgress = () => {}, fetcher = fetch } = {}) {
  signal?.throwIfAborted();
  if (!['ocean', 'all'].includes(mode)) throw new Error(t('Unbekannte Wasserauswahl.'));
  const request = async (url, json = false) => {
    const response = await fetcher(url, { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30000)]) });
    if (!response.ok) throw new Error(tr`Wasserdaten konnten nicht geladen werden (HTTP ${response.status}).`);
    return json ? response.json() : response.arrayBuffer();
  };
  const metadata = await request(WATER_SOURCE, true);
  if (!metadata.tiles?.length || !Number.isInteger(metadata.maxzoom) || metadata.maxzoom < 0 || metadata.maxzoom > 24 ||
    (metadata.minzoom !== undefined && (!Number.isInteger(metadata.minzoom) || metadata.minzoom < 0 || metadata.minzoom > metadata.maxzoom))) {
    throw new Error(t('Die Quelle liefert keine gültigen Wasserkacheln.'));
  }
  const plan = waterTilePlan(object, { minzoom: metadata.minzoom ?? 0, maxzoom: Math.min(14, metadata.maxzoom) });
  const polygons = [], template = new URL(metadata.tiles[0], WATER_SOURCE).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  let next = 0, finished = 0, vertices = 0;
  onProgress({ finished, total: plan.tiles.length, resolution: plan.resolution });
  await Promise.all(Array.from({ length: Math.min(4, plan.tiles.length) }, async () => {
    while (next < plan.tiles.length) {
      signal?.throwIfAborted();
      const tile = plan.tiles[next++];
      const y = metadata.scheme === 'tms' ? 2 ** tile.z - 1 - tile.y : tile.y;
      const url = template.replace(/\{z\}|\{x\}|\{y\}/g, key => ({ '{z}': tile.z, '{x}': tile.x, '{y}': y })[key]);
      const decoded = decodeWaterTile(await request(url), tile, mode);
      for (const polygon of decoded) {
        vertices += polygon.reduce((sum, ring) => sum + ring.length, 0);
        if (vertices > 500000) throw new Error(t('Die Wasserdaten sind zu umfangreich. Bitte die Fläche in kleinere Objekte aufteilen.'));
        polygons.push(polygon);
      }
      onProgress({ finished: ++finished, total: plan.tiles.length, resolution: plan.resolution });
    }
  }));
  return { polygons, plan };
}
