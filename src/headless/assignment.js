import proj4 from 'proj4';
import { GeoFit } from '../geo/geo-fit.js';
import { validatePoints } from './georeference.js';
import { ProjectionSearch } from '../geo/projection-search.js';
import { fixedProjections } from '../geo/projections.js';

const wrap = x => ((x + 180) % 360 + 360) % 360 - 180;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function normalize(landmarks, width, height) {
  if (!Array.isArray(landmarks)) throw new Error('landmarks must be an array.');
  const ids = new Set(), targets = new Map();
  return landmarks.map((p, i) => {
    if (!nonempty(p.id) || ids.has(p.id)) throw new Error('Unique non-empty landmark IDs required.');
    ids.add(p.id);
    const role = p.role ?? 'fit';
    if (!['fit', 'control'].includes(role)) throw new Error('Landmark role must be fit or control.');
    const observations = p.observations ?? (p.pixel ? [{ id: 'observed', pixel: p.pixel, evidence: p.evidence }] : []);
    if (!observations.length || !p.candidates?.length) throw new Error(`Observations and geographic candidates required: ${p.id}`);
    if (role === 'control' && (observations.length !== 1 || p.candidates.length !== 1)) throw new Error('Controls require one independently resolved observation and target.');
    const observationIds = new Set(), candidateIds = new Set();
    for (const o of observations) {
      if (!nonempty(o.id) || observationIds.has(o.id) || !Array.isArray(o.pixel) || o.pixel.length !== 2 || !nonempty(o.evidence)) throw new Error(`Observation ID, pixel and visual evidence required: ${p.id}`);
      observationIds.add(o.id);
      validatePoints([{ pixel: o.pixel, target: { lon: 0, lat: 0 } }], width, height);
    }
    for (const c of p.candidates) {
      if (!nonempty(c.id) || candidateIds.has(c.id) || !nonempty(c.source)) throw new Error(`Candidate ID and coordinate source required: ${p.id}`);
      candidateIds.add(c.id);
      validatePoints([{ pixel: [0, 0], target: c.target }], width, height);
      const prior = targets.get(c.id);
      if (prior && (prior.lon !== c.target.lon || prior.lat !== c.target.lat)) throw new Error(`Conflicting coordinates for candidate ID: ${c.id}`);
      targets.set(c.id, c.target);
    }
    return { ...p, index: i, role, observations };
  });
}

// Successive shortest augmenting paths: maximum cardinality first, minimum
// geometric cost second. Two captions cannot silently become the same place.
function matching(landmarks, pairs) {
  const targets = [...new Set(pairs.map(p => p.candidate.id))].sort();
  const targetIndex = new Map(targets.map((id, i) => [id, i]));
  const count = 2 + landmarks.length + targets.length, source = count - 2, sink = count - 1;
  const graph = Array.from({ length: count }, () => []);
  const add = (a, b, cost, pair) => {
    const forward = { to: b, reverse: graph[b].length, capacity: 1, cost, pair };
    const backward = { to: a, reverse: graph[a].length, capacity: 0, cost: -cost };
    graph[a].push(forward); graph[b].push(backward);
  };
  landmarks.forEach((_, i) => add(source, i, 0));
  targets.forEach((_, i) => add(landmarks.length + i, sink, 0));
  for (const p of pairs) add(p.landmarkIndex, landmarks.length + targetIndex.get(p.candidate.id), p.cost, p);
  for (;;) {
    const distances = Array(count).fill(Infinity), previous = Array(count).fill(null);
    distances[source] = 0;
    for (let pass = 0; pass < count - 1; pass++) {
      let changed = false;
      for (let a = 0; a < count; a++) if (Number.isFinite(distances[a])) graph[a].forEach((edge, index) => {
        if (edge.capacity && distances[a] + edge.cost < distances[edge.to] - 1e-12) {
          distances[edge.to] = distances[a] + edge.cost; previous[edge.to] = [a, index]; changed = true;
        }
      });
      if (!changed) break;
    }
    if (!previous[sink]) break;
    for (let b = sink; b !== source;) {
      const [a, index] = previous[b], edge = graph[a][index];
      edge.capacity = 0; graph[b][edge.reverse].capacity = 1; b = a;
    }
  }
  const chosen = graph.flat().filter(e => e.pair && !e.capacity).map(e => e.pair);
  return { chosen, count: chosen.length, cost: chosen.reduce((s, p) => s + p.cost, 0) };
}

