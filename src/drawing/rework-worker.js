import { topologyReport } from './simplification.js';
self.onmessage = ({ data }) => {
  try { self.postMessage(topologyReport(data.result, data.original)); }
  catch (error) { self.postMessage({ error: error.message }); }
};
