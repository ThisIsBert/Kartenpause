import L from 'leaflet';
import { setBusy } from './busy.js';
import { cropSearch } from './magnetic-path.js';
import { continuesSegment } from './magnetic-click.js';
import { removeSpurs } from './path-cleanup.js';
import { polygonHit, edgePath } from './polygon-follow.js';

export function densifyPixels(points) {
  const result = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (let j = 0; j < steps; j++) result.push(a.map((v, axis) => v + (b[axis] - v) * j / steps));
  }
  if (points.length) result.push(points.at(-1));
  return result;
}

export function createMagneticTool({ map, renderer, getOriginalRaster, getObjects, project, unproject, onState, onComplete }) {
  const el = id => document.getElementById(id), group = L.layerGroup().addTo(map);
  let enabled = false, source = null, anchors = [], segments = [], preview = null, worker = null, target = null;
  let picking = false, color = null, generation = 0, closing = false, moveFrame = 0, mouse = null;
  let color2 = null;
  let segmentHandler = null;
  const vectorMode = () => el('magneticSource').value === 'polygon';
  const screen = p => { const q = map.project(unproject(p)); return [q.x, q.y]; };
  function snap(ll, exact = false) {
    const p = map.project(ll), position = [p.x, p.y];
    const found = polygonHit(getObjects(), position, screen);
    return exact ? project(ll) : found?.hit.point || project(ll);
  }
  const status = text => { el('magneticStatus').textContent = text; };
  const path = () => {
    const points = segments.flatMap((segment, i) => i ? segment.slice(1) : segment);
    return source?.vector ? points : removeSpurs(points);
  };
  function paint() {
    group.clearLayers();
    if (!enabled || !source) return;
    const line = (points, color, dashArray) => L.polyline((source.vector ? points : densifyPixels(points)).map(source.pixelToLatLng), {
      renderer, color, weight: 3, dashArray, interactive: false
    }).addTo(group);
    if (segments.length) line(path(), '#176c65');
    if (preview) line(preview, '#df6e12', '5 5');
    for (const anchor of anchors) L.circleMarker(source.pixelToLatLng(anchor), { renderer, color: '#fff', fillColor: '#176c65', fillOpacity: 1, weight: 1, radius: 4, interactive: false }).addTo(group);
    if (target) L.circleMarker(source.pixelToLatLng(target), { renderer, color: '#df6e12', fillOpacity: .4, weight: 1, radius: 5, interactive: false }).addTo(group);
  }
  function changed() {
    el('magneticRasterSettings').hidden = vectorMode();
    el('polygonFollowHelp').hidden = !vectorMode();
    el('magneticSource').disabled = anchors.length > (segmentHandler ? 1 : 0) || !!preview || !!worker;
    el('magneticAccept').disabled = !preview || !!worker || picking;
    el('magneticReject').disabled = !target && !preview && !worker;
    el('magneticClose').disabled = anchors.length < 3 || !!preview || !!worker || picking;
    el('magneticPick').setAttribute('aria-pressed', String(picking === 1));
    el('magneticPick2').setAttribute('aria-pressed', String(picking === 2));
    el('magneticClearColor2').disabled = !color2;
    el('magneticColor2').textContent = color2 ? `Zweite Farbe: #${color2.map(v => v.toString(16).padStart(2, '0')).join('')}` : 'Optional: zweite Flächenfarbe';
    el('magneticSwatch2').style.backgroundColor = color2 ? `rgb(${color2.join(',')})` : 'transparent';
    el('magneticColorMode').textContent = color && color2 ? 'Suche nach dem Übergang zwischen beiden Farben.' : 'Suche nach einer abgesetzten Bildlinie.';
    el('magneticClearColor').disabled = !color;
    el('magneticColor').textContent = color ? `Linienfarbe: #${color.map(v => v.toString(16).padStart(2, '0')).join('')}` : 'Ohne Farbvorgabe';
    el('magneticSwatch').style.backgroundColor = color ? `rgb(${color.join(',')})` : 'transparent';
    paint(); onState();
  }
  function stopSearch() { generation++; worker?.terminate(); worker = null; setBusy('magnetic', false); }
  function reset() {
    stopSearch(); anchors = []; segments = []; preview = null; target = null; closing = false; picking = false;
    status(''); changed();
  }
  function ensureSource() {
    if (!source) source = vectorMode() ? { vector: true, pixelToLatLng: unproject, latLngToPixel: project } : getOriginalRaster();
    return source;
  }
  function request(end, close = false) {
    stopSearch(); preview = null; target = end; closing = close;
    try {
      if (source.vector) {
        preview = edgePath(getObjects(), anchors.at(-1), end, screen);
        status(close ? 'Schließenden Abschnitt prüfen und übernehmen.' : 'Kantenverlauf als Vorschau. Weiterklicken setzt fort; Alt korrigiert. Ohne passende Kante wird gerade verbunden.');
        changed(); return;
      }
      const crop = cropSearch(source.raster, anchors.at(-1), end, Number(el('magneticRadius').value));
      const requestId = generation;
      worker = new Worker(new URL('./magnetic-worker.js', import.meta.url), { type: 'module' });
      setBusy('magnetic', true);
      worker.onmessage = ({ data }) => {
        if (requestId !== generation) return;
        worker.terminate(); worker = null;
        setBusy('magnetic', false);
        if (data.error) status(data.error);
        else {
          preview = data.result.pixels.map(p => [p[0] + crop.offset[0], p[1] + crop.offset[1]]);
          // Keep shared anchor coordinates exact across independently searched segments.
          preview[0] = [...anchors.at(-1)]; preview[preview.length - 1] = [...end];
          status(close ? 'Schließenden Abschnitt prüfen. „Abschnitt übernehmen“ erstellt das Polygon.' : 'Weiterklicken übernimmt diesen Abschnitt. Ein Klick zurück in den Abschnitt korrigiert ihn. Alt: immer korrigieren; Umschalt: immer fortsetzen.');
        }
        changed();
      };
      worker.onerror = () => { if (requestId !== generation) return; stopSearch(); status('Die Suche konnte nicht ausgeführt werden. Bitte erneut versuchen.'); changed(); };
      worker.postMessage({ raster: crop.raster, start: crop.start, end: crop.end,
        radius: Number(el('magneticRadius').value), color, color2, tolerance: Number(el('magneticTolerance').value) }, [crop.raster.data.buffer]);
      status('Suche in den Originalpixeln …');
    } catch (error) { stopSearch(); status(error.message); }
    changed();
  }
  function complete(closed) {
    const pixels = closed && !source.vector ? removeSpurs(path(), 1e-7, true) : path();
    if (pixels.length < (closed ? 4 : 2)) return;
    const result = { pixels, source, closed };
    reset(); onComplete(result);
  }
  function accept() {
    if (!preview || worker || picking) return;
    if (segmentHandler) {
      const pixels = preview, end = target;
      preview = null; target = null; anchors = [end]; segments = []; closing = false;
      segmentHandler({ pixels, source }); changed(); return;
    }
    segments.push(preview); anchors.push(target); preview = null; target = null;
    if (closing) complete(true);
    else { status('Abschnitt übernommen. Nächsten Anker setzen oder mit „Fertig“ die Linie abschließen.'); changed(); }
  }
  function reject() { stopSearch(); preview = null; target = null; closing = false; status('Vorschau verworfen. Einen neuen Endanker oder einen näheren Zwischenanker setzen.'); changed(); }
  function recompute() { if (target && anchors.length) request(target, closing); else changed(); }
  el('magneticSource').onchange = () => {
    const previousSource = source;
    const seedPoint = segmentHandler && anchors.length ? source.pixelToLatLng(anchors.at(-1)) : null;
    reset(); source = null;
    try {
      if (seedPoint) { ensureSource(); anchors = [source.vector ? snap(seedPoint, true) : source.latLngToPixel(seedPoint, .5)]; if (!anchors[0]) { anchors = []; throw new Error('Anker liegt außerhalb der Pixelkarte.'); } }
      status(vectorMode() ? 'Startpunkt setzen. Nahe Linien und Flächenränder werden erkannt.' : 'Startanker auf die Bildlinie setzen.');
    } catch (error) {
      if (seedPoint) {
        source = previousSource;
        el('magneticSource').value = source.vector ? 'polygon' : 'raster';
        anchors = [source.latLngToPixel(seedPoint, .5)];
      }
      status(error.message);
    }
    changed();
  };
  el('magneticAccept').onclick = accept;
  el('magneticReject').onclick = reject;
  el('magneticClose').onclick = () => { if (anchors.length >= 3 && !worker && !preview) request(anchors[0], true); };
  el('magneticPick').onclick = () => {
    picking = picking === 1 ? false : 1;
    status(picking ? 'Mit der Pixellupe auf ein typisches Pixel der gewünschten Linie klicken. Dies setzt keinen Anker.' : 'Farbaufnahme beendet.'); changed();
  };
  el('magneticClearColor').onclick = () => { color = null; picking = false; recompute(); };
  el('magneticPick2').onclick = () => { picking = picking === 2 ? false : 2; status('Auf die andere Farbfläche neben der Grenze klicken. Dies setzt keinen Anker.'); changed(); };
  el('magneticClearColor2').onclick = () => { color2 = null; picking = false; recompute(); };
  for (const id of ['magneticRadius', 'magneticTolerance']) {
    el(id).oninput = () => { el(`${id}Value`).textContent = el(id).value + (id === 'magneticRadius' ? ' Originalpixel' : ''); };
    el(id).onchange = recompute;
  }
  return {
    get pendingSegment() { return !!preview || !!target || !!worker || !!picking; },
    get isPicking() { return !!picking; },
    toAnchor(ll) {
      ensureSource(); const point = source.vector ? snap(ll, true) : source.latLngToPixel(ll, .5);
      if (!point) throw new Error('Der Endpunkt liegt außerhalb der Pixelkarte. Bitte manuell verbinden.');
      if (segmentHandler && preview) accept();
      request(point);
    },
    setSegmentHandler(handler) { segmentHandler = handler; },
    seed(ll) {
      ensureSource();
      const point = source.vector ? snap(ll, true) : source.latLngToPixel(ll, .5);
      if (!point) throw new Error('Der Anker liegt außerhalb der Pixelkarte. Hier bitte manuell zeichnen.');
      stopSearch(); anchors = [point]; segments = []; preview = null; target = null; closing = false; picking = false; changed();
    },
    get hasDraft() { return anchors.length > 0 || !!worker; },
    get canFinish() { return segments.length > 0 && !preview && !worker && !target && !picking; },
    get canUndo() { return anchors.length > 0; },
    setEnabled(value) {
      if (value === enabled) return;
      enabled = value;
      if (!enabled) { reset(); source = null; cancelAnimationFrame(moveFrame); moveFrame = 0; }
      else { status(vectorMode() ? 'Startpunkt setzen. Nahe Linien und Flächenränder werden erkannt.' : 'Startanker auf die Bildlinie setzen oder zuerst mit der Farbpipette eine Linienfarbe aufnehmen.'); }
    },
    click(ll, modifiers = {}) {
      try {
        ensureSource();
        if (source.vector) {
          const point = snap(ll);
          if (!anchors.length) { anchors = [point]; status('Startpunkt gesetzt. Weiterklicken folgt nahen Kanten oder verbindet gerade.'); changed(); return; }
          if (preview && !closing && !modifiers.altKey) {
            if (segmentHandler) accept();
            else { segments.push(preview); anchors.push(target); preview = null; target = null; }
          }
          request(point); return;
        }
        const pixel = source.latLngToPixel(ll);
        if (!pixel) { status('Bitte innerhalb der eingepassten Pixelkarte klicken.'); return; }
        const rounded = pixel.map(Math.round), index = (rounded[1] * source.raster.width + rounded[0]) * 4;
        if (source.raster.data[index + 3] < 128) { status('Dieses Bildpixel ist transparent. Bitte auf die sichtbare Bildlinie klicken.'); return; }
        if (picking) {
          const sample = [...source.raster.data.slice(index, index + 3)];
          if (picking === 2) color2 = sample; else color = sample;
          picking = false; status('Farbe aufgenommen.'); recompute(); return;
        }
        if (!anchors.length) { anchors = [rounded]; status('Startanker gesetzt. Nun den nächsten Anker auf derselben Bildlinie anklicken.'); changed(); }
        else {
          if (preview && !closing && !modifiers.altKey && (modifiers.shiftKey || continuesSegment(anchors.at(-1), target, rounded))) {
            if (segmentHandler) accept();
            else { segments.push(preview); anchors.push(target); preview = null; target = null; }
          }
          request(rounded);
        }
      } catch (error) { status(error.message); }
    },
    move(ll) {
      if (!enabled || vectorMode()) return;
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
