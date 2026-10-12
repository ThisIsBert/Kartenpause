import { selectColor, paintSelection, selectionPolygons } from './selection.js';
import { rasterizePolygons } from './rework-geometry.js';
import { prepareIntelligent, selectIntelligent } from './intelligent-selection.js';
import { reconstructSelectionContours } from './selection-contours.js';

// Only image features live in this closure. The color model is explicit input
// and output, so history, rejected operations and worker restarts stay atomic.
export function createSelectionProcessor(raster) {
  let intelligent;
  return data => {
    let mask = data.mask, referenceModel = data.referenceModel || null, debug;
    let contourScale = Math.max(1, Number(data.contourScale) || 1);
    if (data.type === 'geometry') {
      mask = rasterizePolygons(data.polygons, raster.width, raster.height);
      referenceModel = null;
      contourScale = 1;
    }
    if (data.type === 'select') {
      let region, regionScale = 1;
      if (data.algorithm === 'intelligent') {
        intelligent ??= prepareIntelligent(raster);
        const result = selectIntelligent(intelligent, data.seed, data.tolerance, data.debug,
          data.mode === 'add' ? referenceModel : null, data.mode === 'add' ? mask : null, { mode: data.mode });
        ({ mask: region, debug } = result);
        regionScale = result.contourScale;
        if (data.mode !== 'subtract') referenceModel = result.referenceModel;
      } else {
        region = selectColor(raster, data.seed, data.tolerance, data.contiguous);
        referenceModel = null;
      }
      if (data.mode === 'replace') mask = region;
      else for (let i = 0; i < mask.length; i++) if (region[i]) mask[i] = data.mode === 'add' ? 1 : 0;
      contourScale = data.mode === 'replace' ? regionScale : Math.max(contourScale, regionScale);
    } else if (data.type === 'paint') paintSelection(mask, raster.width, raster.height, data.stroke, data.diameter, data.add);
    if (!data.preserveExisting) for (let i = 0; i < mask.length; i++) if (raster.data[i * 4 + 3] < 128) mask[i] = 0;
    const polygons = selectionPolygons(mask, raster.width, raster.height);
    const count = mask.reduce((sum, value) => sum + value, 0);
    if (!count) contourScale = 1;
    const contours = reconstructSelectionContours(polygons, .75, contourScale);
    return { mask, polygons, contours, contourScale, count, debug, referenceModel: count ? referenceModel : null };
  };
}
