import { selectColor, paintSelection, selectionPolygons } from './selection.js';
import { rasterizePolygons } from './rework-geometry.js';
import { prepareIntelligent, selectIntelligent } from './intelligent-selection.js';

// Only image features live in this closure. The color model is explicit input
// and output, so history, rejected operations and worker restarts stay atomic.
export function createSelectionProcessor(raster) {
  let intelligent;
  return data => {
    let mask = data.mask, referenceModel = data.referenceModel || null, debug;
    if (data.type === 'geometry') {
      mask = rasterizePolygons(data.polygons, raster.width, raster.height);
      referenceModel = null;
    }
    if (data.type === 'select') {
      let region;
      if (data.algorithm === 'intelligent') {
        intelligent ??= prepareIntelligent(raster);
        const result = selectIntelligent(intelligent, data.seed, data.tolerance, data.debug,
          data.mode === 'add' ? referenceModel : null, data.mode === 'add' ? mask : null);
        ({ mask: region, debug } = result);
        if (data.mode !== 'subtract') referenceModel = result.referenceModel;
      } else {
        region = selectColor(raster, data.seed, data.tolerance, data.contiguous);
        referenceModel = null;
      }
      if (data.mode === 'replace') mask = region;
      else for (let i = 0; i < mask.length; i++) if (region[i]) mask[i] = data.mode === 'add' ? 1 : 0;
    } else if (data.type === 'paint') paintSelection(mask, raster.width, raster.height, data.stroke, data.diameter, data.add);
    if (!data.preserveExisting) for (let i = 0; i < mask.length; i++) if (raster.data[i * 4 + 3] < 128) mask[i] = 0;
    const polygons = selectionPolygons(mask, raster.width, raster.height);
    const count = mask.reduce((sum, value) => sum + value, 0);
    return { mask, polygons, count, debug, referenceModel: count ? referenceModel : null };
  };
}
