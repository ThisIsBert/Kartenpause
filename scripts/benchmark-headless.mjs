import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values: args } = parseArgs({ options: { case: { type: 'string', multiple: true }, out: { type: 'string' }, assign: { type: 'boolean' } } });
const directory = 'benchmarks/headless', output = args.out ?? (args.assign ? 'output/headless/benchmark-assignment' : args.case ? 'output/headless/benchmark-partial' : 'output/headless/benchmark');
const available = (await readdir(directory)).filter(n => n.endsWith('.json')).sort();
if (args.case?.some(name => !available.includes(name + '.json'))) throw new Error('Unknown benchmark case.');
const names = args.case ? available.filter(name => args.case.includes(name.replace(/\.json$/, ''))) : available;
const lock = JSON.parse(await readFile('benchmarks/protocol/headless-development-lock.json', 'utf8'));
for (const name of names) {
  const path = `${directory}/${name}`, expected = lock.files.find(file => file.path === path)?.sha256;
  const actual = createHash('sha256').update(await readFile(path)).digest('hex');
  if (!expected || expected !== actual) throw new Error(`Development observations changed: ${path}. Record the deliberate protocol revision before benchmarking.`);
}
const summaries = [];
const run = (command, args) => {
  const result = spawnSync(process.execPath, ['scripts/headless.mjs', command, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
};
for (const name of names) {
  const caseName = name.replace(/\.json$/, ''), folder = join(output, caseName);
  const data = JSON.parse(await readFile(join(directory, name), 'utf8'));
  const fitPixels = new Set(data.fit.points.map(p => p.pixel.join(',')));
  if (data.checks.points.length < 3 || data.checks.points.some(p => fitPixels.has(p.pixel.join(',')))) throw new Error(`Non-independent or insufficient checkpoints: ${name}`);
  await mkdir(folder, { recursive: true });
  const fitPath = join(folder, 'fit-input.json'), checksPath = join(folder, 'checks.json'), project = join(folder, 'project.json');
  let fitInput = data.fit;
  if (args.assign) {
    const landmarkPath = join(folder, 'landmarks.json');
    await writeFile(landmarkPath, JSON.stringify({ landmarks: data.fit.points.map(p => ({ id: `${p.id}:${p.name}`, role: p.fit === false ? 'control' : 'fit', observations: [{ id: 'frozen-observation', pixel: p.pixel, evidence: p.pixelSource ?? `Frozen observation in ${directory}/${name}, point ${p.id}` }], candidates: [{ id: `target-${p.id}`, target: p.target, source: p.coordinateSource ?? `Frozen target in ${directory}/${name}, point ${p.id}` }] })) }, null, 2));
    process.stderr.write(`Assigning ${caseName}\n`);
    const assigned = run('assign', ['--image', data.image, '--request', landmarkPath, '--out', join(folder, 'assignment-report.json')]);
    fitInput = { ...assigned, options: data.fit.options };
    if (assigned.status !== 'assigned') {
      summaries.push({ name: caseName, originalFitPoints: data.fit.points.length, fitPoints: assigned.assignments.length, assignmentStatus: assigned.status, diagnostics: assigned.diagnostics, unresolved: assigned.unresolved, atLeastAsGood: false, reason: 'Assignment requires review; no georeference produced.' });
      await writeFile(fitPath, JSON.stringify(fitInput, null, 2));
      await writeFile(join(output, 'summary.json'), JSON.stringify({ expectedCases: 6, completeSuite: summaries.length === 6, allPassed: false, cases: summaries }, null, 2));
      process.stderr.write(`${caseName}: assignment requires review\n`);
      continue;
    }
  }
  await writeFile(fitPath, JSON.stringify(fitInput, null, 2));
  await writeFile(checksPath, JSON.stringify(data.checks, null, 2));
  process.stderr.write(`Fitting ${caseName}\n`);
  run('fit', ['--image', data.image, '--request', fitPath, '--out', project, '--report', join(folder, 'fit-report.json')]);
  const comparison = run('compare', ['--project', project, '--reference', data.reference, '--request', checksPath, '--out', join(folder, 'comparison.json')]);
  const summary = { name: caseName, originalFitPoints: data.fit.points.length, fitPoints: fitInput.points.filter(p => p.fit !== false).length, assignmentStatus: args.assign ? fitInput.status : undefined, checkpoints: comparison.checkpoints, candidateRms: comparison.candidateRms, referenceRms: comparison.referenceRms, atLeastAsGood: comparison.atLeastAsGood, project: resolve(project), comparison: resolve(join(folder, 'comparison.json')) };
  summaries.push(summary);
  process.stderr.write(`${caseName}: CLI ${summary.candidateRms.toFixed(0)} m; reference ${summary.referenceRms.toFixed(0)} m; ${summary.atLeastAsGood ? 'PASS' : 'FAIL'}\n`);
  await writeFile(join(output, 'summary.json'), JSON.stringify({ expectedCases: 6, completeSuite: summaries.length === 6, allPassed: summaries.length === 6 && summaries.every(r => r.atLeastAsGood), cases: summaries }, null, 2));
}
console.log(JSON.stringify({ expectedCases: 6, completeSuite: summaries.length === 6, allPassed: summaries.length === 6 && summaries.every(r => r.atLeastAsGood), cases: summaries }));
if (summaries.length !== 6 || summaries.some(r => !r.atLeastAsGood)) process.exitCode = 1;
