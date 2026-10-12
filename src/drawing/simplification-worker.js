import { t } from '../i18n.js';
import { simplifyObject } from './simplification.js';

self.onmessage = ({ data }) => {
  try { self.postMessage({ result: simplifyObject(data.object, data.amount) }); }
  catch (error) { self.postMessage({ error: error.message || t('Vereinfachung fehlgeschlagen.') }); }
};
