import type { Attribution } from './types.js';

/**
 * Catalogue of data sources. A source only belongs here once its terms allow
 * commercial use, or it is explicitly marked `termsPending` and therefore kept
 * out of paid surfaces. Sources forbidden by licence (Blitzortung, RainViewer,
 * CPTEC without written permission, NICT, Zoom Earth) are deliberately absent
 * and must not be added. See `wiki/specs/riscos-legais.md`.
 */
export interface SourceDef {
  id: string;
  name: string;
  /** Origin used for the SSRF allowlist. */
  origins: string[];
  license: string;
  attribution: string;
  url?: string;
  /** True while written confirmation of commercial terms is outstanding. */
  termsPending?: boolean;
}

export const SOURCES = {
  nws: {
    id: 'nws',
    name: 'NOAA / National Weather Service',
    origins: ['https://api.weather.gov'],
    license: 'public domain (US Government)',
    attribution: 'Source: NOAA/NWS',
    url: 'https://www.weather.gov',
  },
  'nws-radar': {
    id: 'nws-radar',
    name: 'NWS RIDGE radar imagery',
    origins: ['https://radar.weather.gov'],
    license: 'public domain (US Government)',
    attribution: 'Source: NOAA/NWS',
    url: 'https://radar.weather.gov',
  },
  spc: {
    id: 'spc',
    name: 'NOAA Storm Prediction Center',
    origins: ['https://www.spc.noaa.gov'],
    license: 'public domain (US Government)',
    attribution: 'Source: NOAA/NWS Storm Prediction Center',
    url: 'https://www.spc.noaa.gov',
  },
  'noaa-star': {
    id: 'noaa-star',
    name: 'NOAA STAR GOES imagery',
    origins: ['https://cdn.star.nesdis.noaa.gov'],
    license: 'public domain (US Government)',
    attribution: 'Source: NOAA/NESDIS/STAR',
    url: 'https://www.star.nesdis.noaa.gov',
  },
  gibs: {
    id: 'gibs',
    name: 'NASA Global Imagery Browse Services',
    origins: ['https://gibs.earthdata.nasa.gov'],
    license: 'open (NASA EOSDIS)',
    attribution:
      "We acknowledge the use of imagery provided by services from NASA's Global Imagery " +
      "Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).",
    url: 'https://nasa-gibs.github.io/gibs-api-docs/',
  },
  'open-meteo': {
    id: 'open-meteo',
    name: 'Open-Meteo',
    origins: ['https://api.open-meteo.com', 'https://geocoding-api.open-meteo.com'],
    // Data is CC BY 4.0, but the free API endpoint is for non-commercial use:
    // commercial operation needs their paid plan or a self-hosted instance
    // (see wiki/specs/fontes-de-dados.md). Fine for the MIT community server,
    // NOT yet cleared for the paid product.
    license: 'CC BY 4.0 (data); free API endpoint is non-commercial use only',
    attribution: 'Weather data by Open-Meteo.com',
    url: 'https://open-meteo.com',
    termsPending: true,
  },
  aviationweather: {
    id: 'aviationweather',
    name: 'NOAA Aviation Weather Center (METAR)',
    origins: ['https://aviationweather.gov'],
    license: 'public domain (US Government)',
    attribution: 'Source: NOAA/NWS Aviation Weather Center',
    url: 'https://aviationweather.gov',
  },
  meteoalarm: {
    id: 'meteoalarm',
    name: 'MeteoAlarm (EUMETNET)',
    origins: ['https://feeds.meteoalarm.org'],
    license: 'CC BY 4.0',
    attribution: '© MeteoAlarm. Data provided by EUMETNET members',
    url: 'https://meteoalarm.org',
  },
  inmet: {
    id: 'inmet',
    name: 'INMET (Brazil)',
    origins: ['https://apiprevmet3.inmet.gov.br', 'https://alertas2.inmet.gov.br'],
    license: 'Brazilian federal public data',
    attribution: 'Fonte: INMET',
    url: 'https://portal.inmet.gov.br',
  },
} as const satisfies Record<string, SourceDef>;

export type SourceId = keyof typeof SOURCES;

export function attributionOf(id: SourceId): Attribution {
  // Widened to SourceDef on purpose: under `as const` every literal entry has
  // a `url`, so TS would narrow the no-url branch to `never`.
  const s: SourceDef = SOURCES[id];
  return s.url === undefined
    ? { source: s.id, text: s.attribution, license: s.license }
    : { source: s.id, text: s.attribution, license: s.license, url: s.url };
}

/** Every origin the server is allowed to talk to. Nothing else is fetched. */
export const ALLOWED_ORIGINS: readonly string[] = Object.values(SOURCES).flatMap(
  (s) => s.origins as readonly string[],
);
