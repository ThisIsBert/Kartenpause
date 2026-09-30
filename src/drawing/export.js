export function drawingFilename(objects) {
  const name = objects.length === 1 ? String(objects[0].name || '').trim() : '';
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').replace(/\.geojson$/i, '');
  const base = safe && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe) ? safe : 'kartenpause';
  return `${base}.geojson`;
}
