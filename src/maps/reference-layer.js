import { MaplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createReferenceStyle, referenceName, referenceColors } from './reference-style.js';

// Bundle the module worker explicitly: its default relative URL is otherwise
// lost when Vite prebundles MapLibre (and when publishing below /Kartenpause/).
setWorkerUrl(workerUrl);

const attribution = '<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

export function createReferenceLayer(language, onUnavailable) {
  const layer = new MaplibreGL({
    style: createReferenceStyle(language), padding: 0, interactive: false,
    isBasemap: true, minZoom: -1, maxZoom: 18,
    // Preserve the GL buffer for the magnetic tool, color picker and wand.
    canvasContextAttributes: { preserveDrawingBuffer: true },
    attributionControl: { customAttribution: attribution }
  });
  layer.getAttribution = () => attribution;
  const add = layer.onAdd, remove = layer.onRemove;
  layer.onAdd = function (map) {
    this._basemapFailed = false;
    try {
      add.call(this, map);
      const gl = this.getMaplibreMap();
      gl.setMissingStyleImageResolver((id) => {
        if (id !== 'reference-place' || gl.hasImage(id)) return;
        // A tiny dot makes the exact place anchor visible for control points.
        const data = new Uint8Array(7 * 7 * 4);
        const rgb = referenceColors.place.match(/\w\w/g).map(v => parseInt(v, 16));
        for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
          const i = (y * 7 + x) * 4;
          data.set([...rgb, Math.round(255 * Math.max(0, Math.min(1, 3 - Math.hypot(x - 3, y - 3))))], i);
        }
        gl.addImage(id, { width: 7, height: 7, data });
      });
      // An idle event can follow failed tile requests too. Keep the notice
      // visible for an incomplete map until the layer is selected again.
      this.getMaplibreMap().on('error', () => { this._basemapFailed = true; onUnavailable(true); });
    } catch {
      this._basemapFailed = true;
      onUnavailable(true);
    }
  };
  layer.onRemove = function (map) {
    if (this.getMaplibreMap()) remove.call(this, map);
    else this.getContainer()?.remove();
    onUnavailable(false);
  };
  layer.setLanguage = function (next) {
    this.options.style = createReferenceStyle(next);
    const gl = this.getMaplibreMap();
    if (!gl) return;
    const update = () => {
      for (const spec of this.options.style.layers) {
        if (spec.type === 'symbol') gl.setLayoutProperty(spec.id, 'text-field', referenceName(next));
      }
    };
    if (gl.isStyleLoaded()) update();
    else gl.once('load', update);
  };
  return layer;
}
