#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { loadImage, decodeRaster, previewImage } from '../src/headless/image.js';
import { fitGeoreference, projectTransform, validatePoints, evaluate } from '../src/headless/georeference.js';
import { vectorize } from '../src/headless/vectorize.js';
import { createGeoToPixel, referencePaths } from '../src/headless/overlay.js';
import { assignLandmarks } from '../src/headless/assignment.js';
import { detectSymbols } from '../src/headless/symbols.js';
import { lookupRecords, lookupGeonames } from '../src/headless/gazetteer.js';
import { extractGraticule } from '../src/headless/graticule.js';

const help = `Kartenpause headless (Node >=24). All results/errors are JSON.
  inspect --image FILE [--out PREVIEW.png] [--request crop.json]
  fit --image FILE --request points.json --out PROJECT.json [--report REPORT.json]
  assign --image FILE --request landmarks.json [--out ASSIGNMENTS.json]
  symbols --image FILE --request regions.json [--out SYMBOLS.json]
  graticule --image FILE --request grid-lines.json [--out GRID-POINTS.json]
  lookup --reference GAZETTEER.json-or-txt --request queries.json [--out CANDIDATES.json]
  transform --project PROJECT.json --request pixels.json [--out FILE.json]
  vectorize --project PROJECT.json --request objects.json [--out FILE.geojson]
  evaluate --project PROJECT.json --request points.json [--out REPORT.json]
  compare --project PROJECT.json --reference GROUND_TRUTH.json --request checks.json [--out REPORT.json]
  overlay --project PROJECT.json --reference WGS84.geojson --out PREVIEW.png [--request preview.json]
Coordinates: pixel=[x,y] at original resolution, origin top left; source={u:x/width,v:y/height}.
See docs/headless.md for request schemas. No AI service or browser is required.`;

async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function save(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }

try {
  const { positionals, values: args } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['image', 'project', 'reference', 'request', 'out', 'report'].map(k => [k, { type: 'string' }]).concat([['help', { type: 'boolean', short: 'h' }]])) });
  const command = positionals[0];
  if (args.help || !command) { console.log(help); process.exit(0); }
  if (positionals.length !== 1) throw new Error('Expected one command.');
  const requireArgs = (...keys) => { for (const key of keys) if (!args[key]) throw new Error(`--${key} is required.`); };
  let result;
  if (command === 'inspect') {
    requireArgs('image');
    const image = await loadImage(args.image);
    result = { name: basename(args.image), sha256: image.sha256, width: image.width, height: image.height, format: image.format };
    if (args.out) { await mkdir(dirname(args.out), { recursive: true }); result.preview = await previewImage(image, args.out, args.request ? await json(args.request) : {}); }
  } else if (command === 'lookup') {
    requireArgs('reference', 'request');
    const request = await json(args.request);
    result = /\.(txt|tsv)$/i.test(args.reference) ? await lookupGeonames(args.reference, request) : lookupRecords(await json(args.reference), request);
    if (args.out) await save(args.out, result);
  } else if (command === 'graticule') {
    requireArgs('image', 'request');
    result = await extractGraticule(await loadImage(args.image), await json(args.request));
    if (args.out) await save(args.out, result);
  } else if (command === 'symbols') {
    requireArgs('image', 'request');
    result = await detectSymbols(await loadImage(args.image), await json(args.request));
    if (args.out) await save(args.out, result);
  } else if (command === 'assign') {
    requireArgs('image', 'request');
    const image = await loadImage(args.image), request = await json(args.request);
    if (request.image?.sha256 && request.image.sha256 !== image.sha256) throw new Error('Landmarks refer to a different source image.');
    result = await assignLandmarks(request.landmarks, image.width, image.height, request.options);
    result.image = { sha256: image.sha256, width: image.width, height: image.height };
    if (args.out) await save(args.out, result);
  } else if (command === 'fit') {
    requireArgs('image', 'request', 'out');
    const image = await loadImage(args.image), request = await json(args.request);
    if (request.status === 'needs-review') throw new Error('Landmark assignment requires review before fitting.');
    if (request.image?.sha256 && request.image.sha256 !== image.sha256) throw new Error('Assignments refer to a different source image.');
    const fit = await fitGeoreference(request.points, image.width, image.height, { ...request.options, progress: family => process.stderr.write(`Fitting ${family}\n`) });
    if (request.provenance) { fit.report.inputProvenance = request.provenance; fit.project.referenceProvenance = request.provenance; }
    fit.project.image = { name: basename(args.image), data: image.dataUrl };
    await save(args.out, fit.project);
    if (args.report) await save(args.report, fit.report);
    result = { project: args.out, report: fit.report };
  } else if (command === 'overlay') {
    requireArgs('project', 'reference', 'out');
    const project = await json(args.project), image = await loadImage(project.image.data);
    const transform = projectTransform(project, image.width, image.height);
    const reference = referencePaths(await json(args.reference), createGeoToPixel(transform, image.width, image.height, project.alignment.center.lon));
    const options = args.request ? await json(args.request) : {};
    await mkdir(dirname(args.out), { recursive: true });
    const preview = await previewImage(image, args.out, { ...options, paths: [...(options.paths ?? []), ...reference.paths], markers: [...(options.markers ?? []), ...reference.markers] });
    result = { reference: args.reference, mappedSamples: reference.mappedSamples, unmappedSamples: reference.unmappedSamples, pathCount: reference.paths.length, preview };
  } else if (['transform', 'vectorize', 'evaluate', 'compare'].includes(command)) {
    requireArgs('project', 'request');
    const project = await json(args.project), image = await loadImage(project.image.data), request = await json(args.request);
    const transform = projectTransform(project, image.width, image.height);
    if (command === 'transform') {
      result = { coordinates: request.pixels.map(pixel => {
        if (!Array.isArray(pixel) || pixel.length !== 2 || !pixel.every(Number.isFinite) || pixel[0] < 0 || pixel[0] > image.width || pixel[1] < 0 || pixel[1] > image.height) throw new Error('Pixel outside image.');
        return transform(pixel[0] / image.width, pixel[1] / image.height);
      }) };
    } else if (command === 'vectorize') {
      const needsRaster = request.objects?.some(o => ['region', 'magnetic'].includes(o.mode));
      result = vectorize(needsRaster ? await decodeRaster(image, request.crop) : image, transform, request.objects);
    }
    else {
      const points = validatePoints(request.points, image.width, image.height);
      result = evaluate(transform, points);
      if (command === 'compare') {
        requireArgs('reference');
        const reference = await json(args.reference), refImage = await loadImage(reference.image.data);
        if (refImage.width !== image.width || refImage.height !== image.height || !refImage.bytes.equals(image.bytes)) throw new Error('Comparison requires identical source images.');
        const human = evaluate(projectTransform(reference, image.width, image.height), points);
        const rms = r => Math.sqrt(r.rows.reduce((s, p) => s + p.error ** 2, 0) / r.rows.length);
        if (!points.length) throw new Error('Independent checkpoints required.');
        result = { units: 'metres', checkpoints: points.length, candidate: result, reference: human, candidateRms: rms(result), referenceRms: rms(human), atLeastAsGood: rms(result) <= rms(human), caution: 'Valid only if checkpoints were independently identified and not used for candidate fitting or selection.' };
      }
    }
    if (args.out) await save(args.out, result);
  } else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(result));
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
}
