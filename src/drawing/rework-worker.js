import { prepareSection } from './section-geometry.js';
self.onmessage = ({ data }) => {
  try { self.postMessage(prepareSection(data.result)); }
  catch (error) { self.postMessage({ error: error.message }); }
};
