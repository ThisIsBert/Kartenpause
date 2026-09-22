import numeric from 'numeric';
import { GeoFit } from './geo-fit.js';

// numeric.js generates parts of its solver dynamically and expects its own
// namespace to be globally reachable while those generated functions run.
globalThis.numeric ??= numeric;

const earthRadius = 6378137;
const radians = Math.PI / 180;

function wrapLongitude(longitude) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function mercator({ lon, lat }, referenceLongitude = lon) {
  const longitude = referenceLongitude + wrapLongitude(lon - referenceLongitude);
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return {
    x: earthRadius * longitude * radians,
    y: earthRadius * Math.log(Math.tan(Math.PI / 4 + latitude * radians / 2))
  };
}

function inverseMercator({ x, y }) {
  return {
    lon: wrapLongitude(x / earthRadius / radians),
    lat: (2 * Math.atan(Math.exp(y / earthRadius)) - Math.PI / 2) / radians
  };
}

function kernelSquared(distanceSquared) {
  return distanceSquared > 1e-20 ? distanceSquared * Math.log(distanceSquared) : 0;
}

function sourceCoordinate(point, aspect) {
  return { x: point.source.u - .5, y: (.5 - point.source.v) * aspect };
}

function solveSurface(samples, key, regularization) {
  const count = samples.length;
  const size = count + 3;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  const values = Array(size).fill(0);

  for (let row = 0; row < count; row++) {
    const sample = samples[row];
    for (let column = 0; column < count; column++) {
      const other = samples[column];
      const dx = sample.x - other.x;
      const dy = sample.y - other.y;
      matrix[row][column] = kernelSquared(dx * dx + dy * dy);
    }
    matrix[row][row] += regularization;
    matrix[row][count] = 1;
    matrix[row][count + 1] = sample.x;
    matrix[row][count + 2] = sample.y;
    matrix[count][row] = 1;
    matrix[count + 1][row] = sample.x;
    matrix[count + 2][row] = sample.y;
    values[row] = sample[key];
  }

  const coefficients = numeric.solve(matrix, values);
  if (!coefficients?.every(Number.isFinite)) throw new Error('TPS-Korrektur konnte nicht stabil berechnet werden.');
  return coefficients;
}

function evaluateSurface(coefficients, samples, x, y) {
  const count = samples.length;
  let value = coefficients[count] + coefficients[count + 1] * x + coefficients[count + 2] * y;
  for (let index = 0; index < count; index++) {
    const dx = x - samples[index].x;
    const dy = y - samples[index].y;
    value += coefficients[index] * kernelSquared(dx * dx + dy * dy);
  }
  return value;
}

function assertNoFolds(transform) {
  let orientation = 0;
  const divisions = 12;
  for (let row = 0; row < divisions; row++) {
    for (let column = 0; column < divisions; column++) {
      const u = column / divisions;
      const v = row / divisions;
      const origin = transform(u, v);
      const right = mercator(transform((column + 1) / divisions, v), origin.lon);
      const down = mercator(transform(u, (row + 1) / divisions), origin.lon);
      const center = mercator(origin, origin.lon);
      const cross = (right.x - center.x) * (down.y - center.y) - (right.y - center.y) * (down.x - center.x);
      if (!Number.isFinite(cross) || Math.abs(cross) < 1e-6) throw new Error('Die TPS-Korrektur erzeugt eine zusammengefaltete Bildfläche.');
      const sign = Math.sign(cross);
      if (!orientation) orientation = sign;
      else if (sign !== orientation) throw new Error('Die TPS-Korrektur würde Teile der Bildfläche umklappen.');
    }
  }
}

export const ThinPlateSpline = {
  minimumPoints: 6,

  fitResiduals(points, width, height, basePredict, regularization = 1e-8) {
    const fitPoints = points.filter(point => point.fit);
    if (fitPoints.length < this.minimumPoints) {
      throw new Error(`Mindestens ${this.minimumPoints} aktive Fit-Punkte für die TPS-Korrektur erforderlich.`);
    }
    const warning = GeoFit.distribution(points, width, height);
    if (warning) throw new Error(`TPS nicht stabil: ${warning}`);

    const aspect = height / width;
    const samples = fitPoints.map(point => {
      const source = sourceCoordinate(point, aspect);
      const base = basePredict(point.source.u, point.source.v);
      const baseMeters = mercator(base);
      const targetMeters = mercator(point.target, base.lon);
      return {
        ...source,
        dx: targetMeters.x - baseMeters.x,
        dy: targetMeters.y - baseMeters.y
      };
    });
    const xCoefficients = solveSurface(samples, 'dx', regularization);
    const yCoefficients = solveSurface(samples, 'dy', regularization);

    const transform = (u, v) => {
      const source = sourceCoordinate({ source: { u, v } }, aspect);
      const base = basePredict(u, v);
      const baseMeters = mercator(base);
      return inverseMercator({
        x: baseMeters.x + evaluateSurface(xCoefficients, samples, source.x, source.y),
        y: baseMeters.y + evaluateSurface(yCoefficients, samples, source.x, source.y)
      });
    };

    assertNoFolds(transform);

    const rows = points.map(point => {
      try {
        const predicted = transform(point.source.u, point.source.v);
        return { id: point.id, fit: point.fit, predicted, error: GeoFit.distance(predicted, point.target) };
      } catch (_) {
        return { id: point.id, fit: point.fit, predicted: null, error: Infinity };
      }
    });
    const statistics = selected => {
      if (!selected.length) return null;
      return {
        count: selected.length,
        rms: Math.sqrt(selected.reduce((sum, row) => sum + row.error ** 2, 0) / selected.length),
        mean: selected.reduce((sum, row) => sum + row.error, 0) / selected.length,
        max: Math.max(...selected.map(row => row.error))
      };
    };

    return {
      regularization,
      transform,
      rows,
      fit: statistics(rows.filter(row => row.fit)),
      control: statistics(rows.filter(row => !row.fit))
    };
  }
};
