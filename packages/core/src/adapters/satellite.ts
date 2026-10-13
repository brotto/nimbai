import type { HttpClient } from '../http.js';
import { SourceError } from '../http.js';
import { SOURCES, attributionOf } from '../sources.js';
import type { Bbox, ImageRef } from '../types.js';

export type SatelliteProduct = 'geocolor' | 'ir' | 'wv' | 'visible';

const STAR_BASE = `${SOURCES['noaa-star'].origins[0]}/GOES19/ABI`;
const GIBS_BASE = SOURCES.gibs.origins[0];

/**
 * Sub-satellite longitudes (degrees). GOES-19 is operational GOES-East
 * (the old GOES-16 paths on cdn.star.nesdis.noaa.gov answer 301 and are not used).
 */
const GOES_EAST_LON = -75.2;
const GOES_WEST_LON = -137.0;
const HIMAWARI_LON = 140.7;
/** Beyond this angle from the sub-satellite point a geostationary view is too oblique to be useful. */
export const GEO_MAX_ANGLE_DEG = 70;

// ---------------------------------------------------------------- geometry

export function assertLatLon(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error(`Invalid coordinates lat=${lat} lon=${lon}`);
  }
}

/** Area of interest reduced to what the adapters need. */
export interface Aoi {
  lat: number;
  lon: number;
  /** [west, south, east, north]; a small box around the point when only a point was given. */
  bbox: Bbox;
  /** True when the caller supplied a bbox rather than a point. */
  explicitBbox: boolean;
}

const POINT_HALF_SPAN_DEG = 5;

export function resolveAoi(input: { lat?: number; lon?: number; bbox?: Bbox }): Aoi {
  if (input.bbox !== undefined) {
    const [w, s, e, n] = input.bbox;
    if (
      ![w, s, e, n].every(Number.isFinite) ||
      s >= n ||
      w >= e ||
      s < -90 ||
      n > 90 ||
      w < -180 ||
      e > 180
    ) {
      throw new Error(
        `Invalid bbox [${input.bbox.join(', ')}]; expected [west, south, east, north] with west < east`,
      );
    }
    return { lat: (s + n) / 2, lon: (w + e) / 2, bbox: [w, s, e, n], explicitBbox: true };
  }
  const { lat, lon } = input;
  if (lat === undefined || lon === undefined) {
    throw new Error('Provide either bbox or both lat and lon');
  }
  assertLatLon(lat, lon);
  const d = POINT_HALF_SPAN_DEG;
  return {
    lat,
    lon,
    bbox: [
      Math.max(-180, lon - d),
      Math.max(-90, lat - d),
      Math.min(180, lon + d),
      Math.min(90, lat + d),
    ],
    explicitBbox: false,
  };
}

const rad = (d: number): number => (d * Math.PI) / 180;

/** Great-circle angle in degrees between two points. */
export function angularDistanceDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const c =
    Math.sin(rad(lat1)) * Math.sin(rad(lat2)) +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon1 - lon2));
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return angularDistanceDeg(lat1, lon1, lat2, lon2) * (Math.PI / 180) * 6371;
}

export function bboxContains(outer: Bbox, lat: number, lon: number): boolean {
  return lon >= outer[0] && lon <= outer[2] && lat >= outer[1] && lat <= outer[3];
}

const bboxArea = (b: Bbox): number => (b[2] - b[0]) * (b[3] - b[1]);

// ------------------------------------------------------------ GOES sectors

export type GoesSectorKind = 'conus' | 'wide' | 'square500' | 'canada';

export interface GoesSector {
  /** Lower-case directory name under `SECTOR/`, or `conus`. */
  id: string;
  name: string;
  kind: GoesSectorKind;
  /**
   * NOMINAL extent [w, s, e, n], estimated by eye from the sector thumbnails
   * (NOAA/STAR publishes no machine-readable extent). Used only to choose a
   * sector; it is never presented as the image's bbox.
   */
  nominal: Bbox;
}

