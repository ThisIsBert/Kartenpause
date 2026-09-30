import L from 'leaflet';
import { isClosed, polygonParts } from './geometry.js';
import { linearObject, nearestEdge, replaceArc, selectedArc, shorterArcIsOther } from './rework-geometry.js';
import { removeSpurs } from './path-cleanup.js';
import { densifyPixels } from './magnetic.js';
import { setBusy } from './busy.js';

export function createSectionEditor({ map, renderer, magnetic, project, unproject, onState, onComplete, onCancel }) {
  const el = id => document.getElementById(id), group = L.layerGroup().addTo(map);
  let object = null, start = null, end = null, path = [], steps = [], other = false, method = 'manual';
  let candidate = null, ready = false, worker = null, generation = 0;
  let preview = null, issues = [], magneticChain = null;
  const screen = p => { const s = map.latLngToContainerPoint(unproject(p)); return [s.x, s.y]; };
  const nearEnd = p => end && Math.hypot(...screen(p).map((v, i) => v - screen(end.point)[i])) < 12;
  const status = text => { el('sectionStatus').textContent = text; };
  function stop() { generation++; worker?.terminate(); worker = null; setBusy('section', false); }
  function changed() {
    group.clearLayers();
    if (object) {
      if (preview && isClosed(preview.kind)) {
        L.polygon(polygonParts(preview).map(part => [part.vertices, ...(part.holes || [])].map(ring => ring.map(unproject))),
          { renderer, color: '#087fa6', weight: 1, fillColor: '#087fa6', fillOpacity: .2, interactive: false }).addTo(group);
      }
      const line = (points, color, dashArray) => L.polyline(points.map(unproject), { renderer, color, dashArray, weight: 4, interactive: false }).addTo(group);
      if (start && end) line(selectedArc(object, start, end, other), '#c64531', '7 5');
      if (path.length > 1) line(path, '#087fa6');
      for (const issue of issues) if (issue.point) L.circleMarker(unproject(issue.point), {
        renderer, radius: 10, color: '#c22', weight: 3, fillOpacity: .15
      }).bindTooltip(issue.reason, { permanent: true, direction: 'right' }).addTo(group);
      for (const [anchor, label] of [[start, 'A'], [end, 'B']]) if (anchor) {
        L.circleMarker(unproject(anchor.point), { renderer, radius: 6, color: '#fff', fillColor: '#087fa6', fillOpacity: 1, weight: 2, interactive: false })
          .bindTooltip(label, { permanent: true, direction: 'top' }).addTo(group);
      }
    }
    el('sectionMethod').value = method;
    el('sectionMethod').disabled = !end || ready || !!worker;
    el('sectionConnect').disabled = !end || ready || !!worker || (method === 'magnetic' && magnetic.pendingSegment);
    el('sectionApply').disabled = !candidate || !!worker || (method === 'magnetic' && magnetic.pendingSegment);
    el('sectionUndo').disabled = !start;
    el('sectionReset').disabled = !start;
    onState();
  }
  function check() {
    stop(); candidate = null; preview = null; issues = [];
    if (!ready) { changed(); return; }
    let result;
    try { result = replaceArc(object, start, end, path, other); }
    catch (error) { status(error.message); changed(); return; }
    const token = generation;
    preview = result;
    try {
      worker = new Worker(new URL('./rework-worker.js', import.meta.url), { type: 'module' });
      setBusy('section', true); status('Ersatzverlauf wird geprüft …');
      worker.onmessage = ({ data }) => {
        if (token !== generation) return;
        stop();
        issues = data.issues || [];
        if (data.valid) { candidate = result; status('Vorschau fertig. Rot gestrichelt: alter Abschnitt. Blau: Ersatz. Übernehmen ersetzt nur diesen Abschnitt.'); }
        else status(data.error || 'Der Ersatz ist geometrisch ungültig. Die erste problematische Stelle ist rot markiert. Bitte den Verlauf dort korrigieren.');
        changed();
      };
      worker.onerror = () => { if (token === generation) { stop(); status('Die Geometrieprüfung ist fehlgeschlagen. Bitte neu zeichnen.'); changed(); } };
      worker.postMessage({ result, original: object });
    } catch (error) { stop(); status(error.message); }
    changed();
  }
  function append(points, exactEnd = false) {
    if (ready) return;
    steps.push({ path: path.map(p => [...p]), chain: structuredClone(magneticChain) });
    for (let i = 1; i < points.length; i++) path.push(points[i]);
    if (nearEnd(path.at(-1)) && (!exactEnd || Math.hypot(...path.at(-1).map((v, i) => v - end.point[i])) < 1e-6)) { path[path.length - 1] = [...end.point]; ready = true; check(); }
    else { status('Weiterzeichnen oder „Mit Endpunkt B verbinden“ wählen.'); changed(); }
  }
  function seed() {
    magneticChain = null;
    try { magnetic.seed(unproject(path.at(-1))); return true; }
    catch (error) { method = 'manual'; status(error.message); changed(); return false; }
  }
  function resetAnchors() {
    stop(); magnetic.cancel(); start = null; end = null; path = []; steps = []; candidate = null; ready = false; other = false; method = 'manual';
    preview = null; issues = []; magneticChain = null;
    status('Anfang A auf dem Rand anklicken. Danach Ende B auf demselben Rand wählen.'); changed();
  }
  function undo() {
    if (!object) return;
    if (method === 'magnetic' && magnetic.pendingSegment) { magnetic.undo(); changed(); return; }
    stop(); candidate = null; preview = null; issues = []; ready = false;
    if (steps.length) {
      const previous = steps.pop(); path = previous.path;
      if (method === 'magnetic') { seed(); magneticChain = previous.chain; }
      status('Letztes Teilstück zurückgenommen.'); changed();
    }
    else resetAnchors();
  }
  function cancel() {
    stop(); object = null; magnetic.setSegmentHandler(null); magnetic.cancel(); group.clearLayers(); onCancel();
  }
  el('sectionMethod').onchange = () => {
    if (!end || ready) return;
    if (magnetic.pendingSegment) { status('Bitte zuerst die magnetische Vorschau bestätigen oder verwerfen.'); changed(); return; }
    method = el('sectionMethod').value; changed();
    if (method === 'magnetic') seed();
  };
  el('sectionConnect').onclick = () => {
    if (!end || ready || worker || (method === 'magnetic' && magnetic.pendingSegment)) return;
    if (method === 'magnetic') {
      try { magnetic.toAnchor(unproject(end.point)); } catch (error) { status(error.message); }
    } else append([path.at(-1), end.point]);
  };
  el('sectionUndo').onclick = undo;
  el('sectionReset').onclick = resetAnchors;
  el('sectionCancel').onclick = cancel;
  el('sectionApply').onclick = () => {
    if (!candidate || worker || magnetic.pendingSegment) return;
    const result = candidate;
    stop(); object = null; magnetic.setSegmentHandler(null); magnetic.cancel(); group.clearLayers(); onComplete(result);
  };
  return {
    get active() { return !!object; },
    get magneticMode() { return !!object && !!end && method === 'magnetic'; },
    begin(original) {
      object = linearObject(original); resetAnchors();
      magnetic.setSegmentHandler(({ pixels, source }) => {
        if (ready) return;
        if (source.vector) { magneticChain = null; append(pixels.map(p => [...p]), true); return; }
        const previous = { path: path.map(p => [...p]), chain: structuredClone(magneticChain) };
        if (!magneticChain) magneticChain = { base: path.map(p => [...p]), pixels: [] };
        magneticChain.pixels = removeSpurs([...magneticChain.pixels, ...pixels.slice(magneticChain.pixels.length ? 1 : 0)]);
        const points = densifyPixels(magneticChain.pixels).map(p => project(source.pixelToLatLng(p)));
        path = magneticChain.base.map(p => [...p]);
        append(points);
        steps[steps.length - 1] = previous;
      });
    },
    click(ll, modifiers) {
      if (!object) return;
      if (!end) {
        const p = map.latLngToContainerPoint(ll), hit = nearestEdge(object, [p.x, p.y], screen, start?.ringIndex ?? null);
        if (!hit || hit.distance > 16) { status('Bitte nahe am gleichen Rand klicken (höchstens 16 Bildschirmpixel).'); return; }
        if (!start) { start = hit; status('Jetzt Ende B auf demselben Rand wählen.'); }
        else if (Math.hypot(...hit.point.map((v, i) => v - start.point[i])) < 1e-6) { status('Anfang und Ende müssen verschieden sein.'); return; }
        else { end = hit; other = shorterArcIsOther(object, start, end); path = [start.point]; status('Der kürzere Randabschnitt wird ersetzt (rot gestrichelt). Von A nach B zeichnen; die fertige Vorschau zeigt die neue Fläche.'); }
        changed(); return;
      }
      if (ready) return;
      if (method === 'magnetic') {
        if (!magnetic.isPicking && nearEnd(project(ll))) { try { magnetic.toAnchor(unproject(end.point)); } catch (error) { status(error.message); } }
        else magnetic.click(ll, modifiers);
      } else {
        const point = project(ll);
        if (Math.hypot(...point.map((v, i) => v - path.at(-1)[i])) > 1e-6) append([path.at(-1), point]);
      }
    },
    undo, cancel,
    enter() { if (method === 'magnetic' && magnetic.pendingSegment) magnetic.enter(); else if (candidate) el('sectionApply').click(); else el('sectionConnect').click(); }
  };
}
