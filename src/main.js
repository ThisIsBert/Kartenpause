import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import proj4 from 'proj4';
import {
  createIcons,
  Crosshair,
  FolderOpen,
  ListOrdered,
  MapPinPlus,
  Pencil,
  Save,
  Scan,
  ScanSearch,
  ShieldCheck,
  Trash2,
  X
} from 'lucide';
import { GeoFit } from './geo/geo-fit.js';
import { ProjectionSearch } from './geo/projection-search.js';
import './styles.css';


    const map = L.map('map', { preferCanvas: true }).setView([51.1, 10.3], 6);

    const basemaps = {
      esriStreet: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri'
      }),
      esriTopo: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri'
      }),
      osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap-Mitwirkende'
      })
    };
    let activeBasemap = basemaps.esriStreet.addTo(map);

    // CRS-Definitionen. 4326 und 3857 kennt Proj4js bereits.
    const candidates = [
      { code: 'EPSG:4326', label: 'Geografisch / Plate Carrée (EPSG:4326)' },
      { code: 'EPSG:3857', label: 'Web Mercator (EPSG:3857)' },
      { code: 'EPSG:3395', label: 'World Mercator (EPSG:3395)', def: '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs' },
      { code: 'EPSG:25832', label: 'ETRS89 / UTM 32N (EPSG:25832)', def: '+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs' },
      { code: 'EPSG:25833', label: 'ETRS89 / UTM 33N (EPSG:25833)', def: '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs' },
      { code: 'EPSG:32632', label: 'WGS84 / UTM 32N (EPSG:32632)', def: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs' },
      { code: 'EPSG:32633', label: 'WGS84 / UTM 33N (EPSG:32633)', def: '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs' },
      { code: 'EPSG:3035', label: 'ETRS89 / LAEA Europe (EPSG:3035)', def: '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +units=m +no_defs' },
      { code: 'EPSG:3034', label: 'ETRS89 / LCC Europe (EPSG:3034)', def: '+proj=lcc +lat_0=52 +lon_0=10 +lat_1=35 +lat_2=65 +x_0=4000000 +y_0=2800000 +ellps=GRS80 +units=m +no_defs' },
      { code: 'DHDN:GK3', label: 'DHDN / Gauß-Krüger Zone 3', def: '+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=3500000 +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs' },
      { code: 'DHDN:GK4', label: 'DHDN / Gauß-Krüger Zone 4', def: '+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs' },
      { code: 'WORLD:ROBIN', label: 'Robinson', def: '+proj=robin +lon_0=0 +datum=WGS84 +units=m +no_defs' },
      { code: 'WORLD:MOLL', label: 'Mollweide', def: '+proj=moll +lon_0=0 +datum=WGS84 +units=m +no_defs' },
      { code: 'WORLD:EQEARTH', label: 'Equal Earth', def: '+proj=eqearth +lon_0=0 +datum=WGS84 +units=m +no_defs' }
    ];
    for (const c of candidates) if (c.def) proj4.defs(c.code, c.def);
    const fixedCodes = candidates.map(c=>c.code);

    const els = {
      file: document.getElementById('file'), opacity: document.getElementById('opacity'), opacityValue: document.getElementById('opacityValue'),
      status: document.getElementById('status'), basemap: document.getElementById('basemap')
    };

    let image = null;
    let imageName = '';
    let imageData = '';
    let points = [], nextPointId = 1, capture = null, results = [], busy = false;
    let fitted = false, imageLoadVersion = 0, searchCancelled = false, cancellable = false;
    let currentCrsIndex = 3, rotation = 0, renderMesh = 20;
    const ui = Object.fromEntries(['workspace','showSource','showResiduals','sourceFit','addPoint','cancelPoint','clearPoints','captureStatus','pointList','metrics','fitCrs','compare','comparisonNote','ranking','saveProject','loadProject','projectFile','notice','renderNote','alignmentLabel','searchParameters','cancelSearch','parameterInfo','validateFit','validationInfo'].map(id => [id, document.getElementById(id)]));
    const sourceMap = L.map('sourceMap', {
      crs: L.CRS.Simple,
      minZoom: -8,
      maxZoom: 5,
      zoomSnap: .25,
      zoomAnimation: false,
      markerZoomAnimation: false,
      fadeAnimation: false,
      scrollWheelZoom: 'center',
      doubleClickZoom: 'center',
      touchZoom: 'center'
    }).setView([0,0], 0);
    const sourceMarks = L.layerGroup().addTo(sourceMap), targetMarks = L.layerGroup().addTo(map), residualMarks = L.layerGroup().addTo(map);
    let sourceLayer = null;
    let imageCenter = L.latLng(51.1, 10.3);
    let halfWidthSource = null;

    function currentCrs() { return candidates[currentCrsIndex]; }

    function projectCenter(code = currentCrs().code) {
      return proj4('EPSG:4326', code, [imageCenter.lng, imageCenter.lat]);
    }

    function sourceGeometry(code = currentCrs().code) {
      if (!image || !fitted || !Number.isFinite(halfWidthSource)) return null;
      const [cx, cy] = projectCenter(code);
      const hw = halfWidthSource;
      const aspect = image.naturalHeight / image.naturalWidth;
      const hh = hw * aspect;
      const rot = rotation * Math.PI / 180;
      return { cx, cy, hw, hh, rot };
    }

    function rotatePoint(x, y, g) {
      if (!g.rot) return [x, y];
      const dx=x-g.cx, dy=y-g.cy, c=Math.cos(g.rot), sn=Math.sin(g.rot);
      return [g.cx + dx*c - dy*sn, g.cy + dx*sn + dy*c];
    }

    function sourceToLatLng(x, y, code = currentCrs().code) {
      const ll = proj4(code, 'EPSG:4326', [x, y]);
      if (!Number.isFinite(ll[0]) || !Number.isFinite(ll[1]) || Math.abs(ll[1]) > 90) throw new Error('Ungültige Rücktransformation');
      return L.latLng(ll[1], ll[0]);
    }

    function uvToLatLng(u, v, g, code = currentCrs().code) {
      let x = g.cx + (u * 2 - 1) * g.hw;
      let y = g.cy + (1 - v * 2) * g.hh;
      [x, y] = rotatePoint(x, y, g);
      return sourceToLatLng(x, y, code);
    }

    class WarpedImageLayer extends L.Layer {
      onAdd(map) {
        this._map = map;
        this._canvas = L.DomUtil.create('canvas', 'leaflet-warped-image-layer');
        this._canvas.style.position = 'absolute';
        this._canvas.style.pointerEvents = 'none';
        map.getPanes().overlayPane.appendChild(this._canvas);
        map.on('move zoom resize viewreset', this.redraw, this);
        this.redraw();
      }
      onRemove(map) {
        map.off('move zoom resize viewreset', this.redraw, this);
        this._canvas.remove();
      }
      redraw() {
        if (!this._map || !this._canvas) return;
        const map = this._map, size = map.getSize();
        this._canvas.width = size.x; this._canvas.height = size.y;
        this._canvas.style.width = size.x + 'px'; this._canvas.style.height = size.y + 'px';
        const topLeft = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, topLeft);
        const ctx = this._canvas.getContext('2d');
        ctx.clearRect(0, 0, size.x, size.y);
        if (!image || !fitted) return;
        ctx.globalAlpha = Number(els.opacity.value) / 100;
        ctx.imageSmoothingEnabled = true;

        const crs = currentCrs();
        const n = renderMesh;
        let g;
        try { g = sourceGeometry(crs.code); }
        catch (err) { showError(err); return; }
        if (!g) return;

        const points = Array.from({ length: n + 1 }, () => Array(n + 1));
        for (let j = 0; j <= n; j++) {
          for (let i = 0; i <= n; i++) {
            const u = i / n, v = j / n;
            try {
              const ll = uvToLatLng(u, v, g, crs.code);
              if (Math.abs(ll.lat) > 85.05112878) throw new Error('Außerhalb Web Mercator');
              const lp = map.latLngToLayerPoint(ll).subtract(topLeft);
              points[j][i] = { x: lp.x, y: lp.y, lon: ll.lng, sx: u * image.naturalWidth, sy: v * image.naturalHeight };
            } catch (e) { points[j][i] = null; }
          }
        }

        let skipped = 0;
        const triangle = (a,b,c) => {
          if (!a || !b || !c || Math.max(a.lon,b.lon,c.lon) - Math.min(a.lon,b.lon,c.lon) > 180) { skipped++; return; }
          drawTriangle(ctx, image, a,b,c);
        };
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
          const p00 = points[j][i], p10 = points[j][i+1], p01 = points[j+1][i], p11 = points[j+1][i+1];
          triangle(p00, p10, p11);
          triangle(p00, p11, p01);
        }
        ui.renderNote.textContent = skipped ? `${skipped} von ${2*n*n} Bilddreiecken außerhalb des darstellbaren Bereichs ausgelassen.` : '';
      }
    }

    function drawTriangle(ctx, img, s0, s1, s2) {
      const x0=s0.sx, y0=s0.sy, x1=s1.sx, y1=s1.sy, x2=s2.sx, y2=s2.sy;
      const X0=s0.x, Y0=s0.y, X1=s1.x, Y1=s1.y, X2=s2.x, Y2=s2.y;
      const den = x0*(y1-y2) + x1*(y2-y0) + x2*(y0-y1);
      if (Math.abs(den) < 1e-9) return;
      const a = (X0*(y1-y2) + X1*(y2-y0) + X2*(y0-y1)) / den;
      const c = (X0*(x2-x1) + X1*(x0-x2) + X2*(x1-x0)) / den;
      const e = (X0*(x1*y2-x2*y1) + X1*(x2*y0-x0*y2) + X2*(x0*y1-x1*y0)) / den;
      const b = (Y0*(y1-y2) + Y1*(y2-y0) + Y2*(y0-y1)) / den;
      const d = (Y0*(x2-x1) + Y1*(x0-x2) + Y2*(x1-x0)) / den;
      const f = (Y0*(x1*y2-x2*y1) + Y1*(x2*y0-x0*y2) + Y2*(x0*y1-x1*y0)) / den;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(X0,Y0); ctx.lineTo(X1,Y1); ctx.lineTo(X2,Y2); ctx.closePath(); ctx.clip();
      ctx.setTransform(a,b,c,d,e,f);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    }

    const overlay = new WarpedImageLayer().addTo(map);

    function updateStatus(extra='') {
      const imageText = image ? `Bild: ${imageName} (${image.naturalWidth}×${image.naturalHeight} px)` : 'Noch kein Bild geladen.';
      const fitText = fitted ? `\nProjektion: ${currentCrs().label}\nAutomatisch angepasst.` : image ? '\nNoch nicht angepasst. Referenzpunkte setzen und die Projektion automatisch anpassen.' : '';
      els.status.textContent = `${imageText}${fitText}${extra ? '\n' + extra : ''}`;
    }
    function showError(err) { ui.notice.textContent = 'Fehler: ' + (err?.message || err); }

    const appIcons = { Crosshair, FolderOpen, ListOrdered, MapPinPlus, Pencil, Save, Scan, ScanSearch, ShieldCheck, Trash2, X };
    function icons() { createIcons({ icons: appIcons }); }
    function formatDistance(value) {
      if (!Number.isFinite(value)) return 'nicht berechenbar';
      return value >= 1000 ? (value / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' km' : value.toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' m';
    }
    function markerIcon(point, extra = '') {
      return L.divIcon({ className: `point-marker ${point.fit ? '' : 'control'} ${extra}`, html: `<span>${point.id}</span>`, iconSize: [32,32] });
    }
    function actionButton(icon, label, action) {
      const button = document.createElement('button'); button.className = 'icon'; button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
      const glyph = document.createElement('i'); glyph.setAttribute('data-lucide', icon); button.appendChild(glyph); button.onclick = action; button.disabled = busy;
      return button;
    }
    function updateAvailability() {
      const enough = points.filter(p => p.fit).length >= 3;
      const count = points.filter(p=>p.fit).length;
      ui.addPoint.disabled = !image || busy || !!capture;
      ui.clearPoints.disabled = !points.length || busy;
      ui.fitCrs.disabled = !image || !enough || busy || !!capture;
      ui.compare.disabled = !image || !enough || busy || !!capture;
      const searchBlock = !image ? 'Kein Bild geladen.' : busy ? 'Berechnung oder Laden läuft.' : capture ? `Punktpaar ${capture.id} noch unvollständig. Punktaufnahme abschließen oder abbrechen.` : count<ProjectionSearch.minimumPoints ? `${count} von ${points.length} Punktpaaren für den Fit aktiv. Mindestens ${ProjectionSearch.minimumPoints} angehakte Fit-Punkte erforderlich.` : '';
      ui.searchParameters.disabled = !!searchBlock;
      ui.searchParameters.title = searchBlock;
      document.getElementById('searchAvailability').textContent = searchBlock || (count===ProjectionSearch.minimumPoints ? '4 aktive Fit-Punkte. Für eine Auslassprüfung wird ein weiterer Fit-Punkt benötigt.' : '');
      ui.validateFit.disabled = !image || count<(currentCrs().model?5:4) || busy || !!capture;
      ui.cancelSearch.hidden = !busy || !cancellable; ui.cancelSearch.disabled = !busy || !cancellable || searchCancelled;
      ui.saveProject.disabled = !image || !fitted || busy || !!capture;
      ui.sourceFit.disabled = !image || busy;
      document.getElementById('zoomImage').disabled = !image || !fitted || busy;
      ui.cancelPoint.hidden = !capture;
      ui.alignmentLabel.textContent = fitted ? 'Automatisch angepasst' : 'Noch nicht angepasst';
      const model=currentCrs().model;
      ui.parameterInfo.textContent = model ? `${ProjectionSearch.names[model.family]}\n${Object.entries(model.parameters).map(([k,v])=>`${k} = ${v.toFixed(4)}°`).join(' · ')}\n${model.family==='lcc'?'Äquivalenter Standardbreitenkreis; keine eindeutige Rekonstruktion der ursprünglichen Parameter.':'Numerisch angepasste Variante; Parameter nicht eindeutig als Original nachgewiesen.'}` : '';
    }
    function invalidateResults() {
      results = []; fitted = false; ui.ranking.replaceChildren();
      ui.validationInfo.textContent = '';
      ui.comparisonNote.textContent = 'Referenzpunkte geändert. Vergleich neu berechnen.';
    }
    function refresh() {
      if(!fitted) ui.validationInfo.textContent = '';
      overlay.redraw(); renderPoints(); updateStatus(); updateAvailability();
    }
    function pointsChanged() { invalidateResults(); ui.notice.textContent = ''; refresh(); }
    function renderPoints() {
      sourceMarks.clearLayers(); targetMarks.clearLayers(); residualMarks.clearLayers(); ui.pointList.replaceChildren();
      let evaluation = null;
      if (image && fitted) {
        try { evaluation = GeoFit.evaluate(points, sourceGeometry(), currentCrs().code, image.naturalWidth, image.naturalHeight); }
        catch (err) { showError(err); }
      }
      for (const point of points) {
        const row = document.createElement('tr'), number = document.createElement('td'), fitCell = document.createElement('td'), errorCell = document.createElement('td'), actions = document.createElement('td');
        number.textContent = point.id;
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = point.fit; check.disabled = busy || !!capture;
        check.title = `Punkt ${point.id} für Anpassung verwenden`; check.setAttribute('aria-label', check.title);
        check.onchange = () => { point.fit = check.checked; pointsChanged(); }; fitCell.appendChild(check);
        const residual = evaluation?.rows.find(r => r.id === point.id);
        errorCell.textContent = residual ? `${formatDistance(residual.error)}${Number.isFinite(residual.pixelError)?' · '+residual.pixelError.toFixed(1)+' px':''}` : '—';
        errorCell.title = point.fit ? 'Fit-Punkt' : 'Unabhängiger Kontrollpunkt';
        const edit = actionButton('pencil', `Punktpaar ${point.id} neu setzen`, () => startCapture(point.id));
        const remove = actionButton('trash-2', `Punktpaar ${point.id} löschen`, () => { points = points.filter(p => p.id !== point.id); cancelCapture(); pointsChanged(); });
        edit.disabled = busy || !!capture; remove.disabled = busy || !!capture;
        actions.append(edit, remove); row.append(number, fitCell, errorCell, actions); ui.pointList.appendChild(row);
        if (!image) continue;
        const srcMarker = L.marker([(1-point.source.v)*image.naturalHeight, point.source.u*image.naturalWidth], { icon: markerIcon(point), interactive: !capture, draggable: !busy && !capture }).addTo(sourceMarks).bindTooltip(`Originalpunkt ${point.id}`);
        srcMarker.on('dragend', e => {
          const ll = e.target.getLatLng(); point.source = { u: Math.max(0, Math.min(1, ll.lng/image.naturalWidth)), v: Math.max(0, Math.min(1, 1-ll.lat/image.naturalHeight)) }; pointsChanged();
        });
        const target = L.marker([point.target.lat, point.target.lon], { icon: markerIcon(point), interactive: !capture, draggable: !busy && !capture }).addTo(targetMarks).bindTooltip(`Zielpunkt ${point.id}${point.fit ? '' : ' · Kontrolle'}`);
        target.on('dragend', e => {
          const ll = e.target.getLatLng().wrap();
          point.target = { lon: ll.lng, lat: Math.max(-85.05112878, Math.min(85.05112878, ll.lat)) }; pointsChanged();
        });
        if (ui.showResiduals.checked && residual?.predicted && Math.abs(residual.predicted.lat) <= 85.05112878) {
          const ll = [residual.predicted.lat, residual.predicted.lon];
          L.marker(ll, { icon: markerIcon(point, 'predicted-marker'), interactive: false }).addTo(residualMarks);
          if (Math.abs(residual.predicted.lon-point.target.lon) <= 180) L.polyline([ll, [point.target.lat, point.target.lon]], { color: '#b0273f', weight: 2, interactive: false }).addTo(residualMarks);
        }
      }
      if (capture?.source && image) L.marker([(1-capture.source.v)*image.naturalHeight, capture.source.u*image.naturalWidth], { icon: markerIcon({ id: capture.id, fit: true }, 'pending'), interactive: false }).addTo(sourceMarks);
      const lines = [];
      if (evaluation?.fit) lines.push(`Fit (${evaluation.fit.count}): RMS ${formatDistance(evaluation.fit.rms)}\nMittel ${formatDistance(evaluation.fit.mean)} · Maximum ${formatDistance(evaluation.fit.max)}`);
      if (Number.isFinite(evaluation?.pixel?.rms)) lines.push(`RMS im Originalbild: ${evaluation.pixel.rms.toFixed(2)} px`);
      if (evaluation?.control) lines.push(`Kontrolle (${evaluation.control.count}): RMS ${formatDistance(evaluation.control.rms)}\nMittel ${formatDistance(evaluation.control.mean)} · Maximum ${formatDistance(evaluation.control.max)}`);
      if (image && points.length) { const warning = GeoFit.distribution(points, image.naturalWidth, image.naturalHeight); if (warning) lines.push(warning); }
      ui.metrics.textContent = lines.join('\n'); icons(); updateAvailability();
    }
    function setSourceVisible(visible) {
      ui.showSource.checked = visible; ui.workspace.classList.toggle('single', !visible);
      requestAnimationFrame(() => { map.invalidateSize(); sourceMap.invalidateSize(); });
    }
    function startCapture(id = nextPointId) {
      if (!image || busy) return;
      capture = { id, phase: 'source', source: null }; setSourceVisible(true); updateCapture(); renderPoints(); renderRanking();
    }
    function updateCapture() {
      document.body.classList.toggle('capture-source', capture?.phase === 'source'); document.body.classList.toggle('capture-target', capture?.phase === 'target');
      ui.captureStatus.textContent = capture ? capture.phase === 'source' ? `Punkt ${capture.id}: Ort im Originalbild wählen.` : `Punkt ${capture.id}: Denselben Ort auf der Basiskarte wählen.` : '';
      updateAvailability();
    }
    function cancelCapture() { capture = null; updateCapture(); renderPoints(); renderRanking(); }
    sourceMap.on('click', e => {
      if (!capture || capture.phase !== 'source' || busy) return;
      const u = e.latlng.lng/image.naturalWidth, v = 1-e.latlng.lat/image.naturalHeight;
      if (u < 0 || u > 1 || v < 0 || v > 1) { showError('Bitte einen Punkt innerhalb des Originalbildes wählen.'); return; }
      ui.notice.textContent = ''; capture.source = { u, v }; capture.phase = 'target'; updateCapture(); renderPoints();
    });
    map.on('click', e => {
      if (!capture || capture.phase !== 'target' || busy) return;
      const ll = e.latlng.wrap(); if (Math.abs(ll.lat) > 85.05112878) return;
      const existing = points.find(p => p.id === capture.id);
      const point = { id: capture.id, source: capture.source, target: { lon: ll.lng, lat: ll.lat }, fit: existing ? existing.fit : true };
      if (existing) points[points.indexOf(existing)] = point; else { points.push(point); nextPointId++; }
      capture = null; updateCapture(); pointsChanged();
    });
    function applyResult(result) {
      if(result.model) registerModel(result.model);
      ui.validationInfo.textContent = '';
      const index = candidates.findIndex(c => c.code === result.code);
      const ll = sourceToLatLng(result.g.cx, result.g.cy, result.code);
      currentCrsIndex = index; imageCenter = ll; halfWidthSource = result.g.hw;
      rotation = result.g.rot*180/Math.PI; fitted = true;
      ui.notice.textContent = result.warning || ''; refresh(); renderRanking();
    }
    function renderRanking() {
      ui.ranking.replaceChildren();
      const valid = results.filter(r => !r.error), best = valid[0];
      for (const result of results) {
        const button = document.createElement('button'), label = document.createElement('span'), value = document.createElement('span');
        label.textContent = result.label || candidates.find(c => c.code === result.code)?.label || result.code;
        if(result.model){const detail=document.createElement('small');detail.textContent=ProjectionSearch.keys(result.model.family).map(k=>`${k} ${result.model.parameters[k].toFixed(2)}°`).join(' · ');label.appendChild(detail);}
        value.textContent = result.error ? 'nicht bewertbar' : formatDistance(result.fit.rms);
        button.append(label, value); button.disabled = !!result.error || busy || !!capture;
        button.title = result.error || [result.warning, result.control ? `Kontroll-RMS: ${formatDistance(result.control.rms)}` : ''].filter(Boolean).join(' · ');
        button.setAttribute('aria-pressed', String(fitted && result.code === currentCrs().code)); button.onclick = () => { try { applyResult(result); } catch (err) { showError(err); } }; ui.ranking.appendChild(button);
      }
      if (!best) { if (results.length) ui.comparisonNote.textContent = 'Keine getestete Variante konnte angepasst werden.'; return; }
      const second = valid[1], near = second && second.fit.rms-best.fit.rms <= Math.max(1, best.fit.rms*.05);
      ui.comparisonNote.textContent = (near ? 'Mehrere Varianten haben ähnliche Fit-Fehler (Abstand ≤ 5 % oder 1 m). Mit diesen Punkten keine eindeutige Unterscheidung.' : 'Sortiert nach Fit-RMS. Beste getestete Variante; kein Nachweis der ursprünglichen Projektion.') + (results.some(r=>r.model) ? ' Variable Modelle haben zusätzliche Freiheitsgrade. Kontrollpunkte oder Auslassprüfung berücksichtigen.' : '');
    }
    function setBusy(value) {
      busy = value;
      document.querySelectorAll('#sidebar button, #sidebar select, #sidebar input').forEach(el => { el.disabled = value; });
      renderPoints(); renderRanking(); updateAvailability();
    }
    function registerModel(model) {
      const def=ProjectionSearch.definition(model),code='CUSTOM:'+model.family;
      const entry={code,label:ProjectionSearch.names[model.family]+' · variabel',def,model:structuredClone(model)};
      proj4.defs(code,def);
      const index=candidates.findIndex(c=>c.code===code);
      if(index>=0) candidates[index]=entry;
      else candidates.push(entry);
      return entry;
    }
    async function searchParameters() {
      if(busy||capture||!image||points.filter(p=>p.fit).length<ProjectionSearch.minimumPoints)return;
      searchCancelled=false;cancellable=true;setBusy(true);ui.notice.textContent='';
      const computed=[];
      try {
        for(const code of fixedCodes){
          await new Promise(resolve=>setTimeout(resolve,0));
          if(searchCancelled)throw new Error('Suche abgebrochen; bisherige Ausrichtung bleibt erhalten.');
          try{computed.push(GeoFit.solve(points,code,image.naturalWidth,image.naturalHeight));}
          catch(err){computed.push({code,error:err.message});}
        }
        const families=Object.keys(ProjectionSearch.names);
        for(let i=0;i<families.length;i++){
          const family=families[i];
          if(searchCancelled)throw new Error('Suche abgebrochen; bisherige Ausrichtung bleibt erhalten.');
          const progress=(start,total)=>{ui.comparisonNote.textContent=`Familie ${i+1}/${families.length}: ${ProjectionSearch.names[family]} · Start ${start}/${total}`;};
          try{
            const result=await ProjectionSearch.search(points,family,image.naturalWidth,image.naturalHeight,{cancelled:()=>searchCancelled,progress});
            computed.push({...result,label:ProjectionSearch.names[family]+' · variabel'});
          } catch(err){
            if(searchCancelled)throw err;
            computed.push({code:'CUSTOM:'+family,label:ProjectionSearch.names[family],error:err.message});
          }
        }
        if(searchCancelled)throw new Error('Suche abgebrochen; bisherige Ausrichtung bleibt erhalten.');
        computed.sort((a,b)=>(a.error?Infinity:a.fit.rms)-(b.error?Infinity:b.fit.rms));
        const best=computed.find(r=>!r.error);
        if(!best)throw new Error('Keine Projektionsvariante konnte angepasst werden.');
        for(const result of computed)if(result.model)registerModel(result.model);
        results=computed;applyResult(best);
      }catch(err){showError(err);}
      finally{cancellable=false;setBusy(false);}
    }
    async function validateFit() {
      if(busy||capture||!image)return;
      searchCancelled=false;cancellable=true;setBusy(true);ui.notice.textContent='';
      const current=currentCrs();
      try{
        const check=await ProjectionSearch.crossValidate(points,current.code,current.model,image.naturalWidth,image.naturalHeight,{cancelled:()=>searchCancelled,progress:(i,n)=>{ui.validationInfo.textContent=`Auslassprüfung: Punkt ${i}/${n}`;}});
        ui.validationInfo.textContent=`Auslassprüfung (jeweils neu angepasst):\nRMS ${formatDistance(check.rms)} · Maximum ${formatDistance(check.max)}\nOriginalbild: ${Number.isFinite(check.pixelRms)?check.pixelRms.toFixed(2):'nicht berechenbar'} px RMS\n${check.rows.map(r=>`Punkt ${r.id}: ${formatDistance(r.error)}`).join('\n')}`;
      }catch(err){ui.validationInfo.textContent='';showError(err);}
      finally{cancellable=false;setBusy(false);}
    }
    async function fitProjections(all) {
      if (busy || capture || !image || points.filter(p => p.fit).length < 3) return;
      ui.notice.textContent = ''; setBusy(true);
      const codes = all ? fixedCodes : [currentCrs().code], computed = [];
      try {
        for (let i=0; i<codes.length; i++) {
          ui.comparisonNote.textContent = `Berechne ${i+1} / ${codes.length}: ${codes[i]}`;
          await new Promise(resolve => setTimeout(resolve, 0));
          try { computed.push({...GeoFit.solve(points, codes[i], image.naturalWidth, image.naturalHeight),model:candidates.find(c=>c.code===codes[i])?.model}); }
          catch (err) { computed.push({ code: codes[i], error: err.message || String(err) }); }
        }
        results = all ? computed : [...results.filter(r => r.code !== codes[0]), ...computed];
        results.sort((a,b) => (a.error ? Infinity : a.fit.rms)-(b.error ? Infinity : b.fit.rms));
        const best = all ? results.find(r => !r.error) : computed.find(r => !r.error);
        if (best) applyResult(best); else showError(computed.map(r => `${r.code}: ${r.error}`).join('\n'));
      } finally { setBusy(false); }
    }
    function fitSource() { if (image) sourceMap.fitBounds([[0,0],[image.naturalHeight,image.naturalWidth]], { padding: [20,20], animate: false }); }
    function readDataUrl(file) { return new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.')); reader.readAsDataURL(file); }); }
    function decodeImage(data) { return new Promise((resolve,reject) => { const img = new Image(); img.onload = () => img.naturalWidth && img.naturalHeight ? resolve(img) : reject(new Error('Leeres Bild.')); img.onerror = () => reject(new Error('Bild konnte nicht geladen werden.')); img.src = data; }); }
    function installImage(img, data, name) {
      image = img; imageData = data; imageName = name;
      if (sourceLayer) sourceMap.removeLayer(sourceLayer);
      sourceLayer = L.imageOverlay(data, [[0,0],[image.naturalHeight,image.naturalWidth]], { interactive: false }).addTo(sourceMap);
      fitSource();
    }
    function saveProject() {
      if (!image || busy || capture) return;
      const viewCenter = map.getCenter().wrap();
      const project = { format: 'pixelkarte-georeferenzierung', version: 2, image: { name: imageName, data: imageData }, points, alignment: { code: currentCrs().code, projection: currentCrs().model, center: { lat: imageCenter.lat, lon: imageCenter.lng }, halfWidth: halfWidthSource, rotation }, view: { center: { lat: Math.max(-85,Math.min(85,viewCenter.lat)), lon: viewCenter.lng }, zoom: map.getZoom(), basemap: els.basemap.value, opacity: Number(els.opacity.value), mesh: renderMesh, showSource: ui.showSource.checked, showResiduals: ui.showResiduals.checked } };
      const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = imageName.replace(/\.[^.]+$/, '') + '.georeferenzierung.json'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function validateProject(data) {
      const finite = Number.isFinite;
      const ll = p => p && finite(p.lat) && finite(p.lon) && Math.abs(p.lat) <= 85.05112878 && Math.abs(p.lon) <= 180;
      if (!data || data.format !== 'pixelkarte-georeferenzierung' || ![1,2].includes(data.version)) throw new Error('Unbekanntes Projektformat oder unbekannte Version.');
      if (typeof data.image?.name !== 'string' || typeof data.image?.data !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(data.image.data)) throw new Error('Projekt enthält kein unterstütztes eingebettetes Bild.');
      if (!Array.isArray(data.points)) throw new Error('Referenzpunktliste fehlt.');
      const ids = new Set();
      for (const p of data.points) {
        if (!p || !Number.isSafeInteger(p.id) || p.id < 1 || ids.has(p.id) || typeof p.fit !== 'boolean' || !ll(p.target) || !p.source || !finite(p.source.u) || !finite(p.source.v) || p.source.u < 0 || p.source.u > 1 || p.source.v < 0 || p.source.v > 1) throw new Error('Ungültiges Referenzpunktpaar.');
        ids.add(p.id);
      }
      const a = data.alignment, v = data.view;
      if (!a || !ll(a.center) || !finite(a.halfWidth) || a.halfWidth <= 0 || !finite(a.rotation) || Math.abs(a.rotation) > 180) throw new Error('Ungültige Ausrichtung.');
      if(a.projection){
        ProjectionSearch.definition(a.projection);
        if(a.code!=='CUSTOM:'+a.projection.family)throw new Error('Projektionscode und Parameter widersprechen sich.');
      }else if(!fixedCodes.includes(a.code))throw new Error('Projektionsparameter fehlen.');
      if (!v || !ll(v.center) || !finite(v.zoom) || v.zoom < 0 || v.zoom > 19 || !Object.hasOwn(basemaps,v.basemap) || !finite(v.opacity) || v.opacity < 0 || v.opacity > 100 || ![12,20,32,48].includes(v.mesh) || typeof v.showSource !== 'boolean' || typeof v.showResiduals !== 'boolean') throw new Error('Ungültige Kartenansicht.');
      return data;
    }
    async function loadProject(file) {
      if (!file || busy) return;
      const version = ++imageLoadVersion; setBusy(true);
      try {
        const data = validateProject(JSON.parse(await file.text())), img = await decodeImage(data.image.data);
        if (version !== imageLoadVersion) return;
        const a = data.alignment, v = data.view;
        if(a.projection)registerModel(a.projection);
        capture = null; installImage(img, data.image.data, data.image.name);
        points = data.points.map(p => ({ id: p.id, fit: p.fit, source: { u: p.source.u, v: p.source.v }, target: { lat: p.target.lat, lon: p.target.lon } })); nextPointId = points.reduce((m,p) => Math.max(m,p.id+1),1);
        currentCrsIndex = candidates.findIndex(c => c.code === a.code);
        imageCenter = L.latLng(a.center.lat,a.center.lon); halfWidthSource = a.halfWidth; rotation = a.rotation; renderMesh = v.mesh;
        els.opacity.value = v.opacity; els.opacityValue.textContent = v.opacity+' %';
        map.removeLayer(activeBasemap); els.basemap.value = v.basemap; activeBasemap = basemaps[v.basemap].addTo(map);
        map.setView([v.center.lat,v.center.lon],v.zoom, { animate: false }); ui.showResiduals.checked = v.showResiduals; setSourceVisible(v.showSource);
        results = []; fitted = true; updateCapture(); ui.notice.textContent = 'Projekt geladen.'; refresh();
      } catch (err) { showError(err); }
      finally { ui.projectFile.value = ''; setBusy(false); }
    }


    els.basemap.addEventListener('change', () => {
      if (activeBasemap) map.removeLayer(activeBasemap);
      activeBasemap = basemaps[els.basemap.value].addTo(map);
      if (els.basemap.value === 'osm' && location.protocol === 'file:') {
        updateStatus('Hinweis: Der OSM-Standardserver kann beim direkten Öffnen dieser Datei HTTP 403 liefern. Nimm dann eine der Esri-Basiskarten.');
      } else {
        updateStatus();
      }
    });

    els.file.addEventListener('change', async () => {
      const file = els.file.files[0]; if (!file) return;
      const version = ++imageLoadVersion; setBusy(true);
      try {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Bitte PNG, JPEG, WebP oder GIF auswählen.');
        const data = await readDataUrl(file), img = await decodeImage(data);
        if (version !== imageLoadVersion) return;
        capture = null; points = []; nextPointId = 1; installImage(img,data,file.name);
        imageCenter = map.getCenter(); halfWidthSource = null; rotation = 0; currentCrsIndex = 3;
        invalidateResults(); updateCapture(); ui.notice.textContent = ''; refresh();
      } catch (err) { showError(err); }
      finally { els.file.value = ''; setBusy(false); }
    });

    els.opacity.addEventListener('input', () => { els.opacityValue.textContent = els.opacity.value + ' %'; overlay.redraw(); });

    ui.addPoint.onclick = () => startCapture();
    ui.cancelPoint.onclick = cancelCapture;
    ui.clearPoints.onclick = () => { points = []; nextPointId = 1; capture = null; updateCapture(); pointsChanged(); };
    ui.showSource.onchange = () => setSourceVisible(ui.showSource.checked);
    ui.showResiduals.onchange = renderPoints;
    ui.sourceFit.onclick = fitSource;
    document.getElementById('zoomImage').onclick = () => {
      if(!image||busy)return;
      try{
        const g=sourceGeometry(),bounds=L.latLngBounds([]);
        for(let j=0;j<=10;j++)for(let i=0;i<=10;i++){
          try{const ll=uvToLatLng(i/10,j/10,g);if(Math.abs(ll.lat)<85&&Math.abs(ll.lng-imageCenter.lng)<180)bounds.extend(ll);}catch(_){}
        }
        if(bounds.isValid())map.fitBounds(bounds,{padding:[24,24],animate:false,maxZoom:16});
      }catch(err){showError(err);}
    };
    ui.fitCrs.onclick = () => fitProjections(true);
    ui.compare.onclick = () => fitProjections(true);
    ui.searchParameters.onclick = searchParameters;
    ui.cancelSearch.onclick = () => {searchCancelled=true;ui.cancelSearch.disabled=true;ui.comparisonNote.textContent='Wird abgebrochen …';};
    ui.validateFit.onclick = validateFit;
    ui.saveProject.onclick = saveProject;
    ui.loadProject.onclick = () => ui.projectFile.click();
    ui.projectFile.onchange = () => loadProject(ui.projectFile.files[0]);
    new ResizeObserver(() => { map.invalidateSize(); sourceMap.invalidateSize(); }).observe(ui.workspace);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && capture) { cancelCapture(); return; }
    });

    refresh(); icons();
