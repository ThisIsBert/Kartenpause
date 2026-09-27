// A click near the old interval is a correction. Beyond its end, or clearly
// sideways from its final part, it continues the trace (including sharp turns).
export function continuesSegment(start, end, next) {
  const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy);
  if (length < 2) return false;
  const t = ((next[0] - start[0]) * dx + (next[1] - start[1]) * dy) / (length * length);
  const side = Math.abs((next[0] - start[0]) * dy - (next[1] - start[1]) * dx) / length;
  return t > 1.08 || (t > .85 && side > Math.max(5, length * .2));
}
