import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import { isClosed, toFeature, hasCurves } from './geometry.js';
import { curveReconstructor } from './curve-reconstruction.js';

// Calculate in the same projected plane used to display and edit the objects.
// toFeature samples curved boundaries without changing the source vertices.
export function combinePolygons(first, second, operation) {
  return operatePolygons([first,second],operation);
}

export function operatePolygons(objects, operation) {
  if (!['union','difference','intersection','xor'].includes(operation)) throw new Error('Unbekannte Flächenoperation.');
  if (objects.length<2 || objects.some(object=>!object || !isClosed(object.kind))) throw new Error('Bitte mindestens zwei Flächen auswählen.');
  const reader=new GeoJSONReader(),writer=new GeoJSONWriter();
  const inputs=objects.map(object=>{
    const geometry=reader.read(toFeature(object,p=>p).geometry);
    if(!new IsValidOp(geometry).isValid())throw new Error('Eine ausgewählte Fläche hat einen ungültigen Rand. Bitte zuerst korrigieren.');
    return geometry;
  });
  let geometry=inputs[0];
  if(operation==='difference') {
    const cutters=inputs.slice(1).reduce((a,b)=>OverlayOp.union(a,b));
    geometry=OverlayOp.difference(geometry,cutters);
  } else for(const next of inputs.slice(1)) geometry=operation==='union'?OverlayOp.union(geometry,next):operation==='intersection'?OverlayOp.intersection(geometry,next):OverlayOp.symDifference(geometry,next);
  // A point/line contact has no area and cannot become a polygon object.
  if(geometry.isEmpty() || geometry.getArea()===0)return null;
  if(!new IsValidOp(geometry).isValid())throw new Error('Es konnte keine gültige Ergebnisfläche berechnet werden.');
  const polygons=[];
  const collect=g=>{if(g.getGeometryType()==='Polygon')polygons.push(writer.write(g).coordinates); else if(g.getNumGeometries()>1 || g.getGeometryType()==='GeometryCollection')for(let i=0;i<g.getNumGeometries();i++){const child=g.getGeometryN(i);if(child!==g)collect(child);}};
  collect(geometry);
  const restore=curveReconstructor(objects), curved=objects.some(hasCurves);
  const convert=preserve=>{
    const parts=polygons.map(rings=>{
      const outer=preserve?restore(rings[0]):{kind:'polygon',vertices:rings[0].slice(0,-1)};
      const holes=rings.slice(1).map(r=>preserve?restore(r):{vertices:r.slice(0,-1)});
      return {...outer,holes:holes.map(h=>h.vertices),...(holes.some(h=>h.curveSegments)?{holeCurveSegments:holes.map(h=>h.curveSegments||null)}:{})};
    });
    return parts.length===1?parts[0]:{kind:'multiPolygon',parts};
  };
  const result=convert(curved);
  // Numerical clipping near tangencies can make reconstructed cubics invalid.
  // Keep the valid overlay instead of changing topology or exporting bad rings.
  if(curved && !new IsValidOp(reader.read(toFeature(result,p=>p).geometry)).isValid())return {...convert(false),curveFallback:true};
  return result;
}
