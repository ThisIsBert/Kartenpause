import { bindAttribute, bindText, t, tr } from '../i18n.js';
import L from 'leaflet';
import { setBusy } from './busy.js';
import { cropSearch } from './magnetic-path.js';
import { continuesSegment } from './magnetic-click.js';
import { removeSpurs } from './path-cleanup.js';
import { polygonHit, edgePath } from './polygon-follow.js';
import { createBasemapCoordinates } from './basemap-source.js';

export function densifyPixels(points) {
  const result = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (let j = 0; j < steps; j++) result.push(a.map((v, axis) => v + (b[axis] - v) * j / steps));
  }
  if (points.length) result.push(points.at(-1));
  return result;
}

export function createMagneticTool({ map, renderer, getOriginalRaster, getBasemapRaster, getObjects, project, unproject, onState, onComplete }) {
  const el = id => document.getElementById(id), group = L.layerGroup().addTo(map);
  let enabled = false, source = null, anchors = [], segments = [], preview = null, worker = null, target = null;
  let picking = false, color = null, generation = 0, closing = false, moveFrame = 0, mouse = null;
  let color2 = null;
  let segmentHandler = null;
  let mapMoving = false, basemapRaster = null, basemapDirty = true;
  const basemapMode = () => el('magneticSource').value === 'basemap';
  const pixelUnit = () => basemapMode() ? t('Kartenpixel') : t('Originalpixel');
  const outsideMessage = () => basemapMode() ? t('Außerhalb des aktuellen Kartenausschnitts. Bitte die Karte verschieben oder herauszoomen.') : t('Außerhalb der Pixelkarte');
  map.on('movestart zoomstart', () => { mapMoving = true; });
  map.on('moveend zoomend resize', () => {
    mapMoving = false;
    basemapDirty = true;
  });
  map.on('layeradd layerremove', e => {
    if (e.layer instanceof L.TileLayer) basemapDirty = true;
  });
  const vectorMode = () => el('magneticSource').value === 'polygon';
  const screen = p => { const q = map.project(unproject(p)); return [q.x, q.y]; };
  function snap(ll, exact = false) {
    const p = map.project(ll), position = [p.x, p.y];
    const found = polygonHit(getObjects(), position, screen);
    return exact ? project(ll) : found?.hit.point || project(ll);
  }
  const status = text => { bindText(el('magneticStatus'), () => text); };
  const path = () => {
    const points = segments.flatMap((segment, i) => i ? segment.slice(1) : segment);
    return source?.vector ? points : removeSpurs(points);
  };
  function paint() {
    group.clearLayers();
    if (!enabled || !source) return;
    const line = (points, color, dashArray) => L.polyline((source.vector || source.basemap ? points : densifyPixels(points)).map(source.pixelToLatLng), {
      renderer, color, weight: 3, dashArray, interactive: false
    }).addTo(group);
    if (segments.length) line(path(), '#176c65');
    if (preview) line(preview, '#df6e12', '5 5');
    for (const anchor of anchors) L.circleMarker(source.pixelToLatLng(anchor), { renderer, color: '#fff', fillColor: '#176c65', fillOpacity: 1, weight: 1, radius: 4, interactive: false }).addTo(group);
    if (target) L.circleMarker(source.pixelToLatLng(target), { renderer, color: '#df6e12', fillOpacity: .4, weight: 1, radius: 5, interactive: false }).addTo(group);
  }
  const canClose = () => anchors.length + (preview ? 1 : 0) >= 3 && !worker && !picking;
  function changed() {
    el('magneticRasterSettings').hidden = vectorMode();
    el('basemapFollowHelp').hidden = !basemapMode();
    bindText(el('magneticRadiusValue'), () => el('magneticRadius').value + ' ' + pixelUnit());
    bindAttribute(el('magneticLoupe'), "aria-label", () => t('Lupe der ') + pixelUnit());
    el('polygonFollowHelp').hidden = !vectorMode();
    el('magneticSource').disabled = anchors.length > (segmentHandler ? 1 : 0) || !!preview || !!worker;
    el('magneticAccept').disabled = !preview || !!worker || picking;
    el('magneticReject').disabled = !target && !preview && !worker;
    el('magneticClose').disabled = !canClose();
    el('magneticPick').setAttribute('aria-pressed', String(picking === 1));
    el('magneticPick2').setAttribute('aria-pressed', String(picking === 2));
    el('magneticClearColor2').disabled = !color2;
    bindText(el('magneticColor2'), () => color2 ? tr`Zweite Farbe: #${color2.map(v => v.toString(16).padStart(2, '0')).join('')}` : t('Optional: zweite Flächenfarbe'));
    el('magneticSwatch2').style.backgroundColor = color2 ? `rgb(${color2.join(',')})` : 'transparent';
    bindText(el('magneticColorMode'), () => color && color2 ? t('Suche nach dem Übergang zwischen beiden Farben.') : t('Suche nach einer abgesetzten Bildlinie.'));
    el('magneticClearColor').disabled = !color;
    bindText(el('magneticColor'), () => color ? tr`Linienfarbe: #${color.map(v => v.toString(16).padStart(2, '0')).join('')}` : t('Ohne Farbvorgabe'));
    el('magneticSwatch').style.backgroundColor = color ? `rgb(${color.join(',')})` : 'transparent';
    paint(); onState();
  }
  function stopSearch() { generation++; worker?.terminate(); worker = null; setBusy('magnetic', false); }
  function reset() {
    stopSearch(); anchors = []; segments = []; preview = null; target = null; closing = false; picking = false;
    if (source?.basemap) source = null;
    basemapRaster = null; basemapDirty = true;
    status(''); changed();
  }
  function ensureSource() {
    if (basemapMode()) {
      if (mapMoving) throw new Error(t('Bitte warten, bis die Kartenbewegung beendet ist.'));
      if (basemapDirty || !basemapRaster) {
        const next = getBasemapRaster();
        basemapRaster = next; basemapDirty = false;
      }
      if (!source) source = createBasemapCoordinates(basemapRaster);
      source.pixelScale = Math.min(source.pixelScale, 2 ** (source.zoom - basemapRaster.zoom));
    } else if (!source) {
      source = vectorMode() ? { vector: true, pixelToLatLng: unproject, latLngToPixel: project } : getOriginalRaster();
    }
    return source;
  }
  const currentRaster = () => source.basemap ? basemapRaster : source;
  function request(end, close = false, autoAccept = false) {
    stopSearch(); preview = null; target = end; closing = close;
    try {
      ensureSource();
      if (source.vector) {
        preview = edgePath(getObjects(), anchors.at(-1), end, screen);
        status(close ? t('Schließstrecke ermittelt. Polygon wird übernommen.') : t('Kantenverlauf als Vorschau. Weiterklicken setzt fort; Alt korrigiert. Ohne passende Kante wird gerade verbunden.'));
        if (autoAccept) accept();
        changed(); return;
      }
      const rasterSource = currentRaster();
      const searchPoint = p => source.basemap ? rasterSource.latLngToPixel(source.pixelToLatLng(p), .5) : p;
      const start = searchPoint(anchors.at(-1)), finish = searchPoint(end);
      if (!start || !finish) throw new Error(t('Für den nächsten Abschnitt müssen letzter Anker und Ziel im Kartenausschnitt liegen. Bitte die Karte verschieben oder herauszoomen; die Zeichnung bleibt erhalten.'));
      const crop = cropSearch(rasterSource.raster, start, finish, Number(el('magneticRadius').value));
      const requestId = generation;
      worker = new Worker(new URL('./magnetic-worker.js', import.meta.url), { type: 'module' });
      setBusy('magnetic', true);
      worker.onmessage = ({ data }) => {
        if (requestId !== generation) return;
        worker.terminate(); worker = null;
        setBusy('magnetic', false);
        if (data.error) status(data.error);
        else {
          preview = data.result.pixels.map(p => {
            const pixel = [p[0] + crop.offset[0], p[1] + crop.offset[1]];
            return source.basemap ? source.latLngToPixel(rasterSource.pixelToLatLng(pixel)) : pixel;
          });
          // Keep shared anchor coordinates exact across independently searched segments.
          preview[0] = [...anchors.at(-1)]; preview[preview.length - 1] = [...end];
          status(close ? t('Schließstrecke ermittelt. Polygon wird übernommen.') : t('Weiterklicken übernimmt diesen Abschnitt. Ein Klick zurück in den Abschnitt korrigiert ihn. Alt: immer korrigieren; Umschalt: immer fortsetzen.'));
        }
        if (autoAccept && preview) accept();
        changed();
      };
      worker.onerror = () => { if (requestId !== generation) return; stopSearch(); status(t('Die Suche konnte nicht ausgeführt werden. Bitte erneut versuchen.')); changed(); };
      worker.postMessage({ raster: crop.raster, start: crop.start, end: crop.end,
        radius: Number(el('magneticRadius').value), color, color2, tolerance: Number(el('magneticTolerance').value) }, [crop.raster.data.buffer]);
      status(source.basemap ? tr`Suche in der Basiskarte (Zoom ${rasterSource.zoom}) …` : t('Suche in den Originalpixeln …'));
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
    else { status(t('Abschnitt übernommen. Nächsten Anker setzen oder mit „Fertig“ die Linie abschließen.')); changed(); }
  }
  function reject() { stopSearch(); preview = null; target = null; closing = false; status(t('Vorschau verworfen. Einen neuen Endanker oder einen näheren Zwischenanker setzen.')); changed(); }
  function recompute() { if (target && anchors.length) request(target, closing, closing); else changed(); }
  el('magneticSource').onchange = () => {
    const previousSource = source;
    const seedPoint = segmentHandler && anchors.length ? source.pixelToLatLng(anchors.at(-1)) : null;
    reset(); source = null; color = null; color2 = null;
    try {
      if (seedPoint) { ensureSource(); anchors = [source.vector ? snap(seedPoint, true) : source.latLngToPixel(seedPoint, .5)]; if (!anchors[0]) { anchors = []; throw new Error(outsideMessage()); } }
      status(vectorMode() ? t('Startpunkt setzen. Nahe Linien und Flächenränder werden erkannt.') : basemapMode() ? t('Passend zoomen, dann Startanker auf eine Linie der Basiskarte setzen.') : t('Startanker auf die Bildlinie setzen.'));
    } catch (error) {
      if (seedPoint) {
        source = previousSource;
        el('magneticSource').value = source.vector ? 'polygon' : source.basemap ? 'basemap' : 'raster';
        anchors = [source.latLngToPixel(seedPoint, .5)];
      }
      status(error.message);
    }
    changed();
  };
  el('magneticAccept').onclick = accept;
  el('magneticReject').onclick = reject;
  el('magneticClose').onclick = () => {
    if (!canClose()) return;
    if (preview) accept();
    request(anchors[0], true, true);
  };
  el('magneticPick').onclick = () => {
    picking = picking === 1 ? false : 1;
    status(picking ? t('Mit der Pixellupe auf ein typisches Pixel der gewünschten Linie klicken. Dies setzt keinen Anker.') : t('Farbaufnahme beendet.')); changed();
  };
  el('magneticClearColor').onclick = () => { color = null; picking = false; recompute(); };
  el('magneticPick2').onclick = () => { picking = picking === 2 ? false : 2; status(t('Auf die andere Farbfläche neben der Grenze klicken. Dies setzt keinen Anker.')); changed(); };
  el('magneticClearColor2').onclick = () => { color2 = null; picking = false; recompute(); };
  for (const id of ['magneticRadius', 'magneticTolerance']) {
    el(id).oninput = () => { bindText(el(`${id}Value`), () => el(id).value + (id === 'magneticRadius' ? ' ' + pixelUnit() : '')); };
    el(id).onchange = recompute;
  }
  return {
    get pendingSegment() { return !!preview || !!target || !!worker || !!picking; },
    get isPicking() { return !!picking; },
    get canConnect() { return !worker && !picking; },
    toAnchor(ll, { autoAccept = false } = {}) {
      ensureSource(); const point = source.vector ? snap(ll, true) : source.latLngToPixel(ll, .5);
      if (!point) throw new Error(tr`${outsideMessage()}${t(' Bitte manuell verbinden.')}`);
      if (segmentHandler && preview) accept();
      if (!anchors.length) return; // Accepting the preview may already have reached B.
      request(point, false, autoAccept);
    },
    setSegmentHandler(handler) { segmentHandler = handler; },
    seed(ll) {
      ensureSource();
      const point = source.vector ? snap(ll, true) : source.latLngToPixel(ll, .5);
      if (!point) throw new Error(tr`${outsideMessage()}${t(' Hier bitte manuell zeichnen.')}`);
      stopSearch(); anchors = [point]; segments = []; preview = null; target = null; closing = false; picking = false; changed();
    },
    get hasDraft() { return anchors.length > 0 || !!worker; },
    get canFinish() { return segments.length > 0 && !preview && !worker && !target && !picking; },
    get canUndo() { return anchors.length > 0; },
    setEnabled(value) {
      if (value === enabled) return;
      enabled = value;
      if (!enabled) { reset(); source = null; cancelAnimationFrame(moveFrame); moveFrame = 0; }
      else {
        if (!vectorMode()) {
          const ctx = el('magneticLoupe').getContext('2d');
          ctx.imageSmoothingEnabled = false;
          bindText(el('magneticPixel'), () => pixelUnit() + t('-Lupe: Maus über die Karte bewegen · 8-fach, ohne Glättung.'));
        }
        status(vectorMode() ? t('Startpunkt setzen. Nahe Linien und Flächenränder werden erkannt.') : t('Startanker auf die Bildlinie setzen oder zuerst mit der Farbpipette eine Linienfarbe aufnehmen.'));
      }
    },
    click(ll, modifiers = {}) {
      try {
        ensureSource();
        if (source.vector) {
          const point = snap(ll);
          if (!anchors.length) { anchors = [point]; status(t('Startpunkt gesetzt. Weiterklicken folgt nahen Kanten oder verbindet gerade.')); changed(); return; }
          if (preview && !closing && !modifiers.altKey) {
            if (segmentHandler) accept();
            else { segments.push(preview); anchors.push(target); preview = null; target = null; }
          }
          request(point); return;
        }
        const rasterSource = currentRaster();
        const pixel = rasterSource.latLngToPixel(ll);
        if (!pixel) { status(outsideMessage()); return; }
        const rounded = pixel.map(Math.round), index = (rounded[1] * rasterSource.raster.width + rounded[0]) * 4;
        if (rasterSource.raster.data[index + 3] < 128) { status(source.basemap ? t('Hier fehlen Kartenpixel. Bitte auf eine geladene Kartenlinie klicken.') : t('Dieses Bildpixel ist transparent. Bitte auf die sichtbare Bildlinie klicken.')); return; }
        if (picking) {
          const sample = [...rasterSource.raster.data.slice(index, index + 3)];
          if (picking === 2) color2 = sample; else color = sample;
          picking = false; status(t('Farbe aufgenommen.')); recompute(); return;
        }
        const point = source.basemap ? source.latLngToPixel(rasterSource.pixelToLatLng(rounded)) : rounded;
        if (!anchors.length) { anchors = [point]; status(t('Startanker gesetzt. Nun den nächsten Anker auf derselben Bildlinie anklicken.')); changed(); }
        else {
          if (preview && !closing && !modifiers.altKey && (modifiers.shiftKey || continuesSegment(...[anchors.at(-1), target, point].map(p => source.basemap ? rasterSource.projectLatLng(source.pixelToLatLng(p)) : p)))) {
            if (segmentHandler) accept();
            else { segments.push(preview); anchors.push(target); preview = null; target = null; }
          }
          request(point);
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
          ensureSource(); const rasterSource = currentRaster(), pixel = rasterSource.latLngToPixel(mouse), canvas = el('magneticLoupe'), ctx = canvas.getContext('2d');
          ctx.fillStyle = '#e9eceb'; ctx.fillRect(0, 0, 180, 180);
          if (!pixel) { bindText(el('magneticPixel'), () => outsideMessage()); return; }
          const [x, y] = pixel.map(Math.round);
          ctx.imageSmoothingEnabled = false; ctx.drawImage(rasterSource.canvas, x - 11, y - 11, 23, 23, -2, -2, 184, 184);
          ctx.strokeStyle = '#e96e18'; ctx.lineWidth = 1; ctx.strokeRect(86.5, 86.5, 7, 7);
          bindText(el('magneticPixel'), () => tr`${pixelUnit()} ${x}, ${y}${source.basemap ? tr` · Zoom ${rasterSource.zoom}` : ''} · 8-fach, ohne Glättung`);
        } catch (error) { status(error.message); }
      });
    },
    undo() {
      if (target || preview || worker) reject();
      else { segments.pop(); anchors.pop(); if (!anchors.length && source?.basemap) source = null; status(t('Letzten Anker zurückgenommen.')); changed(); }
    },
    enter() { if (picking) return; if (preview) accept(); else if (segments.length && !worker && !target) complete(false); },
    finish() { if (segments.length && !preview && !worker && !target && !picking) complete(false); },
    cancel: reset
  };
}