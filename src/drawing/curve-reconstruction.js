import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import { ringEntries, edgeControls, edgePoint, splitEdge } from './geometry.js';

// Overlay works on sampled edges. Map the surviving edges back to their
// source cubic and collapse each continuous run into one Bézier segment.
export function curveReconstructor(objects) {
  const tree=new STRtree(); let scale=1, id=0;
  for(const object of objects) for(const {shape} of ringEntries(object)) {
    for(let i=0;i<shape.vertices.length;i++) {
      const c=edgeControls(shape,i); if(!c)continue;
      const source={id:id++,a:shape.vertices[i],b:shape.vertices[(i+1)%shape.vertices.length],c};
      for(let step=0;step<32;step++) {
        const a=edgePoint(shape,i,step/32), b=edgePoint(shape,i,(step+1)/32);
        scale=Math.max(scale,...a.map(Math.abs),...b.map(Math.abs));
        tree.insert(new Envelope(a[0],b[0],a[1],b[1]),{source,a,b,t0:step/32,t1:(step+1)/32});
      }
    }
  }
  const epsilon=scale*1e-10;
  const locate=(a,b)=>{
    const m=a.map((v,k)=>(v+b[k])/2), candidates=tree.query(new Envelope(m[0]-epsilon,m[0]+epsilon,m[1]-epsilon,m[1]+epsilon)).toArray();
    for(const edge of candidates) {
      const d=edge.b.map((v,k)=>v-edge.a[k]), len=d[0]**2+d[1]**2; if(!len)continue;
      const parameter=p=>((p[0]-edge.a[0])*d[0]+(p[1]-edge.a[1])*d[1])/len;
      const u=parameter(a),v=parameter(b), margin=epsilon/Math.sqrt(len);
      const distance=(p,t)=>Math.hypot(p[0]-edge.a[0]-t*d[0],p[1]-edge.a[1]-t*d[1]);
      if(Math.min(u,v)>=-margin && Math.max(u,v)<=1+margin && distance(a,u)<=epsilon && distance(b,v)<=epsilon)
        return {source:edge.source,t0:edge.t0+u/32,t1:edge.t0+v/32};
    }
    return null;
  };
  const derivative=(s,t)=>s.a.map((v,k)=>3*(1-t)**2*(s.c[0][k]-v)+6*(1-t)*t*(s.c[1][k]-s.c[0][k])+3*t*t*(s.b[k]-s.c[1][k]));
  const contiguous=(a,b)=>a.curve && b.curve && a.curve.source.id===b.curve.source.id && Math.abs(a.curve.t1-b.curve.t0)<1e-7 && (a.curve.t1-a.curve.t0)*(b.curve.t1-b.curve.t0)>0;
  return ring=>{
    const vertices=ring.slice(0,-1), runs=[];
    vertices.forEach((a,i)=>{
      const b=vertices[(i+1)%vertices.length], item={a,b,curve:locate(a,b)}, previous=runs.at(-1);
      if(previous && contiguous(previous,item)){previous.b=b;previous.curve.t1=item.curve.t1;} else runs.push(item);
    });
    if(runs.length>1 && contiguous(runs.at(-1),runs[0])) {const tail=runs.pop();runs[0].a=tail.a;runs[0].curve.t0=tail.curve.t0;}
    const shape={kind:'polygon',vertices:runs.map(r=>r.a)};
    if(runs.some(r=>r.curve)) shape.curveSegments=runs.map(({curve})=>{
      if(!curve)return null;
      const dt=(curve.t1-curve.t0)/3;
      return [derivative(curve.source,curve.t0).map(v=>v*dt),derivative(curve.source,curve.t1).map(v=>-v*dt)];
    });
    while(shape.vertices.length<3 && shape.curveSegments) splitEdge(shape,0);
    return shape;
  };
}
