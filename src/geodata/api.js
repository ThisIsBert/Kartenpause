import { getLanguage, t, tr } from '../i18n.js';
// Search provider and Overpass can be replaced for a hosted/private installation.
const PHOTON = import.meta.env.VITE_PHOTON_URL || 'https://photon.komoot.io/api/';
const OVERPASS = import.meta.env.VITE_OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const cache = new Map();

export async function searchPlaces(query, signal) {
  const language = getLanguage();
  const key = language + ':' + query.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const url = new URL(PHOTON);
  url.search = new URLSearchParams({ q: query.trim(), lang: language, limit: '8' });
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw new Error(response.status === 429 ? t('Die Ortssuche ist ausgelastet. Bitte kurz warten und erneut suchen.') : t('Die Ortssuche ist gerade nicht erreichbar.'));
  const data = await response.json();
  if (!Array.isArray(data.features)) throw new Error(t('Die Ortssuche hat keine gültige Antwort geliefert.'));
  const results = data.features.filter(f => f.geometry?.type === 'Point' && f.geometry.coordinates?.length >= 2 && f.geometry.coordinates.slice(0, 2).every(Number.isFinite));
  if (cache.size >= 60) cache.delete(cache.keys().next().value);
  cache.set(key, results);
  return results;
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException(t('Abgebrochen'), 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

// Adapted from Ich-Will-Geodaten: bounded retries, progress, abort and long loads.
export async function overpass(query, { signal, progress, geometry = false }) {
  const deadline = Date.now() + (geometry ? 600000 : 180000);
  let attempt = 0;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    attempt++;
    try {
      progress(attempt === 1 ? t('Daten werden geladen …') : tr`Daten werden geladen (Versuch ${attempt}) …`);
      const response = await fetch(OVERPASS, {
        method: 'POST', body: new URLSearchParams({ data: query }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(geometry ? 240000 : 120000, deadline - Date.now()))])
      });
      if ([429, 502, 503, 504].includes(response.status)) throw new Error('busy');
      if (!response.ok) throw new Error(tr`Der Geodatendienst antwortet mit Fehler ${response.status}. Bitte erneut versuchen.`);
      progress(t('Antwort empfangen. Daten werden eingelesen …'));
      const data = await response.json();
      // Overpass may return HTTP 200 with partial results after a timeout.
      if (data.remark) throw new Error(t('Die Abfrage wurde vom Geodatendienst nicht vollständig ausgeführt. Bitte erneut versuchen.'));
      if (!Array.isArray(data.elements)) throw new Error(t('Der Geodatendienst hat keine gültige Objektliste geliefert.'));
      signal.throwIfAborted();
      return data;
    } catch (error) {
      signal.throwIfAborted();
      if (error.message !== 'busy' && !['TimeoutError', 'TypeError'].includes(error.name)) throw error;
      const delay = Math.min(attempt * 3000, 20000, deadline - Date.now());
      if (delay <= 0) break;
      progress(tr`Geodatendienst nicht erreichbar oder ausgelastet. Neuer Versuch in ${Math.ceil(delay / 1000)} s …`);
      await pause(delay, signal);
    }
  }
  throw new Error(t('Die Abfrage dauert zu lange. Bitte später erneut versuchen.'));
}

export function osmTarget(type, id) {
  type = ({ N: 'node', W: 'way', R: 'relation' })[type] || type;
  id = Number(id);
  if (type === 'area') { type = id >= 3600000000 ? 'relation' : 'way'; id -= type === 'relation' ? 3600000000 : 2400000000; }
  return ['node', 'way', 'relation'].includes(type) && Number.isSafeInteger(id) && id > 0 ? { type, id } : null;
}

export function objectName(tags = {}, fallback = t('Objekt'), language = getLanguage()) {
  return tags['name:' + language] || tags.name || tags['name:en'] || tags['name:de'] || tags.ref || tags.waterway || tags.highway || tags.amenity || tags.building || tags.boundary || fallback;
}
