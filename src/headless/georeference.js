import proj4 from 'proj4';
import { GeoFit } from '../geo/geo-fit.js';
import { ProjectionSearch } from '../geo/projection-search.js';
import { ThinPlateSpline } from '../geo/thin-plate-spline.js';
import { fixedProjections } from '../geo/projections.js';
import { crossValidateModels } from './model-selection.js';
import { fitAffine, validateAffine } from '../geo/raster-affine.js';

export function validatePoints(points, width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error('Positive integer image dimensions required.');
  if (!Array.isArray(points)) throw new Error('points must be an array.');
  const ids = new Set();
  return points.map((p, i) => {
    const source = p.source ?? { u: p.pixel?.[0] / width, v: p.pixel?.[1] / height };
    const id = p.id ?? i + 1;
    if (!Number.isSafeInteger(id) || id < 1 || ids.has(id)) throw new Error('Point IDs must be unique positive integers.');
    ids.add(id);
    if (![source.u, source.v, p.target?.lon, p.target?.lat].every(Number.isFinite) || source.u < 0 || source.u > 1 || source.v < 0 || source.v > 1 || Math.abs(p.target.lon) > 180 || Math.abs(p.target.lat) > 85.05112878 || (p.fit !== undefined && typeof p.fit !== 'boolean')) throw new Error(`Invalid reference point ${id}.`);
    return { ...p, id, source, fit: p.fit ?? true };
  });
}

export function statistics(rows) {
  if (!rows.length) return null;
  if (rows.some(r => !Number.isFinite(r.error))) throw new Error('Non-finite transformation error.');
  return { count: rows.length, rms: Math.sqrt(rows.reduce((s, r) => s + r.error ** 2, 0) / rows.length), mean: rows.reduce((s, r) => s + r.error, 0) / rows.length, max: Math.max(...rows.map(r => r.error)) };
}

export function evaluate(transform, points) {
  const rows = points.map(p => ({ id: p.id, name: p.name, fit: p.fit, predicted: transform(p.source.u, p.source.v), target: p.target }));
  rows.forEach(r => { r.error = GeoFit.distance(r.predicted, r.target); });
  return { units: 'metres', fit: statistics(rows.filter(r => r.fit)), control: statistics(rows.filter(r => !r.fit)), rows };
}

export function baseTransform(definition, g) {
  if (g.affine) validateAffine(g.affine);
  const projection = proj4(definition, 'EPSG:4326');
  return (u, v) => {
    if (![u, v].every(Number.isFinite)) throw new Error('Finite source coordinates required.');
    const x = (2 * u - 1) * g.hw, y = (1 - 2 * v) * g.hh, c = Math.cos(g.rot), s = Math.sin(g.rot);
    const projected = g.affine
      ? [g.cx + g.affine[0] * (u - .5) + g.affine[1] * (.5 - v), g.cy + g.affine[2] * (u - .5) + g.affine[3] * (.5 - v)]
      : [g.cx + c * x - s * y, g.cy + s * x + c * y];
    const [lon, lat] = projection.forward(projected);
    if (![lon, lat].every(Number.isFinite) || Math.abs(lat) > 90) throw new Error('Source is outside the projection domain.');
    return { lon, lat };
  };
}

// Sensitivity diagnostic only: projection parameters remain those estimated
// from all fit points. This is not an independent accuracy measurement.
function conditionalLeaveOneOut(points, width, height, best) {
  const fit = points.filter(p => p.fit);
  if (fit.length < 4) return null;
  const rows = fit.map(p => {
    try {
      const remaining = fit.filter(q => q.id !== p.id);
      const solved = best.geometry === 'affine' ? fitAffine(remaining, best.definition, width, height) : GeoFit.solve(remaining, best.definition, width, height);
      const predicted = baseTransform(best.definition, solved.g)(p.source.u, p.source.v);
      return { id: p.id, name: p.name, error: GeoFit.distance(predicted, p.target) };
    } catch (error) { return { id: p.id, name: p.name, failure: error.message }; }
  });
  return { description: 'Base projection, one anchor omitted at a time; projection parameters fixed. Sensitivity diagnostic, not independent validation and not TPS validation.', statistics: rows.every(r => Number.isFinite(r.error)) ? statistics(rows) : null, rows };
}

export function projectTransform(project, width, height) {
  fixedProjections();
  const a = project.alignment;
  if (project.format !== 'pixelkarte-georeferenzierung' || ![1, 2, 3, 4].includes(project.version) || !a || !['projection', 'projection+tps'].includes(a.method ?? 'projection')) throw new Error('Unsupported project.');
  if (a.affine !== undefined) {
    if (project.version < 4) throw new Error('Affine alignment requires project version 4.');
    validateAffine(a.affine);
  }
  if (![a.center?.lon, a.center?.lat, a.halfWidth, a.rotation].every(Number.isFinite) || a.halfWidth <= 0) throw new Error('Invalid alignment.');
  const definition = a.projection ? ProjectionSearch.definition(a.projection) : a.definition ?? a.code;
  const [cx, cy] = proj4('EPSG:4326', definition, [a.center.lon, a.center.lat]);
  const base = baseTransform(definition, { cx, cy, hw: a.halfWidth, hh: a.halfWidth * height / width, rot: a.rotation * Math.PI / 180, affine: a.affine });
  if (a.method !== 'projection+tps') return base;
  const points = validatePoints(project.points, width, height);
  return ThinPlateSpline.fitResiduals(points, width, height, base, a.tpsRegularization ?? 1e-8).transform;
}

