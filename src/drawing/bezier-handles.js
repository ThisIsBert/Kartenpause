import { edgeControls, isClosed } from './geometry.js';

// Freeze automatic tangents before editing so only the intended handles change.
export function materializeControls(shape) {
  if (shape.curveSegments) return;
  shape.curveSegments = shape.vertices.slice(0, shape.vertices.length - (isClosed(shape.kind) ? 0 : 1)).map((a, i) => {
    const b = shape.vertices[(i + 1) % shape.vertices.length], controls = edgeControls(shape, i);
    return controls ? [controls[0].map((v, k) => v - a[k]), controls[1].map((v, k) => v - b[k])] : null;
  });
}

export function vertexControls(shape, index) {
  const n = shape.vertices.length, closed = isClosed(shape.kind);
  return {
    incoming: index > 0 || closed ? edgeControls(shape, (index + n - 1) % n)?.[1] ?? null : null,
    outgoing: index < n - 1 || closed ? edgeControls(shape, index)?.[0] ?? null : null
  };
}

export function controlsAligned(shape, index) {
  const { incoming, outgoing } = vertexControls(shape, index), anchor = shape.vertices[index];
  if (!incoming || !outgoing) return false;
  const a = incoming.map((v, k) => v - anchor[k]), b = outgoing.map((v, k) => v - anchor[k]);
  const lengths = Math.hypot(...a) * Math.hypot(...b);
  return lengths > 0 && a[0] * b[0] + a[1] * b[1] < 0 && Math.abs(a[0] * b[1] - a[1] * b[0]) <= lengths * 1e-7;
}

function setOffset(shape, index, side, offset) {
  const edge = side === 'incoming' ? (index + shape.vertices.length - 1) % shape.vertices.length : index;
  shape.curveSegments[edge][side === 'incoming' ? 1 : 0] = offset;
}

export function moveControl(shape, index, side, point, { coupled = controlsAligned(shape, index), snap = false } = {}) {
  const controls = vertexControls(shape, index);
  if (!controls[side]) return;
  materializeControls(shape);
  const anchor = shape.vertices[index], opposite = side === 'incoming' ? 'outgoing' : 'incoming';
  let offset = point.map((v, k) => v - anchor[k]);
  const length = Math.hypot(...offset);
  if (snap && length) {
    const angle = Math.round(Math.atan2(offset[1], offset[0]) / (Math.PI / 4)) * Math.PI / 4;
    offset = [Math.cos(angle) * length, Math.sin(angle) * length];
  }
  setOffset(shape, index, side, offset);
  if (coupled && length && controls[opposite]) {
    const otherLength = Math.hypot(...controls[opposite].map((v, k) => v - anchor[k]));
    setOffset(shape, index, opposite, offset.map(v => -v / length * otherLength));
  }
}

export function alignControls(shape, index) {
  const controls = vertexControls(shape, index), anchor = shape.vertices[index];
  if (!controls.incoming || !controls.outgoing) return;
  materializeControls(shape);
  // Prefer the outgoing tangent, falling back to the incoming one if collapsed.
  const side = ['outgoing', 'incoming'].find(side => controls[side] && Math.hypot(...controls[side].map((v, k) => v - anchor[k])) > 0);
  if (side) {
    const opposite = side === 'incoming' ? 'outgoing' : 'incoming';
    if (!Math.hypot(...controls[opposite].map((v, k) => v - anchor[k]))) {
      setOffset(shape, index, opposite, controls[side].map((v, k) => anchor[k] - v));
    }
    moveControl(shape, index, side, controls[side], { coupled: true });
  } else {
    const n = shape.vertices.length, before = shape.vertices[(index + n - 1) % n], after = shape.vertices[(index + 1) % n];
    let tangent = after.map((v, k) => (v - before[k]) / 6);
    if (!Math.hypot(...tangent)) tangent = after.map((v, k) => (v - anchor[k]) / 3);
    setOffset(shape, index, 'outgoing', tangent);
    setOffset(shape, index, 'incoming', tangent.map(v => -v));
  }
}
