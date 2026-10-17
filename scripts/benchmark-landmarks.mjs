import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadImage } from '../src/headless/image.js';

const { values: args } = parseArgs({ options: { case: { type: 'string' }, out: { type: 'string' } } });
if (!args.case) throw new Error('--case landmarks-case.json required.');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const data = await read(args.case), directory = args.out ?? `output/headless/landmarks-${data.name}`;
await mkdir(directory, { recursive: true });
const save = async (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n');
const protocol = await read(data.protocol), matches = [];
for (const file of protocol.files) {
  const actual = createHash('sha256').update(await readFile(file.path)).digest('hex');
  matches.push({ path: file.path, matches: actual === file.sha256 });
  if (file.path === data.landmarks && actual !== file.sha256) throw new Error('Frozen landmark observations have changed.');
}
// Extract only the raster before assigning or fitting. Reference points and
// alignment are not passed to either CLI command.
const raster = data.image ? await loadImage(data.image) : await loadImage((await read(data.imageProject)).image.data);
const imagePath = join(directory, basename(data.image ?? 'source-image') + '.' + raster.format);
await writeFile(imagePath, raster.bytes);
const input = await read(data.landmarks);
if (input.image?.sha256 !== raster.sha256) throw new Error('Frozen observations refer to a different raster.');
const controls = input.landmarks.filter(p => p.role === 'control');
if (controls.length < 3 || controls.some(p => p.observations?.length !== 1 || p.candidates?.length !== 1)) throw new Error('At least three independently resolved controls required.');
const fitPixels = new Set(input.landmarks.filter(p => p.role !== 'control').flatMap(p => p.observations.map(o => o.pixel.join(','))));
if (controls.some(p => fitPixels.has(p.observations[0].pixel.join(',')))) throw new Error('Control pixel also occurs among fit observations.');
await save('checks.json', { points: controls.map((p, i) => ({ id: i + 1, name: p.id, pixel: p.observations[0].pixel, target: p.candidates[0].target, fit: false })) });
const run = (command, params) => {
  process.stderr.write(`Landmark benchmark: ${command}\n`);
  const result = spawnSync(process.execPath, ['scripts/headless.mjs', command, ...params], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
};
const assignment = run('assign', ['--image', imagePath, '--request', data.landmarks, '--out', join(directory, 'assignments.json')]);
const summary = { name: data.name, imageSha256: raster.sha256, protocolMatches: matches, classification: matches.every(p => p.matches) ? 'original frozen algorithm' : 'development after first result; not an unseen validation', assignmentStatus: assignment.status, assigned: assignment.assignments.length, unresolved: assignment.unresolved, coverage: assignment.diagnostics.imageHullFraction };
if (assignment.status === 'assigned') {
  run('fit', ['--image', imagePath, '--request', join(directory, 'assignments.json'), '--out', join(directory, 'project.json'), '--report', join(directory, 'fit-report.json')]);
  const comparison = run('compare', ['--project', join(directory, 'project.json'), '--reference', data.reference, '--request', join(directory, 'checks.json'), '--out', join(directory, 'comparison.json')]);
  Object.assign(summary, { checkpoints: comparison.checkpoints, candidateRms: comparison.candidateRms, referenceRms: comparison.referenceRms, atLeastAsGood: comparison.atLeastAsGood });
}
await save('summary.json', summary);
console.log(JSON.stringify(summary));
if (!summary.atLeastAsGood) process.exitCode = 1;