export async function fitGeoreference(points, width, height, options = {}) {
  if (!['auto', 'similarity', 'affine'].includes(options.alignment ?? 'auto')) throw new Error('alignment must be auto, similarity or affine.');
  if (options.alignment === 'affine' && options.families?.length) throw new Error('Affine alignment currently supports fixed projections; set families to an empty array.');
  if (!['training', 'cross-validation'].includes(options.selection ?? 'cross-validation')) throw new Error('selection must be training or cross-validation.');
  if (!['auto', 'always', 'never'].includes(options.tps ?? 'auto')) throw new Error('tps must be auto, always or never.');
  if (options.regularization !== undefined && (!Number.isFinite(options.regularization) || options.regularization < 0)) throw new Error('Non-negative finite TPS regularization required.');
  if (options.codes !== undefined && (!Array.isArray(options.codes) || options.codes.some(c => typeof c !== 'string'))) throw new Error('codes must be an array of projection strings.');
  if (options.families !== undefined && (!Array.isArray(options.families) || options.families.some(f => !Object.hasOwn(ProjectionSearch.names, f)))) throw new Error('Unknown projection family.');
  points = validatePoints(points, width, height);
  const warning = GeoFit.distribution(points, width, height);
  if (warning) throw new Error(warning);
  const candidates = [], failures = [], fixed = fixedProjections();
  for (const code of options.codes ?? fixed.map(p => p.code)) {
    if (options.alignment !== 'affine') {
      try { candidates.push({ ...GeoFit.solve(points, code, width, height), definition: code, geometry: 'similarity' }); }
      catch (error) { failures.push({ code, geometry: 'similarity', error: error.message }); }
    }
    if (options.alignment === 'affine' || options.alignment !== 'similarity' && points.filter(p => p.fit).length >= 4) {
      try { candidates.push(fitAffine(points, code, width, height)); }
      catch (error) { failures.push({ code, geometry: 'affine', error: error.message }); }
    }
  }
  if (options.alignment !== 'affine' && points.filter(p => p.fit).length >= ProjectionSearch.minimumPoints) {
    for (const family of options.families ?? Object.keys(ProjectionSearch.names)) {
      options.progress?.(family);
      try {
        const result = await ProjectionSearch.search(points, family, width, height);
        candidates.push({ ...result, definition: ProjectionSearch.definition(result.model), geometry: 'similarity' });
      } catch (error) { failures.push({ family, error: error.message }); }
    }
  }
  candidates.sort((a, b) => a.fit.rms - b.fit.rms);
  let best = candidates[0];
  if (!best || !Number.isFinite(best.fit.rms)) throw new Error('No valid projection fit.');
  const selection = options.selection ?? (points.filter(p => p.fit).length >= 4 ? 'cross-validation' : 'training');
  let validation, validationRankings, correction = options.tps === 'always', regularization = options.regularization ?? 1e-8;
  if (selection === 'cross-validation') {
    const result = await crossValidateModels(candidates, points, width, height, options, baseTransform);
    best = result.best.candidate; validation = result.validation; validationRankings = result.rankings;
    correction ||= result.best.method === 'projection+tps';
    regularization = result.best.regularization ?? regularization;
  } else correction ||= options.tps !== 'never' && best.pixel.rms > 2 && points.filter(p => p.fit).length >= ThinPlateSpline.minimumPoints;
  let transform = baseTransform(best.definition, best.g), method = 'projection';
  let tpsWarning;
  if (correction) {
    try { transform = ThinPlateSpline.fitResiduals(points, width, height, transform, regularization).transform; method = 'projection+tps'; }
    catch (error) { if (options.tps === 'always') throw error; tpsWarning = error.message; }
  }
  const [lon, lat] = proj4(best.definition, 'EPSG:4326', [best.g.cx, best.g.cy]);
  const project = {
    format: 'pixelkarte-georeferenzierung', version: best.g.affine ? 4 : 3, points,
    alignment: { method, code: best.code, projection: best.model, definition: best.definition, center: { lon, lat }, halfWidth: best.g.hw, rotation: best.g.rot * 180 / Math.PI, ...(best.g.affine ? { affine: best.g.affine } : {}), ...(method === 'projection+tps' ? { tpsRegularization: regularization } : {}) },
    view: { center: { lon, lat }, zoom: 5, basemap: 'reference', opacity: 70, mesh: 20, showSource: true, showResiduals: true }
  };
  return { project, transform, report: { ...evaluate(transform, points), geometry: best.geometry, warning: tpsWarning, selection, validation, validationRankings, basePixelRms: best.pixel.rms, conditionalLeaveOneOut: conditionalLeaveOneOut(points, width, height, best), candidates: candidates.map(c => ({ code: c.code, geometry: c.geometry, model: c.model, rms: c.fit.rms, pixelRms: c.pixel.rms })), failures } };
}
