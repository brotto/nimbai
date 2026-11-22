import type { HttpClient } from '../http.js';
import { SOURCES, attributionOf } from '../sources.js';
import { SourceError } from '../http.js';
import type { Bbox, ImageRef } from '../types.js';
import { gibsDegreesPerPixel, gibsMapUrl, resolveAoi, selectGibsGeo } from './satellite.js';
import { radarFrames, selectRadarTarget } from './radar.js';
import { decodeRgbaPng, hasOpaquePixel } from './png.js';

export const MAX_LOOP_FRAMES = 24;
const DEFAULT_FRAMES = 12;
/** How far back to ask GIBS which times exist. 24 frames at 10 min is 4 h. */
const LOOKBACK_MS = 6 * 3600_000;

/**
 * Extra advertised times probed beyond `count`, so that blank newest frames are
 * replaced by older real ones instead of shrinking the loop.
 */
const PROBE_MARGIN = 6;
/** Probe image edge in pixels: 256 pixels, a few hundred bytes as PNG. */
const PROBE_SIZE = 16;
/** Width of the frame images handed to the caller; probes are scaled to this resolution. */
const FRAME_WIDTH = 768;
const THUMB_WIDTH = 320;
/** Parallel probe requests in flight at once. */
const PROBE_CONCURRENCY = 8;

const GIBS_WMTS = `${SOURCES.gibs.origins[0]}/wmts/epsg4326/best/1.0.0`;

const IR_LEGEND =
  'Band 13 clean longwave infrared: grey scale, brighter/whiter = colder cloud tops (higher, often deeper convection), ' +
  'darker = warmer surface. Infrared is used for loops because it is continuous day and night. ' +
  'Rendered by NASA GIBS; colour tables may differ slightly from NOAA/STAR. ' +
  'A frame that arrives uniformly black or empty is MISSING DATA, not a clear sky: ' +
  'say the frame is unavailable rather than describing it.';

export interface LoopOptions {
  /** Clock override for tests. */
  now?: () => number;
  /** Deadline for reading one probe's response body, in ms. Tests shorten it. */
  probeBodyTimeoutMs?: number;
}

/** Bound on reading a probe's body. http.raw only bounds the headers, not the body. */
const PROBE_BODY_TIMEOUT_MS = 8000;

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

export type FrameProbe = 'pixels' | 'blank' | 'unknown';

/**
 * Ground window that PROBE_SIZE pixels of the served frame cover, centred on the bbox centre.
 * Probing the whole bbox in 16 px would hit a coarser pyramid level, which GIBS renders before
 * the native one, and a frame would probe as having pixels while the served image is blank.
 * The window is always strictly inside `bbox` (16 px < the served 768 px width and its 64 px
 * minimum height), so it stays within valid lat/lon.
 */
