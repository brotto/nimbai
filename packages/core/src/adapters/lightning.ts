import type { HttpClient } from '../http.js';
import { SOURCES, attributionOf } from '../sources.js';
import type { Bbox, ImageRef } from '../types.js';
import { isInGoesEastView, resolveAoi, selectGoesSector, starPaths } from './satellite.js';

/**
 * Required wording: this product must never be mistaken for lightning
 * detection. NimbAI has no lightning ingestion in this phase.
 */
export const LIGHTNING_CAVEAT =
  'These are optical detections of lightning flashes from the GOES Geostationary Lightning Mapper (GLM) satellite, ' +
  'aggregated onto a grid as flash extent density. They are NOT individual cloud-to-ground strikes, ' +
  'they give no strike location, count, or distance, and they must NOT be used for the protection of life or equipment.';

const LEGEND =
  'Flash extent density (FED) from GOES GLM, drawn over a GeoColor satellite background: coloured cells show where ' +
  'lightning flashes were detected during the product accumulation window, cool colours (blue/green) = few flashes, ' +
  'warmer colours (yellow/orange/red/magenta) = more flashes per grid cell. Uncoloured area = no detection ' +
  '(or no data). The exact colour bar and observation time are printed on the image. ' +
  'Optical detection can be reduced under thick cloud and near the edge of the satellite view.';

const GLM_ROOT = `${SOURCES['noaa-star'].origins[0]}/GOES19/GLM`;
/** Typical lag between observation and file, measured against the in-image timestamp (about 15 min). */
const LATENCY_MIN = 15;

/**
 * GLM flash-extent-density image for the GOES-East view. No per-flash data
 * exists in NimbAI yet, so this never returns counts, nearest-flash distance
 * or trends. `image` is null when the area is outside the GOES-East view or
 * the source does not answer.
 */
export async function getLightning(
  http: HttpClient,
  input: { lat?: number; lon?: number; bbox?: Bbox; minutes?: number },
): Promise<{ image: ImageRef | null; coverage: string; gaps: string[]; caveat: string }> {
  const aoi = resolveAoi(input);
  const gaps: string[] = [
    'No lightning ingestion exists in this phase: no flash counts, no distance to the nearest flash, no trend.',
  ];
  if (input.minutes !== undefined) {
    gaps.push(
      `The accumulation window is fixed by NOAA/STAR and cannot be chosen; the requested ${input.minutes} minutes was not applied.`,
    );
  }

  if (!isInGoesEastView(aoi.lat, aoi.lon)) {
    gaps.push(
      'The GLM product NimbAI can use covers the Americas (GOES-East view). This location is outside it, so no lightning image is available.',
    );
    return {
      image: null,
      coverage: 'None: outside the GOES-East GLM field of view.',
      gaps,
      caveat: LIGHTNING_CAVEAT,
    };
  }

  const sector = selectGoesSector(aoi);
  let latest: string;
  let thumb: string;
  let label: string;
  if (sector !== undefined) {
    const p = starPaths(sector, 'GLM', 'EXTENT3');
    latest = p.latest;
    thumb = p.thumb;
    label = `${sector.name} (${sector.id.toUpperCase()})`;
  } else {
    // Full-disk fallback: only the 678x678 thumbnail size is checked to exist.
    latest = `${GLM_ROOT}/FD/EXTENT3/latest.jpg`;
    thumb = `${GLM_ROOT}/FD/EXTENT3/678x678.jpg`;
    label = 'GOES-East full disk';
  }

  // Probe the small thumbnail, never the multi-MB original.
  const probe = await http.probe(thumb);
  if (!probe.ok) {
    gaps.push(
      `NOAA/STAR GLM imagery did not respond for ${label}; no lightning image is available right now.`,
    );
    return {
      image: null,
      coverage: `${label}: source unavailable.`,
      gaps,
      caveat: LIGHTNING_CAVEAT,
    };
  }

  const image: ImageRef = {
    url: latest,
    thumbnailUrl: thumb,
    mimeType: 'image/jpeg',
    layer: `GOES-19 GLM flash extent density - ${label}`,
    legend: LEGEND,
    sourceLatencyMin: LATENCY_MIN,
    attribution: attributionOf('noaa-star'),
  };
  return {
    image,
    coverage: `GOES-19 GLM, ${label}. Americas only.`,
    gaps,
    caveat: LIGHTNING_CAVEAT,
  };
}
