import { simplifyObject } from './simplification.js';

self.onmessage = ({ data }) => {
  try { self.postMessage({ result: simplifyObject(data.object, data.amount) }); }
  catch (error) { self.postMessage({ error: error.message || 'Vereinfachung fehlgeschlagen.' }); }
};
