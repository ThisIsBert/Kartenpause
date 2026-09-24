// Invert the forward georeferencing numerically, including TPS. Calculations
// use continuous projected coordinates rather than rounded screen positions.
export function createRasterInverse(width, height, forward) {
  const seeds = [];
  for (let y = 0; y <= 8; y++) for (let x = 0; x <= 8; x++) {
    const pixel = [x * (width - 1) / 8, y * (height - 1) / 8];
    try { const point = forward(pixel); if (point.every(Number.isFinite)) seeds.push({ pixel, point }); } catch { /* Outside projection. */ }
  }
  return target => {
    const nearest = [...seeds].sort((a, b) => Math.hypot(a.point[0] - target[0], a.point[1] - target[1]) - Math.hypot(b.point[0] - target[0], b.point[1] - target[1])).slice(0, 4);
    for (const seed of nearest) {
      let pixel = [...seed.pixel];
      for (let i = 0; i < 25; i++) {
        let p, px, py;
        try { p = forward(pixel); px = forward([pixel[0] + .25, pixel[1]]); py = forward([pixel[0], pixel[1] + .25]); } catch { break; }
        const a = (px[0] - p[0]) * 4, b = (py[0] - p[0]) * 4;
        const c = (px[1] - p[1]) * 4, d = (py[1] - p[1]) * 4, det = a * d - b * c;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
        const ex = target[0] - p[0], ey = target[1] - p[1];
        const dx = (d * ex - b * ey) / det, dy = (-c * ex + a * ey) / det;
        if (Math.hypot(dx, dy) < .03 && pixel[0] >= -.01 && pixel[1] >= -.01 && pixel[0] <= width - 1 + .01 && pixel[1] <= height - 1 + .01) {
          return [Math.max(0, Math.min(width - 1, pixel[0])), Math.max(0, Math.min(height - 1, pixel[1]))];
        }
        const damping = Math.min(1, Math.max(width, height) / 4 / Math.max(1, Math.hypot(dx, dy)));
        pixel = [pixel[0] + damping * dx, pixel[1] + damping * dy];
        if (pixel[0] < -width || pixel[0] > width * 2 || pixel[1] < -height || pixel[1] > height * 2) break;
      }
    }
    return null;
  };
}
