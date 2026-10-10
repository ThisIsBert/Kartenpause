import L from 'leaflet';
import { searchPlaces, overpass, osmTarget, objectName } from './api.js';
import { setBusy } from '../drawing/busy.js';

export function createGeodataTool({ drawingMap, getSourceIds, onImport, onClose }) {
  const el = id => document.getElementById(id);
  const basket = new Map();
  const requests = new Map();
  const loaded = new Map(), extents = new Map(), chosenLayers = new Map();
  let active = false, map, previewLayer, chosenLayer, marker, preview = null, worker = null;
  let timer, lastSearchAt = 0, largeTarget = null, previewId = null, existing = new Set();
  const status = text => { el('geoStatus').textContent = text; };
  const error = text => { el('geoError').textContent = text; };
  const button = (text, action, className = '') => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = text;
    node.className = className; node.onclick = action; return node;
  };
  function syncRequests() {
    el('geoStop').hidden = !requests.has('objects') && !requests.has('geometry');
    setBusy('geodata', requests.size > 0);
    el('geoSidebar').setAttribute('aria-busy', String(requests.size > 0));
    updateObjectActions();
  }
  function stop(name) {
    requests.get(name)?.abort(); requests.delete(name);
    if (name === 'geometry') { worker?.terminate(); worker = null; }
    syncRequests();
  }
  function start(name) {
    stop(name);
    const controller = new AbortController(); requests.set(name, controller);
    syncRequests();
    return { signal: controller.signal, current: () => active && requests.get(name) === controller && !controller.signal.aborted,
      end() { if (requests.get(name) === controller) stop(name); } };
  }
  function clearPreview() {
    stop('geometry'); preview = null; largeTarget = null; previewId = null;
    document.querySelectorAll('#geoObjects .geo-result').forEach(b => b.setAttribute('aria-pressed', 'false'));
    previewLayer?.clearLayers(); el('geoLarge').hidden = true;
    el('geoPreviewName').textContent = 'Noch kein Objekt in der Vorschau.';
    el('geoPreviewDetails').replaceChildren();
    updateObjectActions();
  }
  function paint(feature, group, color) {
    return L.geoJSON(feature, { style: { color, weight: 3, fillOpacity: .16 },
      interactive: false, pointToLayer: (_, ll) => L.circleMarker(ll, { radius: 7, color, fillOpacity: .6, interactive: false }) }).addTo(group);
  }
  function fit(layer) {
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [35, 35], maxZoom: 16 });
  }
  function updateBasket() {
    el('geoChosenCount').textContent = `Zur Übernahme ausgewählt (${basket.size})`;
    el('geoFinish').disabled = !basket.size;
    const list = el('geoChosen'); list.replaceChildren();
    for (const [id, layer] of chosenLayers) if (!basket.has(id)) { chosenLayer.removeLayer(layer); chosenLayers.delete(id); }
    for (const [id, feature] of basket) {
      const row = document.createElement('div'); row.className = 'geo-chosen-row';
      // Large geometries are drawn once, not rebuilt on every preview or selection.
      if (!chosenLayers.has(id)) chosenLayers.set(id, paint(feature, chosenLayer, '#176c65'));
      const layer = chosenLayers.get(id);
      row.append(button(feature.properties.name, () => fit(layer), 'geo-chosen-name'));
      const remove = button('×', () => { basket.delete(id); updateBasket(); }, 'icon');
      remove.setAttribute('aria-label', `${feature.properties.name} aus Auswahl entfernen`); remove.title = 'Aus Auswahl entfernen';
      row.append(remove); list.append(row);
    }
    previewLayer?.bringToFront();
    if (!basket.size) list.textContent = 'Klicke neben einer geladenen Form auf „Auswählen“. Du kannst dafür an mehreren Orten suchen.';
    updateObjectActions();
  }
  function updateObjectActions() {
    for (const action of el('geoObjects').querySelectorAll('.geo-object-action')) {
      const id = action.dataset.osmId, loading = id === previewId && requests.has('geometry');
      action.hidden = !loading && !loaded.has(id) && !extents.has(id) && !existing.has(id);
      action.disabled = loading || basket.has(id) || existing.has(id);
      action.textContent = loading ? 'Lädt …' : existing.has(id) ? 'Vorhanden' : basket.has(id) ? 'Ausgewählt' : loaded.has(id) ? 'Auswählen' : 'Jetzt laden';
    }
  }
  function chooseObject(id) {
    const feature = loaded.get(id);
    if (!feature || existing.has(id) || basket.has(id)) return;
    basket.set(id, feature); updateBasket(); status('Objekt zur Auswahl hinzugefügt. Mit „Fertig“ in die Zeichnung übernehmen.');
  }
  function showPreview(feature) {
    preview = feature; previewLayer.clearLayers(); fit(paint(feature, previewLayer, '#ce4b13'));
    el('geoPreviewName').textContent = feature.properties.name;
    el('geoPreviewDetails').replaceChildren(tagsDetail(feature.properties.tags));
    updateObjectActions(); status('Orange: Vorschau. Grün: zur Übernahme ausgewählt.');
  }
  function tagsDetail(tags = {}) {
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = 'Eigenschaften'; details.append(summary);
    const dl = document.createElement('dl');
    for (const [key, value] of Object.entries(tags)) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = key; dd.textContent = String(value); dl.append(dt, dd);
    }
    details.append(dl); return details;
  }
  async function loadGeometry(target, full = false) {
    clearPreview(); error('');
    const id = `${target.type}/${target.id}`;
    previewId = id;
    document.querySelectorAll('#geoObjects .geo-result').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.osmId === id)));
    if (loaded.has(id)) { showPreview(loaded.get(id)); return; }
    const operation = start('geometry');
    const progress = text => { if (operation.current()) status(text); };
    const options = { signal: operation.signal, progress, geometry: true };
    el('geoPreviewName').textContent = objectName(target.tags, id);
    document.querySelectorAll('#geoObjects .geo-result').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.osmId === id)));
    try {
      if (target.type === 'relation' && !full) {
        const result = await overpass(`[out:json][timeout:180];relation(${target.id});out bb;`, options);
        if (!operation.current()) return;
        const bounds = result.elements.find(e => e.type === 'relation' && e.id === target.id)?.bounds;
        if (bounds && [bounds.minlat, bounds.minlon, bounds.maxlat, bounds.maxlon].every(Number.isFinite)) {
          const box = L.rectangle([[bounds.minlat, bounds.minlon], [bounds.maxlat, bounds.maxlon]], { color: '#ce4b13', dashArray: '6 6', fill: false, interactive: false }).addTo(previewLayer);
          extents.set(id, bounds);
          fit(box);
          if ((bounds.maxlat - bounds.minlat) * (bounds.maxlon - bounds.minlon) >= 1) {
            largeTarget = target; el('geoLarge').hidden = false;
            status('Die gestrichelte Umrandung zeigt nur die Ausdehnung. Lade die vollständige Form, um das Objekt auszuwählen.');
            return;
          }
        }
      }
      const data = await overpass(`[out:json][timeout:180][maxsize:268435456];${target.type}(${target.id});out geom;`, options);
      if (!operation.current()) return;
      progress('Geometrie-Verarbeitung wird gestartet …');
      worker = new Worker(new URL('./geometry-worker.js', import.meta.url), { type: 'module' });
      const feature = await new Promise((resolve, reject) => {
        let phase = 'Geometrie-Verarbeitung wird gestartet', phaseAt = performance.now();
        const ticker = setInterval(() => progress(`${phase} … ${Math.floor((performance.now() - phaseAt) / 1000)} s`), 1000);
        const timeout = setTimeout(() => finish(new Error('Die Geometrie-Verarbeitung dauert zu lange. Bitte erneut laden.')), 120000);
        const abort = () => finish(new DOMException('Abgebrochen', 'AbortError'));
        operation.signal.addEventListener('abort', abort, { once: true });
        const finish = (error, value) => { clearInterval(ticker); clearTimeout(timeout); operation.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
        worker.onmessage = ({ data }) => {
          if (data.phase) { phase = data.phase; phaseAt = performance.now(); progress(`${phase} …`); return; }
          finish(data.error ? new Error(data.error) : null, data.feature);
        };
        worker.onerror = () => finish(new Error('Die Geometrie konnte nicht verarbeitet werden.'));
        worker.onmessageerror = () => finish(new Error('Die vorbereitete Geometrie konnte nicht übertragen werden.'));
        worker.postMessage({ data, id });
      });
      if (!operation.current()) return;
      progress('Form wird auf der Karte angezeigt …');
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (!operation.current()) return;
      showPreview(feature); loaded.set(id, feature); updateObjectActions();
    } catch (e) {
      if (operation.current()) { status(''); error(e.message || 'Geometrie konnte nicht geladen werden.'); }
    } finally { operation.end(); }
  }
  async function loadObjects(latlng, preferred = null) {
    stop('search'); clearTimeout(timer); el('geoSuggestions').replaceChildren(); el('geoSearchStatus').textContent = '';
    clearPreview(); error('');
    const operation = start('objects');
    const ll = latlng.wrap();
    if (!marker) marker = L.circleMarker(ll, { radius: 5, color: '#244f8c', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map);
    else marker.setLatLng(ll);
    el('geoObjects').replaceChildren();
    const renderObjects = elements => {
      el('geoObjects').replaceChildren();
      for (const element of elements) {
        const target = osmTarget(element.type, element.id); if (!target) continue;
        const id = `${target.type}/${target.id}`;
        const row = document.createElement('div'); row.className = 'geo-object-row';
        const b = button('', () => loadGeometry({ ...target, tags: element.tags }), 'geo-result');
        b.dataset.osmId = id; b.setAttribute('aria-pressed', String(id === previewId));
        const title = document.createElement('strong'), detail = document.createElement('span');
        title.textContent = objectName(element.tags, id);
        detail.textContent = `${({ node: 'Punkt', way: 'Weg / Fläche', relation: 'Relation' })[target.type]} · ${id}${existing.has(id) ? ' · bereits in der Zeichnung' : ''}`;
        const action = button('', () => loaded.has(id) ? chooseObject(id) : loadGeometry({ ...target, tags: element.tags }, true), 'geo-object-action');
        action.dataset.osmId = id;
        b.append(title, detail); row.append(b, action); el('geoObjects').append(row);
      }
      updateObjectActions();
    };
    if (preferred) renderObjects([preferred]);
    try {
      const data = await overpass(`[out:json][timeout:60];(nwr(around:45,${ll.lat},${ll.lng});is_in(${ll.lat},${ll.lng})->.a;nwr(pivot.a););out tags center;`, {
        signal: operation.signal, progress: text => { if (operation.current() && !previewId) status(text); }
      });
      if (!operation.current()) return;
      const elements = new Map();
      if (preferred) elements.set(`${preferred.type}/${preferred.id}`, preferred);
      for (const item of data.elements) if (item.tags) elements.set(`${item.type}/${item.id}`, item);
      renderObjects([...elements.values()]);
      if (!requests.has('geometry') && !preview && !largeTarget) status(elements.size ? `${elements.size} Objekte gefunden. Wähle eines für die Vorschau.` : 'Hier wurden keine Objekte gefunden. Versuche einen anderen Punkt auf der Karte.');
    } catch (e) {
      if (operation.current()) { status(''); error(`Objekte konnten nicht geladen werden. ${e.message}`); }
    } finally { operation.end(); }
  }
  function choosePlace(feature) {
    const p = feature.properties || {}, [lon, lat] = feature.geometry.coordinates;
    el('geoQuery').value = p.name || p.street || '';
    const ll = L.latLng(lat, lon); map.setView(ll, 15);
    const target = osmTarget(p.osm_type, p.osm_id);
    loadObjects(ll, target ? { ...target, tags: { name: p.name || p.street || 'Suchtreffer' } } : null);
  }
  async function runSearch() {
    clearTimeout(timer);
    const query = el('geoQuery').value.trim();
    stop('search'); el('geoSuggestions').replaceChildren();
    if (query.length < 3) { el('geoSearchStatus').textContent = query ? 'Mindestens drei Zeichen eingeben.' : ''; return; }
    const operation = start('search'); lastSearchAt = Date.now();
    el('geoSearchStatus').textContent = 'Orte werden gesucht …';
    try {
      const results = await searchPlaces(query, operation.signal);
      if (!operation.current()) return;
      for (const feature of results) {
        const p = feature.properties || {};
        const b = button('', () => choosePlace(feature), 'geo-result');
        const title = document.createElement('strong'), subtitle = document.createElement('span');
        title.textContent = p.name || p.street || 'Ort';
        subtitle.textContent = [...new Set([p.street, p.housenumber, p.postcode, p.city, p.state, p.country].filter(Boolean))].join(', ');
        b.append(title, subtitle); el('geoSuggestions').append(b);
      }
      el('geoSearchStatus').textContent = results.length ? `${results.length} Orte gefunden. Wähle einen Treffer.` : 'Kein Ort gefunden. Versuche einen anderen Namen oder klicke auf die Karte.';
    } catch (e) {
      if (operation.current()) el('geoSearchStatus').textContent = e.name === 'TimeoutError' ? 'Die Ortssuche antwortet nicht. Bitte erneut versuchen.' : e.message;
    } finally { operation.end(); }
  }
  function scheduleSearch() {
    clearTimeout(timer); stop('search'); el('geoSuggestions').replaceChildren();
    if (el('geoQuery').value.trim().length < 3) { el('geoSearchStatus').textContent = 'Mindestens drei Zeichen eingeben.'; return; }
    el('geoSearchStatus').textContent = 'Suche nach der Tipp-Pause …';
    timer = setTimeout(runSearch, Math.max(450, 1000 - (Date.now() - lastSearchAt)));
  }
  el('geoQuery').addEventListener('input', e => { if (!e.isComposing) scheduleSearch(); });
  el('geoQuery').addEventListener('compositionstart', () => { clearTimeout(timer); stop('search'); });
  el('geoQuery').addEventListener('compositionend', scheduleSearch);
  el('geoSearchForm').onsubmit = e => { e.preventDefault(); scheduleSearch(); };
  el('geoQuery').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); el('geoSuggestions').querySelector('button')?.focus(); }
    if (e.key === 'Escape') { clearTimeout(timer); stop('search'); el('geoSuggestions').replaceChildren(); el('geoSearchStatus').textContent = ''; }
  });
  el('geoSuggestions').addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    const items = [...el('geoSuggestions').querySelectorAll('button')], index = items.indexOf(document.activeElement);
    if (e.key === 'Escape' || (e.key === 'ArrowUp' && index <= 0)) el('geoQuery').focus();
    else items[Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1))]?.focus();
  });
  el('geoStop').onclick = () => { stop('objects'); clearPreview(); status('Laden abgebrochen. Deine Auswahl bleibt erhalten.'); };
  function close() {
    active = false; clearTimeout(timer);
    for (const name of [...requests.keys()]) stop(name);
    basket.clear(); clearPreview(); chosenLayer?.clearLayers(); chosenLayers.clear(); loaded.clear(); extents.clear();
    document.body.classList.remove('geodata-mode');
    el('geoSidebar').hidden = true; el('geoMap').hidden = true;
    el('drawingSidebar').inert = false;
    el('openGeodata').setAttribute('aria-pressed', 'false');
    drawingMap.invalidateSize({ pan: false }); onClose();
  }
  el('geoCancel').onclick = close;
  el('geoFinish').onclick = async () => {
    if (!basket.size || requests.has('import')) return;
    const operation = start('import');
    el('geoFinish').disabled = true; status('Auswahl wird in die Zeichnung übernommen …');
    try {
      // Let the busy cursor paint before validating and drawing a large batch.
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (!operation.current()) return;
      const result = onImport([...basket.values()]);
      if (result?.error) { error(result.error); return; }
      close();
    } finally { operation.end(); el('geoFinish').disabled = !basket.size; }
  };
  return {
    get active() { return active; },
    get hasSelection() { return !!basket.size; },
    canLeave() {
      if (!active) return true;
      if (basket.size) { status('Bitte deine Auswahl mit „Fertig“ übernehmen oder mit „Abbrechen“ verwerfen.'); el('geoFinish').focus(); return false; }
      close(); return true;
    },
    open() {
      if (active) { el('geoQuery').focus(); return; }
      active = true; existing = getSourceIds(); basket.clear();
      document.body.classList.add('geodata-mode');
      el('drawingSidebar').inert = true;
      el('geoSidebar').hidden = false; el('geoMap').hidden = false;
      el('openGeodata').setAttribute('aria-pressed', 'true');
      document.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', 'false'));
      if (!map) {
        map = L.map(el('geoMap'), { preferCanvas: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
        chosenLayer = L.featureGroup().addTo(map); previewLayer = L.featureGroup().addTo(map);
        map.on('click', e => loadObjects(e.latlng));
        new ResizeObserver(() => { if (active) map.invalidateSize({ pan: false }); }).observe(el('geoMap'));
      }
      map.invalidateSize({ pan: false }); map.setView(drawingMap.getCenter(), drawingMap.getZoom(), { animate: false });
      if (marker) { marker.remove(); marker = null; }
      clearPreview(); updateBasket(); error(''); status('Suche einen Ort oder klicke auf die Karte.');
      el('geoQuery').value = ''; el('geoSuggestions').replaceChildren(); el('geoObjects').replaceChildren();
      el('geoSearchStatus').textContent = ''; el('geoSidebar').scrollTop = 0; el('geoQuery').focus();
    }
  };
}
