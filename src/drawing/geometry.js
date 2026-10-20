// Coordinates are stored in Leaflet's projected plane. Curves therefore retain
// their shape at every zoom level; GeoJSON is always exported in WGS84 lon/lat.
export const isClosed = kind => kind === 'polygon' || kind === 'curvePolygon' || kind === 'multiPolygon';
export const isCurved = kind => kind === 'curve' || kind === 'curvePolygon';
export const minimumPoints = kind => kind === 'point' ? 1 : isClosed(kind) ? 3 : 2;
export const polygonParts = object => object.kind === 'multiPolygon' ? object.parts : [object];
export const geometryLeaves = object => object.parts
  ? object.parts.flatMap(part => geometryLeaves(part.kind ? part : { ...part, kind: object.kind === 'multiPolygon' ? 'polygon' : object.kind === 'multiPoint' ? 'point' : 'line' }))
  : [object];
export const ringEntries = object => geometryLeaves(object).flatMap((part, partIndex) => [part.vertices, ...(part.holes || [])].map((vertices, holeIndex) => ({ vertices, kind: holeIndex ? 'polygon' : part.kind, partIndex, holeIndex, owner: part, shape: holeIndex ? {
  kind: 'polygon', vertices,
  get curveSegments() { return part.holeCurveSegments?.[holeIndex - 1]; },
  set curveSegments(value) { (part.holeCurveSegments ??= part.holes.map(() => null))[holeIndex - 1] = value; }
} : part })));
export const objectRings = object => ringEntries(object).map(entry => entry.vertices);

