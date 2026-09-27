import { selectColor, paintSelection, selectionPolygons } from './selection.js';
import { rasterizePolygons } from './rework-geometry.js';
let raster;
self.onmessage = ({ data }) => {
  if (data.type === 'init') { raster = data.raster; return; }
  try {
    let mask = data.mask;
    if (data.type === 'geometry') mask = rasterizePolygons(data.polygons, raster.width, raster.height);
    if (data.type === 'select') {
      const region = selectColor(raster, data.seed, data.tolerance, data.contiguous);
      if (data.mode === 'replace') mask = region;
      else for (let i = 0; i < mask.length; i++) if (region[i]) mask[i] = data.mode === 'add' ? 1 : 0;
    } else if (data.type === 'paint') paintSelection(mask, raster.width, raster.height, data.stroke, data.diameter, data.add);
    if (!data.preserveExisting) for (let i = 0; i < mask.length; i++) if (raster.data[i * 4 + 3] < 128) mask[i] = 0;
    const polygons = selectionPolygons(mask, raster.width, raster.height);
    const count = mask.reduce((sum, value) => sum + value, 0);
    self.postMessage({ id: data.id, mask, polygons, count }, [mask.buffer]);
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
