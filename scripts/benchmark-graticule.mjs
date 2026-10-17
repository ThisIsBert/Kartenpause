import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const { values: args } = parseArgs({ options: { case: { type: 'string' }, out: { type: 'string' } } });
if (!args.case) throw new Error('--case grid-case.json required.');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const data = await read(args.case), development = await read(data.developmentCase);
const lock = await read('benchmarks/protocol/headless-development-lock.json');
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
if (await digest(data.developmentCase) !== lock.files.find(p => p.path === data.developmentCase)?.sha256) throw new Error('Development checkpoints changed.');
const directory = args.out ?? `output/headless/${data.name}`;
await mkdir(directory, { recursive: true });
const save = async (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n');
await save('protocol-before-fit.json', { note: 'Existing city checkpoints unchanged. Full grid lines marked control are excluded from fitting.', gridRequest: { path: data.gridRequest, sha256: await digest(data.gridRequest) }, algorithm: await Promise.all(['src/headless/graticule.js', 'src/headless/georeference.js', 'src/headless/model-selection.js', 'src/geo/raster-affine.js'].map(async path => ({ path, sha256: await digest(path) }))) });
const run = (command, params) => {
  process.stderr.write(`Grid benchmark: ${command}\n`);
  const result = spawnSync(process.execPath, ['scripts/headless.mjs', command, ...params], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
};
const measured = run('graticule', ['--image', development.image, '--request', data.gridRequest, '--out', join(directory, 'points.json')]);
await save('preview.json', { ...measured.previewRequest, maxSize: 1600, grid: 100 });
run('inspect', ['--image', development.image, '--request', join(directory, 'preview.json'), '--out', join(directory, 'measured.png')]);
const summary = { name: data.name, measurementStatus: measured.status, lines: measured.lines.map(p => ({ id: p.id, status: p.status, support: p.support, degree: p.polynomial?.length - 1, rmsPixels: p.rms })), warning: measured.provenance.warning };
if (measured.status === 'assigned') {
  const controls = measured.points.filter(p => !p.fit);
  if (controls.length < 3) throw new Error('Reserve at least one complete grid line yielding three controls.');
  await save('withheld-line-checks.json', { points: controls });
  await save('city-checks.json', development.checks);
  run('fit', ['--image', development.image, '--request', join(directory, 'points.json'), '--out', join(directory, 'project.json'), '--report', join(directory, 'fit-report.json')]);
  const compare = name => {
    const comparison = run('compare', ['--project', join(directory, 'project.json'), '--reference', development.reference, '--request', join(directory, `${name}-checks.json`), '--out', join(directory, `comparison-${name}.json`)]);
    return { checkpoints: comparison.checkpoints, candidateRms: comparison.candidateRms, referenceRms: comparison.referenceRms, atLeastAsGood: comparison.atLeastAsGood };
  };
  summary.withheldLine = compare('withheld-line');
  summary.originalCityChecks = compare('city');
}
await save('summary.json', summary);
console.log(JSON.stringify(summary));
// Report both tests; do not hide an inconvenient older comparison.
if (!summary.withheldLine?.atLeastAsGood || !summary.originalCityChecks?.atLeastAsGood) process.exitCode = 1;