export function segmentPoint(vertices, index, t, curved, closed) {
  const n = vertices.length;
  const at = i => vertices[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  const a = at(index), b = at(index + 1);
  if (!curved || n < 3) return a.map((v, axis) => v + (b[axis] - v) * t);
  const before = at(index - 1), after = at(index + 2);
  // Uniform Catmull–Rom: the curve passes through every editable vertex.
  return a.map((v, axis) => .5 * (2 * v + (-before[axis] + b[axis]) * t
    + (2 * before[axis] - 5 * v + 4 * b[axis] - after[axis]) * t * t
    + (-before[axis] + 3 * v - 3 * b[axis] + after[axis]) * t * t * t));
}


// Bézier controls are offsets from the two endpoints. Moving an endpoint
// therefore also moves its attached control, without introducing extra vertices.
export function edgeControls(object, index) {
  const { vertices, kind, curveSegments } = object, n = vertices.length;
  const a = vertices[index], b = vertices[(index + 1) % n], explicit = curveSegments?.[index];
  if (curveSegments) return explicit ? [a.map((v,k) => v + explicit[0][k]), b.map((v,k) => v + explicit[1][k])] : null;
  if (!isCurved(kind) || n < 2) return null;
  const at = i => vertices[isClosed(kind) ? (i + n) % n : Math.max(0,Math.min(n-1,i))];
  const before=at(index-1), after=at(index+2);
  return [a.map((v,k)=>v+(b[k]-before[k])/6), b.map((v,k)=>v-(after[k]-a[k])/6)];
}
export function edgePoint(object,index,t) {
  const a=object.vertices[index], b=object.vertices[(index+1)%object.vertices.length], c=edgeControls(object,index);
  return a.map((v,k)=>c ? (1-t)**3*v+3*(1-t)**2*t*c[0][k]+3*(1-t)*t*t*c[1][k]+t**3*b[k] : v+(b[k]-v)*t);
}
export const hasCurves = object => geometryLeaves(object).some(part => isCurved(part.kind) || part.curveSegments?.some(Boolean) || part.holeCurveSegments?.some(segments=>segments?.some(Boolean)));
export const sampledRings = object => [sampledPoints(object), ...(object.holes || []).map((vertices,i)=>sampledPoints({ kind:'polygon', vertices, curveSegments:object.holeCurveSegments?.[i] }))];

export function splitEdge(shape,index,t=.5) {
  if(isCurved(shape.kind) && !shape.curveSegments) shape.curveSegments=shape.vertices.slice(0,shape.vertices.length-(isClosed(shape.kind)?0:1)).map((a,i)=>{
    const b=shape.vertices[(i+1)%shape.vertices.length],c=edgeControls(shape,i);
    return c?[c[0].map((v,k)=>v-a[k]),c[1].map((v,k)=>v-b[k])]:null;
  });
  const c=edgeControls(shape,index), a=shape.vertices[index], b=shape.vertices[(index+1)%shape.vertices.length];
  const mix=(p,q)=>p.map((v,k)=>v+(q[k]-v)*t);
  const point=edgePoint(shape,index,t);
  if (shape.curveSegments) {
    let segments=[null,null];
    if (c) { const p=mix(a,c[0]), q=mix(c[0],c[1]), r=mix(c[1],b), s=mix(p,q), u=mix(q,r);
      const offset=(p,q)=>p.map((v,k)=>v-q[k]);
      segments=[[offset(p,a),offset(s,point)],[offset(u,point),offset(r,b)]];
    }
    shape.curveSegments.splice(index,1,...segments);
  }
  shape.vertices.splice(index+1,0,point); return point;
}
export function removeVertex(shape,index) {
  if (shape.curveSegments && !isClosed(shape.kind) && (index === 0 || index === shape.vertices.length - 1)) {
    shape.curveSegments.splice(index === 0 ? 0 : index - 1, 1);
    shape.vertices.splice(index, 1); return;
  }
  if (shape.curveSegments) {
    const n=shape.vertices.length, prev=(index+n-1)%n, next=(index+1)%n;
    const a=edgeControls(shape,prev), b=edgeControls(shape,index);
    const offset=(p,q)=>p.map((v,k)=>v-q[k]);
    shape.curveSegments[prev]=a || b ? [a?offset(a[0],shape.vertices[prev]):[0,0], b?offset(b[1],shape.vertices[next]):[0,0]] : null;
    shape.curveSegments.splice(index,1);
  }
  shape.vertices.splice(index,1);
}

export function sampledPoints(object) {
  const { vertices, kind } = object;
  if (kind === 'point' || vertices.length < 2) return vertices;
  const closed = isClosed(kind), result = [];
  const segments = vertices.length - (closed ? 0 : 1);
  for (let i = 0; i < segments; i++) {
    const steps = edgeControls(object,i) ? 32 : 1;
    for (let step = 0; step < steps; step++) result.push(edgePoint(object, i, step / steps));
  }
  result.push(closed ? [...result[0]] : [...vertices.at(-1)]);
  return result;
}


function encodeCurveGeometry(object,toLonLat) {
  if(object.parts)return {kind:object.kind,parts:object.parts.map(part=>encodeCurveGeometry({...part,kind:part.kind || (object.kind==='multiPolygon'?'polygon':object.kind==='multiPoint'?'point':'line')},toLonLat))};
  const controls=(vertices,segments)=>segments?.map((c,i)=>c?c.map((offset,j)=>toLonLat(offset.map((v,k)=>v+vertices[(i+j)%vertices.length][k]))):null);
  return {kind:object.kind,vertices:object.vertices.map(toLonLat),...(object.holes?{holes:object.holes.map(r=>r.map(toLonLat))}:{}),
    ...(object.curveSegments?{curveSegments:controls(object.vertices,object.curveSegments)}:{}),
    ...(object.holeCurveSegments?{holeCurveSegments:object.holeCurveSegments.map((segments,i)=>controls(object.holes[i],segments)||null)}:{})};
}
const curveProperties=(object,toLonLat)=>hasCurves(object)?{curveDefinition:{version:1,geometry:encodeCurveGeometry(object,toLonLat)}}:{};

export function toFeature(object, toLonLat) {
  if (['multiLine', 'multiPoint', 'collection'].includes(object.kind)) {
    const geometries = object.parts.map(part => toFeature(part, toLonLat).geometry);
    const geometry = object.kind === 'collection' ? { type: 'GeometryCollection', geometries }
      : { type: object.kind === 'multiLine' ? 'MultiLineString' : 'MultiPoint', coordinates: geometries.map(g => g.coordinates) };
    return { type: 'Feature', id: object.id, properties: { ...object.properties, ...curveProperties(object,toLonLat), name: object.name }, geometry };
  }
  if (object.kind === 'multiPolygon') {
    const parts = object.parts.map(part => toFeature({ ...part, kind: part.kind || 'polygon' }, toLonLat));
    return { type: 'Feature', id: object.id,
      properties: { ...object.properties, ...curveProperties(object,toLonLat), name: object.name, drawingTool: object.kind,
        partControlPoints: parts.map(part => ({ exterior: part.properties.controlPoints, holes: part.properties.holeControlPoints || [] })) },
      geometry: { type: 'MultiPolygon', coordinates: parts.map(part => part.geometry.coordinates) } };
  }
  let coordinates = sampledPoints(object).map(toLonLat);
  const type = object.kind === 'point' ? 'Point' : isClosed(object.kind) ? 'Polygon' : 'LineString';
  if (type === 'Point') coordinates = coordinates[0];
  if (type === 'Polygon') {
    // RFC 7946 exterior rings use counterclockwise winding.
    const area = coordinates.slice(0, -1).reduce((sum, p, i) => {
      const q = coordinates[i + 1]; return sum + p[0] * q[1] - q[0] * p[1];
    }, 0);
    if (area < 0) coordinates.reverse();
    coordinates = [coordinates, ...(object.holes || []).map((ring, i) => {
      const closed = sampledPoints({ kind: 'polygon', vertices: ring, curveSegments: object.holeCurveSegments?.[i] }).map(toLonLat);
      const area = closed.slice(0, -1).reduce((sum, p, i) => sum + p[0] * closed[i + 1][1] - closed[i + 1][0] * p[1], 0);
      if (area > 0) closed.reverse();
      return closed;
    })];
  }
  return { type: 'Feature', id: object.id, properties: { ...object.properties, ...curveProperties(object,toLonLat), name: object.name,
    drawingTool: object.kind, controlPoints: object.vertices.map(toLonLat),
    ...(object.holes?.length ? { holeControlPoints: object.holes.map(ring => ring.map(toLonLat)) } : {}),
    ...(isCurved(object.kind) ? { interpolation: object.curveSegments ? 'bezier' : 'catmull-rom', samplesPerSegment: 32 } : {})
  }, geometry: { type, coordinates } };
}
