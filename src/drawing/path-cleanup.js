// Remove retraced dead ends, not genuine bends or crossing loops. A stack also
// handles differently subdivided outward and return legs in linear time.
export function removeSpurs(points, tolerance = 1e-7, closed = false) {
  const result = [];
  for (const point of points) {
    let p = [...point];
    while (result.length) {
      const b = result.at(-1);
      if (Math.hypot(p[0] - b[0], p[1] - b[1]) <= tolerance) { p = null; break; }
      if (result.length < 2) break;
      const a = result.at(-2), dx = b[0] - a[0], dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      const cross = dx * (p[1] - a[1]) - dy * (p[0] - a[0]);
      const returning = dx * (p[0] - b[0]) + dy * (p[1] - b[1]) < 0;
      if (!returning || Math.abs(cross) > tolerance * length) break;
      result.pop();
    }
    if (p) result.push(p);
  }
  if (closed && result.length > 3) {
    // Expose the closing join as an interior vertex, so a start anchor beside
    // the image line cannot leave a spur at the polygon's seam either.
    const ring = result.slice(0, -1), middle = Math.floor(ring.length / 2);
    const rotated = [...ring.slice(middle), ...ring.slice(0, middle)];
    return removeSpurs([...rotated, rotated[0]], tolerance);
  }
  return result;
}
