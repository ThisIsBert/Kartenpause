import { GeoFit } from '../geo/geo-fit.js';
import { ProjectionSearch } from '../geo/projection-search.js';
import { ThinPlateSpline } from '../geo/thin-plate-spline.js';
import { fitAffine } from '../geo/raster-affine.js';

export async function crossValidateModels(candidates, points, width, height, options, makeTransform) {
  const fit = points.filter(p => p.fit), rankings = [];
  const hasGridGroups = fit.every(p => Array.isArray(p.gridLines) && p.gridLines.length === 2 && p.gridLines.every(id => typeof id === 'string' && id));
  if (!['auto', 'point', 'grid-line'].includes(options.validation ?? 'auto')) throw new Error('validation must be auto, point or grid-line.');
  const grouped = options.validation === 'grid-line' || options.validation !== 'point' && hasGridGroups;
  if (grouped && !hasGridGroups) throw new Error('Grid-line validation requires two gridLines IDs on every fit point.');
  const folds = grouped
    ? [...new Set(fit.flatMap(p => p.gridLines))].sort().map(group => ({ group, training: fit.filter(p => !p.gridLines.includes(group)), held: fit.filter(p => p.gridLines.includes(group)) }))
    : fit.map(p => ({ training: fit.filter(q => q.id !== p.id), held: [p] }));
  const expectedRows = folds.reduce((sum, fold) => sum + fold.held.length, 0);
  const canValidateTPS = folds.every(fold => fold.training.length >= ThinPlateSpline.minimumPoints);
  const regularizations = options.regularization !== undefined ? [options.regularization] : [1e-8, .001, .01, .1];
  for (const candidate of candidates) {
    options.progress?.(`validation ${candidate.code} ${candidate.geometry ?? 'similarity'}`);
    const variants = [{ method: 'projection', rows: [] }];
    if (options.tps !== 'never' && canValidateTPS) for (const regularization of (options.tps === 'always' ? [options.regularization ?? 1e-8] : regularizations)) variants.push({ method: 'projection+tps', regularization, rows: [] });
    for (const { training, held, group } of folds) {
      let base, definition, projection;
      try {
        const solved = candidate.model
          ? await ProjectionSearch.search(training, candidate.model.family, width, height)
          : candidate.geometry === 'affine' ? fitAffine(training, candidate.definition, width, height) : GeoFit.solve(training, candidate.definition, width, height);
        definition = solved.model ? ProjectionSearch.definition(solved.model) : candidate.definition;
        projection = solved.model;
        base = makeTransform(definition, solved.g);
      } catch (error) {
        for (const variant of variants) for (const p of held) variant.rows.push({ id: p.id, withheldGroup: group, trainingIds: training.map(p => p.id), failure: error.message });
        continue;
      }
      for (const variant of variants) {
        try {
          const transform = variant.method === 'projection' ? base : ThinPlateSpline.fitResiduals(training, width, height, base, variant.regularization).transform;
          const rows = held.map(p => {
            const predicted = transform(p.source.u, p.source.v), error = GeoFit.distance(predicted, p.target);
            if (!Number.isFinite(error)) throw new Error('Non-finite validation prediction.');
            return { id: p.id, withheldGroup: group, trainingIds: training.map(p => p.id), projection, predicted, error };
          });
          variant.rows.push(...rows);
        } catch (error) { for (const p of held) variant.rows.push({ id: p.id, withheldGroup: group, trainingIds: training.map(p => p.id), failure: error.message }); }
      }
    }
    for (const variant of variants) {
      let valid = variant.rows.length === expectedRows && variant.rows.every(r => Number.isFinite(r.error)), fullFitFailure;
      if (valid) try {
        const base = makeTransform(candidate.definition, candidate.g);
        const transform = variant.method === 'projection' ? base : ThinPlateSpline.fitResiduals(fit, width, height, base, variant.regularization).transform;
        for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) transform(x / 4, y / 4);
      } catch (error) { valid = false; fullFitFailure = error.message; }
      const rms = valid ? Math.sqrt(variant.rows.reduce((s, r) => s + r.error ** 2, 0) / expectedRows) : null;
      rankings.push({ candidate, ...variant, valid, rms, fullFitFailure });
    }
  }
  const eligible = rankings.filter(r => r.valid && (options.tps !== 'always' || !canValidateTPS || r.method === 'projection+tps'));
  const complexity = r => Number(r.candidate.geometry === 'affine') + 2 * Number(r.method === 'projection+tps');
  eligible.sort((a, b) => Math.abs(a.rms - b.rms) > 1e-6 ? a.rms - b.rms : complexity(a) - complexity(b));
  if (!eligible.length) throw new Error('No model has complete out-of-sample validation. Add fit landmarks or provide a fixed projection; custom projection validation needs at least five fit points.');
  const best = eligible[0];
  return {
    best,
    validation: { type: grouped ? 'leave-one-grid-line-out' : 'leave-one-out', folds: folds.length, units: 'metres', rms: best.rms, method: best.method, geometry: best.candidate.geometry, regularization: best.regularization, rows: best.rows, refitsProjectionParameters: true, refitsTPS: best.method === 'projection+tps', controlsExcluded: true, caution: 'Used for model selection. Final accuracy requires additional untouched checkpoints.', ...(options.tps === 'always' && !canValidateTPS ? { warning: 'TPS forced by caller; too few anchors in one or more folds to cross-validate TPS. Validation describes the base projection only.' } : {}) },
    rankings: rankings.map(r => ({ code: r.candidate.code, geometry: r.candidate.geometry, method: r.method, regularization: r.regularization, valid: r.valid, rms: r.rms, fullFitFailure: r.fullFitFailure, failedFolds: r.rows.filter(p => p.failure).map(p => ({ id: p.id, error: p.failure })) }))
  };
}
