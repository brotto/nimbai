import type { HttpClient } from '../http.js';
import { SourceError } from '../http.js';
import { SOURCES, attributionOf } from '../sources.js';
import type { Bbox, ImageRef } from '../types.js';
import { bboxContains, distanceKm, resolveAoi } from './satellite.js';
import type { Aoi } from './satellite.js';

export interface RadarSite {
  id: string;
  name?: string;
  lat: number;
  lon: number;
  rangeKm: number;
}

const RIDGE = `${SOURCES['nws-radar'].origins[0]}/ridge/standard`;

/** Nominal WSR-88D reflectivity range. */
const REFLECTIVITY_RANGE_KM = 230;
/**
 * The RIDGE per-site image is a 600x550 crop that shows roughly +-150 km
 * around the radar (estimated from city spacing in KFWS_0.gif), narrower than
 * the 230 km detection range. A site image is only chosen when the point is
 * inside this crop.
 */
const SITE_IMAGE_RADIUS_KM = 150;
/** Above this span (degrees) a single-site crop cannot show the requested box. */
const MAX_SITE_BBOX_SPAN_DEG = 3;

/**
 * The full WSR-88D network: every station returned by
 * https://api.weather.gov/radar/stations?stationType=WSR-88D, read on
 * 2026-10-13, with the API's own ids, names and coordinates.
 *
 * Deliberately complete rather than a curated subset. With a subset, a point
 * near a station that happened to be missing looked uncovered, which denied
 * real coverage: southeast Alaska (Juneau, Sitka, Ketchikan) is ~950 km from
 * Kenai but minutes from Sitka's own PACG.
 */
