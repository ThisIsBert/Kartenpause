import numeric from 'numeric';
import { GeoFit } from './geo-fit.js';

export const ProjectionSearch = (() => {
    const minimumPoints = 4;
    const names = { eqc: 'Längentreue Zylinderprojektion', lcc: 'Lambert konisch', aea: 'Albers flächentreu', eqdc: 'Längentreue Kegelprojektion', laea: 'Lambert azimutal', aeqd: 'Azimutal längentreu', stere: 'Stereografisch', ortho: 'Orthografisch', gnom: 'Gnomonisch', tmerc: 'Transversale Mercatorprojektion', robin: 'Robinson', moll: 'Mollweide', eqearth: 'Equal Earth', sinu: 'Sinusoidal', poly: 'Polykonisch' };
    const keys = family => family === 'eqc' ? ['lat_ts'] : family === 'lcc' ? ['lat_1'] : ['aea','eqdc'].includes(family) ? ['lat_1','lat_2'] : ['laea','aeqd','stere','ortho','gnom'].includes(family) ? ['lon_0','lat_0'] : ['lon_0'];
    const wrap = lon => ((lon+180)%360+360)%360-180;
    const clamp = lat => Math.max(-80,Math.min(80,lat));
    function definition(model) {
      if (!model || !Object.hasOwn(names,model.family) || !model.parameters) throw new Error('Unbekannte Projektionsfamilie.');
      const p=model.parameters, required=[...new Set(['lon_0',...keys(model.family)])];
      if (Object.keys(p).some(k=>!required.includes(k)) || required.some(k=>!Number.isFinite(p[k]))) throw new Error('Ungültige Projektionsparameter.');
      if (Math.abs(p.lon_0)>180 || required.some(k=>k!=='lon_0'&&Math.abs(p[k])>85)) throw new Error('Projektionsparameter außerhalb der Suchgrenzen.');
      if (model.family==='eqc'&&(p.lat_ts<0||p.lat_ts>80)) throw new Error('Ungültiger Standardbreitenkreis.');
      if (model.family==='lcc'&&Math.abs(p.lat_1)<.05) throw new Error('Lambert-Kegel degeneriert am Äquator.');
      if (['aea','eqdc'].includes(model.family)&&Math.abs(p.lat_1+p.lat_2)<.1) throw new Error('Kegelparameter degeneriert.');
      const parameters={...p};
      if (model.family==='lcc') parameters.lat_2=p.lat_1;
      if (!Object.hasOwn(parameters,'lat_0')) parameters.lat_0=0;
      return `+proj=${model.family} ${Object.entries(parameters).map(([k,v])=>`+${k}=${v}`).join(' ')} +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`;
    }
    function seeds(family,points) {
      const fit=points.filter(p=>p.fit), lat=fit.reduce((s,p)=>s+p.target.lat,0)/fit.length;
      const sin=fit.reduce((s,p)=>s+Math.sin(p.target.lon*Math.PI/180),0),cos=fit.reduce((s,p)=>s+Math.cos(p.target.lon*Math.PI/180),0);
      const lon=wrap(Math.atan2(sin,cos)*180/Math.PI);
      let starts;
      if(family==='eqc') starts=[[10],[30],[55]];
      else if(family==='lcc') starts=[lat-20,lat,lat+20].map(v=>[Math.abs(v)<.1 ? 1 : clamp(v)]);
      else if(['aea','eqdc'].includes(family)) starts=[[clamp(lat-15),clamp(lat+15)],[clamp(lat),clamp(lat)],[clamp(lat-30),clamp(lat+30)]];
      else if(['laea','aeqd','stere','ortho','gnom'].includes(family)) starts=[[lon,clamp(lat)],[wrap(lon-20),clamp(lat-20)],[wrap(lon+20),clamp(lat+20)]];
      else starts=[[lon],[wrap(lon-25)],[wrap(lon+25)]];
      return {lon,starts};
    }
    async function search(points,family,width,height,options={}) {
      if (points.filter(p=>p.fit).length<minimumPoints) throw new Error('Mindestens vier Fit-Punkte für die Parametersuche erforderlich.');
      if (!numeric?.uncmin) throw new Error('Optimierungsbibliothek fehlt.');
      const fit=points.filter(p=>p.fit),{lon,starts}=seeds(family,fit),parameterKeys=keys(family);
      const reference=Math.max(1,fit.reduce((s,p)=>s+GeoFit.distance(p.target,fit[0].target)**2,0)/fit.length);
      let best=null, attempted=0, failures=0;
      const makeModel=values=>({family,parameters:{lon_0:lon,...Object.fromEntries(parameterKeys.map((k,i)=>[k,values[i]]))}});
      for(let seedIndex=0;seedIndex<starts.length;seedIndex++) {
        await new Promise(resolve=>setTimeout(resolve,0));
        if(options.cancelled?.()) throw new Error('Suche abgebrochen.');
        options.progress?.(seedIndex+1,starts.length);
        const values=starts[seedIndex];
        try {
          const initial=GeoFit.solve(fit,definition(makeModel(values)),width,height,false).g;
          const geometry=v=>({cx:initial.cx+v[0]*initial.hw,cy:initial.cy+v[1]*initial.hw,hw:initial.hw*Math.exp(v[2]),hh:initial.hh*Math.exp(v[2]),rot:initial.rot+v[3]});
          const loss=v=>{
            if(!v.every(Number.isFinite)||Math.abs(v[2])>8) return 1e8;
            try {
              const model=makeModel(v.slice(4).map(x=>x*20)),def=definition(model),g=geometry(v);
              const evaluation=GeoFit.evaluate(fit,g,def,width,height),rms=evaluation.fit.rms;
              if(!Number.isFinite(rms)) return 1e8;
              if(!best||rms<best.fit.rms) best={model,def,g,...evaluation};
              return rms**2/reference;
            } catch(_) {return 1e8;}
          };
          const start=[0,0,0,0,...values.map(x=>x/20)];loss(start);attempted++;
          numeric.uncmin(loss,start,1e-9,undefined,220);
        } catch(_) {failures++;}
      }
      if(!best) throw new Error('Keine gültige Anpassung innerhalb der Suchgrenzen.');
      // Refine the alignment at the best parameters before publishing this candidate.
      const refined=GeoFit.solve(points,best.def,width,height);
      if(refined.fit.rms<=best.fit.rms) best.g=refined.g;
      best.g.rot=((best.g.rot+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
      return { code:'CUSTOM:'+family, model:best.model, g:best.g, ...GeoFit.evaluate(points,best.g,best.def,width,height), warning:failures ? `${failures} Startversuch(e) ohne vollständige Optimierung; beste gefundene Lösung.` : '', starts:attempted };
    }
    async function crossValidate(points,code,model,width,height,options={}) {
      const fit=points.filter(p=>p.fit);
      if(fit.length<(model?5:4)) throw new Error(model?'Mindestens fünf Fit-Punkte für die Auslassprüfung mit Parametersuche.':'Mindestens vier Fit-Punkte für die Auslassprüfung.');
      const rows=[];
      for(let i=0;i<fit.length;i++) {
        await new Promise(resolve=>setTimeout(resolve,0));
        if(options.cancelled?.()) throw new Error('Prüfung abgebrochen.');
        options.progress?.(i+1,fit.length);
        const training=fit.filter((_,j)=>i!==j);
        try {
          const result=model ? await search(training,model.family,width,height,{cancelled:options.cancelled}) : GeoFit.solve(training,code,width,height);
          const def=result.model ? definition(result.model) : code;
          const test=GeoFit.evaluate([fit[i]],result.g,def,width,height).rows[0];rows.push(test);
        } catch(err) {
          if(options.cancelled?.()) throw err;
          rows.push({id:fit[i].id,error:Infinity,pixelError:Infinity});
        }
      }
      return {rows,rms:Math.sqrt(rows.reduce((s,r)=>s+r.error**2,0)/rows.length),max:Math.max(...rows.map(r=>r.error)),pixelRms:Math.sqrt(rows.reduce((s,r)=>s+r.pixelError**2,0)/rows.length)};
    }
    return { names, keys, definition, search, crossValidate, minimumPoints };
  })();
