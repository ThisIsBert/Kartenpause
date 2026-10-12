import { t, tr } from '../i18n.js';
// Full-geometry Overpass multipolygons need no synthetic node database.
// Join by endpoints and locate each hole using bounding boxes and one interior
// test, instead of testing every hole vertex against every outer ring.
export function fullMultipolygon(element, progress = () => {}) {
  if (element?.type !== 'relation' || !['multipolygon', 'boundary'].includes(element.tags?.type)) return null;
  const invalid = () => { throw new Error(t('Die Relation enthält unvollständige oder nicht geschlossene Teilflächen. Sie kann nicht übernommen werden.')); };
  const key = point => `${point[0]},${point[1]}`;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const groups = { outer: [], inner: [] }, seen = new Set();
  for (const member of element.members || []) {
    const role = member.role || 'outer';
    if (!['outer', 'inner'].includes(role)) continue;
    if (member.type !== 'way') { invalid(); }
    if (seen.has(`${role}/${member.ref}`)) continue;
    seen.add(`${role}/${member.ref}`);
    if (!Array.isArray(member.geometry) || member.geometry.length < 2) invalid();
    const points = member.geometry.map(p => {
      if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) invalid();
      return [p.lon, p.lat];
    });
    groups[role].push(points);
  }
  function join(parts) {
    const ends = new Map(), used = new Set(), rings = [];
    parts.forEach((part, index) => {
      if (same(part[0], part.at(-1))) { if (part.length < 4) invalid(); rings.push(part); used.add(index); return; }
      for (const point of [part[0], part.at(-1)]) {
        const k = key(point); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(index);
      }
    });
    // Ambiguous touching ways are left to the general-purpose converter.
    if ([...ends.values()].some(indices => indices.length > 2)) return null;
    for (let index = 0; index < parts.length; index++) {
      if (used.has(index)) continue;
      used.add(index); const ring = [...parts[index]];
      while (!same(ring[0], ring.at(-1))) {
        const next = (ends.get(key(ring.at(-1))) || []).find(i => !used.has(i));
        if (next === undefined) invalid();
        used.add(next); const part = parts[next];
        if (same(ring.at(-1), part[0])) for (let i = 1; i < part.length; i++) ring.push(part[i]);
        else for (let i = part.length - 2; i >= 0; i--) ring.push(part[i]);
      }
      if (ring.length < 4) invalid();
      rings.push(ring);
    }
    return rings;
  }
  progress(t('Teilwege werden zu Flächenrändern verbunden'));
  const outers = join(groups.outer), inners = join(groups.inner);
  if (!outers || !inners) return null;
  if (!outers.length) invalid();
  const bounds = ring => {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of ring) { box[0] = Math.min(box[0], p[0]); box[1] = Math.min(box[1], p[1]); box[2] = Math.max(box[2], p[0]); box[3] = Math.max(box[3], p[1]); }
    return box;
  };
  const area = ring => {
    // Translate to the first point to avoid cancellation for very small islands.
    const [x, y] = ring[0]; let sum = 0;
    for (let i = 1; i < ring.length; i++) sum += (ring[i - 1][0] - x) * (ring[i][1] - y) - (ring[i][0] - x) * (ring[i - 1][1] - y);
    return sum;
  };
  // -1 outside, 0 on the boundary, 1 inside. A touching vertex alone does not
  // decide containment; in that case try another vertex of the hole.
  function locate([x, y], polygon) {
    const ring = polygon.rings[0], minY = polygon.bounds[1], spanY = polygon.bounds[3] - minY;
    const count = Math.min(1024, Math.max(1, Math.ceil(Math.sqrt(ring.length))));
    const bucket = latitude => Math.max(0, Math.min(count - 1, Math.floor((latitude - minY) / (spanY || 1) * count)));
    // A horizontal ray only intersects edges spanning its latitude. Index
    // those once per exterior, instead of rescanning a coastline for each island.
    if (!polygon.scan) {
      polygon.scan = Array.from({ length: count }, () => []);
      for (let i = 1; i < ring.length; i++) {
        const from = bucket(Math.min(ring[i - 1][1], ring[i][1]));
        const to = bucket(Math.max(ring[i - 1][1], ring[i][1]));
        for (let b = from; b <= to; b++) polygon.scan[b].push(i);
      }
    }
    let inside = false;
    for (const i of polygon.scan[bucket(y)]) {
      const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
      const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
      if (cross === 0 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return 0;
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    return inside ? 1 : -1;
  }
  const polygons = outers.map(ring => ({ rings: [ring], bounds: bounds(ring), area: Math.abs(area(ring)) }));
  progress(t('Inseln und Löcher werden zugeordnet'));
  for (let index = 0; index < inners.length; index++) {
    const inner = inners[index], box = bounds(inner);
    const candidates = polygons.filter(p => box[0] >= p.bounds[0] && box[1] >= p.bounds[1] && box[2] <= p.bounds[2] && box[3] <= p.bounds[3]).sort((a, b) => a.area - b.area);
    const parent = candidates.find(p => {
      for (const point of inner) { const result = locate(point, p); if (result !== 0) return result === 1; }
      return false;
    });
    if (!parent) invalid();
    parent.rings.push(inner);
    if (index % 100 === 0) progress(tr`Inseln und Löcher werden zugeordnet (${index + 1}/${inners.length})`);
  }
  for (const polygon of polygons) polygon.rings.forEach((ring, index) => { if ((area(ring) > 0) !== (index === 0)) ring.reverse(); });
  return { type: 'Feature', id: `relation/${element.id}`, properties: { type: 'relation', id: element.id, tags: { ...element.tags } },
    geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0].rings } : { type: 'MultiPolygon', coordinates: polygons.map(p => p.rings) } };
}
