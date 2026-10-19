import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import { combinePolygons } from './polygon-operation.js';
import { t } from '../i18n.js';

export function subtractWater(object, polygons) {
  if (!polygons.length) return { result: structuredClone(object), changed: false };
  const reader = new GeoJSONReader(), writer = new GeoJSONWriter();
  // Tile buffers overlap. Union them before subtracting, preserving islands
  // (holes in the water mask) and avoiding artificial tile-edge boundaries.
  const geometries = polygons.map(coordinates => {
    const geometry = reader.read({ type: 'Polygon', coordinates });
    if (!new IsValidOp(geometry).isValid()) throw new Error(t('Die Wasserdaten enthalten einen ungültigen Rand.'));
    return geometry;
  });
  const mask = UnaryUnionOp.union(geometries[0].getFactory().createGeometryCollection(geometries));
  if (mask.isEmpty()) return { result: structuredClone(object), changed: false };
  const geojson = writer.write(mask);
  const parts = (geojson.type === 'Polygon' ? [geojson.coordinates] : geojson.coordinates).map(rings => ({
    kind: 'polygon', vertices: rings[0].slice(0, -1), holes: rings.slice(1).map(ring => ring.slice(0, -1))
  }));
  const cutter = parts.length === 1 ? parts[0] : { kind: 'multiPolygon', parts };
  // Check actual overlap so land-only objects keep their original vertices.
  if (!combinePolygons(object, cutter, 'intersection')) return { result: structuredClone(object), changed: false };
  const result = combinePolygons(object, cutter, 'difference');
  return { result: result ? { ...result, id: object.id, name: object.name, properties: structuredClone(object.properties) } : null, changed: true };
}
