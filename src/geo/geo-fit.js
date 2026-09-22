import proj4 from 'proj4';
import numeric from 'numeric';

export const GeoFit = (() => {
    const radians = Math.PI / 180;
    function distance(a, b) {
      const dlat = (a.lat - b.lat) * radians, dlon = (a.lon - b.lon) * radians;
      const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dlon / 2) ** 2;
      return 12742000 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
    }
    function xy(point, width, height) {
      return [(point.source.u - .5) * width, (.5 - point.source.v) * height];
    }
    function predict(point, g, code, width, height) {
      const [x, y] = xy(point, width, height), scale = 2 * g.hw / width;
      const c = Math.cos(g.rot), s = Math.sin(g.rot);
      const ll = proj4(code, 'EPSG:4326', [g.cx + scale * (c * x - s * y), g.cy + scale * (s * x + c * y)]);
      if (!ll.every(Number.isFinite) || Math.abs(ll[1]) > 90) throw new Error('Punkt außerhalb des Projektionsbereichs.');
      return { lon: ll[0], lat: ll[1] };
    }
    function stats(rows) {
      if (!rows.length) return null;
      if (rows.some(r => !Number.isFinite(r.error))) return { rms: Infinity, mean: Infinity, max: Infinity, count: rows.length };
      return { rms: Math.sqrt(rows.reduce((s, r) => s + r.error ** 2, 0) / rows.length), mean: rows.reduce((s, r) => s + r.error, 0) / rows.length, max: Math.max(...rows.map(r => r.error)), count: rows.length };
    }
    function evaluate(points, g, code, width, height) {
      const rows = points.map(point => {
        try {
          const predicted = predict(point, g, code, width, height);
          const target = proj4('EPSG:4326', code, [point.target.lon,point.target.lat]);
          const dx=target[0]-g.cx, dy=target[1]-g.cy, c=Math.cos(g.rot), s=Math.sin(g.rot), scale=2*g.hw/width;
          const [x,y]=xy(point,width,height);
          const pixelError=Math.hypot((c*dx+s*dy)/scale-x,(-s*dx+c*dy)/scale-y);
          return { id: point.id, fit: point.fit, predicted, error: distance(predicted, point.target), pixelError };
        }
        catch (_) { return { id: point.id, fit: point.fit, predicted: null, error: Infinity }; }
      });
      return { rows, fit: stats(rows.filter(r => r.fit)), control: stats(rows.filter(r => !r.fit)), pixel: stats(rows.filter(r=>r.fit).map(r=>({error:r.pixelError}))) };
    }
    function distribution(points, width, height) {
      const fit = points.filter(p => p.fit), coords = fit.map(p => xy(p, width, height));
      if (fit.length < 3) return 'Mindestens drei aktive Fit-Punktpaare erforderlich.';
      const mx = coords.reduce((s, p) => s + p[0], 0) / fit.length, my = coords.reduce((s, p) => s + p[1], 0) / fit.length;
      let xx = 0, yy = 0, cross = 0;
      coords.forEach(([x, y]) => { xx += (x - mx) ** 2; yy += (y - my) ** 2; cross += (x - mx) * (y - my); });
      const trace = xx + yy;
      if (trace / fit.length < 4) return 'Fit-Punkte liegen nahezu aufeinander.';
      if ((xx * yy - cross ** 2) / (trace ** 2) < .0025) return 'Fit-Punkte liegen fast auf einer Linie. Die Fläche ist schlecht abgesichert.';
      if (trace / fit.length / (width ** 2 + height ** 2) < .01) return 'Fit-Punkte liegen eng beieinander. Die übrige Bildfläche ist schlecht abgesichert.';
      return '';
    }
    function solve(points, code, width, height, refine = true) {
      const fit = points.filter(p => p.fit);
      if (fit.length < 3) throw new Error('Mindestens drei aktive Fit-Punktpaare erforderlich.');
      const src = fit.map(p => xy(p, width, height));
      const dst = fit.map(p => {
        const q = proj4('EPSG:4326', code, [p.target.lon, p.target.lat]);
        if (!q.every(Number.isFinite)) throw new Error('Zielpunkt nicht projizierbar.');
        const back = proj4(code, 'EPSG:4326', q);
        if (!back.every(Number.isFinite) || distance(p.target, { lon: back[0], lat: back[1] }) > 2) throw new Error('Zielpunkt außerhalb des zuverlässig transformierbaren Bereichs.');
        return q;
      });
      const mean = data => [0, 1].map(k => data.reduce((s, p) => s + p[k], 0) / data.length);
      const sm = mean(src), dm = mean(dst);
      let den = 0, dot = 0, cross = 0;
      src.forEach((p, i) => {
        const x = p[0] - sm[0], y = p[1] - sm[1], X = dst[i][0] - dm[0], Y = dst[i][1] - dm[1];
        den += x*x + y*y; dot += x*X + y*Y; cross += x*Y - y*X;
      });
      if (den / fit.length < 4) throw new Error('Fit-Punkte liegen nahezu aufeinander.');
      // Complex multiplication encodes rotation and a single scale, with no reflection.
      const a = dot / den, b = cross / den, scale = Math.hypot(a, b);
      if (!Number.isFinite(scale) || scale < 1e-12) throw new Error('Zielpunkte ergeben keinen brauchbaren Maßstab.');
      const initial = { cx: dm[0] - a*sm[0] + b*sm[1], cy: dm[1] - b*sm[0] - a*sm[1], hw: scale*width/2, hh: scale*height/2, rot: Math.atan2(b, a) };
      if (!refine) return { code, g: initial, ...evaluate(points,initial,code,width,height), warning: '' };
      const reference = Math.max(1, fit.reduce((s, p) => s + distance(p.target, fit[0].target) ** 2, 0) / fit.length);
      const geometry = v => ({ cx: initial.cx + v[0]*initial.hw, cy: initial.cy + v[1]*initial.hw, hw: initial.hw*Math.exp(v[2]), hh: initial.hh*Math.exp(v[2]), rot: initial.rot + v[3] });
      const loss = v => {
        if (!v.every(Number.isFinite) || Math.abs(v[2]) > 10) return 1e12;
        const result = evaluate(fit, geometry(v), code, width, height).fit.rms;
        return Number.isFinite(result) ? result ** 2 / reference : 1e12;
      };
      if (!numeric?.uncmin) throw new Error('Optimierungsbibliothek nicht geladen. Internetverbindung prüfen und neu laden.');
      const start = [0, 0, 0, 0], initialLoss = loss(start);
      if (initialLoss >= 1e12) throw new Error('Anfangsanpassung nicht rücktransformierbar.');
      let g = initial, warning = '';
      try {
        const opt = numeric.uncmin(loss, start, 1e-9, undefined, 250);
        if (loss(opt.solution) <= initialLoss) g = geometry(opt.solution);
        if (opt.iterations >= 250) warning = 'Iterationsgrenze erreicht; beste gefundene Anpassung.';
      } catch (_) { warning = 'Numerische Verfeinerung fehlgeschlagen; Ausgangsanpassung verwendet.'; }
      g.rot = ((g.rot + Math.PI) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI) - Math.PI;
      return { code, g, ...evaluate(points, g, code, width, height), warning };
    }
    return { distance, evaluate, solve, distribution };
  })();
