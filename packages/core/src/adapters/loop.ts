import type { HttpClient } from '../http.js';
import { SOURCES, attributionOf } from '../sources.js';
import { SourceError } from '../http.js';
import type { Bbox, ImageRef } from '../types.js';
import { gibsMapUrl, resolveAoi, selectGibsGeo } from './satellite.js';
import { radarFrames, selectRadarTarget } from './radar.js';

export const MAX_LOOP_FRAMES = 24;
const DEFAULT_FRAMES = 12;
/** How far back to ask GIBS which times exist. 24 frames at 10 min is 4 h. */
const LOOKBACK_MS = 6 * 3600_000;

const GIBS_WMTS = `${SOURCES.gibs.origins[0]}/wmts/epsg4326/best/1.0.0`;

const IR_LEGEND =
  'Band 13 clean longwave infrared: grey scale, brighter/whiter = colder cloud tops (higher, often deeper convection), ' +
  'darker = warmer surface. Infrared is used for loops because it is continuous day and night. ' +
  'Rendered by NASA GIBS; colour tables may differ slightly from NOAA/STAR.';

export interface LoopOptions {
  /** Clock override for tests. */
  now?: () => number;
}

const isoZ = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function periodMs(p: string): number | undefined {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(p);
  if (m === null) return undefined;
  const ms =
    Number(m[1] ?? 0) * 86_400_000 + Number(m[2] ?? 0) * 3_600_000 + Number(m[3] ?? 0) * 60_000;
  return ms > 0 ? ms : undefined;
}

function parseTime(s: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
}

/**
 * Expands a WMTS DescribeDomains time domain such as
 * `2026-10-12T18:00:00Z/2026-10-12T19:20:00Z/PT10M,2026-10-12T20:00:00Z/2026-10-13T05:50:00Z/PT10M`
 * into ascending, de-duplicated epoch milliseconds.
 */
export function expandTimeDomain(domain: string): number[] {
  const out = new Set<number>();
  for (const part of domain.split(',')) {
    const bits = part.trim().split('/');
    const start = parseTime(bits[0] ?? '');
    if (!Number.isFinite(start)) continue;
    const end = bits[1] === undefined ? start : parseTime(bits[1]);
    const step = bits[2] === undefined ? undefined : periodMs(bits[2]);
    if (!Number.isFinite(end) || step === undefined) {
      out.add(start);
      if (Number.isFinite(end)) out.add(end);
      continue;
    }
    // Hard cap so a malformed domain cannot spin.
    for (let t = start, i = 0; t <= end && i < 5000; t += step, i++) out.add(t);
  }
  return [...out].sort((a, b) => a - b);
}

async function gibsTimes(http: HttpClient, layer: string, now: number): Promise<number[]> {
  const url = `${GIBS_WMTS}/${layer}/default/2km/all/${isoZ(now - LOOKBACK_MS)}--${isoZ(now)}.xml`;
  const xml = await http.text(url);
  const m = /<Domain>([^<]*)<\/Domain>/.exec(xml);
  if (m === null || m[1] === undefined) {
    throw new SourceError(`GIBS returned no time domain for ${layer}`);
  }
  return expandTimeDomain(m[1]);
}

/**
 * Chronological animation frames. `satellite` uses real NASA GIBS time steps
 * (asked of GIBS, never guessed: GIBS answers blank images for missing times)
 * and Band 13 infrared. `radar` uses the 10 newest NWS RIDGE frames.
 * At most 24 frames, oldest first.
 */
export async function getImageryLoop(
  http: HttpClient,
  input: { layer: 'satellite' | 'radar'; bbox?: Bbox; lat?: number; lon?: number; frames?: number },
  options: LoopOptions = {},
): Promise<{ frames: ImageRef[]; coverage: string }> {
  const requested = Math.trunc(input.frames ?? DEFAULT_FRAMES);
  const count = Math.min(
    Math.max(Number.isFinite(requested) ? requested : DEFAULT_FRAMES, 1),
    MAX_LOOP_FRAMES,
  );
  const areaInput: { lat?: number; lon?: number; bbox?: Bbox } = {};
  if (input.lat !== undefined) areaInput.lat = input.lat;
  if (input.lon !== undefined) areaInput.lon = input.lon;
  if (input.bbox !== undefined) areaInput.bbox = input.bbox;
  const aoi = resolveAoi(areaInput);

  if (input.layer === 'radar') {
    const { target } = selectRadarTarget(aoi);
    const frames = radarFrames(target, count);
    return {
      frames,
      coverage:
        `NWS RIDGE ${target.kind === 'site' ? `site ${target.site.id}` : `${target.mosaic.name} mosaic`}: ` +
        `${frames.length} frame(s), oldest first. RIDGE keeps only the 10 newest scans (about 5-10 minutes apart), ` +
        'so a longer loop is not available. Frame URLs are positional and shift as new scans arrive; ' +
        'fetch them promptly. Observation times are printed in each image footer.',
    };
  }

  const geo = selectGibsGeo(aoi.lat, aoi.lon);
  if (geo === undefined) {
    throw new SourceError(
      `No geostationary satellite loop is available for (${aoi.lat.toFixed(2)}, ${aoi.lon.toFixed(2)}).`,
      undefined,
      'Loops need GOES-East, GOES-West or Himawari coverage; this location is outside all three views.',
    );
  }
  const now = (options.now ?? Date.now)();
  const times = (await gibsTimes(http, geo.ir, now)).filter((t) => t <= now).slice(-count);
  if (times.length === 0) {
    throw new SourceError(
      `GIBS lists no recent frames for ${geo.ir}`,
      undefined,
      'Try again in a few minutes.',
    );
  }
  const frames: ImageRef[] = times.map((t) => ({
    url: gibsMapUrl({ layer: geo.ir, bbox: aoi.bbox, width: 768, time: isoZ(t) }),
    thumbnailUrl: gibsMapUrl({ layer: geo.ir, bbox: aoi.bbox, width: 320, time: isoZ(t) }),
    mimeType: 'image/jpeg',
    validTime: isoZ(t),
    bbox: aoi.bbox,
    layer: `NASA GIBS ${geo.ir}`,
    legend: IR_LEGEND,
    attribution: attributionOf('gibs'),
  }));
  const last = times[times.length - 1] ?? now;
  return {
    frames,
    coverage:
      `${geo.satellite} Band 13 infrared via NASA GIBS, ${frames.length} frame(s) oldest first, ` +
      `newest ${isoZ(last)} (${Math.round((now - last) / 60_000)} min before the request). ` +
      'GIBS can have a missing scan inside the window, shown as a blank or black frame.',
  };
}
