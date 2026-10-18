// Invert the rendered image mesh, rather than approximating the inverse TPS.
// The last drawn triangle wins where a warped image overlaps itself.
export function sourceFromTriangles(point, triangles, width, height) {
  if (!(width > 0 && height > 0)) return null;
  for (let i = triangles.length - 1; i >= 0; i--) {
    const [a, b, c] = triangles[i];
    const det = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(det) < 1e-9) continue;
    const x = point.x - a.x, y = point.y - a.y;
    const v = (x * (c.y - a.y) - y * (c.x - a.x)) / det;
    const w = ((b.x - a.x) * y - (b.y - a.y) * x) / det;
    const u = 1 - v - w;
    if (Math.min(u, v, w) < -1e-9) continue;
    return {
      u: Math.max(0, Math.min(1, (u * a.sx + v * b.sx + w * c.sx) / width)),
      v: Math.max(0, Math.min(1, (u * a.sy + v * b.sy + w * c.sy) / height))
    };
  }
  return null;
}
