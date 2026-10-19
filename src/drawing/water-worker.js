import { loadWaterPolygons } from './water-data.js';
import { subtractWater } from './water-geometry.js';

self.onmessage = async ({ data }) => {
  const controller = new AbortController();
  try {
    const { polygons, plan } = await loadWaterPolygons(data.object, data.mode, {
      signal: controller.signal, onProgress: progress => self.postMessage({ progress })
    });
    self.postMessage({ processing: true, resolution: plan.resolution });
    self.postMessage({ ...subtractWater(data.object, polygons), resolution: plan.resolution });
  } catch (error) {
    controller.abort();
    self.postMessage({ error: error.message });
  }
};