export function probeBbox(bbox: Bbox, servedWidth: number): Bbox {
  const dpp = gibsDegreesPerPixel(bbox, servedWidth);
  const hw = (PROBE_SIZE * dpp.x) / 2;
  const hh = (PROBE_SIZE * dpp.y) / 2;
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

/**
 * GIBS advertises a timestep before its WMS imagery is rendered, and which
 * (layer, bbox, time) combinations are blank cannot be predicted. So ask for
 * that exact frame as a tiny PNG: GIBS serves RGBA and marks missing data with
 * alpha 0. The probe is 16x16 at the same degrees per pixel as the served image (see probeBbox).
 * 'unknown' means we could not tell (network failure, unexpected
 * response); callers must not treat it as blank.
 */
export async function probeGibsFrame(
  http: HttpClient,
  opts: {
    layer: string;
    bbox: Bbox;
    time: string;
    servedWidth: number;
    bodyTimeoutMs?: number;
  },
): Promise<FrameProbe> {
  const url = gibsMapUrl({
    layer: opts.layer,
    time: opts.time,
    bbox: probeBbox(opts.bbox, opts.servedWidth),
    width: PROBE_SIZE,
    height: PROBE_SIZE,
    format: 'image/png',
  });
  // http.raw clears its own timer once headers arrive, so a stalled body would otherwise hang
  // the whole loop. The controller aborts the body stream; the race covers a fetch that ignores it.
  const ctl = new AbortController();
  const bodyMs = opts.bodyTimeoutMs ?? PROBE_BODY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await http.raw(url, { timeoutMs: 8000, retries: 1, signal: ctl.signal });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new Error('probe body timed out'));
      }, bodyMs);
    });
    const body = await Promise.race([res.arrayBuffer(), deadline]);
    const img = decodeRgbaPng(new Uint8Array(body), { width: PROBE_SIZE, height: PROBE_SIZE });
    return hasOpaquePixel(img) ? 'pixels' : 'blank';
  } catch {
    // Network error, non-2xx, body timeout, WMS XML exception, a PNG of the wrong size or one we
    // do not decode: cannot tell, and never "blank".
    return 'unknown';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Chronological animation frames. `satellite` uses real NASA GIBS time steps
 * (asked of GIBS, never guessed) and Band 13 infrared. Advertised times are not
 * trusted to have imagery yet: each candidate is probed (see probeGibsFrame) and
 * frames with no pixels are dropped. `radar` uses the 10 newest NWS RIDGE frames.
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
  // Probe a window wider than `count`: blank newest frames are replaced, not subtracted.
  const advertised = (await gibsTimes(http, geo.ir, now)).filter((t) => t <= now);
  const candidates = advertised.slice(-(count + PROBE_MARGIN));
  if (candidates.length === 0) {
    throw new SourceError(
      `GIBS lists no recent frames for ${geo.ir}`,
      undefined,
      'Try again in a few minutes.',
    );
  }
  const probes = await mapLimited(candidates, PROBE_CONCURRENCY, (t) =>
    probeGibsFrame(http, {
      layer: geo.ir,
      bbox: aoi.bbox,
      time: isoZ(t),
      servedWidth: FRAME_WIDTH,
      ...(options.probeBodyTimeoutMs === undefined
        ? {}
        : { bodyTimeoutMs: options.probeBodyTimeoutMs }),
    }),
  );
  const kept = candidates.filter((_, i) => probes[i] !== 'blank');
  const times = kept.slice(-count);
  if (times.length === 0) {
    throw new SourceError(
      `GIBS advertises ${candidates.length} recent time(s) for ${geo.ir} but none has imagery rendered yet`,
      undefined,
      'Try again in a few minutes.',
    );
  }
  // Only what shaped the returned loop is reported. A blank candidate older than the oldest
  // returned frame never affected it (the loop was already full of newer real frames).
  const oldest = times[0] ?? now;
  const droppedBlank = candidates.filter((t, i) => probes[i] === 'blank' && t > oldest).length;
  const blankOutside = probes.filter((p) => p === 'blank').length - droppedBlank;
  const uncheckedKept = times.filter((t) => probes[candidates.indexOf(t)] === 'unknown').length;
  const frames: ImageRef[] = times.map((t) => ({
    url: gibsMapUrl({ layer: geo.ir, bbox: aoi.bbox, width: FRAME_WIDTH, time: isoZ(t) }),
    thumbnailUrl: gibsMapUrl({ layer: geo.ir, bbox: aoi.bbox, width: THUMB_WIDTH, time: isoZ(t) }),
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
      `GIBS advertises times before it has rendered them: ${candidates.length} advertised time(s) were checked ` +
      `with a tiny PNG probe and ${droppedBlank} dropped, newer than the oldest returned frame, for having no imagery yet` +
      (droppedBlank > 0 ? ' (blank/black, no pixels)' : '') +
      (blankOutside > 0
        ? `; ${blankOutside} further blank candidate(s) were older than the oldest returned frame and did not change this loop`
        : '') +
      '. ' +
      (uncheckedKept === 0
        ? ''
        : `${uncheckedKept} of the ${frames.length} returned frame(s) could not be checked ` +
          '(request failed, timed out or unexpected response) and are kept in the loop. ') +
      // Measured against the live service: GIBS renders an extent progressively, so a
      // sample can hold pixels while the full frame is still empty, and the same URL
      // can serve imagery one minute and a blank image the next. The probe removes
      // what is blank when it runs. It cannot promise what the caller will be served.
      'The probe samples one small window at the frame resolution when this call runs; ' +
      'GIBS renders an extent progressively and can serve a blank image for an advertised ' +
      'time, or serve imagery for a URL that was blank minutes earlier. So a kept frame is ' +
      'not guaranteed to have imagery when YOU fetch it: treat a uniformly black or empty ' +
      'frame as missing data, never as clear sky.' +
      (times.length < count
        ? ` Fewer than the ${count} requested frames had imagery in the window.`
        : ''),
  };
}
