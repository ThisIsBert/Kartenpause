import { findMagneticPath } from './magnetic-path.js';

self.onmessage = ({ data }) => {
  try { self.postMessage({ result: findMagneticPath(data) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
