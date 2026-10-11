import L from 'leaflet';
import { edgeControls, hasCurves, isClosed, sampledRings } from './geometry.js';

// SVG draws the actual cubic segments; sampled points only provide Leaflet's
// bounds and the standard polygon representation used for geospatial exchange.
const CurvePolygon=L.Polygon.extend({
  initialize(object,unproject,options) { this._object=object; this._unproject=unproject; L.Polygon.prototype.initialize.call(this,sampledRings(object).map(r=>r.map(unproject)),options); },
  setGeometry(object) { this._object=object; return this.setLatLngs(sampledRings(object).map(r=>r.map(this._unproject))); },
  _updatePath() {
    if (!this._map) return;
    const point=p=>{ const origin=this._map.getPixelOrigin(), q=this._map.project(this._unproject(p),this._map.getZoom()).subtract(origin); return q.x+','+q.y; };
    const object=this._object, rings=[object, ...(object.holes||[]).map((vertices,i)=>({kind:'polygon',vertices,curveSegments:object.holeCurveSegments?.[i]}))];
    const d=rings.map(shape=>{
      if(!shape.vertices.length)return '';
      let path='M'+point(shape.vertices[0]);
      const count=shape.vertices.length-(isClosed(shape.kind)?0:1);
      for(let i=0;i<count;i++){const c=edgeControls(shape,i),end=shape.vertices[(i+1)%shape.vertices.length]; path+=c?'C'+point(c[0])+' '+point(c[1])+' '+point(end):'L'+point(end);}
      return path+(isClosed(shape.kind)?'Z':'');
    }).join('');
    this._renderer._setPath(this,d||'M0 0');
  }
});
export const curveLayer=(object,unproject,options)=>hasCurves(object)?new CurvePolygon(object,unproject,{...options,fill:isClosed(object.kind)}):null;