export const GOES_SECTORS: readonly GoesSector[] = [
  { id: 'conus', name: 'Contiguous United States', kind: 'conus', nominal: [-125, 24, -66, 50] },
  { id: 'ga', name: 'Gulf of America', kind: 'square500', nominal: [-98, 17, -79, 32] },
  { id: 'mex', name: 'Mexico', kind: 'square500', nominal: [-118, 12, -85, 33] },
  { id: 'cam', name: 'Central America', kind: 'square500', nominal: [-95, 3, -70, 25] },
  { id: 'car', name: 'Caribbean', kind: 'square500', nominal: [-85, 6, -55, 26] },
  { id: 'nsa', name: 'Northern South America', kind: 'wide', nominal: [-88, -22, -30, 17] },
  { id: 'ssa', name: 'Southern South America', kind: 'wide', nominal: [-85, -60, -30, -5] },
  { id: 'taw', name: 'Tropical Atlantic (wide)', kind: 'wide', nominal: [-100, 2, -15, 32] },
  { id: 'eep', name: 'Eastern East Pacific', kind: 'wide', nominal: [-140, -5, -80, 25] },
  { id: 'na', name: 'North Atlantic', kind: 'wide', nominal: [-75, 30, -15, 62] },
  { id: 'can', name: 'Canada', kind: 'canada', nominal: [-135, 43, -55, 70] },
];

/** Thumbnail size that exists on the CDN for each sector family (checked with curl). */
const THUMB_SIZE: Record<GoesSectorKind, string> = {
  conus: '625x375',
  wide: '900x540',
  square500: '500x500',
  canada: '560x280',
};

export function isInGoesEastView(lat: number, lon: number): boolean {
  return angularDistanceDeg(lat, lon, 0, GOES_EAST_LON) <= GEO_MAX_ANGLE_DEG;
}

/**
 * Smallest sector that contains the whole area of interest, else the smallest
 * that contains its centre. `undefined` when no published sector covers it.
 */
export function selectGoesSector(aoi: Aoi): GoesSector | undefined {
  if (!isInGoesEastView(aoi.lat, aoi.lon)) return undefined;
  const [w, s, e, n] = aoi.bbox;
  const corners: [number, number][] = [
    [s, w],
    [s, e],
    [n, w],
    [n, e],
  ];
  const bySize = [...GOES_SECTORS].sort((a, b) => bboxArea(a.nominal) - bboxArea(b.nominal));
  const whole = bySize.find((sec) =>
    corners.every(([la, lo]) => bboxContains(sec.nominal, la, lo)),
  );
  return whole ?? bySize.find((sec) => bboxContains(sec.nominal, aoi.lat, aoi.lon));
}

/** Directory + file names for a STAR sector product. */
export function starPaths(
  sector: GoesSector,
  family: 'ABI' | 'GLM',
  code: string,
): { dir: string; latest: string; thumb: string } {
  const root = family === 'ABI' ? STAR_BASE : STAR_BASE.replace('/ABI', '/GLM');
  const dir =
    sector.id === 'conus' ? `${root}/CONUS/${code}` : `${root}/SECTOR/${sector.id}/${code}`;
  // Some products have no latest.jpg on the CDN (404, checked with curl); use the largest
  // jpg that does exist: CONUS band 02 (only a .zip) and the Canada sector's non-GeoColor bands.
  let latest = `${dir}/latest.jpg`;
  if (family === 'ABI' && sector.id === 'conus' && code === '02') latest = `${dir}/5000x3000.jpg`;
  if (family === 'ABI' && sector.id === 'can' && code !== 'GEOCOLOR')
    latest = `${dir}/4500x2250.jpg`;
  return { dir, latest, thumb: `${dir}/${THUMB_SIZE[sector.kind]}.jpg` };
}

// ------------------------------------------------------------------ legends

const STAR_CODE: Record<SatelliteProduct, string> = {
  geocolor: 'GEOCOLOR',
  ir: '13',
  wv: '09',
  visible: '02',
};

const LEGEND: Record<SatelliteProduct, string> = {
  geocolor:
    'GeoColor: daytime = approximate true colour (white/grey clouds, blue ocean, green/brown land); ' +
    'night = infrared-based clouds in shades of white/grey/blue over a city-lights background. ' +
    'Not a precise measurement; use IR for cloud-top temperature.',
  ir:
    'Band 13 clean longwave infrared (10.3 um): grey scale where brighter/whiter = colder cloud tops ' +
    '(higher, often deeper convection) and darker = warmer surface. Colour enhancement, where present, ' +
    'marks the coldest tops (roughly cyan/green to yellow/red/magenta as tops get colder).',
  wv:
    'Band 9 mid-level water vapour (6.9 um): bright/white or coloured = moist or cloudy mid-troposphere, ' +
    'dark = dry air. Shows upper-level flow and dry slots, not surface conditions.',
  visible:
    'Band 2 red visible: reflected sunlight, brighter = thicker/more reflective cloud. ' +
    'Daytime only: the image is dark or absent at night.',
};

