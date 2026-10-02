import { isClosed, ringEntries } from './geometry.js';
import { linearObject, nearestEdge, selectedArc, shorterArcIsOther } from './rework-geometry.js';

export function polygonHit(objects, point, screen, limit = 16) {
  let best = null;
  for (const [index, original] of objects.entries()) {

    const object = linearObject(original), hit = nearestEdge(object, point, screen);
    if (hit && hit.distance <= limit && (!best || hit.distance < best.hit.distance)) best = { object, hit, index };
  }
  return best;
}

export function polygonPath(object, start, end) {
  if (start.ringIndex !== end.ringIndex) throw new Error('Bitte auf demselben Polygonrand bleiben.');
  if (Math.hypot(...start.point.map((v, i) => v - end.point[i])) < 1e-8) throw new Error('Bitte einen anderen Randpunkt wählen.');
  return selectedArc(object, start, end, shorterArcIsOther(object, start, end)).map(p => [...p]);
}

// Follow connected edges, including reversed members of a MultiLineString.
// Shared coordinates are junctions; gaps are never silently bridged.
export function edgePath(objects, start, end, screen, limit = 16) {
  const locate = point => {
    const found = polygonHit(objects, screen(point), screen, limit);
    if (!found) return null;
    // Screen coordinates select a nearby source only. Compute the position in
    // the stored plane, preserving an already-snapped anchor exactly. Rounding
    // an anchor to display pixels here used to create artificial backtracking.
    const hit = nearestEdge(found.object, point, p => p, found.hit.ringIndex);
    const epsilon = 64 * Number.EPSILON * Math.max(1, ...point.map(Math.abs));
    if (hit.distance <= epsilon) hit.point = point;
    return { ...found, hit };
  };
  const a = locate(start), b = locate(end);
  if (!a || !b) return [start, end];
  const graph = new Map(), key = p => JSON.stringify(p);
  const node = p => {
    const k = key(p);
    if (!graph.has(k)) graph.set(k, { point: p, edges: [] });
    return k;
  };
  const connect = (p, q) => {
    const u = node(p), v = node(q), cost = Math.hypot(p[0] - q[0], p[1] - q[1]);
    graph.get(u).edges.push([v, cost]); graph.get(v).edges.push([u, cost]);
  };
  for (const [objectIndex, original] of objects.entries()) {
    const object = linearObject(original);
    ringEntries(object).forEach(({ vertices, kind }, ringIndex) => {
      const hits = [a, b].filter(hit => hit.index === objectIndex && hit.hit.ringIndex === ringIndex);
      for (let i = 0; i < vertices.length - (isClosed(kind) ? 0 : 1); i++) {
        const cuts = hits.filter(h => h.hit.segmentIndex === i).sort((x, y) => x.hit.at - y.hit.at);
        const points = [vertices[i], ...cuts.map(h => h.hit.point), vertices[(i + 1) % vertices.length]];
        for (let j = 1; j < points.length; j++) connect(points[j - 1], points[j]);
      }
    });
  }
  const from = key(a.hit.point), to = key(b.hit.point), distances = new Map([[from, 0]]), previous = new Map();
  const heap = [];
  const push = item => {
    heap.push(item); let i = heap.length - 1;
    while (i) { const parent = (i - 1) >> 1; if (heap[parent][0] <= item[0]) break; heap[i] = heap[parent]; i = parent; }
    heap[i] = item;
  };
  const pop = () => {
    const first = heap[0], last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child++;
        if (heap[child][0] >= last[0]) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  push([0, from]);
  while (heap.length) {
    const [distance, current] = pop();
    if (distance !== distances.get(current)) continue;
    if (current === to) {
      const path = []; let k = to;
      while (k !== undefined) { path.push(graph.get(k).point); k = previous.get(k); }
      return [start, ...path.reverse(), end].filter((p, i, all) => !i || key(p) !== key(all[i - 1]));
    }
    for (const [next, cost] of graph.get(current)?.edges || []) {
      const d = distance + cost;
      if (d < (distances.get(next) ?? Infinity)) { distances.set(next, d); previous.set(next, current); push([d, next]); }
    }
  }
  return [start, end];
}
