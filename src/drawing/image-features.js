// Shared, dependency-free original-pixel color features. Keep the classic
// wand's conversion constants and arithmetic unchanged.
const linear = Float64Array.from({ length: 256 }, (_, c) => { const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
export function lab(data, i = 0) {
  const r = linear[data[i]], g = linear[data[i + 1]], b = linear[data[i + 2]];
  const f = v => v > .008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  const x = f((.4124564 * r + .3575761 * g + .1804375 * b) / .95047);
  const y = f(.2126729 * r + .7151522 * g + .072175 * b);
  const z = f((.0193339 * r + .119192 * g + .9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export const colorDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const pixelContrast = (data, a, b) => Math.hypot(data[a] - data[b], data[a + 1] - data[b + 1], data[a + 2] - data[b + 2]);
export function median(values) {
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}
export const medianColor = samples => [0, 1, 2].map(c => median(samples.map(p => p[c])));
