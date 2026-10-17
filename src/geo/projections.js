import { t } from '../i18n.js';
import proj4 from 'proj4';

export function fixedProjections() {
  const candidates = [
      { code: 'EPSG:4326', label: t('Geografisch / Plate Carrée (EPSG:4326)') },
      { code: 'EPSG:3857', label: 'Web Mercator (EPSG:3857)' },
      { code: 'EPSG:3395', label: 'World Mercator (EPSG:3395)', def: '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs' },
      { code: 'EPSG:25832', label: 'ETRS89 / UTM 32N (EPSG:25832)', def: '+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs' },
      { code: 'EPSG:25833', label: 'ETRS89 / UTM 33N (EPSG:25833)', def: '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs' },
      { code: 'EPSG:32632', label: 'WGS84 / UTM 32N (EPSG:32632)', def: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs' },
      { code: 'EPSG:32633', label: 'WGS84 / UTM 33N (EPSG:32633)', def: '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs' },
      { code: 'EPSG:3035', label: 'ETRS89 / LAEA Europe (EPSG:3035)', def: '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +units=m +no_defs' },
      { code: 'EPSG:3034', label: 'ETRS89 / LCC Europe (EPSG:3034)', def: '+proj=lcc +lat_0=52 +lon_0=10 +lat_1=35 +lat_2=65 +x_0=4000000 +y_0=2800000 +ellps=GRS80 +units=m +no_defs' },
      { code: 'DHDN:GK3', label: t('DHDN / Gauß-Krüger Zone 3'), def: '+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=3500000 +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs' },
      { code: 'DHDN:GK4', label: t('DHDN / Gauß-Krüger Zone 4'), def: '+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs' },
      { code: 'WORLD:ROBIN', label: 'Robinson', def: '+proj=robin +lon_0=0 +datum=WGS84 +units=m +no_defs' },
      { code: 'WORLD:MOLL', label: 'Mollweide', def: '+proj=moll +lon_0=0 +datum=WGS84 +units=m +no_defs' },
      { code: 'WORLD:EQEARTH', label: 'Equal Earth', def: '+proj=eqearth +lon_0=0 +datum=WGS84 +units=m +no_defs' }
    ];
  for (const c of candidates) if (c.def) proj4.defs(c.code, c.def);
  return candidates;
}
