import sharp from 'sharp';

export async function detectSymbols(image, request) {
  if (!Array.isArray(request.regions) || !request.regions.length || request.regions.length > 100) throw new Error('One to 100 landmark regions required.');
  const threshold = request.threshold ?? 110, minDiameter = request.minDiameter ?? 2, maxDiameter = request.maxDiameter ?? 14, limit = request.limit ?? 20;
  const color = request.color, tolerance = request.colorTolerance ?? 60;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255 || !Number.isFinite(minDiameter) || minDiameter < 1 || !Number.isFinite(maxDiameter) || maxDiameter < minDiameter || maxDiameter > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid symbol detection options.');
  if (color && (!Array.isArray(color) || color.length !== 3 || color.some(v => !Number.isFinite(v) || v < 0 || v > 255) || !Number.isFinite(tolerance) || tolerance <= 0)) throw new Error('Invalid symbol color.');
  const regions = [], ids = new Set();
  for (const region of request.regions) {
    const { id, label, left, top, width, height } = region;
    if (typeof id !== 'string' || !id || ids.has(id) || ![left, top, width, height].every(Number.isSafeInteger) || left < 0 || top < 0 || width < 1 || height < 1 || left + width > image.width || top + height > image.height || width * height > 2000000) throw new Error('Invalid symbol region or duplicate region ID.');
    ids.add(id);
    const data = await sharp(image.bytes).extract({ left, top, width, height }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
    const ink = new Uint8Array(width * height), seen = new Uint8Array(ink.length), queue = new Int32Array(ink.length);
    for (let i = 0; i < ink.length; i++) {
      const offset = i * 4;
      ink[i] = Number(data[offset + 3] >= 128 && (color ? Math.hypot(...color.map((v, k) => v - data[offset + k])) <= tolerance : (data[offset] + data[offset + 1] + data[offset + 2]) / 3 <= threshold));
    }
    const found = [];
    for (let start = 0; start < ink.length; start++) if (ink[start] && !seen[start]) {
      let head = 0, tail = 1, minX = width, minY = height, maxX = 0, maxY = 0, sumX = 0, sumY = 0;
      queue[0] = start; seen[start] = 1;
      while (head < tail) {
        const index = queue[head++], x = index % width, y = Math.floor(index / width);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); sumX += x; sumY += y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          const next = (y + dy) * width + x + dx;
          if (ink[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
        }
      }
      const w = maxX - minX + 1, h = maxY - minY + 1, aspect = Math.min(w, h) / Math.max(w, h), fill = tail / (w * h);
      if (minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1 || Math.min(w, h) < minDiameter || Math.max(w, h) > maxDiameter || aspect < .55 || fill < .2) continue;
      found.push({ pixel: [left + sumX / tail, top + sumY / tail], box: { left: left + minX, top: top + minY, width: w, height: h }, area: tail, shapeScore: aspect * Math.min(1, fill / .6) });
    }
    found.sort((a, b) => b.shapeScore - a.shapeScore || a.pixel[1] - b.pixel[1] || a.pixel[0] - b.pixel[0]);
    const observations = found.slice(0, limit).map((o, i) => ({ ...o, id: `${id}:symbol-${i+1}`, evidence: `Raster ${image.sha256}; ROI ${left},${top},${width},${height}; connected ink component ${o.box.left},${o.box.top},${o.box.width},${o.box.height}. Semantic identity requires visual verification.` }));
    regions.push({ id, label, status: observations.length ? 'proposals' : 'no-symbol', detectedCount: found.length, truncated: found.length > limit, observations, previewRequest: { left, top, width, height, scale: Math.min(8, 1600 / Math.max(width, height)), markers: observations.map((o, i) => ({ id: i + 1, pixel: o.pixel })) } });
  }
  return { image: { sha256: image.sha256, width: image.width, height: image.height }, algorithm: 'Connected dark/colored ink components; compact shape proposals, not a semantic detector or probability.', regions };
}
