import L from 'leaflet';
import { isClosed, isCurved, minimumPoints, sampledPoints, segmentPoint, toFeature, polygonParts, objectRings, geometryLeaves, ringEntries } from './geometry.js';
import { createMagneticTool, densifyPixels } from './magnetic.js';
import { simplify } from './simplify-path.js';
import { createWand } from './wand.js';
import { drawingFilename } from './export.js';
import { importGeoJSON } from './import.js';
import { vertexCount, geometryCounts } from './simplification.js';
import { setBusy } from './busy.js';
import { linearObject } from './rework-geometry.js';
import { createSectionEditor } from './section-editor.js';

const labels = { multiLine: 'Mehrteilige Linie', multiPoint: 'Punktgruppe', collection: 'Geometriesammlung', point: 'Punkt', line: 'Linie', polygon: 'Polygon', multiPolygon: 'Mehrteilige Fläche', curve: 'Geschwungene Linie', curvePolygon: 'Geschwungenes Polygon' };

export function createDrawingEditor({ map, sourceMap, opacity, canEnter, onModeChange, getOriginalRaster }) {
  const el = id => document.getElementById(id);
  const shapes = L.layerGroup().addTo(map), handles = L.layerGroup().addTo(map);
  map.createPane('drawingShapes');
  map.getPane('drawingShapes').style.zIndex = 450;
  const renderer = L.svg({ pane: 'drawingShapes' });
  let active = false, tool = 'select', objects = [], selectedId = null, vertexIndex = null, draft = null;
  let undo = [], redo = [], layers = new Map();
  let savedObjects = JSON.stringify(objects);
  let vertexRing = 0;
  let simplification = null, simplifyAmount = 0;
  let simplifyWorker = null, simplifyTimer = null, simplifyBusy = false, simplifyGeneration = 0;
  let areaEdit = null;
  const selected = () => objects.find(object => object.id === selectedId);
  const project = ll => { const p = L.CRS.EPSG3857.project(ll); return [p.x, p.y]; };
  const unproject = p => L.CRS.EPSG3857.unproject(L.point(p));
  const toLonLat = p => { const ll = unproject(p); return [ll.lng, ll.lat]; };
  const feature = object => toFeature(object, toLonLat);
  const message = text => { el('drawingStatus').textContent = text; };
  const snapshot = () => JSON.stringify({ objects, selectedId });
  const record = () => { undo.push(snapshot()); if (undo.length > 100) undo.shift(); redo = []; };
  const magnetic = createMagneticTool({ map, renderer, getOriginalRaster,
    getObjects: () => objects.filter(object => !section.active || object.id !== selectedId),
    project, unproject, onState: updateUI, onComplete({ pixels, source, closed }) {
    record();
    const projected = source.vector ? pixels : densifyPixels(pixels).map(p => project(source.pixelToLatLng(p)));
    const origin = project(source.pixelToLatLng(pixels[0]));
    const neighbor = project(source.pixelToLatLng([pixels[0][0] + 1, pixels[0][1]]));
    const tolerance = Math.max(.001, Math.hypot(neighbor[0] - origin[0], neighbor[1] - origin[1]) * .3);
    let vertices = source.vector ? projected.map(p => [...p]) : simplify(projected, tolerance);
    if (closed) vertices = vertices.slice(0, -1);
    if (vertices.length < (closed ? 3 : 2)) { message('Die Form ist zu klein. Bitte weiter auseinanderliegende Anker setzen.'); render(); return; }
    const object = { id: crypto.randomUUID(), kind: closed ? 'polygon' : 'line', name: `Magnetische ${closed ? 'Fläche' : 'Linie'} ${objects.length + 1}`, vertices };
    objects.push(object); selectedId = object.id; vertexIndex = null; tool = 'select';
    message('Magnetische Zeichnung übernommen. Alle Stützpunkte sind bearbeitbar.'); render();
  } });
  const wand = createWand({ map, renderer, getOriginalRaster, onState: updateUI, onComplete({ polygons, source }) {
    const ringToWorld = ring => {
      const dense = densifyPixels([...ring, ring[0]]).map(p => project(source.pixelToLatLng(p)));
      const a = project(source.pixelToLatLng(ring[0])), b = project(source.pixelToLatLng([ring[0][0] + 1, ring[0][1]]));
      return simplify(dense, Math.max(.001, Math.hypot(a[0] - b[0], a[1] - b[1]) * .15)).slice(0, -1);
    };
    const parts = polygons.map(polygon => ({ vertices: ringToWorld(polygon[0]), holes: polygon.slice(1).map(ringToWorld) }));
    const object = { id: areaEdit?.id || crypto.randomUUID(), name: areaEdit?.name || `Ausgewählte Fläche ${objects.length + 1}`,
      ...(parts.length === 1 ? { kind: 'polygon', ...parts[0] } : { kind: 'multiPolygon', parts }) };
    record();
    if (areaEdit) objects = objects.map(existing => existing.id === areaEdit.id ? object : existing);
    else objects.push(object);
    areaEdit = null; selectedId = object.id; vertexIndex = null; vertexRing = 0; tool = 'select';
    message(`${parts.length} Teilfläche(n) einschließlich ihrer Löcher als ein Objekt übernommen.`); render();
  } });

  const section = createSectionEditor({ map, renderer, magnetic, project, unproject, onState: updateUI,
    onComplete(result) {
      record(); objects = objects.map(object => object.id === result.id ? result : object);
      tool = 'select'; vertexIndex = null; message('Randabschnitt ersetzt. Mit Rückgängig wiederherstellen.'); render();
    },
    onCancel() { tool = 'select'; message('Original unverändert.'); render(); }
  });
  const reworking = () => !!areaEdit || section.active;
  function cancelArea() {
    areaEdit = null; tool = 'select'; wand.cancel(); message('Original unverändert.'); render();
  }
  el('reworkArea').onclick = async () => {
    const original = selected();
    if (!original || !isClosed(original.kind) || simplification || reworking()) return;
    const object = linearObject(original), session = { id: object.id, name: object.name };
    areaEdit = session; tool = 'wand'; vertexIndex = null;
    el('wandMode').value = 'add'; render();
    const polygons = polygonParts(object).map(part => [part.vertices, ...(part.holes || [])]);
    const success = await wand.loadGeometry(polygons, unproject);
    if (!success && areaEdit === session) {
      const error = el('wandStatus').textContent; cancelArea(); message(error);
    }
  };
  el('areaApply').onclick = () => wand.finish();
  el('areaCancel').onclick = cancelArea;
  el('reworkSection').onclick = () => {
    if (!selected() || selected().kind === 'point' || simplification || reworking()) return;
    tool = 'section'; vertexIndex = null; section.begin(selected()); render();
  };

  function history(from, to) {
    if (section.active) { if (from === undo) section.undo(); return; }
    if (simplification) { cancelSimplification(); return; }
    if (tool === 'wand' && (areaEdit || wand.hasDraft || wand.canUndo || wand.canRedo)) { wand.history(from === redo); return; }
    if (tool === 'magnetic' && magnetic.hasDraft) { if (from === undo) magnetic.undo(); return; }
    if (draft) {
      if (from === undo) { draft.vertices.pop(); if (!draft.vertices.length) draft = null; render(); }
      return;
    }
    if (!from.length) return;
    to.push(snapshot());
    ({ objects, selectedId } = JSON.parse(from.pop()));
    vertexIndex = null; render();
  }

  function updateUI() {
    const object = selected();
    const pending = !!draft || magnetic.hasDraft || wand.hasDraft || !!simplification || reworking();
    el('drawingSelection').disabled = !object || !!draft || magnetic.hasDraft || wand.hasDraft || reworking();
    el('reworkArea').disabled = !object || !isClosed(object.kind) || !!simplification;
    el('reworkSection').disabled = !object || geometryLeaves(object).every(part => part.kind === 'point') || !!simplification;
    el('areaEditSettings').hidden = !areaEdit;
    el('areaApply').disabled = !wand.canFinish;
    el('sectionSettings').hidden = !section.active;
    if (section.active && magnetic.pendingSegment) el('sectionConnect').disabled = true;
    el('drawingName').value = object?.name || '';
    for (const id of ['drawingName', 'copyDrawing', 'deleteDrawing']) el(id).disabled = !!simplification;
    el('simplifyDrawing').disabled = !object || geometryLeaves(object).every(part => part.kind === 'point');
    el('simplifyDrawing').value = simplifyAmount;
    el('simplifyValue').textContent = `${simplifyAmount} %`;
    el('simplifyStatus').textContent = !object ? 'Objekt auswählen.' : geometryLeaves(object).every(part => part.kind === 'point') ? 'Punkte lassen sich nicht vereinfachen.'
      : simplifyBusy ? `Berechne ${simplifyAmount} % … Der Regler bleibt bedienbar; Verwerfen bricht die Berechnung ab.`
      : simplification ? `Vorschau: ${vertexCount(object)} → ${vertexCount(simplification)} Stützpunkte.${isClosed(object.kind) ? ` ${geometryCounts(object).parts} → ${geometryCounts(simplification).parts} Teilflächen, ${geometryCounts(object).holes} → ${geometryCounts(simplification).holes} Löcher. Kleine Inseln und Löcher können entfallen.` : ''} Übernehmen oder verwerfen.`
        : `${vertexCount(object)} Stützpunkte. Regler zeigt eine Vorschau; 0 stellt die Ausgangsform wieder her.${vertexCount(object) > 1000 ? ' Bei großen Formen werden Griffe ausgedünnt. Zum Bearbeiten einzelner Punkte hineinzoomen.' : ''}`;
    el('applySimplification').disabled = !simplification || simplifyBusy;
    el('cancelSimplification').disabled = !simplification;
    const selectedRing = object && objectRings(object)[vertexRing];
    el('deleteVertex').disabled = !!simplification || vertexIndex === null || !selectedRing || selectedRing.length <= minimumPoints(ringEntries(object)[vertexRing].kind);
    el('finishDrawing').disabled = section.active || (tool === 'wand' ? !wand.canFinish : tool === 'magnetic' ? !magnetic.canFinish : !draft || draft.vertices.length < minimumPoints(draft.kind));
    el('cancelDrawing').disabled = !pending;
    el('undoDrawing').disabled = !undo.length && !draft && !magnetic.canUndo && !simplification && !section.active;
    el('redoDrawing').disabled = !redo.length || pending;
    if (tool === 'wand' && (areaEdit || wand.hasDraft || wand.canUndo || wand.canRedo)) {
      el('undoDrawing').disabled = !wand.canUndo; el('redoDrawing').disabled = !wand.canRedo;
    }
    el('saveDrawing').disabled = !objects.length || pending;
    el('importDrawing').disabled = pending;
    el('pasteDrawing').disabled = pending;
    el('drawingCount').textContent = `Objekte (${objects.length})`;
    el('drawingHelp').textContent = tool === 'select'
      ? 'Objekt anklicken. Stützpunkte ziehen; + auf einer Kante fügt einen Punkt hinzu. Stützpunkt anklicken und mit Entf löschen.'
      : tool === 'magnetic' ? 'Enter übernimmt die Vorschau. Ohne Vorschau schließt „Fertig“ die Linie ab. Für Flächen „Polygon schließen“ wählen und die Schließkante bestätigen. Esc bricht die Zeichnung ab.'
      : tool === 'wand' ? 'Farbfläche auswählen und bei Bedarf mit dem Pinsel korrigieren. Fertig übernimmt die Umrisse, Esc verwirft die Auswahl.'
      : tool === 'point' ? 'Auf die Karte klicken, um einen Punkt zu setzen.'
        : `Stützpunkte durch Klicken setzen. ${isClosed(tool) ? 'Mindestens drei' : 'Mindestens zwei'} Punkte. Mit Enter oder „Fertig“ abschließen, Esc bricht ab.`;
    if (section.active) el('drawingHelp').textContent = 'Sie bearbeiten das ausgewählte Objekt. Methodenwechsel erfolgt oben im Abschnittswerkzeug. Esc verwirft alle Änderungen.';
    document.querySelectorAll('[data-tool]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.tool === tool)); button.disabled = reworking(); });
    map.getContainer().classList.toggle('drawing-crosshair', active && tool !== 'select');
    el('magneticSettings').hidden = tool !== 'magnetic' && !section.active;
    el('magneticActiveSettings').hidden = tool !== 'magnetic' && !section.magneticMode;
    magnetic.setEnabled(active && (tool === 'magnetic' || section.magneticMode));
    el('magneticClose').hidden = section.active;
    el('wandSettings').hidden = tool !== 'wand';
    wand.setEnabled(active && tool === 'wand');
    const list = el('drawingObjects'); list.replaceChildren();
    for (const object of objects) {
      const button = document.createElement('button');
      button.textContent = object.name;
      button.setAttribute('aria-pressed', String(object.id === selectedId));
      button.onclick = () => select(object.id);
      list.append(button);
    }
  }

  function select(id) {
    if (draft || magnetic.hasDraft || wand.hasDraft || simplification || reworking()) { message('Bitte zuerst die begonnene Form oder Vorschau übernehmen oder verwerfen.'); return; }
    selectedId = id; vertexIndex = null; tool = 'select'; message(''); render();
  }

  function drawShape(object, temporary = false) {

    const style = { renderer, color: object.id === selectedId ? '#ce4b13' : '#176c65', weight: 3,
      fillOpacity: .16, bubblingMouseEvents: false, interactive: active && !temporary,
      dashArray: temporary ? '6 6' : undefined };
    const leafLayer = part => {
      const points = sampledPoints(part).map(unproject);
      return part.kind === 'point' ? L.circleMarker(points[0], { ...style, radius: 7, fillOpacity: 1 })
        : isClosed(part.kind) ? L.polygon(polygonLatLngs(part), style) : L.polyline(points, style);
    };
    const layer = object.parts ? L.featureGroup(geometryLeaves(object).map(leafLayer)) : leafLayer(object);
    layer.addTo(shapes);
    if (!temporary) {
      layers.set(object.id, layer);
      layer.on('click', e => tool === 'select' ? select(object.id) : mapClick(e));
      layer.bindTooltip(() => { const span = document.createElement('span'); span.textContent = object.name; return span; });
    }
    return layer;
  }

  function polygonLatLngs(object) {
    const parts = polygonParts(object).map(part => [sampledPoints({ ...part, kind: object.kind === 'multiPolygon' ? 'polygon' : object.kind }).map(unproject),
      ...(part.holes || []).map(ring => ring.map(unproject))]);
    return object.kind === 'multiPolygon' ? parts : parts[0];
  }

  function updateShape(object) {
    const layer = layers.get(object.id);
    const update = (target, part) => {
      if (part.kind === 'point') target.setLatLng(unproject(part.vertices[0]));
      else target.setLatLngs(isClosed(part.kind) ? polygonLatLngs(part) : sampledPoints(part).map(unproject));
    };
    if (object.parts) {
      // Simplification can remove polygon parts, so rebuild grouped layers.
      shapes.removeLayer(layer); drawShape(object);
    } else update(layer, object);
  }

  function marker(point, className, title, draggable = false) {
    return L.marker(unproject(point), { draggable, keyboard: true, title, alt: title,
      bubblingMouseEvents: false, icon: L.divIcon({ className,
        html: `<span>${className.includes('midpoint') ? '+' : ''}</span>`, iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(handles);
  }

  function renderHandles(object) {
    const dense = vertexCount(object) > 1000, cells = new Set(), size = map.getSize();
    let shown = 0;
    const visible = (point, chosen = false) => {
      if (!dense || chosen) return true;
      const p = map.latLngToContainerPoint(unproject(point));
      if (p.x < -18 || p.y < -18 || p.x > size.x + 18 || p.y > size.y + 18 || shown >= 600) return false;
      const cell = `${Math.floor(p.x / 18)},${Math.floor(p.y / 18)}`;
      if (cells.has(cell)) return false;
      cells.add(cell); shown++; return true;
    };
    ringEntries(object).forEach(({ vertices, kind, partIndex, holeIndex }, index) => {
      const prefix = `${object.kind === 'multiPolygon' ? `Teilfläche ${partIndex + 1}: ` : ''}${holeIndex ? `Loch ${holeIndex}: ` : ''}`;
      renderRingHandles(object, vertices, index, prefix, visible, kind);
    });
  }
  function renderRingHandles(object, vertices, ringIndex, prefix, visible, kind = object.kind) {
    const midpointMarkers = [];
    vertices.forEach((point, index) => {
      if (!visible(point, vertexIndex === index && vertexRing === ringIndex)) return;
      const handle = marker(point, `drawing-vertex${vertexIndex === index && vertexRing === ringIndex ? ' chosen' : ''}`, `${prefix}Stützpunkt ${index + 1}`, true);
      const choose = () => {
        vertexIndex = index; vertexRing = ringIndex;
        handles.eachLayer(layer => layer.getElement()?.classList.remove('chosen'));
        handle.getElement().classList.add('chosen'); updateUI();
      };
      handle.getElement().addEventListener('pointerdown', choose);
      handle.on('click', choose);
      handle.on('dragstart', () => { record(); vertexIndex = index; vertexRing = ringIndex; midpointMarkers.forEach(m => handles.removeLayer(m)); });
      handle.on('drag', () => { vertices[index] = project(handle.getLatLng()); updateShape(object); });
      handle.on('dragend', () => { message('Stützpunkt verschoben.'); render(); });
      handle.on('keydown', e => { if (e.originalEvent.key === 'Enter') { vertexIndex = index; vertexRing = ringIndex; render(); } });
    });
    if (kind === 'point') return;
    const count = vertices.length - (isClosed(kind) ? 0 : 1);
    for (let i = 0; i < count; i++) {
      const point = segmentPoint(vertices, i, .5, isCurved(kind), isClosed(kind));
      if (!visible(point)) continue;
      const mid = marker(point, 'drawing-midpoint', `Stützpunkt zwischen ${i + 1} und ${(i + 1) % vertices.length + 1} hinzufügen`, true);
      let inserted = false;
      const insert = () => {
        if (inserted) return;
        record(); vertices.splice(i + 1, 0, point); vertexIndex = i + 1; vertexRing = ringIndex;
        inserted = true;
      };
      mid.on('dragstart', () => {
        insert(); midpointMarkers.filter(m => m !== mid).forEach(m => handles.removeLayer(m));
        mid.getElement().className = 'leaflet-marker-icon drawing-vertex chosen leaflet-zoom-animated leaflet-interactive';
        mid.getElement().firstElementChild.textContent = '';
      });
      mid.on('drag', () => { vertices[i + 1] = project(mid.getLatLng()); updateShape(object); });
      mid.on('dragend', () => { message('Stützpunkt eingefügt und verschoben.'); render(); });
      mid.on('click', () => {
        insert(); message('Stützpunkt hinzugefügt. Zum Verfeinern verschieben.'); render();
      });
      midpointMarkers.push(mid);
    }
  }

  function render() {
    shapes.clearLayers(); handles.clearLayers(); layers = new Map();
    objects.forEach(object => { if (object.id !== areaEdit?.id) drawShape(simplification?.id === object.id ? simplification : object); });
    if (active && selected() && !draft && !simplification && !reworking()) renderHandles(selected());
    if (active && draft) {
      drawShape(draft, true);
      draft.vertices.forEach((point, i) => marker(point, 'drawing-vertex draft', `Neuer Stützpunkt ${i + 1}`));
    }
    updateUI();
  }

  function setMode(value) {
    if (value && !canEnter()) return;
    if (draft || magnetic.hasDraft || wand.hasDraft || simplification || reworking()) { message('Bitte zuerst die begonnene Form oder Vorschau übernehmen oder verwerfen.'); return; }
    active = value;
    document.body.classList.toggle('drawing-mode', active);
    el('sidebar').inert = active;
    el('sourcePanel').inert = active;
    el('drawingSidebar').hidden = !active;
    el('drawingOpacity').value = opacity.value;
    if (active) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
    onModeChange(active); render();
    // ResizeObserver follows the sliding grid throughout its transition.
    requestAnimationFrame(() => { map.invalidateSize({ pan: false }); sourceMap.invalidateSize({ pan: false }); });
    (active ? el('leaveDrawing') : el('enterDrawing')).focus();
  }

  function finish() {
    if (tool === 'wand') { wand.finish(); return; }
    if (tool === 'magnetic') { magnetic.finish(); return; }
    if (!draft || draft.vertices.length < minimumPoints(draft.kind)) return;
    record(); objects.push(draft); selectedId = draft.id; draft = null; vertexIndex = null; tool = 'select';
    message('Objekt angelegt. Die Stützpunkte sind jetzt bearbeitbar.'); render();
  }

  function deleteObject() {
    if (!selected() || draft || simplification || reworking()) return;
    record(); objects = objects.filter(object => object.id !== selectedId); selectedId = null; vertexIndex = null;
    message('Objekt gelöscht. Mit Rückgängig wiederherstellen.'); render();
  }

  function deleteVertex() {
    const object = selected();
    if (!object || vertexIndex === null || draft || simplification || reworking()) return;
    const vertices = objectRings(object)[vertexRing];
    if (!vertices || vertices.length <= minimumPoints(ringEntries(object)[vertexRing].kind)) { message('Diese Form benötigt ihre verbleibenden Stützpunkte.'); return; }
    record(); vertices.splice(vertexIndex, 1); vertexIndex = null; render();
  }

  function mapClick(e) {
    if (!active) return;
    if (simplification) { message('Bitte die Vereinfachung zuerst übernehmen oder verwerfen.'); return; }
    if (section.active) { section.click(e.latlng, e.originalEvent); return; }
    if (tool === 'magnetic') { magnetic.click(e.latlng, e.originalEvent); return; }
    if (tool === 'wand') { wand.click(e.latlng); return; }
    if (tool === 'select') { selectedId = null; vertexIndex = null; render(); return; }
    // Ignore the second click of a double-click rather than making duplicate vertices.
    if (e.originalEvent?.detail > 1) return;
    const point = project(e.latlng);
    if (!draft) {
      selectedId = null; vertexIndex = null;
      draft = { id: crypto.randomUUID(), kind: tool, name: `${labels[tool]} ${objects.length + 1}`, vertices: [] };
    }
    if (draft.vertices.length && Math.hypot(...point.map((v, i) => v - draft.vertices.at(-1)[i])) < 1e-6) return;
    draft.vertices.push(point);
    if (tool === 'point') finish(); else { message(`${draft.vertices.length} Stützpunkte gesetzt.`); render(); }
  }
  map.on('click', mapClick);
  map.on('moveend zoomend', () => {
    const object = selected();
    if (active && object && !draft && !simplification && !reworking() && vertexCount(object) > 1000) {
      handles.clearLayers(); renderHandles(object);
    }
  });
  map.on('mousemove', e => { if (active && (tool === 'magnetic' || section.magneticMode)) magnetic.move(e.latlng); });

  document.querySelectorAll('[data-tool]').forEach(button => {
    button.onclick = () => {
      if (draft || magnetic.hasDraft || wand.hasDraft || simplification || reworking()) { message('Bitte zuerst die begonnene Form oder Vorschau übernehmen oder verwerfen.'); return; }
      tool = button.dataset.tool; selectedId = null; vertexIndex = null; message(''); render();
    };
  });
  el('enterDrawing').onclick = () => setMode(true);
  el('leaveDrawing').onclick = () => setMode(false);
  el('finishDrawing').onclick = finish;
  el('cancelDrawing').onclick = () => { if (section.active) { section.cancel(); return; } if (areaEdit) { cancelArea(); return; } stopSimplification(); simplification = null; simplifyAmount = 0; magnetic.cancel(); wand.cancel(); draft = null; message('Zeichnen abgebrochen.'); render(); };
  function stopSimplification() {
    simplifyGeneration++; clearTimeout(simplifyTimer); simplifyTimer = null;
    simplifyWorker?.terminate(); simplifyWorker = null;
    simplifyBusy = false; setBusy('simplification', false);
  }
  function cancelSimplification() {
    stopSimplification();
    simplification = null; simplifyAmount = 0; message('Vereinfachung verworfen.'); render();
  }
  el('simplifyDrawing').oninput = () => {
    const object = selected();
    if (!object || geometryLeaves(object).every(part => part.kind === 'point')) return;
    stopSimplification();
    simplifyAmount = Number(el('simplifyDrawing').value);
    if (!simplifyAmount) { cancelSimplification(); return; }
    const generation = simplifyGeneration;
    // Keep the last preview visible, but never use it as the next input geometry.
    simplification ||= object;
    simplifyBusy = true; setBusy('simplification', true);
    vertexIndex = null; handles.clearLayers(); updateUI();
    simplifyTimer = setTimeout(() => {
      const fail = error => {
        if (generation !== simplifyGeneration) return;
        cancelSimplification(); message(`Vereinfachung fehlgeschlagen: ${error}. Die Ausgangsform bleibt erhalten.`);
      };
      try {
        simplifyWorker = new Worker(new URL('./simplification-worker.js', import.meta.url), { type: 'module' });
        simplifyWorker.onmessage = ({ data }) => {
          if (generation !== simplifyGeneration) return;
          if (data.error) { fail(data.error); return; }
          stopSimplification(); simplification = data.result;
          updateShape(simplification); updateUI();
        };
        simplifyWorker.onerror = () => fail('Hintergrundberechnung nicht verfügbar');
        simplifyWorker.postMessage({ object, amount: simplifyAmount });
      } catch (error) { fail(error.message); }
    }, 120);
  };
  el('cancelSimplification').onclick = cancelSimplification;
  el('applySimplification').onclick = () => {
    if (!simplification || simplifyBusy) return;
    record(); objects = objects.map(object => object.id === simplification.id ? simplification : object);
    simplification = null; simplifyAmount = 0; message('Objekt vereinfacht und geglättet. Mit Rückgängig wiederherstellen.'); render();
  };
  el('undoDrawing').onclick = () => history(undo, redo);
  el('redoDrawing').onclick = () => history(redo, undo);
  el('deleteDrawing').onclick = deleteObject;
  el('deleteVertex').onclick = deleteVertex;
  el('drawingName').onchange = () => {
    if (!selected()) return;
    record(); selected().name = el('drawingName').value.trim() || labels[selected().kind]; render();
  };
  el('drawingOpacity').oninput = () => { opacity.value = el('drawingOpacity').value; opacity.dispatchEvent(new Event('input')); };
  function loadGeoJSON(text) {
    if (draft || magnetic.hasDraft || wand.hasDraft || simplification || reworking()) { message('Bitte zuerst die begonnene Bearbeitung abschließen oder verwerfen.'); return; }
    try {
      const imported = importGeoJSON(text, p => project(L.latLng(p[1], p[0])));
      record(); for (const object of imported) objects.push(object);
      selectedId = imported[0].id; vertexIndex = null; tool = 'select';
      render();
      const bounds = L.latLngBounds([]);
      for (const object of imported) for (const ring of objectRings(object)) for (const p of ring) bounds.extend(unproject(p));
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
      message(`${imported.length} Objekte importiert. Mit Rückgängig wieder entfernen.`);
    } catch (error) { message(`Import fehlgeschlagen: ${error.message}`); }
  }
  el('importDrawing').onclick = () => el('importDrawingFile').click();
  el('importDrawingFile').onchange = async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    try { loadGeoJSON(await file.text()); } catch (error) { message(`Datei konnte nicht gelesen werden: ${error.message}`); }
  };
  el('pasteDrawing').onclick = async () => {
    try { loadGeoJSON(await navigator.clipboard.readText()); }
    catch { message('Zwischenablage nicht freigegeben. Bitte auf die Karte klicken und Strg+V verwenden.'); }
  };
  el('saveDrawing').onclick = () => {
    const collection = { type: 'FeatureCollection', features: objects.map(feature) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(collection, null, 2)], { type: 'application/geo+json' }));
    const link = document.createElement('a'); link.href = url; link.download = drawingFilename(objects); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    savedObjects = JSON.stringify(objects);
    message(`${objects.length} Objekte als GeoJSON gespeichert.`);
  };
  el('copyDrawing').onclick = async () => {
    if (!selected() || draft || simplification || reworking()) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(feature(selected()), null, 2));
      message('Ausgewähltes Objekt als GeoJSON kopiert.');
    } catch { message('Zwischenablage nicht freigegeben. Bitte Strg+C verwenden.'); }
  };
  const editingText = target => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
  document.addEventListener('paste', e => {
    if (!active || editingText(e.target)) return;
    e.preventDefault(); loadGeoJSON(e.clipboardData.getData('text/plain'));
  });
  document.addEventListener('copy', e => {
    if (!active || !selected() || draft || simplification || reworking() || editingText(e.target) || window.getSelection()?.toString()) return;
    e.clipboardData.setData('text/plain', JSON.stringify(feature(selected()), null, 2));
    e.preventDefault(); message('Ausgewähltes Objekt als GeoJSON kopiert.');
  });
  document.addEventListener('keydown', e => {
    if (!active || editingText(e.target)) return;
    if (section.active && e.key === 'Enter') { e.preventDefault(); section.enter(); return; }
    if (e.key === 'Escape' && reworking()) { e.preventDefault(); if (section.active) section.cancel(); else cancelArea(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); history(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); history(redo, undo); }
    else if (e.key === 'Enter' && tool === 'magnetic') { e.preventDefault(); magnetic.enter(); }
    else if (e.key === 'Enter' && tool === 'wand') { e.preventDefault(); wand.finish(); }
    else if (e.key === 'Enter' && draft) { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { if (simplification) { cancelSimplification(); return; } magnetic.cancel(); wand.cancel(); draft = null; selectedId = null; vertexIndex = null; tool = 'select'; message(''); render(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (vertexIndex !== null) deleteVertex(); else deleteObject(); }
  });
  window.addEventListener('beforeunload', e => {
    if (draft || magnetic.hasDraft || wand.hasDraft || reworking() || JSON.stringify(objects) !== savedObjects) { e.preventDefault(); e.returnValue = ''; }
  });
  render();
}
