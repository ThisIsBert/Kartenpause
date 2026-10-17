import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const normalize = s => s.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replaceAll('ß', 'ss').replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();

function queryState(request) {
  if (!Array.isArray(request.queries) || !request.queries.length || request.queries.length > 100 || request.queries.some(q => typeof q !== 'string' || !normalize(q))) throw new Error('One to 100 non-empty place queries required.');
  const limit = request.limit ?? 10, bounds = request.bounds, countries = request.countries;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Gazetteer limit must be between 1 and 50.');
  if (bounds && (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || Math.abs(bounds[0]) > 180 || Math.abs(bounds[2]) > 180 || Math.abs(bounds[1]) > 90 || Math.abs(bounds[3]) > 90 || bounds[1] > bounds[3])) throw new Error('bounds must be [west,south,east,north].');
  if (countries && (!Array.isArray(countries) || countries.some(c => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c)))) throw new Error('countries must contain two-letter uppercase country codes.');
  const queries = request.queries.map(query => ({ query, normalized: normalize(query), candidates: [], matchingCount: 0 }));
  const wanted = new Map();
  for (const q of queries) { if (!wanted.has(q.normalized)) wanted.set(q.normalized, []); wanted.get(q.normalized).push(q); }
  function add(record) {
    const { lon, lat } = record.target ?? {};
    if (typeof record.id !== 'string' || typeof record.name !== 'string' || typeof record.source !== 'string' || ![lon, lat].every(Number.isFinite) || Math.abs(lon) > 180 || Math.abs(lat) > 85.05112878) return;
    if (countries && !countries.includes(record.country)) return;
    if (bounds && (lat < bounds[1] || lat > bounds[3] || (bounds[0] <= bounds[2] ? lon < bounds[0] || lon > bounds[2] : lon < bounds[0] && lon > bounds[2]))) return;
    const matches = new Set();
    for (const name of [record.name, ...(record.aliases ?? [])]) if (typeof name === 'string') for (const q of wanted.get(normalize(name)) ?? []) matches.add(q);
    for (const q of matches) {
      q.matchingCount++;
      q.candidates.push({ id: record.id, name: record.name, target: record.target, source: record.source, country: record.country, population: record.population ?? 0 });
      q.candidates.sort((a, b) => b.population - a.population || a.id.localeCompare(b.id));
      if (q.candidates.length > limit) q.candidates.pop();
    }
  }
  return { add, result: () => ({ matching: 'Exact normalized names and aliases; country/bounds constraints applied before ranking. Population order is not a confidence estimate.', queries: queries.map(({ normalized, ...q }) => ({ ...q, truncated: q.matchingCount > q.candidates.length })) }) };
}

export function lookupRecords(records, request) {
  if (!Array.isArray(records)) throw new Error('JSON gazetteer must be an array of records.');
  const state = queryState(request);
  records.forEach(state.add);
  return state.result();
}

export async function lookupGeonames(path, request) {
  const state = queryState(request);
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const r = line.split('\t');
      if (r.length < 15 || !/^\d+$/.test(r[0])) continue;
      state.add({ id: `geonames:${r[0]}`, name: r[1], aliases: [r[2], ...r[3].split(',')], target: { lat: Number(r[4]), lon: Number(r[5]) }, country: r[8], population: Number(r[14]) || 0, source: `https://www.geonames.org/${r[0]}/` });
    }
  } finally { lines.close(); input.destroy(); }
  return state.result();
}
