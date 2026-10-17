// A deliberately small OpenMapTiles style. No road, terrain, land-use or POI
// sources/layers: the same clean pixels are also used by the tracing tools.
export const referenceColors = {
  land: '#faf9f6', water: '#add7e6', waterline: '#287fa0',
  border: '#575563', place: '#283536', country: '#72717a'
};

export function referenceName(language = 'de') {
  return ['coalesce', ['get', `name:${language}`], ['get', `name_${language}`], ['get', 'name'], ['get', 'name:latin']];
}

export function createReferenceStyle(language = 'de') {
  const c = referenceColors, name = referenceName(language);
  const source = (layer) => ({ source: 'osm', 'source-layer': layer });
  const width = ['interpolate', ['linear'], ['zoom'], 2, 1, 6, 1.5, 12, 2.2, 18, 3];
  const border = ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1], ['!', ['has', 'claimed_by']]];
  const placeMarker = { 'icon-image': 'reference-place', 'icon-size': 0.7, 'text-anchor': 'bottom', 'text-offset': [0, -0.45] };
  const label = (id, layer, filter, minzoom, size, color, extra = {}) => ({
    id, type: 'symbol', ...source(layer), filter, minzoom,
    layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': size,
      'text-max-width': 9, 'text-padding': 5, ...extra },
    paint: { 'text-color': color, 'text-halo-color': c.land, 'text-halo-width': 1.2 }
  });
  return {
    version: 8, name: 'Kartenpause · Referenzkarte',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { osm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': c.land } },
      { id: 'water', type: 'fill', ...source('water'), filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': c.water } },
      { id: 'shore', type: 'line', ...source('water'), filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'line-color': c.waterline, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.65, 10, 1.1, 18, 1.6] } },
      { id: 'waterways', type: 'line', ...source('waterway'), filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.waterline, 'line-width': ['interpolate', ['linear'], ['zoom'],
          5, ['match', ['get', 'class'], 'river', 1.4, 0.9],
          12, ['match', ['get', 'class'], 'river', 2.2, 1.3],
          18, ['match', ['get', 'class'], 'river', 3.5, 2] ] } },
      { id: 'borders', type: 'line', ...source('boundary'),
        filter: ['all', border, ['!=', ['get', 'disputed'], 1]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.border, 'line-width': width } },
      { id: 'disputed-borders', type: 'line', ...source('boundary'),
        filter: ['all', border, ['==', ['get', 'disputed'], 1]],
        paint: { 'line-color': c.border, 'line-width': width, 'line-dasharray': [3, 2] } },
      // Town labels have priority over water names, with collision detection
      // keeping labels sparse. Country labels disappear at local scales.
      label('cities', 'place', ['==', ['get', 'class'], 'city'], 2,
        ['interpolate', ['linear'], ['zoom'], 3, 11, 8, 14, 14, 17], c.place,
        { ...placeMarker, 'symbol-sort-key': ['coalesce', ['get', 'rank'], 99] }),
      label('towns', 'place', ['==', ['get', 'class'], 'town'], 6, 12, c.place, placeMarker),
      label('villages', 'place', ['==', ['get', 'class'], 'village'], 9, 11.5, c.place, placeMarker),
      label('localities', 'place', ['match', ['get', 'class'], ['hamlet', 'suburb', 'neighbourhood', 'quarter', 'isolated_dwelling'], true, false], 12, 11, c.place, placeMarker),
      { ...label('countries', 'place', ['==', ['get', 'class'], 'country'], 1, 12, c.country,
        { 'text-letter-spacing': 0.12, 'text-transform': 'uppercase' }), maxzoom: 7 },
      label('river-names', 'waterway', ['!=', ['get', 'brunnel'], 'tunnel'], 7, 11, c.waterline,
        { 'text-font': ['Noto Sans Italic'], 'symbol-placement': 'line', 'symbol-spacing': 450, 'text-offset': [0, 1] }),
      label('water-names', 'water_name', ['==', ['geometry-type'], 'Point'], 2, 11, c.waterline,
        { 'text-font': ['Noto Sans Italic'] }),
      label('water-line-names', 'water_name', ['==', ['geometry-type'], 'LineString'], 5, 11, c.waterline,
        { 'text-font': ['Noto Sans Italic'], 'symbol-placement': 'line', 'symbol-spacing': 450 })
    ]
  };
}
