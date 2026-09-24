import L from 'leaflet';
import { isClosed, isCurved, minimumPoints, sampledPoints, segmentPoint, toFeature } from './geometry.js';
import { createTracingBrush } from './brush.js';
import { createMagneticTool, densifyPixels } from './magnetic.js';
import { simplify } from './trace.js';

const labels = { point: 'Punkt', line: 'Linie', polygon: 'Polygon', curve: 'Geschwungene Linie', curvePolygon: 'Geschwungenes Polygon' };

export function createDrawingEditor({ map, sourceMap, opacity, canEnter, onModeChange, getRaster, getOriginalRaster }) {
  const el = id => document.getElementById(id);
  const shapes = L.layerGroup().addTo(map), handles = L.layerGroup().addTo(map);
  map.createPane('drawingShapes');
  map.getPane('drawingShapes').style.zIndex = 450;
  const renderer = L.svg({ pane: 'drawingShapes' });
  let active = false, tool = 'select', objects = [], selectedId = null, vertexIndex = null, draft = null;
  let undo = [], redo = [], layers = new Map();
  let savedObjects = JSON.stringify(objects);
  const selected = () => objects.find(object => object.id === selectedId);
  const project = ll => { const p = L.CRS.EPSG3857.project(ll); return [p.x, p.y]; };
  const unproject = p => L.CRS.EPSG3857.unproject(L.point(p));
  const toLonLat = p => { const ll = unproject(p); return [ll.lng, ll.lat]; };
  const feature = object => toFeature(object, toLonLat);
  const message = text => { el('drawingStatus').textContent = text; };
  const snapshot = () => JSON.stringify({ objects, selectedId });
  const record = () => { undo.push(snapshot()); if (undo.length > 100) undo.shift(); redo = []; };
  const brush = createTracingBrush({ map, getRaster, onMessage: message, onResult(result) {
    record();
    const kind = result.closed ? 'polygon' : 'line';
    const object = { id: crypto.randomUUID(), kind, name: `Erkannte ${result.closed ? 'Fläche' : 'Linie'} ${objects.length + 1}`,
      vertices: result.vertices.map(point => project(map.containerPointToLatLng(point))) };
    objects.push(object); selectedId = object.id; vertexIndex = null; tool = 'select';
    message(`${result.closed ? 'Polygon' : 'Linie'} erkannt: ${object.vertices.length} Stützpunkte. Bitte prüfen und bei Bedarf nachbearbeiten.`); render();
  } });
  const magnetic = createMagneticTool({ map, renderer, getOriginalRaster, onState: updateUI, onComplete({ pixels, source, closed }) {
    record();
    const projected = densifyPixels(pixels).map(p => project(source.pixelToLatLng(p)));
    const origin = project(source.pixelToLatLng(pixels[0]));
    const neighbor = project(source.pixelToLatLng([pixels[0][0] + 1, pixels[0][1]]));
    const tolerance = Math.max(.001, Math.hypot(neighbor[0] - origin[0], neighbor[1] - origin[1]) * .3);
    let vertices = simplify(projected, tolerance);
    if (closed) vertices = vertices.slice(0, -1);
    if (vertices.length < (closed ? 3 : 2)) { message('Die Form ist zu klein. Bitte weiter auseinanderliegende Anker setzen.'); render(); return; }
    const object = { id: crypto.randomUUID(), kind: closed ? 'polygon' : 'line', name: `Magnetische ${closed ? 'Fläche' : 'Linie'} ${objects.length + 1}`, vertices };
    objects.push(object); selectedId = object.id; vertexIndex = null; tool = 'select';
    message('Magnetische Zeichnung übernommen. Alle Stützpunkte sind bearbeitbar.'); render();
  } });

  function history(from, to) {
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
    const pending = !!draft || magnetic.hasDraft;
    el('drawingSelection').disabled = !object || pending;
    el('drawingName').value = object?.name || '';
    el('deleteVertex').disabled = vertexIndex === null || !object || object.vertices.length <= minimumPoints(object.kind);
    el('finishDrawing').disabled = tool === 'magnetic' ? !magnetic.canFinish : !draft || draft.vertices.length < minimumPoints(draft.kind);
    el('cancelDrawing').disabled = !pending;
    el('undoDrawing').disabled = !undo.length && !draft && !magnetic.canUndo;
    el('redoDrawing').disabled = !redo.length || pending;
    el('saveDrawing').disabled = !objects.length || pending;
    el('drawingCount').textContent = `Objekte (${objects.length})`;
    el('drawingHelp').textContent = tool === 'select'
      ? 'Objekt anklicken. Stützpunkte ziehen; + auf einer Kante fügt einen Punkt hinzu. Stützpunkt anklicken und mit Entf löschen.'
      : tool === 'brush' ? 'Bildlinie mit gedrückter Maustaste abfahren; Esc bricht ab. Die Pinselspur begrenzt den Suchbereich.'
      : tool === 'magnetic' ? 'Enter übernimmt die Vorschau. Ohne Vorschau schließt „Fertig“ die Linie ab. Für Flächen „Polygon schließen“ wählen und die Schließkante bestätigen. Esc bricht die Zeichnung ab.'
      : tool === 'point' ? 'Auf die Karte klicken, um einen Punkt zu setzen.'
        : `Stützpunkte durch Klicken setzen. ${isClosed(tool) ? 'Mindestens drei' : 'Mindestens zwei'} Punkte. Mit Enter oder „Fertig“ abschließen, Esc bricht ab.`;
    document.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
    map.getContainer().classList.toggle('drawing-crosshair', active && tool !== 'select');
    el('brushSettings').hidden = tool !== 'brush';
    brush.setEnabled(active && tool === 'brush');
    el('magneticSettings').hidden = tool !== 'magnetic';
    magnetic.setEnabled(active && tool === 'magnetic');
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
    if (draft || magnetic.hasDraft) { message('Bitte zuerst die begonnene Form fertigstellen oder abbrechen.'); return; }
    selectedId = id; vertexIndex = null; tool = 'select'; message(''); render();
  }

  function drawShape(object, temporary = false) {
    const points = sampledPoints(object).map(unproject);
    const style = { renderer, color: object.id === selectedId ? '#ce4b13' : '#176c65', weight: 3,
      fillOpacity: .16, bubblingMouseEvents: false, interactive: active && !temporary,
      dashArray: temporary ? '6 6' : undefined };
    const layer = object.kind === 'point' ? L.circleMarker(points[0], { ...style, radius: 7, fillOpacity: 1 })
      : isClosed(object.kind) && points.length >= 3 ? L.polygon(points, style) : L.polyline(points, style);
    layer.addTo(shapes);
    if (!temporary) {
      layers.set(object.id, layer);
      layer.on('click', e => tool === 'select' ? select(object.id) : mapClick(e));
      layer.bindTooltip(() => { const span = document.createElement('span'); span.textContent = object.name; return span; });
    }
    return layer;
  }

  function updateShape(object) {
    const layer = layers.get(object.id);
    if (object.kind === 'point') layer.setLatLng(unproject(object.vertices[0]));
    else layer.setLatLngs(sampledPoints(object).map(unproject));
  }

  function marker(point, className, title, draggable = false) {
    return L.marker(unproject(point), { draggable, keyboard: true, title, alt: title,
      bubblingMouseEvents: false, icon: L.divIcon({ className,
        html: `<span>${className.includes('midpoint') ? '+' : ''}</span>`, iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(handles);
  }

  function renderHandles(object) {
    const midpointMarkers = [];
    object.vertices.forEach((point, index) => {
      const handle = marker(point, `drawing-vertex${vertexIndex === index ? ' chosen' : ''}`, `Stützpunkt ${index + 1}`, true);
      const choose = () => {
        vertexIndex = index;
        handles.eachLayer(layer => layer.getElement()?.classList.remove('chosen'));
        handle.getElement().classList.add('chosen'); updateUI();
      };
      handle.getElement().addEventListener('pointerdown', choose);
      handle.on('click', choose);
      handle.on('dragstart', () => { record(); vertexIndex = index; midpointMarkers.forEach(m => handles.removeLayer(m)); });
      handle.on('drag', () => { object.vertices[index] = project(handle.getLatLng()); updateShape(object); });
      handle.on('dragend', () => { message('Stützpunkt verschoben.'); render(); });
      handle.on('keydown', e => { if (e.originalEvent.key === 'Enter') { vertexIndex = index; render(); } });
    });
    if (object.kind === 'point') return;
    const count = object.vertices.length - (isClosed(object.kind) ? 0 : 1);
    for (let i = 0; i < count; i++) {
      const point = segmentPoint(object.vertices, i, .5, isCurved(object.kind), isClosed(object.kind));
      const mid = marker(point, 'drawing-midpoint', `Stützpunkt zwischen ${i + 1} und ${(i + 1) % object.vertices.length + 1} hinzufügen`, true);
      let inserted = false;
      const insert = () => {
        if (inserted) return;
        record(); object.vertices.splice(i + 1, 0, point); vertexIndex = i + 1;
        inserted = true;
      };
      mid.on('dragstart', () => {
        insert(); midpointMarkers.filter(m => m !== mid).forEach(m => handles.removeLayer(m));
        mid.getElement().className = 'leaflet-marker-icon drawing-vertex chosen leaflet-zoom-animated leaflet-interactive';
        mid.getElement().firstElementChild.textContent = '';
      });
      mid.on('drag', () => { object.vertices[i + 1] = project(mid.getLatLng()); updateShape(object); });
      mid.on('dragend', () => { message('Stützpunkt eingefügt und verschoben.'); render(); });
      mid.on('click', () => {
        insert(); message('Stützpunkt hinzugefügt. Zum Verfeinern verschieben.'); render();
      });
      midpointMarkers.push(mid);
    }
  }

  function render() {
    shapes.clearLayers(); handles.clearLayers(); layers = new Map();
    objects.forEach(object => drawShape(object));
    if (active && selected() && !draft) renderHandles(selected());
    if (active && draft) {
      drawShape(draft, true);
      draft.vertices.forEach((point, i) => marker(point, 'drawing-vertex draft', `Neuer Stützpunkt ${i + 1}`));
    }
    updateUI();
  }

  function setMode(value) {
    if (value && !canEnter()) return;
    if (draft || magnetic.hasDraft) { message('Bitte zuerst die begonnene Form fertigstellen oder abbrechen.'); return; }
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
    if (tool === 'magnetic') { magnetic.finish(); return; }
    if (!draft || draft.vertices.length < minimumPoints(draft.kind)) return;
    record(); objects.push(draft); selectedId = draft.id; draft = null; vertexIndex = null; tool = 'select';
    message('Objekt angelegt. Die Stützpunkte sind jetzt bearbeitbar.'); render();
  }

  function deleteObject() {
    if (!selected() || draft) return;
    record(); objects = objects.filter(object => object.id !== selectedId); selectedId = null; vertexIndex = null;
    message('Objekt gelöscht. Mit Rückgängig wiederherstellen.'); render();
  }

  function deleteVertex() {
    const object = selected();
    if (!object || vertexIndex === null || draft) return;
    if (object.vertices.length <= minimumPoints(object.kind)) { message('Diese Form benötigt ihre verbleibenden Stützpunkte.'); return; }
    record(); object.vertices.splice(vertexIndex, 1); vertexIndex = null; render();
  }

  function mapClick(e) {
    if (!active || tool === 'brush') return;
    if (tool === 'magnetic') { magnetic.click(e.latlng); return; }
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
  map.on('mousemove', e => { if (active && tool === 'magnetic') magnetic.move(e.latlng); });

  document.querySelectorAll('[data-tool]').forEach(button => {
    button.onclick = () => {
      if (draft || magnetic.hasDraft) { message('Bitte zuerst die begonnene Form fertigstellen oder abbrechen.'); return; }
      tool = button.dataset.tool; selectedId = null; vertexIndex = null; message(''); render();
    };
  });
  el('enterDrawing').onclick = () => setMode(true);
  el('brushWidth').oninput = () => {
    el('brushWidthValue').textContent = `${el('brushWidth').value} px`;
    brush.setWidth(Number(el('brushWidth').value));
  };
  el('leaveDrawing').onclick = () => setMode(false);
  el('finishDrawing').onclick = finish;
  el('cancelDrawing').onclick = () => { magnetic.cancel(); draft = null; message('Zeichnen abgebrochen.'); render(); };
  el('undoDrawing').onclick = () => history(undo, redo);
  el('redoDrawing').onclick = () => history(redo, undo);
  el('deleteDrawing').onclick = deleteObject;
  el('deleteVertex').onclick = deleteVertex;
  el('drawingName').onchange = () => {
    if (!selected()) return;
    record(); selected().name = el('drawingName').value.trim() || labels[selected().kind]; render();
  };
  el('drawingOpacity').oninput = () => { opacity.value = el('drawingOpacity').value; opacity.dispatchEvent(new Event('input')); };
  el('saveDrawing').onclick = () => {
    const collection = { type: 'FeatureCollection', features: objects.map(feature) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(collection, null, 2)], { type: 'application/geo+json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'kartenpause.geojson'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    savedObjects = JSON.stringify(objects);
    message(`${objects.length} Objekte als GeoJSON gespeichert.`);
  };
  el('copyDrawing').onclick = async () => {
    if (!selected() || draft) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(feature(selected()), null, 2));
      message('Ausgewähltes Objekt als GeoJSON kopiert.');
    } catch { message('Zwischenablage nicht freigegeben. Bitte Strg+C verwenden.'); }
  };
  const editingText = target => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
  document.addEventListener('copy', e => {
    if (!active || !selected() || draft || editingText(e.target) || window.getSelection()?.toString()) return;
    e.clipboardData.setData('text/plain', JSON.stringify(feature(selected()), null, 2));
    e.preventDefault(); message('Ausgewähltes Objekt als GeoJSON kopiert.');
  });
  document.addEventListener('keydown', e => {
    if (!active || editingText(e.target)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); history(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); history(redo, undo); }
    else if (e.key === 'Enter' && tool === 'magnetic') { e.preventDefault(); magnetic.enter(); }
    else if (e.key === 'Enter' && draft) { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { brush.cancel(); magnetic.cancel(); draft = null; selectedId = null; vertexIndex = null; tool = 'select'; message(''); render(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (vertexIndex !== null) deleteVertex(); else deleteObject(); }
  });
  window.addEventListener('beforeunload', e => {
    if (draft || magnetic.hasDraft || JSON.stringify(objects) !== savedObjects) { e.preventDefault(); e.returnValue = ''; }
  });
  render();
}
