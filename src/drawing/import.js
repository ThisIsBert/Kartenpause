// Parse completely before changing the drawing: malformed imports are atomic.
export function importGeoJSON(text, project, makeId = () => crypto.randomUUID()) {
  const root = JSON.parse(text.replace(/^\uFEFF/, '')), result = [];
  const point = p => {
    if (!Array.isArray(p) || p.length < 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) >= 90) throw new Error('Ungültige WGS84-Koordinate (Längengrad, Breitengrad).');
    return project(p);
  };
  const points = (coords, closed = false) => {
    if (!Array.isArray(coords)) throw new Error('Koordinaten fehlen.');
    const out = coords.map(point);
    if (closed && out.length > 1 && out[0].every((v, i) => v === out.at(-1)[i])) out.pop();
    if (out.length < (closed ? 3 : 2)) throw new Error('Zu wenige Stützpunkte.');
    return out;
  };
  const part = rings => {
    if (!Array.isArray(rings) || !rings.length) throw new Error('Polygon ohne Außenrand.');
    return { vertices: points(rings[0], true), holes: rings.slice(1).map(r => points(r, true)) };
  };
  const list = (value, label) => {
    if (!Array.isArray(value) || !value.length) throw new Error(`${label} ist leer oder fehlt.`);
    return value;
  };
  function geometry(g) {
    if (!g) throw new Error('Geometrie fehlt.');
    const c = g.coordinates;
    switch (g.type) {
      case 'Point': return { kind: 'point', vertices: [point(c)] };
      case 'MultiPoint': return { kind: 'multiPoint', parts: list(c, 'Punktgruppe').map(p => geometry({ type: 'Point', coordinates: p })) };
      case 'LineString': return { kind: 'line', vertices: points(c) };
      case 'MultiLineString': return { kind: 'multiLine', parts: list(c, 'Liniengruppe').map(p => geometry({ type: 'LineString', coordinates: p })) };
      case 'Polygon': return { kind: 'polygon', ...part(c) };
      case 'MultiPolygon': return { kind: 'multiPolygon', parts: list(c, 'MultiPolygon').map(part) };
      case 'GeometryCollection': return { kind: 'collection', parts: list(g.geometries, 'Geometriesammlung').map(geometry) };
      default: throw new Error(`Unbekannter Geometrietyp: ${g.type}`);
    }
  }
  function add(g, properties = {}, sourceId) {
    const extra = structuredClone(properties);
    for (const key of ['drawingTool', 'controlPoints', 'holeControlPoints', 'partControlPoints', 'interpolation', 'samplesPerSegment']) delete extra[key];
    if (sourceId !== undefined && extra.sourceId === undefined) extra.sourceId = sourceId;
    result.push({ ...geometry(g), id: makeId(), name: String(properties.name || properties.tags?.name || `Import ${result.length + 1}`), properties: extra });
  }
  function read(value) {
    if (!value || typeof value !== 'object') throw new Error('Kein GeoJSON-Objekt.');
    if (value.crs && !JSON.stringify(value.crs).match(/CRS84|4326/)) throw new Error('Bitte GeoJSON in WGS84 (EPSG:4326) verwenden.');
    if (value.type === 'FeatureCollection') {
      if (!Array.isArray(value.features)) throw new Error('Feature-Liste fehlt.');
      value.features.forEach(read);
    } else if (value.type === 'Feature') add(value.geometry, value.properties || {}, value.id);
    else add(value);
  }
  read(root);
  if (!result.length) throw new Error('Keine importierbaren Objekte enthalten.');
  return result;
}
