// Read only basemap tiles, never controls or drawing/image overlays.
// Keep a geographic transform tied to the captured zoom, independent of later pans.
export function createBasemapRaster(map, layer) {
  const zoom = map.getZoom(), size = map.getSize();
  const width = Math.round(size.x), height = Math.round(size.y);
  if (!width || !height || width * height > 8000000) throw new Error('Der Kartenausschnitt ist zu groß. Bitte das Kartenfenster verkleinern.');
  if (!layer || layer.isLoading() || layer._tileZoom !== zoom) throw new Error('Die Basiskarte lädt noch. Bitte kurz warten und erneut versuchen.');
  const origin = map.project(map.containerPointToLatLng([0, 0]), zoom);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tileSize = layer.getTileSize();
  let count = 0;
  // Leaflet 1.9 tile coordinates retain world-wrap offsets; image URLs do not.
  for (const tile of Object.values(layer._tiles || {})) {
    if (tile.coords.z !== zoom) continue;
    const x = tile.coords.x * tileSize.x - origin.x, y = tile.coords.y * tileSize.y - origin.y;
    if (x >= width || y >= height || x + tileSize.x <= 0 || y + tileSize.y <= 0) continue;
    if (!tile.el.complete || !tile.el.naturalWidth) throw new Error('Im Ausschnitt fehlen Kartenkacheln. Bitte die Basiskarte neu laden oder wechseln.');
    ctx.drawImage(tile.el, x, y, tileSize.x, tileSize.y); count++;
  }
  if (!count) throw new Error('Noch keine Basiskartenkacheln verfügbar. Bitte kurz warten.');
  let raster;
  try { raster = ctx.getImageData(0, 0, width, height); }
  catch { throw new Error('Diese Basiskarte erlaubt keinen Pixelzugriff. Bitte eine andere Basiskarte wählen.'); }
  return {
    basemap: true, zoom, canvas, raster,
    pixelToLatLng(p) { return map.unproject([origin.x + p[0] + .5, origin.y + p[1] + .5], zoom); },
    projectLatLng(ll) {
      const p = map.project(ll, zoom);
      return [p.x - origin.x - .5, p.y - origin.y - .5];
    },
    latLngToPixel(ll, margin = 0) {
      const p = map.project(ll, zoom), x = p.x - origin.x - .5, y = p.y - origin.y - .5;
      if (x < -margin || y < -margin || x > width - 1 + margin || y > height - 1 + margin) return null;
      return [Math.max(0, Math.min(width - 1, x)), Math.max(0, Math.min(height - 1, y))];
    }
  };
}

// A drawing keeps one coordinate frame while its search rasters change.
export function createBasemapCoordinates(snapshot) {
  return { basemap: true, zoom: snapshot.zoom, pixelScale: 1, pixelToLatLng: snapshot.pixelToLatLng, latLngToPixel: snapshot.projectLatLng };
}
