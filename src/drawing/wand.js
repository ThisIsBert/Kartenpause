import L from 'leaflet';
import { densifyPixels } from './magnetic.js';
import { setBusy } from './busy.js';

export function createWand({ map, renderer, getOriginalRaster, onState, onComplete }) {
  const el = id => document.getElementById(id), group = L.layerGroup().addTo(map);
  const canvas = document.createElement('canvas'); canvas.className = 'tracing-brush'; canvas.hidden = true; canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Auswahl mit Pinsel bearbeiten'); map.getContainer().append(canvas);
  let enabled = false, source = null, mask = null, polygons = [], count = 0, worker = null, generation = 0, busy = false;
  let undo = [], redo = [], stroke = null, cursor = null, pointer = null, dragging = false, gestures = [];
  let renderedPolygons = null;
  let preserveExisting = false;
  const status = text => { el('wandStatus').textContent = text; };
  const painting = () => el('wandMode').value.startsWith('paint');
  function ensureSource() {
    if (!source) {
      const next = getOriginalRaster();
      if (next.raster.width * next.raster.height > 25000000) throw new Error('Für die Flächenauswahl bitte eine Vorlage mit höchstens 25 Millionen Pixeln verwenden.');
      source = next; mask = new Uint8Array(source.raster.width * source.raster.height);
    }
    return source;
  }
  function paint() {
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!cursor || !source) return;
    const radius = Number(el('wandBrushSize').value) / 2;
    ctx.strokeStyle = el('wandMode').value === 'paintSubtract' ? '#c64531' : '#176c65'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const angle = i / 40 * Math.PI * 2, p = map.latLngToContainerPoint(source.pixelToLatLng([cursor[0] + Math.cos(angle) * radius, cursor[1] + Math.sin(angle) * radius]));
      if (!i) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    if (stroke?.length) {
      const center = map.latLngToContainerPoint(source.pixelToLatLng(cursor));
      const edge = map.latLngToContainerPoint(source.pixelToLatLng([cursor[0] + radius, cursor[1]]));
      ctx.lineWidth = Math.max(2, center.distanceTo(edge) * 2); ctx.globalAlpha = .25; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
      stroke.forEach((point, i) => { const p = map.latLngToContainerPoint(source.pixelToLatLng(point)); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  function changed() {
    setBusy('wand', busy);
    const wantsPaint = enabled && painting();
    canvas.hidden = !wantsPaint;
    if (wantsPaint && !dragging) { dragging = map.dragging.enabled(); map.dragging.disable(); }
    if (!wantsPaint && dragging) { map.dragging.enable(); dragging = false; }
    el('wandClear').disabled = busy || !mask || !count;
    if (renderedPolygons !== polygons || !enabled) {
      renderedPolygons = polygons;
      group.clearLayers();
      if (enabled && source) for (const polygon of polygons) {
        L.polygon(polygon.map(ring => densifyPixels([...ring, ring[0]]).map(source.pixelToLatLng)), {
          renderer, interactive: false, color: '#087fa6', weight: 1, fillColor: '#11aed2', fillOpacity: .35
        }).addTo(group);
      }
    }
    paint(); onState();
  }
  function startWorker() {
    if (worker) return;
    worker = new Worker(new URL('./selection-worker.js', import.meta.url), { type: 'module' });
    worker.postMessage({ type: 'init', raster: source.raster });
  }
  function snapshot() { return { mask: mask.slice(), polygons, count }; }
  function compute(operation, base = mask, saveHistory = true) {
    const id = ++generation, before = snapshot();
    busy = true; startWorker(); status('Auswahl wird aus den Originalpixeln berechnet …'); changed();
    worker.onmessage = ({ data }) => {
      if (data.id !== generation) return;
      busy = false;
      if (data.error) status(data.error);
      else {
        if (saveHistory) {
          undo.push(before); redo = [];
          const limit = Math.max(1, Math.min(12, Math.floor(32000000 / mask.length)));
          while (undo.length > limit) undo.shift();
        }
        mask = data.mask; polygons = data.polygons; count = data.count;
        status(`${count.toLocaleString('de-DE')} Originalpixel ausgewählt · ${polygons.length} Fläche(n). Mit „Fertig“ als ein Objekt übernehmen.`);
      }
      changed();
    };
    worker.onerror = () => { worker?.terminate(); worker = null; busy = false; status('Die Auswahl konnte nicht berechnet werden. Bitte erneut versuchen.'); changed(); };
    const copy = base.slice(); worker.postMessage({ ...operation, id, mask: copy, preserveExisting }, [copy.buffer]);
  }
  function cancelStroke() {
    stroke = null;
    if (pointer !== null && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    pointer = null; gestures.forEach(handler => handler.enable()); gestures = []; paint();
  }
  function reset() {
    generation++; worker?.terminate(); worker = null; busy = false; cancelStroke();
    mask = source ? new Uint8Array(source.raster.width * source.raster.height) : null;
    polygons = []; count = 0; undo = []; redo = []; cursor = null; preserveExisting = false; status(''); changed();
  }
  const eventPixel = e => {
    const bounds = canvas.getBoundingClientRect();
    return source.latLngToPixel(map.containerPointToLatLng([e.clientX - bounds.left, e.clientY - bounds.top]));
  };
  function resize() { const size = map.getSize(); canvas.width = size.x; canvas.height = size.y; paint(); }
  map.on('resize move zoom', resize); resize();
  canvas.addEventListener('pointerdown', e => {
    if (!enabled || busy || !painting() || e.button !== 0 || pointer !== null) return;
    e.preventDefault(); e.stopPropagation(); canvas.focus({ preventScroll: true });
    try { ensureSource(); cursor = eventPixel(e); if (!cursor) return; }
    catch (error) { status(error.message); return; }
    pointer = e.pointerId; canvas.setPointerCapture(pointer); stroke = [cursor];
    gestures = [map.scrollWheelZoom, map.touchZoom, map.boxZoom, map.keyboard].filter(h => h?.enabled()); gestures.forEach(h => h.disable()); paint();
  });
  canvas.addEventListener('pointermove', e => {
    if (!enabled || !painting()) return;
    try { ensureSource(); } catch (error) { status(error.message); return; }
    cursor = eventPixel(e);
    if (stroke && e.pointerId === pointer && cursor) stroke.push(cursor);
    paint();
  });
  canvas.addEventListener('pointerup', e => {
    if (e.pointerId !== pointer) return;
    e.preventDefault(); e.stopPropagation();
    const points = stroke; cancelStroke();
    compute({ type: 'paint', stroke: points, diameter: Number(el('wandBrushSize').value), add: el('wandMode').value === 'paintAdd' });
  });
  canvas.addEventListener('pointercancel', cancelStroke);
  canvas.addEventListener('lostpointercapture', () => { if (stroke) cancelStroke(); });
  canvas.addEventListener('pointerleave', () => { if (!stroke) { cursor = null; paint(); } });
  for (const name of ['click', 'dblclick', 'mousedown', 'touchstart']) canvas.addEventListener(name, e => e.stopPropagation());
  el('wandMode').onchange = () => { cancelStroke(); changed(); };
  el('wandBrushSize').oninput = () => { el('wandBrushSizeValue').textContent = `${el('wandBrushSize').value} Originalpixel`; paint(); };
  el('wandTolerance').oninput = () => { el('wandToleranceValue').textContent = el('wandTolerance').value; };
  el('wandClear').onclick = () => { if (mask && !busy) compute({ type: 'restore' }, new Uint8Array(mask.length)); };
  return {
    async loadGeometry(worldPolygons, unproject) {
      const token = ++generation;
      busy = true; preserveExisting = true;
      status('Vorhandene Geometrie wird in eine Pixelauswahl umgewandelt …'); changed();
      try {
        ensureSource();
        let deadline = performance.now() + 8, total = 0;
        const checkpoint = async () => {
          if (performance.now() > deadline) { await new Promise(resolve => setTimeout(resolve, 0)); deadline = performance.now() + 8; }
          if (token !== generation) throw new Error('abgebrochen');
        };
        const pixel = point => {
          const p = source.latLngToPixel(unproject(point), .5);
          if (!p) throw new Error('Die Fläche liegt teilweise außerhalb der Pixelkarte oder ist nicht rückprojizierbar. Bitte den Randabschnitt-Modus verwenden.');
          return p;
        };
        const converted = [];
        for (const polygon of worldPolygons) {
          const rings = []; converted.push(rings);
          for (const ring of polygon) {
            const output = []; rings.push(output);
            const edge = async (a, b, pa, pb, depth = 0) => {
              await checkpoint();
              const mid = a.map((v, i) => (v + b[i]) / 2), pm = pixel(mid);
              const distance = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
              const deviation = Math.hypot(pm[0] - (pa[0] + pb[0]) / 2, pm[1] - (pa[1] + pb[1]) / 2);
              if (depth < 16 && (distance > 8 || deviation > .2)) {
                await edge(a, mid, pa, pm, depth + 1); await edge(mid, b, pm, pb, depth + 1);
              } else {
                if (++total > 500000) throw new Error('Die Fläche ist für diese Pixelauswahl zu komplex. Bitte zuerst vereinfachen.');
                output.push(pa);
              }
            };
            let a = ring[0], pa = pixel(a);
            for (let i = 1; i <= ring.length; i++) {
              const b = ring[i % ring.length], pb = pixel(b);
              await edge(a, b, pa, pb); a = b; pa = pb;
            }
          }
        }
        if (token !== generation) return false;
        compute({ type: 'geometry', polygons: converted }, mask, false);
        return true;
      } catch (error) {
        if (token !== generation) return false;
        busy = false; status(error.message); changed(); return false;
      }
    },
    get hasDraft() { return busy || !!count || !!stroke; },
    get canFinish() { return !!count && !busy && !stroke; },
    get canUndo() { return !busy && undo.length > 0; },
    get canRedo() { return !busy && redo.length > 0; },
    setEnabled(value) { if (enabled === value) return; enabled = value; if (!value) { reset(); source = null; mask = null; } else { status('In die gewünschte Farbfläche klicken.'); changed(); } },
    click(ll) {
      if (!enabled || busy || painting()) return;
      try {
        ensureSource(); const seed = source.latLngToPixel(ll);
        if (!seed) { status('Bitte innerhalb der Pixelkarte klicken.'); return; }
        const operation = { type: 'select', seed, mode: el('wandMode').value, tolerance: Number(el('wandTolerance').value), contiguous: el('wandContiguous').checked };
        compute(operation);
      } catch (error) { status(error.message); }
    },
    history(forward) {
      if (busy || stroke) return;
      const from = forward ? redo : undo, to = forward ? undo : redo;
      if (!from.length) return;
      to.push(snapshot()); ({ mask, polygons, count } = from.pop());
      status(`${count.toLocaleString('de-DE')} Originalpixel ausgewählt.`); changed();
    },
    finish() { if (count && !busy && !stroke) { const result = { polygons, source }; reset(); onComplete(result); } },
    cancel: reset
  };
}
