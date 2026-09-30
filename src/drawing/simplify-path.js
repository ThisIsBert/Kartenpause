const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function simplify(points, tolerance = 1.2) {
  if (points.length < 3) return points;
  const keep = new Set([0, points.length - 1]), stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop(), a = points[start], b = points[end];
    const dx = b[0] - a[0], dy = b[1] - a[1], denominator = dx * dx + dy * dy;
    let maximum = tolerance, split = -1;
    for (let i = start + 1; i < end; i++) {
      const p = points[i], t = denominator ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / denominator)) : 0;
      const d = distance(p, [a[0] + t * dx, a[1] + t * dy]);
      if (d > maximum) { maximum = d; split = i; }
    }
    if (split >= 0) { keep.add(split); stack.push([start, split], [split, end]); }
  }
  return [...keep].sort((a, b) => a - b).map(i => points[i]);
}
