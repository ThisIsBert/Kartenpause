import L from 'leaflet';
import { cropSearch } from './magnetic-path.js';

export function densifyPixels(points) {
  const result = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (let j = 0; j < steps; j++) result.push(a.map((v, axis) => v + (b[axis] - v) * j / steps));
  }
  if (points.length) result.push(points.at(-1));
  return result;
}

export function createMagneticTool({ map, renderer, getOriginalRaster, onState, onComplete }) {
  const el = id => document.getElementById(id), group = L.layerGroup().addTo(map);
  let enabled = false, source = null, anchors = [], segments = [], preview = null, worker = null, target = null;
  let picking = false, color = null, generation = 0, closing = false, moveFrame = 0, mouse = null;
  const status = text => { el('magneticStatus').textContent = text; };
  const path = () => segments.flatMap((segment, i) => i ? segment.slice(1) : segment);
  function paint() {
    group.clearLayers();
    if (!enabled || !source) return;
    const line = (points, color, dashArray) => L.polyline(densifyPixels(points).map(source.pixelToLatLng), {
      renderer, color, weight: 3, dashArray, interactive: false
    }).addTo(group);
    if (segments.length) line(path(), '#176c65');
    if (preview) line(preview, '#df6e12', '5 5');
    for (const anchor of anchors) L.circleMarker(source.pixelToLatLng(anchor), { renderer, color: '#fff', fillColor: '#176c65', fillOpacity: 1, weight: 1, radius: 4, interactive: false }).addTo(group);
    if (target) L.circleMarker(source.pixelToLatLng(target), { renderer, color: '#df6e12', fillOpacity: .4, weight: 1, radius: 5, interactive: false }).addTo(group);
  }
  function changed() {
    el('magneticAccept').disabled = !preview || !!worker || picking;
    el('magneticReject').disabled = !target && !preview && !worker;
    el('magneticClose').disabled = anchors.length < 3 || !!preview || !!worker || picking;
    el('magneticPick').setAttribute('aria-pressed', String(picking));
    el('magneticClearColor').disabled = !color;
    el('magneticColor').textContent = color ? `Linienfarbe: #${color.map(v => v.toString(16).padStart(2, '0')).join('')}` : 'Ohne Farbvorgabe';
    el('magneticSwatch').style.backgroundColor = color ? `rgb(${color.join(',')})` : 'transparent';
    paint(); onState();
  }
  function stopSearch() { generation++; worker?.terminate(); worker = null; }
  function reset() {
    stopSearch(); anchors = []; segments = []; preview = null; target = null; closing = false; picking = false;
    status(''); changed();
  }
  function ensureSource() {
    if (!source) source = getOriginalRaster();
    return source;
  }
  function request(end, close = false) {
    stopSearch(); preview = null; target = end; closing = close;
    try {
      const crop = cropSearch(source.raster, anchors.at(-1), end, Number(el('magneticRadius').value));
      const requestId = generation;
      worker = new Worker(new URL('./magnetic-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (requestId !== generation) return;
        worker.terminate(); worker = null;
        if (data.error) status(data.error);
        else {
          preview = data.result.pixels.map(p => [p[0] + crop.offset[0], p[1] + crop.offset[1]]);
          // Keep shared anchor coordinates exact across independently searched segments.
          preview[0] = [...anchors.at(-1)]; preview[preview.length - 1] = [...end];
          status(close ? 'Schließenden Abschnitt prüfen. „Abschnitt übernehmen“ erstellt das Polygon.' : 'Orange Vorschau prüfen und übernehmen. Ein weiterer Kartenklick ersetzt den vorgeschlagenen Endanker.');
        }
        changed();
      };
      worker.onerror = () => { if (requestId !== generation) return; stopSearch(); status('Die Suche konnte nicht ausgeführt werden. Bitte erneut versuchen.'); changed(); };
      worker.postMessage({ raster: crop.raster, start: crop.start, end: crop.end,
        radius: Number(el('magneticRadius').value), color, tolerance: Number(el('magneticTolerance').value) }, [crop.raster.data.buffer]);
      status('Suche in den Originalpixeln …');
    } catch (error) { stopSearch(); status(error.message); }
    changed();
  }
  function complete(closed) {
    const pixels = path();
    if (pixels.length < (closed ? 4 : 2)) return;
    const result = { pixels, source, closed };
    reset(); onComplete(result);
  }
  function accept() {
    if (!preview || worker || picking) return;
    segments.push(preview); anchors.push(target); preview = null; target = null;
    if (closing) complete(true);
    else { status('Abschnitt übernommen. Nächsten Anker setzen oder mit „Fertig“ die Linie abschließen.'); changed(); }
  }
  function reject() { stopSearch(); preview = null; target = null; closing = false; status('Vorschau verworfen. Einen neuen Endanker oder einen näheren Zwischenanker setzen.'); changed(); }
  function recompute() { if (target && anchors.length) request(target, closing); else changed(); }
  el('magneticAccept').onclick = accept;
  el('magneticReject').onclick = reject;
  el('magneticClose').onclick = () => { if (anchors.length >= 3 && !worker && !preview) request(anchors[0], true); };
  el('magneticPick').onclick = () => {
    picking = !picking;
    status(picking ? 'Mit der Pixellupe auf ein typisches Pixel der gewünschten Linie klicken. Dies setzt keinen Anker.' : 'Farbaufnahme beendet.'); changed();
  };
  el('magneticClearColor').onclick = () => { color = null; picking = false; recompute(); };
  for (const id of ['magneticRadius', 'magneticTolerance']) {
    el(id).oninput = () => { el(`${id}Value`).textContent = el(id).value + (id === 'magneticRadius' ? ' Originalpixel' : ''); };
    el(id).onchange = recompute;
  }
  return {
    get hasDraft() { return anchors.length > 0 || !!worker; },
    get canFinish() { return segments.length > 0 && !preview && !worker && !target && !picking; },
    get canUndo() { return anchors.length > 0; },
    setEnabled(value) {
      if (value === enabled) return;
      enabled = value;
      if (!enabled) { reset(); source = null; cancelAnimationFrame(moveFrame); moveFrame = 0; }
      else { status('Startanker auf die Bildlinie setzen oder zuerst mit der Farbpipette eine Linienfarbe aufnehmen.'); }
    },
    click(ll) {
      try {
        ensureSource();
        const pixel = source.latLngToPixel(ll);
        if (!pixel) { status('Bitte innerhalb der eingepassten Pixelkarte klicken.'); return; }
        const rounded = pixel.map(Math.round), index = (rounded[1] * source.raster.width + rounded[0]) * 4;
        if (source.raster.data[index + 3] < 128) { status('Dieses Bildpixel ist transparent. Bitte auf die sichtbare Bildlinie klicken.'); return; }
        if (picking) { color = [...source.raster.data.slice(index, index + 3)]; picking = false; status('Linienfarbe aufgenommen.'); recompute(); return; }
        if (!anchors.length) { anchors = [rounded]; status('Startanker gesetzt. Nun den nächsten Anker auf derselben Bildlinie anklicken.'); changed(); }
        else request(rounded);
      } catch (error) { status(error.message); }
    },
    move(ll) {
      if (!enabled) return;
      mouse = ll;
      if (moveFrame) return;
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0;
        try {
          ensureSource(); const pixel = source.latLngToPixel(mouse), canvas = el('magneticLoupe'), ctx = canvas.getContext('2d');
          ctx.fillStyle = '#e9eceb'; ctx.fillRect(0, 0, 180, 180);
          if (!pixel) { el('magneticPixel').textContent = 'Außerhalb der Pixelkarte'; return; }
          const [x, y] = pixel.map(Math.round);
          ctx.imageSmoothingEnabled = false; ctx.drawImage(source.canvas, x - 11, y - 11, 23, 23, -2, -2, 184, 184);
          ctx.strokeStyle = '#e96e18'; ctx.lineWidth = 1; ctx.strokeRect(86.5, 86.5, 7, 7);
          el('magneticPixel').textContent = `Originalpixel ${x}, ${y} · 8-fach, ohne Glättung`;
        } catch (error) { status(error.message); }
      });
    },
    undo() {
      if (target || preview || worker) reject();
      else { segments.pop(); anchors.pop(); status('Letzten Anker zurückgenommen.'); changed(); }
    },
    enter() { if (picking) return; if (preview) accept(); else if (segments.length && !worker && !target) complete(false); },
    finish() { if (segments.length && !preview && !worker && !target && !picking) complete(false); },
    cancel: reset
  };
}
