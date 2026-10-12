import { bindAttribute, bindText, t, tr, untranslated } from '../i18n.js';
import L from 'leaflet';
import { createElement, Trash2 } from 'lucide';
import { curveLayer } from './curve-layer.js';
import { isClosed, minimumPoints, sampledPoints, edgePoint, splitEdge, removeVertex, sampledRings, toFeature, polygonParts, objectRings, geometryLeaves, ringEntries } from './geometry.js';
import { createMagneticTool, densifyPixels } from './magnetic.js';
import { simplify } from './simplify-path.js';
import { createWand } from './wand.js';
import { drawingFilename } from './export.js';
import { importGeoJSON } from './import.js';
import { vertexCount, geometryCounts } from './simplification.js';
import { setBusy } from './busy.js';
import { linearObject } from './rework-geometry.js';
import { createSectionEditor } from './section-editor.js';
import { createGeodataTool } from '../geodata/tool.js';

const labels = { multiLine: 'Mehrteilige Linie', multiPoint: 'Punktgruppe', collection: 'Geometriesammlung', point: 'Punkt', line: 'Linie', polygon: 'Polygon', multiPolygon: 'Mehrteilige Fläche', curve: 'Geschwungene Linie', curvePolygon: 'Geschwungenes Polygon' };

export function createDrawingEditor({ map, sourceMap, canEnter, onModeChange, onCancelGeoreference, getOriginalRaster, getBasemapRaster }) {
  const el = id => document.getElementById(id);
  const shapes = L.layerGroup().addTo(map), handles = L.layerGroup().addTo(map), polygonIssueLayer = L.layerGroup().addTo(map);
  map.createPane('drawingShapes');
  map.getPane('drawingShapes').style.zIndex = 450;
  const renderer = L.svg({ pane: 'drawingShapes' });
  let drawingView = null, displayedTool = null;
  let geodata = null;
  const toolLabels = { select: 'Auswahl', point: 'Punkt', line: 'Linie', polygon: 'Polygon', curve: 'Kurve', curvePolygon: 'Kurvenfläche', magnetic: 'Magnetisch zeichnen', wand: 'Zauberstab', section: 'Randabschnitt ersetzen', files: 'Import / Export' };
  let active = false, tool = 'select', objects = [], selectedIds = [], vertexIndex = null, draft = null;
  let undo = [], redo = [], layers = new Map();
  let savedObjects = JSON.stringify(objects);
  let vertexRing = 0;
  let simplification = null, simplifyAmount = 0;
  let simplifyWorker = null, simplifyTimer = null, simplifyBusy = false, simplifyGeneration = 0;
  let areaEdit = null, polygonWorker = null, polygonIssues = [];
  const selection = () => selectedIds.map(id => objects.find(object => object.id === id)).filter(Boolean);
  const selected = () => selectedIds.length === 1 ? objects.find(object => object.id === selectedIds[0]) : undefined;
  const project = ll => { const p = L.CRS.EPSG3857.project(ll); return [p.x, p.y]; };
  const unproject = p => L.CRS.EPSG3857.unproject(L.point(p));
  const toLonLat = p => { const ll = unproject(p); return [ll.lng, ll.lat]; };
  const feature = object => toFeature(object, toLonLat);
  const message = text => { bindText(el('drawingStatus'), () => text); };
  const snapshot = () => JSON.stringify({ objects, selectedIds });
  const record = () => { clearPolygonIssues(); undo.push(snapshot()); if (undo.length > 100) undo.shift(); redo = []; };
  const magnetic = createMagneticTool({ map, renderer, getOriginalRaster, getBasemapRaster,
    getObjects: () => objects.filter(object => !section.active || object.id !== selectedIds[0]),
    project, unproject, onState: updateUI, onComplete({ pixels, source, closed }) {
    record();
    const projected = source.vector ? pixels : (source.basemap ? pixels : densifyPixels(pixels)).map(p => project(source.pixelToLatLng(p)));
    const origin = project(source.pixelToLatLng(pixels[0]));
    const neighbor = project(source.pixelToLatLng([pixels[0][0] + 1, pixels[0][1]]));
    const tolerance = Math.max(.001, Math.hypot(neighbor[0] - origin[0], neighbor[1] - origin[1]) * .3 * (source.pixelScale ?? 1));
    let vertices = source.vector ? projected.map(p => [...p]) : simplify(projected, tolerance);
    if (closed) vertices = vertices.slice(0, -1);
    if (vertices.length < (closed ? 3 : 2)) { message(t('Die Form ist zu klein. Bitte weiter auseinanderliegende Anker setzen.')); render(); return; }
    const object = { id: crypto.randomUUID(), kind: closed ? 'polygon' : 'line', name: tr`Magnetische ${closed ? t('Fläche') : t('Linie')} ${objects.length + 1}`, vertices };
    objects.push(object); selectedIds = [object.id]; vertexIndex = null; tool = 'select';
    message(t('Magnetische Zeichnung übernommen. Alle Stützpunkte sind bearbeitbar.')); render();
  } });
  const wand = createWand({ map, renderer, getOriginalRaster, getBasemapRaster, onState: updateUI, onComplete({ polygons, source }) {
    const ringToWorld = ring => {
      const dense = densifyPixels([...ring, ring[0]]).map(p => project(source.pixelToLatLng(p)));
      const a = project(source.pixelToLatLng(ring[0])), b = project(source.pixelToLatLng([ring[0][0] + 1, ring[0][1]]));
      return simplify(dense, Math.max(.001, Math.hypot(a[0] - b[0], a[1] - b[1]) * .15)).slice(0, -1);
    };
    const parts = polygons.map(polygon => ({ vertices: ringToWorld(polygon[0]), holes: polygon.slice(1).map(ringToWorld) }));
    const object = { ...(areaEdit?.properties ? { properties: areaEdit.properties } : {}), id: areaEdit?.id || crypto.randomUUID(), name: areaEdit?.name || tr`Ausgewählte Fläche ${objects.length + 1}`,
      ...(parts.length === 1 ? { kind: 'polygon', ...parts[0] } : { kind: 'multiPolygon', parts }) };
    record();
    if (areaEdit) objects = objects.map(existing => existing.id === areaEdit.id ? object : existing);
    else objects.push(object);
    areaEdit = null; selectedIds = [object.id]; vertexIndex = null; vertexRing = 0; tool = 'select';
    message(tr`${parts.length} Teilfläche(n) einschließlich ihrer Löcher als ein Objekt übernommen.`); render();
  } });

  const section = createSectionEditor({ map, renderer, magnetic, project, unproject, onState: updateUI,
    onComplete(result) {
      record(); objects = objects.map(object => object.id === result.id ? result : object);
      tool = 'select'; vertexIndex = null; message(t('Randabschnitt ersetzt. Mit Rückgängig wiederherstellen.')); render();
    },
    onCancel() { tool = 'select'; message(t('Original unverändert.')); render(); }
  });
  const reworking = () => !!areaEdit || section.active || !!polygonWorker;
  function cancelArea() {
    areaEdit = null; tool = 'select'; wand.cancel(); message(t('Original unverändert.')); render();
  }
  el('reworkArea').onclick = async () => {
    const original = selected();
    if (!original || !isClosed(original.kind) || simplification || reworking()) return;
    const object = linearObject(original), session = { id: object.id, name: object.name, properties: structuredClone(object.properties) };
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
    if (geodata?.active || polygonWorker) return;
    if (section.active) { if (from === undo) section.undo(); return; }
    if (simplification) { cancelSimplification(); return; }
    if (tool === 'wand' && (areaEdit || wand.hasDraft || wand.canUndo || wand.canRedo)) { wand.history(from === redo); return; }
    if (tool === 'magnetic' && magnetic.hasDraft) { if (from === undo) magnetic.undo(); return; }
    if (draft) {
      if (from === undo) { draft.vertices.pop(); if (!draft.vertices.length) draft = null; render(); }
      return;
    }
    if (!from.length) return;
    clearPolygonIssues();
    to.push(snapshot());
    ({ objects, selectedIds = [] } = JSON.parse(from.pop()));
    vertexIndex = null; render();
  }

  function updateUI() {
    const object = selected();
    const currentTool = areaEdit ? 'area' : tool;
    if (currentTool !== displayedTool) { el('drawingSidebar').scrollTop = 0; displayedTool = currentTool; }
    bindText(el('toolTitle'), () => areaEdit ? t('Fläche weiterbearbeiten') : toolLabels[tool]);
    el('areaActions').hidden = !areaEdit;
    el('sectionActions').hidden = !section.active;
    el('objectPanel').hidden = tool !== 'select';
    el('drawingSelection').hidden = !object;
    el('filePanel').hidden = tool !== 'files';
    el('drawingActions').hidden = tool === 'files' || tool === 'select' || reworking();
    el('historyControls').hidden = !active;
    el('leaveDrawing').setAttribute('aria-pressed', String(!active));
    const pending = !!draft || magnetic.hasDraft || wand.hasDraft || !!simplification || reworking();
    el('drawingSelection').disabled = !object || !!draft || magnetic.hasDraft || wand.hasDraft || reworking();
    el('reworkArea').disabled = !object || !isClosed(object.kind) || !!simplification;
    el('reworkSection').disabled = !object || geometryLeaves(object).every(part => part.kind === 'point') || !!simplification;
    el('areaEditSettings').hidden = !areaEdit;
    el('areaApply').disabled = !wand.canFinish;
    el('sectionSettings').hidden = !section.active;
    if (section.active) el('sectionConnect').disabled = !section.canConnect;
    el('drawingName').value = object?.name || '';
    for (const id of ['drawingName', 'saveSelectedDrawing', 'copyDrawing', 'deleteDrawing']) el(id).disabled = !!simplification;
    el('simplifyDrawing').disabled = !object || geometryLeaves(object).every(part => part.kind === 'point');
    el('simplifyDrawing').value = simplifyAmount;
    bindText(el('simplifyValue'), () => `${simplifyAmount} %`);
    bindText(el('simplifyStatus'), () => !object ? t('Objekt auswählen.') : geometryLeaves(object).every(part => part.kind === 'point') ? t('Punkte lassen sich nicht vereinfachen.')
      : simplifyBusy ? tr`Berechne ${simplifyAmount} % … Der Regler bleibt bedienbar; Abbrechen beendet die Berechnung.`
      : simplification ? tr`Vorschau: ${vertexCount(object)} → ${vertexCount(simplification)} Stützpunkte.${isClosed(object.kind) ? tr` ${geometryCounts(object).parts} → ${geometryCounts(simplification).parts} Teilflächen, ${geometryCounts(object).holes} → ${geometryCounts(simplification).holes} Löcher. Kleine Inseln und Löcher können entfallen.` : ''} Mit Fertig bestätigen oder abbrechen.`
        : tr`${vertexCount(object)} Stützpunkte. Regler zeigt eine Vorschau; 0 stellt die Ausgangsform wieder her.${vertexCount(object) > 1000 ? t(' Bei großen Formen werden Griffe ausgedünnt. Zum Bearbeiten einzelner Punkte hineinzoomen.') : ''}`);
    el('applySimplification').disabled = !simplification || simplifyBusy;
    el('cancelSimplification').disabled = !simplification;
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
    bindText(el('drawingCount'), () => tr`Objekte (${objects.length})`);
    const chosen = selection(), canCombine = chosen.length >= 2 && chosen.every(object => isClosed(object.kind)) && !pending;
    for(const id of ['unionDrawings','subtractDrawings','intersectDrawings','xorDrawings']) el(id).disabled=!canCombine;
    el('cancelPolygonOperation').hidden = !polygonWorker;
    el('showPolygonIssue').hidden = !active || tool !== 'select' || !polygonIssues.some(issue => issue.point);
    bindText(el('polygonSelectionHelp'), () => polygonWorker ? t('Berechne Ergebnisfläche … Esc bricht die Berechnung ab.')
      : chosen.length >= 2 ? chosen.map((object,i)=>`${i+1}: ${object.name}`).join(' · ') + (chosen.every(object=>isClosed(object.kind)) ? t('. Subtrahieren zieht alle weiteren Flächen von der ersten ab. Schnittmenge behält nur die gemeinsame Fläche; Exklusiv (XOR) behält Bereiche mit einer ungeraden Anzahl überlagerter Flächen.') : t('. Flächenoperationen sind nur für Flächen möglich.')) + t(' Das Ergebnis wird als neues Objekt angelegt; die Ausgangsobjekte bleiben erhalten.')
      : t('Weitere Objekte mit Strg/⌘ oder Umschalt anklicken. Das Ergebnis wird als neues Objekt angelegt; die Ausgangsobjekte bleiben erhalten.'));
    if (polygonWorker) el('undoDrawing').disabled = el('redoDrawing').disabled = true;
    bindAttribute(el('undoDrawing'), 'title', () => (draft ? t('Letzten Punkt zurück') : magnetic.hasDraft ? t('Letzten Abschnitt zurück') : wand.hasDraft ? t('Letzte Auswahländerung zurück') : t('Rückgängig')) + t(' (Strg+Z)'));
    bindText(el('drawingHelp'), () => tool === 'files' ? t('Lade vorhandene Objekte oder speichere deine Zeichnung für die Weiterarbeit.') : tool === 'select'
      ? t('Objekt anklicken; mit Strg/⌘ oder Umschalt weitere auswählen. Stützpunkte ziehen; + fügt einen Punkt hinzu. Stützpunkt anklicken und mit Entf löschen.')
      : tool === 'magnetic' ? t('Enter übernimmt die Vorschau. Ohne Vorschau schließt „Fertig“ die Linie ab. Für Flächen „Polygon schließen“ wählen und die Schließkante bestätigen. Esc bricht die Zeichnung ab.')
      : tool === 'wand' ? t('Farbfläche auswählen und bei Bedarf mit dem Pinsel korrigieren. Fertig übernimmt die Umrisse, Esc verwirft die Auswahl.')
      : tool === 'point' ? t('Auf die Karte klicken, um einen Punkt zu setzen.')
        : tr`Stützpunkte durch Klicken setzen. ${isClosed(tool) ? t('Mindestens drei') : t('Mindestens zwei')} Punkte. Mit Enter oder „Fertig“ abschließen, Esc bricht ab.`);
    if (section.active) bindText(el('drawingHelp'), () => t('Wähle Anfang und Ende des Randabschnitts und zeichne den neuen Verlauf. Mit „Fertig“ speicherst du ihn; Esc verwirft die Änderungen.'));
    document.querySelectorAll('[data-tool]').forEach(button => { button.setAttribute('aria-pressed', String(active && !geodata?.active && button.dataset.tool === tool)); button.disabled = reworking(); });
    map.getContainer().classList.toggle('drawing-crosshair', active && !['select', 'files'].includes(tool));
    el('magneticSettings').hidden = tool !== 'magnetic' && !section.active;
    el('magneticActiveSettings').hidden = tool !== 'magnetic' && !section.magneticMode;
    magnetic.setEnabled(active && !geodata?.active && (tool === 'magnetic' || section.magneticMode));
    el('magneticClose').hidden = section.active;
    el('wandSettings').hidden = tool !== 'wand';
    wand.setEnabled(active && !geodata?.active && tool === 'wand');
    const list = el('drawingObjects'); list.replaceChildren();
    for (const object of objects) {
      const row=document.createElement('div'); row.className='drawing-object-row';
      const button = document.createElement('button'); button.className='drawing-object-select';
      const index = chosen.findIndex(item => item.id === object.id);
      bindText(button, () => `${chosen.length >= 2 && index !== -1 ? `${index + 1}. ` : ''}${object.name}`, false);
      button.setAttribute('aria-pressed', String(index !== -1));
      button.onclick = event => select(object.id, event.ctrlKey || event.metaKey || event.shiftKey);
      const remove=document.createElement('button'); remove.className='drawing-object-delete';
      bindAttribute(remove, 'title', () => tr`„${untranslated(object.name)}“ löschen`); bindAttribute(remove, "aria-label", () => remove.title); remove.disabled=pending;
      const icon=createElement(Trash2); icon.setAttribute('aria-hidden','true'); remove.append(icon);
      remove.onclick=()=>deleteObject(object.id);
      row.append(button,remove); list.append(row);
    }
  }

  function select(id, additive = false) {
    if (draft || magnetic.hasDraft || wand.hasDraft || simplification || reworking()) { message(t('Bitte zuerst die begonnene Form oder Vorschau übernehmen oder verwerfen.')); return; }
    if (!additive) selectedIds=[id];
    else if (selectedIds.includes(id)) selectedIds=selectedIds.filter(chosen=>chosen!==id);
    else selectedIds.push(id);
    vertexIndex=null; tool='select'; message(''); render();
  }

  function stopPolygonOperation() {
    polygonWorker?.terminate(); polygonWorker = null; setBusy('polygon-operation', false);
  }
  function clearPolygonIssues() {
    polygonIssues = []; polygonIssueLayer.clearLayers();
  }
  function renderPolygonIssues() {
    polygonIssueLayer.clearLayers();
    if (!active || geodata?.active || tool !== 'select') return;
    for (const issue of polygonIssues) {
      for (const edge of issue.segments || []) L.polyline(edge.map(unproject), {
        renderer, color: '#c22', weight: 4, dashArray: '3 5', interactive: false
      }).addTo(polygonIssueLayer);
      if (issue.point) {
        const label = document.createElement('span');
        bindText(label, () => `${issue.objectName || t('Fläche')}: ${t(issue.reason)}`, false);
        L.circleMarker(unproject(issue.point), { renderer, radius: 10, color: '#c22',
          weight: 3, fillOpacity: .15, interactive: false, className: 'polygon-issue'
        }).bindTooltip(label, { permanent: true, direction: 'right', className: 'section-issue' }).addTo(polygonIssueLayer);
      }
    }
  }
  el('showPolygonIssue').onclick = () => {
    const points = polygonIssues.flatMap(issue => [...(issue.point ? [issue.point] : []), ...(issue.segments || []).flat()]);
    if (points.length) map.fitBounds(L.latLngBounds(points.map(unproject)), { padding: [80, 80], maxZoom: 16, animate: false });
  };
  function cancelPolygonOperation() {
    stopPolygonOperation(); message(t('Flächenberechnung abgebrochen. Ausgangsobjekte unverändert.')); render();
  }
  function operatePolygons(operation) {
    const chosen = selection();
    if (chosen.length < 2 || !chosen.every(object => isClosed(object.kind)) || draft || magnetic.hasDraft || wand.hasDraft || simplification || reworking()) return;
    clearPolygonIssues();
    const symbols={union: '+', difference: '−', intersection: '∩', xor: '⊕'};
    const fail = (error, issues = []) => {
      stopPolygonOperation(); polygonIssues = issues;
      message(tr`Flächenberechnung fehlgeschlagen: ${error}${issues.some(issue => issue.point) ? t(' Die Fehlerstelle ist rot markiert; „Fehlerstelle anzeigen“ zoomt dorthin.') : ''} Die Ausgangsobjekte bleiben erhalten.`); render();
    };
    try {
      const worker = new Worker(new URL('./polygon-operation-worker.js', import.meta.url), { type: 'module' });
      polygonWorker = worker; setBusy('polygon-operation', true); vertexIndex = null; render();
      worker.onmessage = ({ data }) => {
        if (polygonWorker !== worker) return;
        if (data.error) { fail(data.error, data.issues); return; }
        stopPolygonOperation();
        if (!data.result) { message(t('Das Ergebnis ist leer oder enthält keine Fläche; kein neues Objekt angelegt.')); render(); return; }
        record();
        const result = { ...data.result, id: crypto.randomUUID(), name: operation==='difference' && chosen.length>2 ? `${chosen[0].name} − (${chosen.slice(1).map(object=>object.name).join(' + ')})` : chosen.map(object=>object.name).join(` ${symbols[operation]} `) };
        objects.push(result); selectedIds = [result.id]; vertexRing = 0;
        message(data.result.curveFallback ? t('Ergebnis angelegt. An problematischen Schnittstellen musste der Rand in Stützpunkte umgewandelt werden; die Ausgangskurven bleiben erhalten.') : t('Ergebnis als neues Flächenobjekt angelegt. Kurven bleiben bearbeitbar; die Ausgangsobjekte bleiben erhalten. Mit Rückgängig entfernen.')); render();
      };
      worker.onerror = () => { if (polygonWorker === worker) fail(t('Hintergrundberechnung nicht verfügbar.')); };
      worker.postMessage({ objects:chosen, operation });
    } catch (error) { fail(error.message); }
  }
  el('unionDrawings').onclick = () => operatePolygons('union');
  el('subtractDrawings').onclick = () => operatePolygons('difference');
  el('intersectDrawings').onclick = () => operatePolygons('intersection');
  el('xorDrawings').onclick = () => operatePolygons('xor');
  el('cancelPolygonOperation').onclick = cancelPolygonOperation;

  function drawShape(object, temporary = false) {

    const style = { renderer, color: object.id === selectedIds[0] ? '#ce4b13' : selectedIds.includes(object.id) ? '#287ac7' : '#176c65', weight: 3,
      fillOpacity: .16, bubblingMouseEvents: false, interactive: active && !temporary,
      dashArray: temporary ? '6 6' : undefined };
    const leafLayer = part => {
      const curved=curveLayer(part,unproject,style); if(curved)return curved;
      const points = sampledPoints(part).map(unproject);
      return part.kind === 'point' ? L.circleMarker(points[0], { ...style, radius: 7, fillOpacity: 1 })
        : isClosed(part.kind) ? L.polygon(polygonLatLngs(part), style) : L.polyline(points, style);
    };
    const layer = object.parts ? L.featureGroup(geometryLeaves(object).map(leafLayer)) : leafLayer(object);
    layer.addTo(shapes);
    if (!temporary) {
      layers.set(object.id, layer);
      layer.on('click', e => tool === 'select' ? select(object.id, e.originalEvent?.ctrlKey || e.originalEvent?.metaKey || e.originalEvent?.shiftKey) : mapClick(e));
      layer.bindTooltip(() => { const span = document.createElement('span'); bindText(span, () => object.name, false); return span; });
    }
    return layer;
  }

  function polygonLatLngs(object) {
    const parts=polygonParts(object).map(part=>sampledRings({...part,kind:part.kind || (object.kind==='multiPolygon'?'polygon':object.kind)}).map(ring=>ring.map(unproject)));
    return object.kind==='multiPolygon'?parts:parts[0];
  }

  function updateShape(object) {
    const layer = layers.get(object.id);
    const update = (target, part) => {
      if (target.setGeometry) { target.setGeometry(part); return; }
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
    ringEntries(object).forEach(({ vertices, kind, partIndex, holeIndex, shape }, index) => {
      const prefix = `${object.kind === 'multiPolygon' ? tr`Teilfläche ${partIndex + 1}: ` : ''}${holeIndex ? tr`Loch ${holeIndex}: ` : ''}`;
      renderRingHandles(object, vertices, index, prefix, visible, kind, shape);
    });
  }
  function renderRingHandles(object, vertices, ringIndex, prefix, visible, kind = object.kind, shape = object) {
    const midpointMarkers = [];
    vertices.forEach((point, index) => {
      if (!visible(point, vertexIndex === index && vertexRing === ringIndex)) return;
      const handle = marker(point, `drawing-vertex${vertexIndex === index && vertexRing === ringIndex ? ' chosen' : ''}`, tr`${prefix}Stützpunkt ${index + 1}`, true);
      const choose = () => {
        vertexIndex = index; vertexRing = ringIndex;
        handles.eachLayer(layer => layer.getElement()?.classList.remove('chosen'));
        handle.getElement().classList.add('chosen'); updateUI();
      };
      handle.getElement().addEventListener('pointerdown', choose);
      handle.on('click', choose);
      handle.on('dragstart', () => { record(); vertexIndex = index; vertexRing = ringIndex; midpointMarkers.forEach(m => handles.removeLayer(m)); });
      handle.on('drag', () => { vertices[index] = project(handle.getLatLng()); updateShape(object); });
      handle.on('dragend', () => { message(t('Stützpunkt verschoben.')); render(); });
      handle.on('keydown', e => { if (e.originalEvent.key === 'Enter') { vertexIndex = index; vertexRing = ringIndex; render(); } });
    });
    if (kind === 'point') return;
    const count = vertices.length - (isClosed(kind) ? 0 : 1);
    for (let i = 0; i < count; i++) {
      const point = edgePoint(shape, i, .5);
      if (!visible(point)) continue;
      const mid = marker(point, 'drawing-midpoint', tr`Stützpunkt zwischen ${i + 1} und ${(i + 1) % vertices.length + 1} hinzufügen`, true);
      let inserted = false;
      const insert = () => {
        if (inserted) return;
        record(); splitEdge(shape,i); vertexIndex = i + 1; vertexRing = ringIndex;
        inserted = true;
      };
      mid.on('dragstart', () => {
        insert(); midpointMarkers.filter(m => m !== mid).forEach(m => handles.removeLayer(m));
        mid.getElement().className = 'leaflet-marker-icon drawing-vertex chosen leaflet-zoom-animated leaflet-interactive';
        bindText(mid.getElement().firstElementChild, () => '');
      });
      mid.on('drag', () => { vertices[i + 1] = project(mid.getLatLng()); updateShape(object); });
      mid.on('dragend', () => { message(t('Stützpunkt eingefügt und verschoben.')); render(); });
      mid.on('click', () => {
        insert(); message(t('Stützpunkt hinzugefügt. Zum Verfeinern verschieben.')); render();
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
      draft.vertices.forEach((point, i) => marker(point, 'drawing-vertex draft', tr`Neuer Stützpunkt ${i + 1}`));
    }
    renderPolygonIssues(); updateUI();
  }

  function setMode(value) {
    if (geodata?.active && !geodata.canLeave()) return;
    if (value && !canEnter()) return;
    if (draft || magnetic.hasDraft || wand.hasDraft || simplification || reworking()) { message(t('Bitte zuerst die begonnene Form oder Vorschau übernehmen oder verwerfen.')); return; }
    if (active === value) return true;
    const previousView = { center: map.getCenter(), zoom: map.getZoom() };
    if (!value) drawingView = objects.length ? previousView : null;
    active = value;
    document.body.classList.toggle('drawing-mode', active);
    el('sidebar').inert = active;
    el('sidebar').hidden = active;
    el('sourcePanel').inert = active;
    el('drawingSidebar').hidden = !active;
    el(active ? 'drawingSidebar' : 'sidebar').scrollTop = 0;
    if (active) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
    onModeChange(active); render();
    // Apply the new map dimensions before restoring an existing drawing's view.
    const nextView = active && drawingView ? drawingView : previousView;
    requestAnimationFrame(() => {
      map.invalidateSize({ pan: false }); sourceMap.invalidateSize({ pan: false });
      map.setView(nextView.center, nextView.zoom, { animate: false });
      if (!active) el('sourceFit').click();
    });
    (active ? document.querySelector(`[data-tool="${tool}"]`) : el('leaveDrawing'))?.focus();
    return true;
  }

  function finish() {
    if (tool === 'wand') { wand.finish(); return; }
    if (tool === 'magnetic') { magnetic.finish(); return; }
    if (!draft || draft.vertices.length < minimumPoints(draft.kind)) return;
    record(); objects.push(draft); selectedIds = [draft.id]; draft = null; vertexIndex = null; tool = 'select';
    message(t('Objekt angelegt. Die Stützpunkte sind jetzt bearbeitbar.')); render();
  }

  function deleteObject(id=selected()?.id) {
    if (!objects.some(object=>object.id===id) || draft || magnetic.hasDraft || wand.hasDraft || simplification || reworking()) return;
    record(); objects=objects.filter(object=>object.id!==id); selectedIds=selectedIds.filter(chosen=>chosen!==id); vertexIndex=null;
    message(t('Objekt gelöscht. Mit Rückgängig wiederherstellen.')); render();
  }

  function deleteVertex() {
    const object = selected();
    if (!object || vertexIndex === null || draft || simplification || reworking()) return;
    const vertices = objectRings(object)[vertexRing];
    if (!vertices || vertices.length <= minimumPoints(ringEntries(object)[vertexRing].kind)) { message(t('Diese Form benötigt ihre verbleibenden Stützpunkte.')); return; }
    record(); removeVertex(ringEntries(object)[vertexRing].shape,vertexIndex); vertexIndex = null; render();
  }

  function mapClick(e) {
    if (!active || geodata?.active || polygonWorker || tool === 'files') return;
    if (simplification) { message(t('Bitte die Vereinfachung zuerst übernehmen oder verwerfen.')); return; }
    if (section.active) { section.click(e.latlng, e.originalEvent); return; }
    if (tool === 'magnetic') { magnetic.click(e.latlng, e.originalEvent); return; }
    if (tool === 'wand') { wand.click(e.latlng); return; }
    if (tool === 'select') { selectedIds = []; vertexIndex = null; render(); return; }
    // Ignore the second click of a double-click rather than making duplicate vertices.
    if (e.originalEvent?.detail > 1) return;
    const point = project(e.latlng);
    if (!draft) {
      selectedIds = []; vertexIndex = null;
      draft = { id: crypto.randomUUID(), kind: tool, name: `${t(labels[tool])} ${objects.length + 1}`, vertices: [] };
    }
    if (draft.vertices.length && Math.hypot(...point.map((v, i) => v - draft.vertices.at(-1)[i])) < 1e-6) return;
    draft.vertices.push(point);
    if (tool === 'point') finish(); else { message(tr`${draft.vertices.length} Stützpunkte gesetzt.`); render(); }
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
      if (geodata?.active && !geodata.canLeave()) return;
      if (draft || magnetic.hasDraft || wand.hasDraft || simplification || reworking()) { message(t('Bitte zuerst die begonnene Form oder Vorschau übernehmen oder verwerfen.')); return; }
      if (!active && !setMode(true)) return;
      tool = button.dataset.tool; selectedIds = []; vertexIndex = null; message(''); render();
    };
  });
  el('enterDrawing').onclick = () => setMode(true);
  el('leaveDrawing').onclick = () => setMode(false);
  el('cancelGeoreference').onclick = () => { if (onCancelGeoreference()) setMode(true); };
  el('finishDrawing').onclick = finish;
  el('cancelDrawing').onclick = () => { if (section.active) { section.cancel(); return; } if (areaEdit) { cancelArea(); return; } stopSimplification(); simplification = null; simplifyAmount = 0; magnetic.cancel(); wand.cancel(); draft = null; message(t('Zeichnen abgebrochen.')); render(); };
  function stopSimplification() {
    simplifyGeneration++; clearTimeout(simplifyTimer); simplifyTimer = null;
    simplifyWorker?.terminate(); simplifyWorker = null;
    simplifyBusy = false; setBusy('simplification', false);
  }
  function cancelSimplification() {
    stopSimplification();
    simplification = null; simplifyAmount = 0; message(t('Vereinfachung verworfen.')); render();
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
        cancelSimplification(); message(tr`Vereinfachung fehlgeschlagen: ${error}. Die Ausgangsform bleibt erhalten.`);
      };
      try {
        simplifyWorker = new Worker(new URL('./simplification-worker.js', import.meta.url), { type: 'module' });
        simplifyWorker.onmessage = ({ data }) => {
          if (generation !== simplifyGeneration) return;
          if (data.error) { fail(data.error); return; }
          stopSimplification(); simplification = data.result;
          updateShape(simplification); updateUI();
        };
        simplifyWorker.onerror = () => fail(t('Hintergrundberechnung nicht verfügbar'));
        simplifyWorker.postMessage({ object, amount: simplifyAmount });
      } catch (error) { fail(error.message); }
    }, 120);
  };
  el('cancelSimplification').onclick = cancelSimplification;
  el('applySimplification').onclick = () => {
    if (!simplification || simplifyBusy) return;
    record(); objects = objects.map(object => object.id === simplification.id ? simplification : object);
    simplification = null; simplifyAmount = 0; message(t('Objekt vereinfacht und geglättet. Mit Rückgängig wiederherstellen.')); render();
  };
  el('undoDrawing').onclick = () => history(undo, redo);
  el('redoDrawing').onclick = () => history(redo, undo);
  el('deleteDrawing').onclick = () => deleteObject();
  el('drawingName').onchange = () => {
    if (!selected()) return;
    record(); selected().name = el('drawingName').value.trim() || t(labels[selected().kind]); render();
  };
  el('zoomContent').onclick = () => {
    const bounds = L.latLngBounds([]);
    for (const object of objects) for (const ring of objectRings(object)) for (const p of ring) bounds.extend(unproject(p));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    else el('zoomImage').click();
  };
  function loadGeoJSON(text) {
    if (draft || magnetic.hasDraft || wand.hasDraft || simplification || reworking()) { const error = t('Bitte zuerst die begonnene Bearbeitung abschließen oder verwerfen.'); message(error); return { error }; }
    try {
      const imported = importGeoJSON(text, p => project(L.latLng(p[1], p[0])));
      record(); for (const object of imported) objects.push(object);
      selectedIds = [imported[0].id]; vertexIndex = null; tool = 'select';
      render();
      const bounds = L.latLngBounds([]);
      for (const object of imported) for (const ring of objectRings(object)) for (const p of ring) bounds.extend(unproject(p));
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
      message(tr`${imported.length} Objekte importiert. Mit Rückgängig wieder entfernen.`);
      return { count: imported.length };
    } catch (error) { message(tr`Import fehlgeschlagen: ${error.message}`); return { error: error.message }; }
  }
  el('importDrawing').onclick = () => el('importDrawingFile').click();
  el('importDrawingFile').onchange = async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    try { loadGeoJSON(await file.text()); } catch (error) { message(tr`Datei konnte nicht gelesen werden: ${error.message}`); }
  };
  el('pasteDrawing').onclick = async () => {
    try { loadGeoJSON(await navigator.clipboard.readText()); }
    catch { message(t('Zwischenablage nicht freigegeben. Bitte auf die Karte klicken und Strg+V verwenden.')); }
  };
  function saveObjects(exportedObjects) {
    const collection = { type: 'FeatureCollection', features: exportedObjects.map(feature) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(collection, null, 2)], { type: 'application/geo+json' }));
    const link = document.createElement('a'); link.href = url; link.download = drawingFilename(exportedObjects); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  el('saveSelectedDrawing').onclick = () => {
    const object = selected();
    if (!object || draft || simplification || reworking()) return;
    saveObjects([object]);
    message(t('Ausgewähltes Objekt als GeoJSON gespeichert.'));
  };
  el('saveDrawing').onclick = () => {
    saveObjects(objects);
    savedObjects = JSON.stringify(objects);
    message(tr`${objects.length} Objekte als GeoJSON gespeichert.`);
  };
  el('copyDrawing').onclick = async () => {
    if (!selected() || draft || simplification || reworking()) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(feature(selected()), null, 2));
      message(t('Ausgewähltes Objekt als GeoJSON kopiert.'));
    } catch { message(t('Zwischenablage nicht freigegeben. Bitte Strg+C verwenden.')); }
  };
  const editingText = target => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
  document.addEventListener('paste', e => {
    if (!active || geodata?.active || editingText(e.target)) return;
    e.preventDefault(); loadGeoJSON(e.clipboardData.getData('text/plain'));
  });
  document.addEventListener('copy', e => {
    if (!active || geodata?.active || !selected() || draft || simplification || reworking() || editingText(e.target) || window.getSelection()?.toString()) return;
    e.clipboardData.setData('text/plain', JSON.stringify(feature(selected()), null, 2));
    e.preventDefault(); message(t('Ausgewähltes Objekt als GeoJSON kopiert.'));
  });
  document.addEventListener('keydown', e => {
    if (!active || geodata?.active || editingText(e.target)) return;
    if (polygonWorker) { if (e.key === 'Escape') { e.preventDefault(); cancelPolygonOperation(); } return; }
    if (section.active && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); section.deleteVertex(); return; }
    if (section.active && e.key === 'Enter') { e.preventDefault(); section.enter(); return; }
    if (e.key === 'Escape' && reworking()) { e.preventDefault(); if (section.active) section.cancel(); else cancelArea(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); history(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); history(redo, undo); }
    else if (e.key === 'Enter' && tool === 'magnetic') { e.preventDefault(); magnetic.enter(); }
    else if (e.key === 'Enter' && tool === 'wand') { e.preventDefault(); wand.finish(); }
    else if (e.key === 'Enter' && draft) { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { if (simplification) { cancelSimplification(); return; } magnetic.cancel(); wand.cancel(); draft = null; selectedIds = []; vertexIndex = null; tool = 'select'; message(''); render(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (vertexIndex !== null) deleteVertex(); else deleteObject(); }
  });
  window.addEventListener('beforeunload', e => {
    if (geodata?.hasSelection || draft || magnetic.hasDraft || wand.hasDraft || reworking() || JSON.stringify(objects) !== savedObjects) { e.preventDefault(); e.returnValue = ''; }
  });
  const sourceIds = () => new Set(objects.map(object => object.properties?.sourceId).filter(Boolean));
  geodata = createGeodataTool({ drawingMap: map, getSourceIds: sourceIds,
    onImport(features) {
      const known = sourceIds();
      const unique = features.filter(feature => { if (known.has(feature.id)) return false; known.add(feature.id); return true; });
      if (!unique.length) return { error: t('Diese Objekte sind bereits in der Zeichnung vorhanden.') };
      return loadGeoJSON(JSON.stringify({ type: 'FeatureCollection', features: unique }));
    },
    onClose() { render(); el('drawingSidebar').scrollTop = 0; document.querySelector(`[data-tool="${tool}"]`)?.focus(); }
  });
  el('openGeodata').onclick = () => {
    if (draft || magnetic.hasDraft || wand.hasDraft || simplification || reworking()) { message(t('Bitte zuerst die begonnene Form oder Vorschau übernehmen oder verwerfen.')); return; }
    if (!active && !setMode(true)) return;
    geodata.open(); updateUI();
  };
  setMode(true);
}
