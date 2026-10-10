import osmtogeojson from 'osmtogeojson';
import { importGeoJSON } from '../drawing/import.js';
import { objectName } from './api.js';
import { fullMultipolygon } from './multipolygon.js';

self.onmessage = ({ data: { data, id } }) => {
  try {
    self.postMessage({ phase: 'OSM-Geometrie wird zusammengesetzt' });
    const target = data.elements.find(e => `${e.type}/${e.id}` === id);
    const feature = fullMultipolygon(target, phase => self.postMessage({ phase }))
      || osmtogeojson(data, { flatProperties: false }).features.find(f => f.id === id);
    if (!feature?.geometry || feature.properties?.tainted) throw new Error('Keine vollständige Geometrie verfügbar. Dieses Objekt kann nicht übernommen werden.');
    feature.properties = { ...feature.properties, name: objectName(feature.properties?.tags, id), sourceId: id,
      source: 'OpenStreetMap', attribution: '© OpenStreetMap contributors', license: 'ODbL-1.0' };
    // Validate every coordinate and part before offering the object for import.
    self.postMessage({ phase: 'Koordinaten und Teilflächen werden geprüft' });
    importGeoJSON(feature, p => p, () => id);
    self.postMessage({ phase: 'Vollständige Form wird an die Karte übertragen' });
    self.postMessage({ feature });
  } catch (error) { self.postMessage({ error: error.message }); }
};
