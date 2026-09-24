import { traceRaster } from './trace.js';

export function createTracingBrush({ map, getRaster, onResult, onMessage }) {
  const container = map.getContainer(), canvas = document.createElement('canvas');
  canvas.className = 'tracing-brush'; canvas.hidden = true;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Pinselbereich zur Linienerkennung');
  container.append(canvas);
  let enabled = false, width = 40, stroke = null, cursor = null, raster = null, pointerId = null;
  let restoreDragging = false, gestures = [];
  const position = e => { const bounds = canvas.getBoundingClientRect(); return [e.clientX - bounds.left, e.clientY - bounds.top]; };
  function paint() {
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (stroke?.length) {
      ctx.strokeStyle = 'rgba(24, 123, 166, .25)'; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); stroke.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
    }
    if (cursor) {
      ctx.strokeStyle = '#176c65'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(...cursor, width / 2, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  function cancel() {
    stroke = null; raster = null;
    if (pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    pointerId = null; gestures.forEach(handler => handler.enable()); gestures = []; paint();
  }
  function resize() { cancel(); const size = map.getSize(); canvas.width = size.x; canvas.height = size.y; paint(); }
  map.on('resize', resize); resize();
  canvas.addEventListener('pointerdown', e => {
    if (!enabled || e.button !== 0 || pointerId !== null) return;
    e.preventDefault(); e.stopPropagation();
    canvas.focus({ preventScroll: true });
    try { raster = getRaster(); } catch { onMessage('Die Pixelkarte konnte nicht gelesen werden. Bitte die Vorlage erneut laden.'); return; }
    pointerId = e.pointerId; canvas.setPointerCapture(pointerId);
    gestures = [map.scrollWheelZoom, map.touchZoom, map.boxZoom, map.keyboard].filter(handler => handler?.enabled());
    gestures.forEach(handler => handler.disable());
    cursor = position(e); stroke = [cursor]; paint();
  });
  canvas.addEventListener('pointermove', e => {
    if (!enabled) return;
    cursor = position(e);
    if (stroke && e.pointerId === pointerId && Math.hypot(cursor[0] - stroke.at(-1)[0], cursor[1] - stroke.at(-1)[1]) >= 2) stroke.push(cursor);
    paint();
  });
  canvas.addEventListener('pointerup', e => {
    if (e.pointerId !== pointerId) return;
    e.preventDefault(); e.stopPropagation();
    const points = [...stroke, position(e)], source = raster;
    cancel();
    try { onResult(traceRaster(source, points, width)); } catch (error) { onMessage(error.message); }
  });
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('lostpointercapture', () => { if (stroke) cancel(); });
  canvas.addEventListener('pointerleave', () => { if (!stroke) { cursor = null; paint(); } });
  // Prevent Leaflet's synthesized click from creating a manual draft.
  for (const name of ['click', 'dblclick', 'mousedown', 'touchstart']) canvas.addEventListener(name, e => e.stopPropagation());
  return {
    setEnabled(value) {
      if (value === enabled) return;
      cancel(); enabled = value; canvas.hidden = !enabled; cursor = null;
      if (enabled) { restoreDragging = map.dragging.enabled(); map.dragging.disable(); resize(); }
      else if (restoreDragging) map.dragging.enable();
    },
    setWidth(value) { width = value; paint(); },
    cancel
  };
}