export const RADAR_SITES: readonly RadarSite[] = (
  [
    ['KABR', 'Aberdeen', 45.4558, -98.413],
    ['KABX', 'Albuquerque', 35.1497, -106.8239],
    ['KAKQ', 'Norfolk', 36.9839, -77.0075],
    ['KAMA', 'Amarillo', 35.2333, -101.7093],
    ['KAMX', 'Miami', 25.6105, -80.413],
    ['KAPX', 'NCL Michigan', 44.9063, -84.7195],
    ['KARX', 'La Crosse', 43.8228, -91.1911],
    ['KATX', 'Seattle', 48.1946, -122.4957],
    ['KBBX', 'Beale AFB', 39.4961, -121.6316],
    ['KBGM', 'Binghamton', 42.1997, -75.9847],
    ['KBHX', 'Eureka (Bunker Hill)', 40.4983, -124.2922],
    ['KBIS', 'Bismarck', 46.7708, -100.7603],
    ['KBLX', 'Billings', 45.8538, -108.6068],
    ['KBMX', 'Birmingham', 33.1719, -86.7697],
    ['KBOX', 'Boston', 41.9558, -71.1369],
    ['KBRO', 'Brownsville', 25.9155, -97.4186],
    ['KBUF', 'Buffalo', 42.9486, -78.7369],
    ['KBYX', 'Key West', 24.5969, -81.7033],
    ['KCAE', 'Columbia', 33.9486, -81.1186],
    ['KCBW', 'Caribou', 46.0392, -67.8064],
    ['KCBX', 'Boise', 43.4902, -116.236],
    ['KCCX', 'State College', 40.9231, -78.0039],
    ['KCLE', 'Cleveland', 41.413, -81.86],
    ['KCLX', 'Charleston,SC', 32.6555, -81.0422],
    ['KCRP', 'Corpus Christi', 27.7839, -97.5108],
    ['KCXX', 'Burlington', 44.5111, -73.1664],
    ['KCYS', 'Cheyenne', 41.1519, -104.8061],
    ['KDAX', 'Sacramento', 38.5011, -121.6778],
    ['KDDC', 'Dodge City', 37.7608, -99.9689],
    ['KDFX', 'Laughlin AFB', 29.2725, -100.2803],
    ['KDGX', 'Jackson/Brandon,MS', 32.28, -89.9844],
    ['KDIX', 'Philadelphia', 39.9469, -74.4107],
    ['KDLH', 'Duluth', 46.8369, -92.2097],
    ['KDMX', 'Des Moines', 41.7311, -93.7228],
    ['KDOX', 'Dover AFB', 38.8255, -75.44],
    ['KDTX', 'Detroit', 42.7, -83.4717],
    ['KDVN', 'Quad Cities', 41.6117, -90.5808],
    ['KDYX', 'Dyess AFB', 32.5383, -99.2542],
    ['KEAX', 'Pleasant Hill', 38.8102, -94.2645],
    ['KEMX', 'Tucson', 31.8936, -110.6303],
    ['KENX', 'Albany', 42.5866, -74.0641],
    ['KEOX', 'Ft Rucker', 31.4606, -85.4594],
    ['KEPZ', 'El Paso', 31.873, -106.698],
    ['KESX', 'Las Vegas', 35.7011, -114.8914],
    ['KEVX', 'Eglin Afb', 30.565, -85.9217],
    ['KEWX', 'Austin/San Antonio', 29.704, -98.0286],
    ['KEYX', 'Edwards AFB', 35.0978, -117.5607],
    ['KFCX', 'Roanoke', 37.0242, -80.2742],
    ['KFDR', 'Altus AFB', 34.3622, -98.9767],
    ['KFDX', 'Cannon AFB', 34.6342, -103.6189],
    ['KFFC', 'Atlanta', 33.3633, -84.5658],
    ['KFSD', 'Sioux Falls', 43.5878, -96.7289],
    ['KFSX', 'Flagstaff', 34.5743, -111.1984],
    ['KFTG', 'Denver', 39.7866, -104.5458],
    ['KFWS', 'Dallas/Ft Worth', 32.5728, -97.3031],
    ['KGGW', 'Glasgow', 48.2064, -106.6247],
    ['KGJX', 'Grand Junction', 39.0622, -108.2138],
    ['KGLD', 'Goodland', 39.3669, -101.7003],
    ['KGRB', 'Green Bay', 44.4986, -88.1111],
    ['KGRK', 'Ft Hood', 30.7217, -97.3828],
    ['KGRR', 'Grand Rapids', 42.8939, -85.5449],
    ['KGSP', 'Greer', 34.8833, -82.2198],
    ['KGWX', 'Columbus AFB', 33.8969, -88.3292],
    ['KGYX', 'Portland,ME', 43.8913, -70.2564],
    ['KHDC', 'Hammond', 30.5196, -90.4074],
    ['KHDX', 'Holloman AFB', 33.077, -106.12],
    ['KHGX', 'Houston', 29.4719, -95.0789],
    ['KHNX', 'San Joaquin Valley', 36.3142, -119.6321],
    ['KHPX', 'Ft Campbell', 36.7367, -87.285],
    ['KHTX', 'Northeast Alabama', 34.9305, -86.0836],
    ['KICT', 'Wichita', 37.6544, -97.443],
    ['KICX', 'Cedar City', 37.591, -112.8622],
    ['KILN', 'Cincinnati', 39.4203, -83.8217],
    ['KILX', 'Lincoln', 40.1505, -89.3368],
    ['KIND', 'Indianapolis', 39.7075, -86.2803],
    ['KINX', 'Tulsa', 36.175, -95.5641],
    ['KIWA', 'Phoenix', 33.2892, -111.67],
    ['KIWX', 'Northern Indiana', 41.3586, -85.7],
    ['KJAX', 'Jacksonville', 30.4846, -81.7019],
    ['KJGX', 'Robins AFB', 32.675, -83.3511],
    ['KJKL', 'Jackson,KY', 37.5908, -83.3131],
    ['KLBB', 'Lubbock', 33.6541, -101.8142],
    ['KLCH', 'Lake Charles', 30.1253, -93.2159],
    ['KLGX', 'Langley Hill', 47.1169, -124.1066],
    ['KLNX', 'North Platte', 41.9579, -100.5762],
    ['KLOT', 'Chicago', 41.6044, -88.0844],
    ['KLRX', 'Elko', 40.7397, -116.8028],
    ['KLSX', 'St Louis', 38.6989, -90.6828],
    ['KLTX', 'Wilmington', 33.9892, -78.4292],
    ['KLVX', 'Louisville', 37.9753, -85.9439],
    ['KLWX', 'Sterling', 38.9761, -77.4875],
    ['KLZK', 'Little Rock', 34.8364, -92.2619],
    ['KMAF', 'Midland/Odessa', 31.9435, -102.1892],
    ['KMAX', 'Medford', 42.0811, -122.7173],
    ['KMBX', 'Minot AFB', 48.3925, -100.8644],
    ['KMHX', 'Morehead City', 34.7758, -76.8764],
    ['KMKX', 'Milwaukee', 42.9678, -88.5506],
    ['KMLB', 'Melbourne', 28.1131, -80.6544],
    ['KMOB', 'Mobile', 30.6794, -88.2397],
    ['KMPX', 'Minneapolis', 44.8489, -93.5655],
    ['KMQT', 'Marquette', 46.5311, -87.5483],
    ['KMRX', 'Knoxville', 36.1683, -83.4019],
    ['KMSX', 'Missoula', 47.0411, -113.9861],
    ['KMTX', 'Salt Lake City', 41.2628, -112.4478],
    ['KMUX', 'San Francisco', 37.1552, -121.8984],
    ['KMVX', 'Fargo/Grand Forks', 47.5281, -97.325],
    ['KMXX', 'Maxwell AFB', 32.5366, -85.7897],
    ['KNKX', 'San Diego', 32.9189, -117.0419],
    ['KNQA', 'Memphis', 35.3447, -89.8733],
    ['KOAX', 'Omaha', 41.3203, -96.3668],
    ['KOHX', 'Nashville', 36.2472, -86.5625],
    ['KOKX', 'Brookhaven', 40.8655, -72.8639],
    ['KOTX', 'Spokane', 47.6805, -117.6258],
    ['KPAH', 'Paducah', 37.0683, -88.7719],
    ['KPBZ', 'Pittsburgh', 40.5317, -80.2179],
    ['KPDT', 'Pendleton', 45.6906, -118.8529],
    ['KPOE', 'Ft Polk', 31.1553, -92.9758],
    ['KPUX', 'Pueblo', 38.4594, -104.1814],
    ['KRAX', 'Raleigh/Durham', 35.6653, -78.49],
    ['KRGX', 'Reno', 39.754, -119.462],
    ['KRIW', 'Riverton/Lander', 43.0661, -108.4773],
    ['KRLX', 'Charleston,WV', 38.3111, -81.7228],
    ['KRTX', 'Portland,OR', 45.715, -122.965],
    ['KSFX', 'Pocatello', 43.1056, -112.6861],
    ['KSGF', 'Springfield', 37.2353, -93.4003],
    ['KSHV', 'Shreveport', 32.4508, -93.8412],
    ['KSJT', 'San Angelo', 31.3711, -100.4922],
    ['KSOX', 'Santa Ana Mts', 33.8177, -117.636],
    ['KSRX', 'Western Arkansas', 35.2904, -94.3619],
    ['KTBW', 'Tampa', 27.7053, -82.4019],
    ['KTFX', 'Great Falls', 47.4597, -111.3853],
    ['KTLH', 'Tallahassee', 30.3975, -84.3289],
    ['KTLX', 'Norman', 35.3331, -97.2777],
    ['KTWX', 'Topeka', 38.9969, -96.2325],
    ['KTYX', 'Ft Drum', 43.7558, -75.68],
    ['KUDX', 'Rapid City', 44.1247, -102.83],
    ['KUEX', 'Grand Island', 40.3208, -98.4419],
    ['KVAX', 'Moody AFB', 30.8903, -83.0018],
    ['KVBX', 'Vandenberg AFB', 34.8385, -120.3979],
    ['KVNX', 'Vance AFB', 36.7408, -98.1275],
    ['KVTX', 'Los Angeles', 34.4117, -119.1786],
    ['KVWX', 'Evansville,IN', 38.2602, -87.7245],
    ['KYUX', 'Yuma', 32.4953, -114.6567],
    ['PABC', 'Bethel', 60.7919, -161.8764],
    ['PACG', 'Sitka', 56.8528, -135.5291],
    ['PAEC', 'Nome', 64.5114, -165.295],
    ['PAHG', 'Kenai', 60.7259, -151.3514],
    ['PAIH', 'Middleton Island', 59.4619, -146.3011],
    ['PAKC', 'King Salmon', 58.6794, -156.6294],
    ['PAPD', 'Fairbanks Faa', 65.0351, -147.5014],
    ['PGUA', 'Andersen AFB', 13.4558, 144.8111],
    ['PHKI', 'South Kauai', 21.8939, -159.5525],
    ['PHKM', 'Kamuela/Kohala Apt', 20.1253, -155.7778],
    ['PHMO', 'Molokai', 21.1328, -157.1803],
    ['PHWA', 'South Shore', 19.095, -155.5689],
    ['RKJK', 'Kunsan AB', 35.9242, 126.6222],
    ['RKSG', 'Camp Humphreys', 37.2076, 127.2856],
    ['RODN', 'Kadena AB', 26.3019, 127.9097],
    ['TJUA', 'San Juan', 18.1157, -66.0782],
  ] as const
).map(([id, name, lat, lon]) => ({ id, name, lat, lon, rangeKm: REFLECTIVITY_RANGE_KM }));

