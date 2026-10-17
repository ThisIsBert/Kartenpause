import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function loadImage(pathOrData) {
  const bytes = pathOrData.startsWith('data:') ? Buffer.from(pathOrData.split(',')[1], 'base64') : await readFile(pathOrData);
  const metadata = await sharp(bytes).metadata();
  if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format)) throw new Error('Unsupported raster format; use PNG, JPEG, WebP or GIF.');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), width: metadata.width, height: metadata.height, format: metadata.format,
    dataUrl: `data:image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format};base64,${bytes.toString('base64')}` };
}

export async function decodeRaster(image, crop) {
  let pipeline = sharp(image.bytes);
  if (crop) {
    const { left, top, width, height } = crop;
    if (![left, top, width, height].every(Number.isSafeInteger) || left < 0 || top < 0 || width < 1 || height < 1 || left + width > image.width || top + height > image.height) throw new Error('Invalid raster crop.');
    pipeline = pipeline.extract(crop);
  }
  const { data, info } = await pipeline.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data), offset: [crop?.left ?? 0, crop?.top ?? 0], sourceWidth: image.width, sourceHeight: image.height };
}

export async function previewImage(image, destination, options = {}) {
  const left = options.left ?? 0, top = options.top ?? 0, width = options.width ?? image.width, height = options.height ?? image.height;
  if (![left, top, width, height].every(Number.isSafeInteger) || left < 0 || top < 0 || width < 1 || height < 1 || left + width > image.width || top + height > image.height) throw new Error('Invalid crop rectangle.');
  const maxSize = options.maxSize ?? 1600;
  if (!Number.isSafeInteger(maxSize) || maxSize < 1 || maxSize > 8000) throw new Error('Invalid preview size.');
  const requestedScale = options.scale ?? 1;
  if (!Number.isFinite(requestedScale) || requestedScale <= 0 || requestedScale > 16) throw new Error('Preview scale must be greater than zero and at most 16.');
  const scale = Math.min(requestedScale, maxSize / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const step = options.grid ?? 10 ** Math.ceil(Math.log10(80 / scale));
  if (!Number.isSafeInteger(step) || step < 10) throw new Error('Grid spacing must be at least 10 source pixels.');
  const marks = [];
  if (options.paths !== undefined && !Array.isArray(options.paths)) throw new Error('paths must be an array.');
  for (const path of options.paths ?? []) {
    if (!Array.isArray(path) || path.length < 2 || path.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) throw new Error('Invalid preview path.');
    marks.push(`<path d="${path.map((p,i) => (i ? 'L' : 'M') + [(p[0]-left)*scale, (p[1]-top)*scale].join(',')).join('')}" fill="none" stroke="#0057ff" stroke-width="1.5"/>`);
  }
  for (let x = Math.ceil(left / step) * step; x < left + width; x += step) {
    const px = (x - left) * scale;
    marks.push(`<path d="M${px},0V${h}"/><text x="${px + 3}" y="16">${x}</text>`);
  }
  for (let y = Math.ceil(top / step) * step; y < top + height; y += step) {
    const py = (y - top) * scale;
    marks.push(`<path d="M0,${py}H${w}"/><text x="3" y="${py + 15}">${y}</text>`);
  }
  if (options.markers !== undefined && !Array.isArray(options.markers)) throw new Error('markers must be an array.');
  for (const [index, marker] of (options.markers ?? []).entries()) {
    const p = marker.pixel, id = marker.id ?? index + 1;
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || p[0] < 0 || p[1] < 0 || p[0] > image.width || p[1] > image.height || !Number.isSafeInteger(id) || id < 1) throw new Error('Invalid preview marker.');
    if (p[0] < left || p[0] > left + width || p[1] < top || p[1] > top + height) continue;
    const x = (p[0] - left) * scale, y = (p[1] - top) * scale;
    marks.push(`<g stroke="#0057ff" fill="none" stroke-width="1.5"><circle cx="${x}" cy="${y}" r="7"/><path d="M${x-11},${y}h22M${x},${y-11}v22"/><text x="${x+9}" y="${y-9}" fill="#0057ff" stroke="white" stroke-width="3" paint-order="stroke">${id}</text></g>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g stroke="#e6007e" stroke-width="0.6" fill="#e6007e" font-family="sans-serif" font-size="13">${marks.join('')}</g></svg>`;
  await sharp(image.bytes).extract({ left, top, width, height }).resize(w, h, { kernel: scale > 1 ? 'nearest' : 'lanczos3' }).composite([{ input: Buffer.from(svg) }]).png().toFile(destination);
  return { path: destination, crop: { left, top, width, height }, preview: { width: w, height: h }, sourcePerPreviewPixel: 1 / scale, coordinateConvention: 'x right, y down; original image coordinates, no EXIF autorotation' };
}
