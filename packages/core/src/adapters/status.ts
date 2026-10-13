import type { HttpClient } from '../http.js';
import { SOURCES, type SourceId } from '../sources.js';
import type { SourceStatus } from '../types.js';

/**
 * A cheap, representative URL per source. Probing the real product path (not
 * just the origin) is the point: an origin that answers while its product path
 * 404s is still a broken source for us.
 */
const PROBES: Partial<Record<SourceId, string>> = {
  // `?limit=1` alone is a 400 from this endpoint; a point query is the
  // cheapest request it actually accepts (~230 bytes).
  nws: 'https://api.weather.gov/alerts/active?point=35.47,-97.52',
  spc: 'https://www.spc.noaa.gov/products/outlook/',
  'noaa-star': 'https://cdn.star.nesdis.noaa.gov/GOES19/ABI/CONUS/GEOCOLOR/',
  // WMTSCapabilities.xml is 5+ MB and takes ~9 s, which trips the probe
  // timeout even when GIBS is healthy. An 8x8 GetMap answers in <1 s.
  gibs: 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=GOES-East_ABI_Band13_Clean_Infrared&STYLES=&SRS=EPSG:4326&BBOX=-10,-10,10,10&WIDTH=8&HEIGHT=8&FORMAT=image/jpeg',
  'open-meteo':
    'https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m',
  inmet: 'https://apiprevmet3.inmet.gov.br/avisos/ativos',
  'nws-radar': 'https://radar.weather.gov/ridge/standard/CONUS_0.gif',
};

/**
 * Typical end-to-end delay from observation to availability, in minutes, as
 * documented by each provider. Reported so a model can explain to a user why
 * an image looks older than "now" instead of guessing.
 */
const TYPICAL_LATENCY_MIN: Partial<Record<SourceId, number>> = {
  nws: 1,
  spc: 30,
  'noaa-star': 15,
  gibs: 40,
  'open-meteo': 60,
  'nws-radar': 5,
  meteoalarm: 10,
  inmet: 15,
};

export async function getSourcesStatus(
  http: HttpClient,
  ids?: SourceId[],
): Promise<{ statuses: SourceStatus[]; checkedAt: string }> {
  const targets = (ids ?? (Object.keys(PROBES) as SourceId[])).filter((id) => id in PROBES);

  const statuses = await Promise.all(
    targets.map(async (id): Promise<SourceStatus> => {
      const url = PROBES[id];
      if (url === undefined) {
        return { source: id, ok: false, note: 'No probe URL configured for this source.' };
      }
      const { ok, latencyMs } = await http.probe(url);
      const latency = TYPICAL_LATENCY_MIN[id];
      const base: SourceStatus = { source: id, ok, latencyMs };
      const note = ok
        ? `${SOURCES[id].name} reachable.`
        : `${SOURCES[id].name} did not answer; data from it may be stale or missing.`;
      return latency === undefined
        ? { ...base, note }
        : { ...base, typicalLatencyMin: latency, note };
    }),
  );

  return { statuses, checkedAt: new Date().toISOString() };
}