interface Mosaic {
  /** RIDGE product id, e.g. `CONUS`. */
  id: string;
  name: string;
  /** Nominal extent used only to pick a mosaic. */
  nominal: Bbox;
  /** Optional higher-resolution variant. */
  large?: string;
}

const MOSAICS: readonly Mosaic[] = [
  {
    id: 'CONUS',
    name: 'Contiguous United States',
    nominal: [-125, 24, -66, 50],
    large: 'CONUS-LARGE',
  },
  { id: 'HAWAII', name: 'Hawaii', nominal: [-161, 18, -154, 23] },
  { id: 'ALASKA', name: 'Alaska', nominal: [-170, 52, -130, 72] },
];

const LEGEND =
  'NWS base reflectivity in dBZ; the colour bar is printed at the bottom of the image. ' +
  'Roughly: blue/green = light precipitation (about 10-30 dBZ), yellow/orange = moderate to heavy (about 35-50), ' +
  'red = intense (50-60), pink/purple/white = very intense, often hail (60+). ' +
  'Observation time is printed in the image footer. Reflectivity is not rainfall rate, and ' +
  'ground clutter, beam blockage and overshooting can distort it.';

/** Typical delay between a volume scan and the RIDGE image. */
const LATENCY_MIN = 5;

export type RadarTarget =
  { kind: 'site'; site: RadarSite; distanceKm: number } | { kind: 'mosaic'; mosaic: Mosaic };

