import { t } from '../i18n.js';
import { isClosed, minimumPoints, toFeature } from './geometry.js';

// Curve definitions are optional GeoJSON extension data. Never let stale or
// malformed metadata override the actual geometry supplied by another editor.
export function restoreCurves(geo,properties,project) {
  const point=p=>{if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||Math.abs(p[0])>180||Math.abs(p[1])>=90)throw new Error(t('Ungültiger Kurvenpunkt.'));return project(p);};
  const decode=data=>{
    if(!data || !['polygon','curvePolygon','line','curve','point','multiPolygon','multiLine','multiPoint','collection'].includes(data.kind))throw new Error(t('Ungültige Kurvenform.'));
    if(data.parts){if(!Array.isArray(data.parts)||!data.parts.length)throw new Error(t('Leere Kurvenform.'));const parts=data.parts.map(decode);if(data.kind==='multiPolygon'&&parts.some(p=>!['polygon','curvePolygon'].includes(p.kind)))throw new Error(t('Ungültige Teilfläche.'));return {kind:data.kind,parts};}
    const vertices=data.vertices.map(point); if(vertices.length<minimumPoints(data.kind))throw new Error(t('Zu wenige Kurvenpunkte.'));
    const controls=(values,ring)=>{
      if(!values)return undefined;
      if(!Array.isArray(values)||values.length!==ring.length-(isClosed(data.kind)?0:1))throw new Error(t('Ungültige Kurvensegmente.'));
      return values.map((c,i)=>{if(c===null)return null;if(!Array.isArray(c)||c.length!==2)throw new Error(t('Ungültiges Kurvensegment.'));return c.map((p,j)=>point(p).map((v,k)=>v-ring[(i+j)%ring.length][k]));});
    };
    const holes=data.holes?.map(r=>{if(!Array.isArray(r)||r.length<3)throw new Error(t('Ungültiges Loch.'));return r.map(point);});
    const curveSegments=controls(data.curveSegments,vertices);
    const holeCurveSegments=data.holeCurveSegments?.map((values,i)=>{if(!holes?.[i])throw new Error(t('Kurvenloch fehlt.'));return controls(values,holes[i])||null;});
    return {kind:data.kind,vertices,...(holes?{holes}:{}),...(curveSegments?{curveSegments}:{}),...(holeCurveSegments?{holeCurveSegments}:{} )};
  };
  const close=(a,b)=>a.every((v,k)=>Math.abs(v-b[k])<=Math.max(1e-7,Math.abs(v)*1e-10,Math.abs(b[k])*1e-10));
  const ring=(a,b)=>{if(a.length!==b.length)return false;const n=a.length-1;let start=b.slice(0,n).findIndex(p=>close(a[0],p));if(start<0)return false;return [1,-1].some(direction=>a.slice(0,n).every((p,i)=>close(p,b[(start+direction*i+n)%n])));};
  const same=(a,b)=>{
    if(a.type!==b.type)return false;
    if(a.type==='Polygon')return a.coordinates.length===b.coordinates.length&&a.coordinates.every((r,i)=>ring(r,b.coordinates[i]));
    if(a.type==='MultiPolygon')return a.coordinates.length===b.coordinates.length&&a.coordinates.every((c,i)=>same({type:'Polygon',coordinates:c},{type:'Polygon',coordinates:b.coordinates[i]}));
    if(a.type==='GeometryCollection')return a.geometries.length===b.geometries.length&&a.geometries.every((g,i)=>same(g,b.geometries[i]));
    const points=(a,b)=>a.length===b.length&&a.every((p,i)=>Array.isArray(p[0])?points(p,b[i]):close(p,b[i]));
    return a.type==='Point'?close(a.coordinates,b.coordinates):points(a.coordinates,b.coordinates);
  };
  try {
    let definition=properties.curveDefinition?.version===1?properties.curveDefinition.geometry:null;
    if(!definition && properties.interpolation==='catmull-rom' && ['curve','curvePolygon'].includes(properties.drawingTool))
      definition={kind:properties.drawingTool,vertices:properties.controlPoints,holes:properties.holeControlPoints};
    if(!definition)return null;
    const restored=decode(definition);
    const projectGeo=g=>{
      if(g.type==='GeometryCollection')return {type:g.type,geometries:g.geometries.map(projectGeo)};
      const depth={Point:0,MultiPoint:1,LineString:1,MultiLineString:2,Polygon:2,MultiPolygon:3}[g.type];
      if(depth===undefined)throw new Error(t('Unbekannte Geometrie.'));
      const coordinates=(value,n)=>n?value.map(v=>coordinates(v,n-1)):point(value);
      return {type:g.type,coordinates:coordinates(g.coordinates,depth)};
    };
    if(!same(toFeature(restored,p=>p).geometry,projectGeo(geo)))return null;
    return restored;
  } catch {return null;}
}
