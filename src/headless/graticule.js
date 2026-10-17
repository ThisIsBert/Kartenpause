import { decodeRaster } from './image.js';
import numeric from 'numeric';

const finitePoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

function measureLine(raster, line, options) {
  const [x, y] = line.from, dx = line.to[0] - x, dy = line.to[1] - y, length = Math.hypot(dx, dy);
  const normal = [-dy / length, dx / length], stations = [];
  const count = Math.min(2000, Math.ceil(length / 3));
  for (let i = 0; i <= count; i++) {
    const t = i / count, candidates = [];
    let run = [];
    const flush = () => {
      if (run.length && run.length <= options.maxWidth) {
        const weight = run.reduce((s, p) => s + p.weight, 0);
        candidates.push({ t: t - .5, offset: run.reduce((s, p) => s + p.offset * p.weight, 0) / weight });
      }
      run = [];
    };
    for (let offset = -options.radius; offset <= options.radius; offset++) {
      const px = Math.round(x + dx * t + normal[0] * offset) - raster.offset[0];
      const py = Math.round(y + dy * t + normal[1] * offset) - raster.offset[1];
      const index = (py * raster.width + px) * 4;
      const value = (raster.data[index] + raster.data[index + 1] + raster.data[index + 2]) / 3;
      if (px >= 0 && py >= 0 && px < raster.width && py < raster.height && raster.data[index + 3] >= 128 && value < options.threshold) run.push({ offset, weight: options.threshold - value });
      else flush();
    }
    flush(); stations.push(candidates);
  }
  const samples = stations.flat();
  if (samples.length < 2) return { ...line, status: 'needs-review', reason: 'Insufficient compact dark strokes along the proposed grid line.' };
  let state = options.seed;
  const random = n => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
  const value = (coefficients, t) => coefficients.reduce((s, c, i) => s + c * t ** i, 0);
  const select = coefficients => stations.flatMap(candidates => {
    const ranked = candidates.map(p => ({ ...p, residual: Math.abs(p.offset - value(coefficients, p.t)) })).sort((p, q) => p.residual - q.residual);
    return ranked[0]?.residual <= options.maxResidual ? [ranked[0]] : [];
  });
  let best;
  const remember = coefficients => {
    const inliers = select(coefficients), cost = inliers.reduce((s, p) => s + p.residual ** 2, 0);
    if (!best || inliers.length > best.inliers.length || inliers.length === best.inliers.length && cost < best.cost) best = { coefficients, inliers, cost };
  };
  remember([0, 0]);
  for (let i = 0; i < options.trials; i++) {
    const p = samples[random(samples.length)], q = samples[random(samples.length)];
    if (Math.abs(q.t - p.t) < .2) continue;
    const b = (q.offset - p.offset) / (q.t - p.t), a = p.offset - b * p.t;
    if (Math.max(Math.abs(a - b / 2), Math.abs(a + b / 2)) <= options.radius) remember([a, b]);
  }
  const straight = best;
  if (options.degree !== 1) for (let i = 0; i < options.trials; i++) {
    const rows = [samples[random(samples.length)], samples[random(samples.length)], samples[random(samples.length)]].sort((a, b) => a.t - b.t);
    if (rows[1].t - rows[0].t < .15 || rows[2].t - rows[1].t < .15 || rows[2].t - rows[0].t < .5) continue;
    try {
      const coefficients = numeric.solve(rows.map(p => [1, p.t, p.t ** 2]), rows.map(p => p.offset));
      if ([-.5, -.25, 0, .25, .5].every(t => Math.abs(value(coefficients, t)) <= options.radius)) remember(coefficients);
    } catch { /* Degenerate curve sample. */ }
  }
  if (best.coefficients.length === 3 && options.degree === 'auto' && best.inliers.length < straight.inliers.length + .05 * stations.length) best = straight;
  for (let pass = 0; pass < 3 && best.inliers.length >= 2; pass++) {
    const rows = best.inliers, degree = best.coefficients.length;
    try {
      const matrix = Array.from({ length: degree }, (_, i) => Array.from({ length: degree }, (_, j) => rows.reduce((s, p) => s + p.t ** (i + j), 0)));
      const target = Array.from({ length: degree }, (_, i) => rows.reduce((s, p) => s + p.offset * p.t ** i, 0));
      remember(numeric.solve(matrix, target));
    } catch { break; }
  }
  const support = best.inliers.length / stations.length, span = Math.max(...best.inliers.map(p => p.t)) - Math.min(...best.inliers.map(p => p.t));
  const rms = Math.sqrt(best.cost / best.inliers.length);
  if (!Number.isFinite(rms) || support < options.minSupport || span < .75) return { ...line, status: 'needs-review', support, span, rms, reason: 'No sufficiently continuous grid line. Check labels, corridor, curvature and raster contrast.' };
  const from = line.from.map((v, k) => v + normal[k] * value(best.coefficients, -.5));
  const to = line.to.map((v, k) => v + normal[k] * value(best.coefficients, .5));
  return { ...line, status: 'measured', from, to, hint: { from: line.from, to: line.to }, normal, polynomial: best.coefficients, support, span, rms, inlierStations: best.inliers.length, stations: stations.length };
}

function curve(line, t, derivative = false) {
  const { from, to } = line.hint, z = t - .5;
  const offset = line.polynomial.reduce((s, c, i) => s + (derivative ? i ? i * c * z ** (i - 1) : 0 : c * z ** i), 0);
  return from.map((v, k) => (derivative ? to[k] - v : v + (to[k] - v) * t) + line.normal[k] * offset);
}