function evaluateHypothesis(landmarks, definition, g, width, height, threshold) {
  const projection = proj4('EPSG:4326', definition), scale = 2 * g.hw / width;
  const c = Math.cos(g.rot), s = Math.sin(g.rot), pairs = [];
  landmarks.forEach((p, landmarkIndex) => {
    for (const candidate of p.candidates) {
      let q;
      try { q = projection.forward([candidate.target.lon, candidate.target.lat]); } catch { continue; }
      if (!q?.every(Number.isFinite)) continue;
      const dx = q[0] - g.cx, dy = q[1] - g.cy;
      const predictedPixel = [width / 2 + (c * dx + s * dy) / scale, height / 2 - (-s * dx + c * dy) / scale];
      for (const observation of p.observations) {
        const error = Math.hypot(...observation.pixel.map((v, k) => v - predictedPixel[k]));
        if (error <= threshold) pairs.push({ landmarkIndex, landmark: p, observation, candidate, error, cost: (error / threshold) ** 2 });
      }
    }
  });
  return { definition, g, pairs, ...matching(landmarks, pairs) };
}

function spread(pixels, width, height) {
  const sorted = pixels.map(p => [p[0] / width, p[1] / height]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a, b, c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const half = list => { const h = []; for (const p of list) { while (h.length > 1 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop(); h.push(p); } return h; };
  const hull = [...half(sorted).slice(0, -1), ...half(sorted.slice().reverse()).slice(0, -1)];
  const area = Math.abs(hull.reduce((s, p, i) => { const q = hull[(i + 1) % hull.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  return { imageHullFraction: area, hullPixels: hull.map(p => [p[0] * width, p[1] * height]) };
}

export async function assignLandmarks(input, width, height, options = {}) {
  fixedProjections();
  const all = normalize(input, width, height), landmarks = all.filter(p => p.role === 'fit');
  if (landmarks.length < 4) throw new Error('At least four fit landmarks are required to test assignment consensus.');
  const threshold = options.maxErrorPixels ?? 6, trials = options.trials ?? 384, ambiguityGap = options.ambiguityCostGap ?? .02;
  if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isSafeInteger(trials) || trials < 1 || trials > 10000 || !Number.isFinite(ambiguityGap) || ambiguityGap < 0) throw new Error('Invalid assignment search options.');
  if (options.codes !== undefined && (!Array.isArray(options.codes) || !options.codes.length || options.codes.some(code => !nonempty(code)))) throw new Error('Assignment codes must be a non-empty array of projection strings.');
  const families = options.families ?? (options.codes ? [] : Object.keys(ProjectionSearch.names));
  if (!Array.isArray(families) || families.some(family => !Object.hasOwn(ProjectionSearch.names, family))) throw new Error('Unknown assignment projection family.');
  const minimumCoverage = options.minimumCoverage ?? .1;
  if (!Number.isFinite(minimumCoverage) || minimumCoverage < 0 || minimumCoverage > 1) throw new Error('minimumCoverage must be between zero and one.');
  let state = options.seed ?? 20261016;
  if (!Number.isSafeInteger(state) || state < 1 || state > 0xffffffff) throw new Error('seed must be a positive 32-bit integer.');
  const random = n => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
  const alternatives = new Map();
  const remember = h => {
    if (h.count < 4) return;
    const key = h.chosen.map(p => `${p.landmark.id}:${p.observation.id}:${p.candidate.id}`).sort().join('|');
    if (!alternatives.has(key) || alternatives.get(key).cost > h.cost) alternatives.set(key, h);
    if (alternatives.size > 24) {
      const ordered = [...alternatives.entries()].sort((a, b) => b[1].count - a[1].count || a[1].cost - b[1].cost);
      alternatives.delete(ordered.at(-1)[0]);
    }
  };
  for (let trial = 0; trial < trials; trial++) {
    const indices = new Set(); while (indices.size < 3) indices.add(random(landmarks.length));
    const sample = [...indices].map(i => { const p = landmarks[i]; return { id: i + 1, pixel: p.observations[random(p.observations.length)].pixel, target: p.candidates[random(p.candidates.length)].target }; });
    const points = validatePoints(sample, width, height);
    if (GeoFit.distribution(points, width, height)) continue;
    const lat = sample.reduce((s, p) => s + p.target.lat, 0) / 3;
    const lon = Math.atan2(sample.reduce((s, p) => s + Math.sin(p.target.lon * Math.PI / 180), 0), sample.reduce((s, p) => s + Math.cos(p.target.lon * Math.PI / 180), 0)) * 180 / Math.PI;
    const definitions = options.codes ?? ['EPSG:4326', 'EPSG:3857', `+proj=aeqd +lon_0=${wrap(lon)} +lat_0=${lat} +datum=WGS84 +units=m`, `+proj=laea +lon_0=${wrap(lon)} +lat_0=${lat} +datum=WGS84 +units=m`];
    for (const definition of definitions) try {
      const solved = GeoFit.solve(points, definition, width, height, false);
      remember(evaluateHypothesis(landmarks, definition, solved.g, width, height, threshold));
    } catch { /* An invalid projection/sample is not an assignment. */ }
  }
  const ranked = [...alternatives.values()].sort((a, b) => b.count - a.count || a.cost - b.cost);
  for (const initial of ranked.slice(0, 6)) {
    let h = initial;
    for (let pass = 0; pass < 3; pass++) try {
      const points = validatePoints(h.chosen.map((p, i) => ({ id: i + 1, pixel: p.observation.pixel, target: p.candidate.target })), width, height);
      const solved = GeoFit.solve(points, h.definition, width, height, false);
      h = evaluateHypothesis(landmarks, h.definition, solved.g, width, height, threshold); remember(h);
    } catch { break; }
  }
  // A coarse projection is only a starting hypothesis. Refitting its family
  // and rematching every original candidate can recover anchors it rejected.
  // Controls never enter either stage. Several initial consensuses are kept
  // so the first local model cannot silently settle a competing assignment.
  let refinedModels = 0;
  const seeds = [...alternatives.values()].sort((a, b) => b.count - a.count || a.cost - b.cost).slice(0, 6);
  for (const initial of seeds) for (const family of families) {
    let h = initial;
    for (let pass = 0; pass < 3; pass++) {
      const points = validatePoints(h.chosen.map((p, i) => ({ id: i + 1, pixel: p.observation.pixel, target: p.candidate.target })), width, height);
      try {
        const solved = await ProjectionSearch.search(points, family, width, height);
        const next = evaluateHypothesis(landmarks, ProjectionSearch.definition(solved.model), solved.g, width, height, threshold);
        refinedModels++; remember(next);
        if (next.count < 4 || next.chosen.length === h.chosen.length && next.chosen.every(p => h.chosen.some(q => q.landmark.id === p.landmark.id && q.observation.id === p.observation.id && q.candidate.id === p.candidate.id))) break;
        h = next;
      } catch { break; }
    }
  }
  const final = [...alternatives.values()].sort((a, b) => b.count - a.count || a.cost - b.cost), best = final[0];
  if (!best) return { status: 'needs-review', points: [], assignments: [], unresolved: landmarks.map(p => ({ id: p.id, reason: 'No four-landmark consensus within the tested projection hypotheses.' })), diagnostics: { trials, maxErrorPixels: threshold } };
  const ambiguous = new Set();
  const competitors = final.filter(h => h !== best && h.count === best.count && h.cost <= best.cost + ambiguityGap);
  for (const h of competitors) for (const p of best.chosen) if (!h.chosen.some(q => q.landmark.id === p.landmark.id && q.candidate.id === p.candidate.id && q.observation.id === p.observation.id)) ambiguous.add(p.landmark.id);
  for (const p of best.chosen) {
    const alternative = matching(landmarks, best.pairs.filter(q => !(q.landmark.id === p.landmark.id && q.candidate.id === p.candidate.id && q.observation.id === p.observation.id)));
    if (alternative.count === best.count && alternative.cost <= best.cost + ambiguityGap) ambiguous.add(p.landmark.id);
  }
  const chosen = best.chosen.filter(p => !ambiguous.has(p.landmark.id));
  const coverage = spread(chosen.map(p => p.observation.pixel), width, height);
  const assignments = chosen.map(p => ({ id: p.landmark.id, observationId: p.observation.id, candidateId: p.candidate.id, pixel: p.observation.pixel, target: p.candidate.target, errorPixels: p.error, visualEvidence: p.observation.evidence, coordinateSource: p.candidate.source }));
  const unresolved = landmarks.filter(p => !chosen.some(q => q.landmark.id === p.id)).map(p => ({ id: p.id, reason: ambiguous.has(p.id) ? 'Competing geometric assignments; semantic or additional visual evidence required.' : 'No unique target within the geometric consensus threshold.' }));
  const points = [...assignments.map(p => ({ name: p.id, pixel: p.pixel, target: p.target, fit: true, assignment: p })), ...all.filter(p => p.role === 'control').map(p => ({ name: p.id, pixel: p.observations[0].pixel, target: p.candidates[0].target, fit: false, visualEvidence: p.observations[0].evidence, coordinateSource: p.candidates[0].source }))].map((p, i) => ({ ...p, id: i + 1 }));
  return { status: chosen.length >= 4 && !ambiguous.size && coverage.imageHullFraction >= minimumCoverage ? 'assigned' : 'needs-review', points: chosen.length >= 4 ? points : [], assignments, unresolved, diagnostics: { trials, refinedModels, maxErrorPixels: threshold, consensusCount: best.count, competingHypotheses: competitors.length, projection: best.definition, normalizedCost: best.cost, ...coverage, minimumCoverage, coverageWarning: coverage.imageHullFraction < minimumCoverage ? 'Resolved anchors cover too little of the image; add distributed landmarks or explicitly set a smaller minimumCoverage.' : undefined, note: 'Geometric consistency, not proof of landmark identity or map accuracy. Controls never participate in assignment or model refinement.' } };
}