const GIBS_LEGEND_NOTE =
  ' Rendered by NASA GIBS from the original satellite data; colour tables may differ slightly from NOAA/STAR.';

// -------------------------------------------------------------- GIBS pieces

interface GibsGeo {
  name: string;
  lon: number;
  ir: string;
  /** Not every platform has GeoColor in GIBS. */
  color?: string;
  visible: string;
  /** Short platform id used in text. */
  satellite: string;
}

const GIBS_GEO: readonly GibsGeo[] = [
  {
    name: 'GOES-East',
    lon: GOES_EAST_LON,
    ir: 'GOES-East_ABI_Band13_Clean_Infrared',
    color: 'GOES-East_ABI_GeoColor',
    visible: 'GOES-East_ABI_Band2_Red_Visible_1km',
    satellite: 'GOES-19 (GOES-East)',
  },
  {
    name: 'GOES-West',
    lon: GOES_WEST_LON,
    ir: 'GOES-West_ABI_Band13_Clean_Infrared',
    color: 'GOES-West_ABI_GeoColor',
    visible: 'GOES-West_ABI_Band2_Red_Visible_1km',
    satellite: 'GOES-18 (GOES-West)',
  },
  {
    name: 'Himawari',
    lon: HIMAWARI_LON,
    ir: 'Himawari_AHI_Band13_Clean_Infrared',
    visible: 'Himawari_AHI_Band3_Red_Visible_1km',
    satellite: 'Himawari-9',
  },
];

/** Closest geostationary platform whose view angle is acceptable, if any. */
export function selectGibsGeo(lat: number, lon: number): GibsGeo | undefined {
  let best: GibsGeo | undefined;
  let bestAngle = Infinity;
  for (const g of GIBS_GEO) {
    const a = angularDistanceDeg(lat, lon, 0, g.lon);
    if (a <= GEO_MAX_ANGLE_DEG && a < bestAngle) {
      best = g;
      bestAngle = a;
    }
  }
  return best;
}

/** GIBS WMS GetMap URL (EPSG:4326, WMS 1.1.1 axis order lon/lat). Omit `time` for "latest". */
export function gibsMapUrl(opts: {
  layer: string;
  bbox: Bbox;
  width: number;
  time?: string;
  format?: 'image/jpeg' | 'image/png';
}): string {
  const [w, s, e, n] = opts.bbox;
  const aspect = (e - w) / (n - s);
  const width = Math.round(opts.width);
  const height = Math.min(2048, Math.max(64, Math.round(width / aspect)));
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.1.1',
    LAYERS: opts.layer,
    STYLES: '',
    SRS: 'EPSG:4326',
    BBOX: `${w},${s},${e},${n}`,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: opts.format ?? 'image/jpeg',
  });
  if (opts.time !== undefined) params.set('TIME', opts.time);
  return `${GIBS_BASE}/wms/epsg4326/best/wms.cgi?${params.toString()}`;
}

// -------------------------------------------------------------------- main

/**
 * Latest satellite image for a point or box.
 *
 * Order of preference: a NOAA/STAR GOES-19 sector image (best quality, ready-made
 * JPEG); otherwise a NASA GIBS render of the nearest geostationary platform
 * (GOES-East, GOES-West, Himawari); otherwise a polar-orbiter daily true-colour
 * image, clearly labelled as such. No network call is made: URLs are built only.
 */
