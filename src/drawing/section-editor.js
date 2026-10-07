import L from 'leaflet';
import { isClosed, geometryLeaves } from './geometry.js';
import { linearObject, nearestEdge, replaceArc, selectedArc, shorterArcIsOther } from './rework-geometry.js';
import { removeSpurs } from './path-cleanup.js';
import { densifyPixels } from './magnetic.js';
import { setBusy } from './busy.js';

export function createSectionEditor({ map, renderer, magnetic, project, unproject, onState, onComplete, onCancel }) {
  const el = id => document.getElementById(id), group = L.layerGroup().addTo(map), handles = L.layerGroup().addTo(map);
  let object = null, start = null, end = null, path = [], steps = [], other = false, method = 'manual';
  let candidate = null, ready = false, worker = null, generation = 0;
  let preview = null, issues = [], magneticChain = null, normalized = null, chosen = null, dragging = false, pathLayer = null;
  const screen = p => { const s = map.project(unproject(p)); return [s.x, s.y]; };
  const nearEnd = p => end && Math.hypot(...screen(p).map((v, i) => v - screen(end.point)[i])) < 12;
  const status = text => { el('sectionStatus').textContent = text; };
  function stop() { generation++; worker?.terminate(); worker = null; setBusy('section', false); }
  function changed() {
    group.clearLayers();
    if (object) {
      if (preview) for (const part of geometryLeaves(preview)) if (isClosed(part.kind)) {
        L.polygon([part.vertices, ...(part.holes || [])].map(ring => ring.map(unproject)),
          { renderer, color: '#087fa6', weight: 1, fillColor: '#087fa6', fillOpacity: .2, interactive: false }).addTo(group);
      }
      const line = (points, color, dashArray) => L.polyline(points.map(unproject), { renderer, color, dashArray, weight: 4, interactive: false }).addTo(group);
      if (start && end) line(selectedArc(object, start, end, other), '#c64531', '7 5');
      pathLayer = path.length > 1 ? line(path, '#087fa6') : null;
      for (const issue of issues) for (const edge of issue.segments || []) line(edge, '#c22', '3 5');
      for (const issue of issues) if (issue.point) L.circleMarker(unproject(issue.point), {
        renderer, radius: 10, color: '#c22', weight: 3, fillOpacity: .15, interactive: false
      }).bindTooltip(issue.reason, { permanent: true, direction: 'right', className: 'section-issue' }).addTo(group);
      for (const [anchor, label] of [[start, 'A'], [end, 'B']]) if (anchor) {
        L.circleMarker(unproject(anchor.point), { renderer, radius: 6, color: '#fff', fillColor: '#087fa6', fillOpacity: 1, weight: 2, interactive: false })
          .bindTooltip(label, { permanent: true, direction: 'top' }).addTo(group);
      }
    }
    el('sectionMethod').value = method;
    el('sectionMethod').disabled = !end || ready || !!worker;
    el('sectionConnect').disabled = !end || ready || !!worker || (method === 'magnetic' && magnetic.pendingSegment);
    el('sectionApply').disabled = !candidate || !!worker || (method === 'magnetic' && magnetic.pendingSegment);
    el('sectionUseRepair').hidden = !normalized;
    el('sectionUseRepair').disabled = !!worker;
    el('sectionEditHelp').hidden = !ready;
    el('sectionDeleteVertex').hidden = !ready;
    el('sectionDeleteVertex').disabled = chosen === null || chosen === 0 || chosen === path.length - 1;
    el('sectionUndo').disabled = !start;
    renderHandles();
    el('sectionReset').disabled = !start;
    onState();
  }
  const remember = () => steps.push({ path: path.map(p => [...p]), chain: structuredClone(magneticChain), ready });
  function invalidate() { stop(); candidate = null; normalized = null; issues = []; el('sectionApply').disabled = true; el('sectionUseRepair').disabled = true; }
  function renderHandles() {
    if (dragging) return;
    handles.clearLayers();
    if (!object || !ready) return;
    const cells = new Set(), size = map.getSize(); let shown = 0;
    const visible = (point, selected = false) => {
      const p = map.latLngToContainerPoint(unproject(point));
      if (p.x < -18 || p.y < -18 || p.x > size.x + 18 || p.y > size.y + 18) return false;
      if (selected || path.length < 600) return true;
      const cell = `${Math.floor(p.x / 16)},${Math.floor(p.y / 16)}`;
      if (shown >= 600 || cells.has(cell)) return false;
      cells.add(cell); shown++; return true;
    };
    const marker = (point, className, title, draggable) => L.marker(unproject(point), {
      draggable, keyboard: true, title, alt: title, bubblingMouseEvents: false,
      icon: L.divIcon({ className, html: `<span>${className.includes('midpoint') ? '+' : ''}</span>`, iconSize: [18, 18], iconAnchor: [9, 9] })
    }).addTo(handles);
    for (let i = 1; i < path.length - 1; i++) {
      if (!visible(path[i], chosen === i)) continue;
      const handle = marker(path[i], `drawing-vertex section-vertex${chosen === i ? ' chosen' : ''}`, `Ersatzstützpunkt ${i}`, true);
      handle.on('click', () => { chosen = i; changed(); });
      handle.on('dragstart', () => { remember(); invalidate(); chosen = i; dragging = true; magneticChain = null; });
      handle.on('drag', () => { path[i] = project(handle.getLatLng()); pathLayer?.setLatLngs(path.map(unproject)); });
      handle.on('dragend', () => { dragging = false; check(); });
    }
    for (let i = 0; i < path.length - 1; i++) {
      if (Math.hypot(...screen(path[i]).map((v, k) => v - screen(path[i + 1])[k])) < 26) continue;
      const point = path[i].map((v, k) => (v + path[i + 1][k]) / 2);
      if (!visible(point)) continue;
      marker(point, 'drawing-midpoint section-midpoint', 'Ersatzstützpunkt hinzufügen', false).on('click', () => {
        remember(); path.splice(i + 1, 0, point); chosen = i + 1; magneticChain = null; check();
      });
    }
  }
  function deleteVertex() {
    if (!ready || chosen === null || chosen === 0 || chosen === path.length - 1) return;
    remember(); path.splice(chosen, 1); chosen = null; magneticChain = null; check();
  }
  map.on('zoomend moveend', () => { if (object && ready) renderHandles(); });
  function check() {
    invalidate(); preview = null;
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
        preview = data.normalized || data.result || result;
        normalized = data.valid ? null : data.normalized;
        if (data.valid) {
          candidate = data.result;
          status(`${data.cleaned ? 'Flächenlose Rückläufe bereinigt. ' : ''}Vorschau fertig. Stützpunkte können verschoben werden. Übernehmen ersetzt den Randabschnitt.`);
        } else {
          const parts = normalized ? geometryLeaves(normalized).filter(p => isClosed(p.kind)) : [];
          const counts = normalized ? ` Bereinigter Flächenvorschlag: ${parts.length} Teilfläche(n), ${parts.reduce((n, p) => n + (p.holes?.length || 0), 0)} Loch/Löcher. Prüfen und bestätigen oder den Verlauf korrigieren.` : '';
          status(data.error || `Die beteiligten Randabschnitte sind rot markiert. Blaue Stützpunkte verschieben oder über + ergänzen; der Verlauf bleibt erhalten.${counts}`);
        }
        changed();
      };
      worker.onerror = () => { if (token === generation) { stop(); status('Die Prüfung ist fehlgeschlagen. Der Verlauf bleibt erhalten und seine Stützpunkte sind bearbeitbar.'); changed(); } };
      worker.postMessage({ result, original: object });
    } catch (error) { stop(); status(error.message); }
    changed();
  }
  function append(points, exactEnd = false) {
    if (ready) return;
    remember();
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
    preview = null; issues = []; magneticChain = null; normalized = null; chosen = null; handles.clearLayers();
    status('Anfang A auf dem Rand anklicken. Danach Ende B auf demselben Rand wählen.'); changed();
  }
  function undo() {
    if (!object) return;
    if (method === 'magnetic' && magnetic.pendingSegment) { magnetic.undo(); changed(); return; }
    invalidate(); preview = null; chosen = null;
    if (steps.length) {
      const previous = steps.pop(); path = previous.path; ready = !!previous.ready;
      if (ready) { magnetic.cancel(); magneticChain = previous.chain; check(); }
      else {
        if (method === 'magnetic') { seed(); magneticChain = previous.chain; }
        status('Letzte Änderung zurückgenommen.'); changed();
      }
    }

    else resetAnchors();
  }
  function cancel() {
    stop(); object = null; magnetic.setSegmentHandler(null); magnetic.cancel(); group.clearLayers(); handles.clearLayers(); onCancel();
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
  el('sectionDeleteVertex').onclick = deleteVertex;
  el('sectionUseRepair').onclick = () => {
    if (!normalized || worker) return;
    candidate = normalized; normalized = null; issues = [];
    status('Bereinigte Flächenaufteilung bestätigt. Mit Übernehmen speichern oder Stützpunkte weiter korrigieren.'); changed();
  };
  el('sectionUndo').onclick = undo;
  el('sectionReset').onclick = resetAnchors;
  el('sectionCancel').onclick = cancel;
  el('sectionApply').onclick = () => {
    if (!candidate || worker || magnetic.pendingSegment) return;
    const result = candidate;
    stop(); object = null; magnetic.setSegmentHandler(null); magnetic.cancel(); group.clearLayers(); handles.clearLayers(); onComplete(result);
  };
  return {
    get active() { return !!object; },
    get magneticMode() { return !!object && !!end && !ready && method === 'magnetic'; },
    begin(original) {
      object = linearObject(original); resetAnchors();
      magnetic.setSegmentHandler(({ pixels, source }) => {
        if (ready) return;
        if (source.vector || source.basemap) {
          magneticChain = null;
          const points = source.basemap ? removeSpurs(pixels).map(p => project(source.pixelToLatLng(p))) : pixels.map(p => [...p]);
          append(points, true); return;
        }
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
        const p = map.project(ll), hit = nearestEdge(object, [p.x, p.y], screen, start?.ringIndex ?? null);
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
    undo, cancel, deleteVertex,
    enter() { if (method === 'magnetic' && magnetic.pendingSegment) magnetic.enter(); else if (candidate) el('sectionApply').click(); else el('sectionConnect').click(); }
  };
}