function intersection(a, b) {
  const p = a.from, q = b.from, r = a.to.map((v, k) => v - p[k]), s = b.to.map((v, k) => v - q[k]);
  const cross = (u, v) => u[0] * v[1] - u[1] * v[0], determinant = cross(r, s);
  if (Math.abs(determinant) / Math.hypot(...r) / Math.hypot(...s) < .05) return null;
  const delta = q.map((v, k) => v - p[k]);
  let t = cross(delta, s) / determinant, u = cross(delta, r) / determinant;
  for (let pass = 0; pass < 12; pass++) {
    const A = curve(a, t), B = curve(b, u), error = A.map((v, k) => v - B[k]);
    if (Math.hypot(...error) < .001) break;
    const da = curve(a, t, true), db = curve(b, u, true), determinant = cross(da, db);
    if (Math.abs(determinant) < 1e-8) return null;
    t -= cross(error, db) / determinant; u -= cross(error, da) / determinant;
  }
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  const A = curve(a, t), B = curve(b, u);
  return Math.hypot(...A.map((v, k) => v - B[k])) < .01 ? A : null;
}

export async function extractGraticule(image, request) {
  if (!Array.isArray(request.lines) || request.lines.length < 4 || request.lines.length > 50) throw new Error('Four to 50 labelled grid lines required.');
  if (request.image?.sha256 && request.image.sha256 !== image.sha256) throw new Error('Grid observations refer to a different source image.');
  const options = { radius: 12, threshold: 140, maxWidth: 4, trials: 192, maxResidual: 1.25, minSupport: .55, degree: 'auto', seed: 20261016, ...request.options };
  if (![1, 2, 'auto'].includes(options.degree)) throw new Error('Grid degree must be 1, 2 or auto.');
  if (!Number.isSafeInteger(options.radius) || options.radius < 1 || options.radius > 50 || !Number.isSafeInteger(options.trials) || options.trials < 1 || options.trials > 10000 || !Number.isSafeInteger(options.seed) || options.seed < 1 || options.seed > 0xffffffff || !Number.isFinite(options.threshold) || options.threshold < 1 || options.threshold > 255 || !Number.isSafeInteger(options.maxWidth) || options.maxWidth < 1 || options.maxWidth > 30 || !Number.isFinite(options.maxResidual) || options.maxResidual <= 0 || !Number.isFinite(options.minSupport) || options.minSupport <= 0 || options.minSupport > 1) throw new Error('Invalid grid measurement options.');
  const ids = new Set(), labels = new Set();
  for (const line of request.lines) {
    if (typeof line.id !== 'string' || !line.id || ids.has(line.id) || !['longitude', 'latitude'].includes(line.axis) || !Number.isFinite(line.value) || Math.abs(line.value) > (line.axis === 'longitude' ? 180 : 85.05112878) || !['fit', 'control'].includes(line.role ?? 'fit') || typeof line.evidence !== 'string' || !line.evidence.trim() || ![line.from, line.to].every(p => finitePoint(p) && p[0] >= 0 && p[1] >= 0 && p[0] < image.width && p[1] < image.height) || Math.hypot(...line.from.map((v, k) => v - line.to[k])) < 40) throw new Error('Invalid grid line, evidence, role or duplicate ID.');
    if (labels.has(`${line.axis}:${line.value}`)) throw new Error('Duplicate grid degree label.');
    ids.add(line.id); labels.add(`${line.axis}:${line.value}`);
  }
  const lines = [];
  for (const line of request.lines) {
    const left = Math.max(0, Math.floor(Math.min(line.from[0], line.to[0]) - options.radius - 1));
    const top = Math.max(0, Math.floor(Math.min(line.from[1], line.to[1]) - options.radius - 1));
    const right = Math.min(image.width, Math.ceil(Math.max(line.from[0], line.to[0]) + options.radius + 2));
    const bottom = Math.min(image.height, Math.ceil(Math.max(line.from[1], line.to[1]) + options.radius + 2));
    lines.push(measureLine(await decodeRaster(image, { left, top, width: right - left, height: bottom - top }), line, options));
  }
  const measured = lines.filter(p => p.status === 'measured'), points = [];
  for (const meridian of measured.filter(p => p.axis === 'longitude')) for (const parallel of measured.filter(p => p.axis === 'latitude')) {
    const pixel = intersection(meridian, parallel);
    if (!pixel || pixel[0] < 0 || pixel[1] < 0 || pixel[0] >= image.width || pixel[1] >= image.height) continue;
    points.push({ id: points.length + 1, name: `${meridian.id} / ${parallel.id}`, pixel, target: { lon: meridian.value, lat: parallel.value }, fit: meridian.role !== 'control' && parallel.role !== 'control', pixelSource: `Measured grid crossing in raster ${image.sha256}`, coordinateSource: `${meridian.evidence}; ${parallel.evidence}`, gridLines: [meridian.id, parallel.id] });
  }
  return { status: measured.length === lines.length && points.filter(p => p.fit).length >= 4 ? 'assigned' : 'needs-review', image: { sha256: image.sha256, width: image.width, height: image.height }, points, lines, options: request.fitOptions, provenance: { type: 'labelled-graticule', warning: 'Grid intersections share line measurements. Leave-one-point-out errors are correlated; validate against independent features or withhold complete grid lines. Labels and coordinate datum require semantic verification.' }, previewRequest: { paths: measured.map(p => Array.from({ length: 33 }, (_, i) => curve(p, i / 32))), markers: points.map(p => ({ id: p.id, pixel: p.pixel })) } };
}