export async function getSatelliteLatest(
  _http: HttpClient,
  input: { lat?: number; lon?: number; bbox?: Bbox; product?: SatelliteProduct },
): Promise<{ image: ImageRef; satellite: string; coverage: string }> {
  const product = input.product ?? 'geocolor';
  const aoi = resolveAoi(input);

  const sector = selectGoesSector(aoi);
  if (sector !== undefined) {
    const code = STAR_CODE[product];
    const p = starPaths(sector, 'ABI', code);
    const image: ImageRef = {
      url: p.latest,
      thumbnailUrl: p.thumb,
      mimeType: 'image/jpeg',
      layer: `GOES-19 ABI ${sector.name} - ${STAR_CODE[product] === 'GEOCOLOR' ? 'GeoColor' : `Band ${code}`}`,
      legend: LEGEND[product],
      sourceLatencyMin: 15,
      attribution: attributionOf('noaa-star'),
    };
    return {
      image,
      satellite: 'GOES-19 (GOES-East)',
      coverage:
        `NOAA/STAR sector "${sector.name}" (${sector.id.toUpperCase()}), GOES-East, Americas. ` +
        'Sector images are ready-made by NOAA; the observation time is printed in the image footer and is not in the response.',
    };
  }

  return gibsFallback(aoi, product);
}

function gibsFallback(
  aoi: Aoi,
  product: SatelliteProduct,
): { image: ImageRef; satellite: string; coverage: string } {
  const geo = selectGibsGeo(aoi.lat, aoi.lon);
  const attribution = attributionOf('gibs');

  if (geo !== undefined) {
    let layer: string;
    let note = '';
    let latency = 30;
    switch (product) {
      case 'wv':
        throw new SourceError(
          `No water-vapour imagery is available outside the NOAA/STAR GOES-East sectors for (${aoi.lat.toFixed(2)}, ${aoi.lon.toFixed(2)}).`,
          undefined,
          'Ask for product "ir" instead, or use a point inside the Americas.',
        );
      case 'visible':
        layer = geo.visible;
        break;
      case 'ir':
        layer = geo.ir;
        break;
      case 'geocolor':
        if (geo.color !== undefined) {
          layer = geo.color;
          latency = 40;
        } else {
          layer = geo.ir;
          note = ` GeoColor is not offered for ${geo.name} in GIBS, so Band 13 infrared is returned instead.`;
        }
        break;
    }
    const base = {
      layer,
      bbox: aoi.bbox,
    };
    const image: ImageRef = {
      url: gibsMapUrl({ ...base, width: 1024 }),
      thumbnailUrl: gibsMapUrl({ ...base, width: 384 }),
      mimeType: 'image/jpeg',
      bbox: aoi.bbox,
      layer: `NASA GIBS ${layer}`,
      legend:
        LEGEND[layer === geo.ir ? 'ir' : layer === geo.visible ? 'visible' : 'geocolor'] +
        GIBS_LEGEND_NOTE,
      sourceLatencyMin: latency,
      attribution,
    };
    return {
      image,
      satellite: geo.satellite,
      coverage:
        `Outside the NOAA/STAR GOES-East sectors; rendered from ${geo.name} by NASA GIBS (latest available time, not stamped in the response).` +
        note,
    };
  }

  if (product === 'wv') {
    throw new SourceError(
      `No geostationary water-vapour imagery is available for (${aoi.lat.toFixed(2)}, ${aoi.lon.toFixed(2)}).`,
      undefined,
      'This location is outside the GOES-East, GOES-West and Himawari views NimbAI can use.',
    );
  }

  // Europe, Africa, Indian Ocean: no geostationary source with permitted terms in the catalogue.
  const layer = 'VIIRS_SNPP_CorrectedReflectance_TrueColor';
  const base = { layer, bbox: aoi.bbox };
  const image: ImageRef = {
    url: gibsMapUrl({ ...base, width: 1024 }),
    thumbnailUrl: gibsMapUrl({ ...base, width: 384 }),
    mimeType: 'image/jpeg',
    bbox: aoi.bbox,
    layer: `NASA GIBS ${layer}`,
    legend:
      'True-colour daytime composite from a polar-orbiting satellite: white/grey = cloud, blue = water, ' +
      'green/brown = land. Black wedges are gaps between orbits or night.' +
      GIBS_LEGEND_NOTE,
    attribution,
  };
  return {
    image,
    satellite: 'Suomi NPP VIIRS (polar orbit)',
    coverage:
      'No geostationary imagery with permitted terms covers this location (outside GOES-East, GOES-West and Himawari views). ' +
      'This is a polar-orbiter daily composite: NOT a real-time image, it may be hours old, and it has gaps between orbits.',
  };
}