/**
 * How far from a known NEXRAD station a point may be and still be offered a
 * mosaic. Deliberately generous: this station list is a curated subset of the
 * network, so a tight threshold denies real coverage (Billings, Montana sits
 * next to KBLX but has no station in this list). It only has to exclude the
 * egregious case — a point inside the nominal rectangle but hundreds of
 * kilometres from any radar, such as Whitehorse inside the Alaska box.
 */
const MOSAIC_MAX_SITE_DISTANCE_KM = 700;

/** The closest known station, regardless of whether the point is in its range. */
export function nearestSite(
  lat: number,
  lon: number,
): { site: RadarSite; distanceKm: number } | undefined {
  let best: { site: RadarSite; distanceKm: number } | undefined;
  for (const site of RADAR_SITES) {
    const d = distanceKm(lat, lon, site.lat, site.lon);
    if (best === undefined || d < best.distanceKm) best = { site, distanceKm: d };
  }
  return best;
}

/** Sites whose detection range covers the point, nearest first. */
export function sitesInRange(lat: number, lon: number): { site: RadarSite; distanceKm: number }[] {
  return RADAR_SITES.map((site) => ({ site, distanceKm: distanceKm(lat, lon, site.lat, site.lon) }))
    .filter((x) => x.distanceKm <= x.site.rangeKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Picks the RIDGE product for an area, or throws when there is no US radar coverage. */
export function selectRadarTarget(aoi: Aoi): { target: RadarTarget; sites: RadarSite[] } {
  const inRange = sitesInRange(aoi.lat, aoi.lon);
  const sites = inRange.map((x) => x.site);
  const span = Math.max(aoi.bbox[2] - aoi.bbox[0], aoi.bbox[3] - aoi.bbox[1]);
  const nearest = inRange[0];

  if (
    nearest !== undefined &&
    nearest.distanceKm <= SITE_IMAGE_RADIUS_KM &&
    !(aoi.explicitBbox && span > MAX_SITE_BBOX_SPAN_DEG)
  ) {
    return { target: { kind: 'site', ...nearest }, sites };
  }
  // The nominal mosaic rectangles overlap Mexico and Canada, so a bbox test
  // alone would hand back a CONUS image for Monterrey or Whitehorse while
  // claiming coverage. Radar coverage is a function of distance to a station,
  // not of a rectangle, so a mosaic is only offered when some known station is
  // within reach of the point.
  const mosaic = MOSAICS.find((m) => bboxContains(m.nominal, aoi.lat, aoi.lon));
  const nearestAnywhere = nearestSite(aoi.lat, aoi.lon);
  if (
    mosaic !== undefined &&
    nearestAnywhere !== undefined &&
    nearestAnywhere.distanceKm <= MOSAIC_MAX_SITE_DISTANCE_KM
  ) {
    return { target: { kind: 'mosaic', mosaic }, sites };
  }

  throw new SourceError(
    `No US radar coverage for (${aoi.lat.toFixed(2)}, ${aoi.lon.toFixed(2)}).`,
    undefined,
    'NimbAI radar is limited to NWS NEXRAD (continental US, Alaska, Hawaii, Puerto Rico). ' +
      `Use nimbai_get_satellite_latest for this location.${nationalRadarPointer(aoi.lat, aoi.lon)}`,
  );
}

/**
 * Who does operate radar over a point NimbAI cannot serve.
 *
 * Telling a user "no coverage" when a radar is in fact scanning their city is
 * a half-truth. NimbAI cannot serve those images — the operators below either
 * publish no licence or block automated access entirely, and this project
 * does not redistribute data it has no permission for — but naming the
 * service and letting a person open it themselves costs nothing and is the
 * honest answer. See `wiki/research/radar-argentina-sinarame.md`.
 */
const NATIONAL_RADAR: readonly { bbox: Bbox; text: string }[] = [
  {
    // Argentina, Uruguay, Paraguay and the southern Brazilian border: the
    // SINARAME and INTA radars reach here, and nothing of NimbAI's does.
    bbox: [-74, -56, -52, -20],
    text:
      ' A radar may cover this area, operated by others: the Servicio Meteorológico Nacional ' +
      'of Argentina (SINARAME/INTA network, https://www.smn.gob.ar) and, for Córdoba, the ' +
      'Observatorio Hidrometeorológico de Córdoba (https://webmet.ohmc.ar). Tell the user to ' +
      'open one of those directly; NimbAI has no licence to serve their imagery.',
  },
  {
    // Brazil: DECEA publishes the aeronautical radar mosaic.
    bbox: [-74, -34, -33, 6],
    text:
      ' A radar may cover this area, operated by others: REDEMET/DECEA publishes Brazilian radar ' +
      'at https://redemet.decea.mil.br. Tell the user to open it directly; NimbAI has no licence ' +
      'to serve that imagery.',
  },
];

export function nationalRadarPointer(lat: number, lon: number): string {
  // All matches, not the first: the boxes overlap along the Brazil-Argentina
  // border, which is exactly where both networks matter.
  const matches = NATIONAL_RADAR.filter((r) => bboxContains(r.bbox, lat, lon));
  return matches.length === 0
    ? ' Otherwise use your national weather service radar.'
    : matches.map((m) => m.text).join('');
}

export function ridgeUrl(id: string, index: number): string {
  return `${RIDGE}/${id}_${index}.gif`;
}

function imageFor(target: RadarTarget, index: number): ImageRef {
  if (target.kind === 'site') {
    const { site } = target;
    return {
      url: ridgeUrl(site.id, index),
      mimeType: 'image/gif',
      layer: `NWS RIDGE base reflectivity - ${site.id}${site.name ? ` (${site.name})` : ''}`,
      legend: LEGEND,
      sourceLatencyMin: LATENCY_MIN,
      attribution: attributionOf('nws-radar'),
    };
  }
  const { mosaic } = target;
  const ref: ImageRef = {
    url: ridgeUrl(mosaic.large ?? mosaic.id, index),
    mimeType: 'image/gif',
    layer: `NWS RIDGE reflectivity mosaic - ${mosaic.name}`,
    legend: LEGEND,
    sourceLatencyMin: LATENCY_MIN,
    attribution: attributionOf('nws-radar'),
  };
  if (mosaic.large !== undefined) ref.thumbnailUrl = ridgeUrl(mosaic.id, index);
  return ref;
}

export function describeTarget(target: RadarTarget): string {
  return target.kind === 'site'
    ? `NEXRAD site ${target.site.id} (${target.site.name ?? 'unnamed'}), ${Math.round(target.distanceKm)} km from the point.`
    : `NWS RIDGE national mosaic for ${target.mosaic.name} (no listed radar site close enough for a site image).`;
}

export function radarGaps(target: RadarTarget, sites: RadarSite[] = []): string[] {
  const gaps = [
    'Radar sees precipitation, not clouds: clear-air echoes, birds, insects, and ground clutter can appear as weak returns.',
    'RIDGE files carry no machine-readable time; read the observation time from the image footer.',
  ];
  if (target.kind === 'mosaic') {
    gaps.push('Mosaic is low resolution and combines many radars; use a site image for detail.');
    if (sites.length === 0) {
      // The nominal mosaic rectangles overlap Mexico and Canada, so a point
      // can be inside one with no radar actually reaching it. Say so instead
      // of letting the image imply coverage.
      gaps.push(
        'No WSR-88D station reaches this point within its nominal 230 km range. The mosaic ' +
          'rectangles overlap Mexico and Canada, where NEXRAD does not reach, so do not assert ' +
          "that this image shows the user's location; outside the United States, point them at " +
          'their national weather service radar.',
      );
    }
  }
  return gaps;
}

/**
 * Latest NWS RIDGE radar image. URLs are built, not fetched. Outside US
 * coverage it throws a `SourceError` rather than return an unrelated image.
 */
export async function getRadarLatest(
  _http: HttpClient,
  input: { lat?: number; lon?: number; bbox?: Bbox },
): Promise<{ image: ImageRef; sites: RadarSite[]; coverage: string; gaps: string[] }> {
  const aoi = resolveAoi(input);
  const { target, sites } = selectRadarTarget(aoi);
  return {
    image: imageFor(target, 0),
    sites,
    coverage:
      target.kind === 'mosaic' && sites.length === 0
        ? `${describeTarget(target)} No station in NimbAI's list covers this point, so treat this as regional context rather than a confirmed view of the location.`
        : describeTarget(target),
    gaps: radarGaps(target, sites),
  };
}

/** RIDGE keeps the 10 most recent frames as `<ID>_0.gif` (newest) .. `<ID>_9.gif`. */
export const RIDGE_FRAME_COUNT = 10;

export function radarFrames(target: RadarTarget, count: number): ImageRef[] {
  const n = Math.min(Math.max(Math.trunc(count), 1), RIDGE_FRAME_COUNT);
  const frames: ImageRef[] = [];
  // Oldest first: _9 is oldest, _0 newest.
  for (let i = n - 1; i >= 0; i--) frames.push(imageFor(target, i));
  return frames;
}
