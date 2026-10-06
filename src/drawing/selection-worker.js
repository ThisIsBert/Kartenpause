import { createSelectionProcessor } from './selection-operation.js';
let process;
self.onmessage = ({ data }) => {
  if (data.type === 'init') { process = createSelectionProcessor(data.raster); return; }
  try {
    const result = process(data);
    self.postMessage({ id: data.id, ...result }, [result.mask.buffer]);
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
