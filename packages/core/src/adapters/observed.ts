import { attributionOf } from '../sources.js';
import type { HttpClient } from '../http.js';
import { SourceError, sanitizeExternalText } from '../http.js';
import type { Attribution } from '../types.js';
import { distanceKm } from './satellite.js';

const METAR_ENDPOINT = 'https://aviationweather.gov/api/data/metar';

/**
 * Half-width of the search box around the point, in degrees. ~1.5° keeps the
 * query small (the API slows markedly on wide boxes) while still reaching a
 * station in most inhabited areas.
 */
const SEARCH_HALF_SPAN_DEG = 1.5;

/**
 * Beyond this, an aerodrome observation says little about the user's weather:
 * a METAR 200 km away is a different airmass, not "current conditions here".
 */
const DEFAULT_MAX_DISTANCE_KM = 100;

interface MetarRecord {
  icaoId?: string;
  name?: string;
  lat?: number;
  lon?: number;
  elev?: number;
  obsTime?: number;
  reportTime?: string;
  temp?: number | null;
  dewp?: number | null;
  wdir?: number | string | null;
  wspd?: number | null;
  wgst?: number | null;
  visib?: number | string | null;
  altim?: number | null;
  cover?: string | null;
  rawOb?: string;
}

export interface ObservedConditions {
  /** Where the instrument is, not where the user asked. */
  station: { id: string; name?: string; lat: number; lon: number; elevationM?: number };
  /** Great-circle distance from the requested point to the station. */
  distanceKm: number;
  /** Observation time in UTC ISO-8601, from the report itself. */
  observedAt: string;
  /** Minutes between the observation and now. */
  ageMin: number;
  temperatureC: number | null;
  dewPointC: number | null;
  /** Derived from temperature and dew point (Magnus), not reported directly. */
  humidityPct: number | null;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  /** Null when the report says VRB (variable). */
  windDirectionDeg: number | null;
  pressureHpa: number | null;
  cloudCover: string | null;
  visibility: string | null;
  /** The untouched METAR, so a reader can check every derived value. */
  raw: string;
  attribution: Attribution;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown, maxChars: number): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? sanitizeExternalText(value, maxChars)
    : null;
}

/** ICAO identifiers are four alphanumerics; anything else is not a station id. */
const ICAO = /^[A-Z0-9]{3,5}$/;

/** Magnus formula; the same approximation aviation and surface analyses use. */
export function relativeHumidity(
  temperatureC: number | null,
  dewPointC: number | null,
): number | null {
  if (temperatureC === null || dewPointC === null) return null;
  const e = (t: number): number => 6.112 * Math.exp((17.67 * t) / (t + 243.5));
  const rh = (e(dewPointC) / e(temperatureC)) * 100;
  return Math.round(Math.min(100, Math.max(0, rh)));
}

const KT_TO_KMH = 1.852;

export function toObserved(
  record: MetarRecord,
  lat: number,
  lon: number,
): ObservedConditions | null {
  // Everything here is third-party text that ends up in model-facing output
  // (the id is interpolated into the summary sentence), so each field is
  // type-checked and sanitised rather than trusted.
  const id = str(record.icaoId, 8);
  const sLat = num(record.lat);
  const sLon = num(record.lon);
  const raw = str(record.rawOb, 600);
  const obsTime = num(record.obsTime);
  if (id === null || !ICAO.test(id) || sLat === null || sLon === null || raw === null) {
    return null;
  }
  if (obsTime === null || sLat < -90 || sLat > 90 || sLon < -180 || sLon > 180) return null;

  const temperatureC = num(record.temp);
  const dewPointC = num(record.dewp);
  const windKt = num(record.wspd);
  const gustKt = num(record.wgst);
  const observedAt = new Date(obsTime * 1000).toISOString();

  const station: ObservedConditions['station'] = { id, lat: sLat, lon: sLon };
  const name = str(record.name, 120);
  if (name !== null) station.name = name;
  const elev = num(record.elev);
  if (elev !== null) station.elevationM = elev;

  return {
    station,
    distanceKm: Math.round(distanceKm(lat, lon, sLat, sLon) * 10) / 10,
    observedAt,
    ageMin: Math.max(0, Math.round((Date.now() - obsTime * 1000) / 60_000)),
    temperatureC,
    dewPointC,
    humidityPct: relativeHumidity(temperatureC, dewPointC),
    windSpeedKmh: windKt === null ? null : Math.round(windKt * KT_TO_KMH * 10) / 10,
    windGustKmh: gustKt === null ? null : Math.round(gustKt * KT_TO_KMH * 10) / 10,
    // `wdir` is "VRB" on a variable wind; a number would invent a direction.
    windDirectionDeg: num(record.wdir),
    pressureHpa: num(record.altim),
    cloudCover: str(record.cover, 16),
    visibility: typeof record.visib === 'number' ? String(record.visib) : str(record.visib, 16),
    raw,
    attribution: attributionOf('aviationweather'),
  };
}

/**
 * Nearest surface observation to a point. This is what instruments measured,
 * as opposed to what a model computed for the grid cell — the two disagree
 * often enough that presenting a model value as "current conditions" without
 * saying so is misleading.
 */
export async function getObservedConditions(
  http: HttpClient,
  input: { lat: number; lon: number; maxDistanceKm?: number },
): Promise<{ observed: ObservedConditions | null; coverage: string }> {
  const { lat, lon } = input;
  const maxDistance = input.maxDistanceKm ?? DEFAULT_MAX_DISTANCE_KM;
  // Clamped, not wrapped: within ~1.5° of the antimeridian the box is cut
  // short and may miss stations on the far side. Rare enough to accept, and
  // a truncated box under-reports rather than returning a wrong station.
  const d = SEARCH_HALF_SPAN_DEG;
  const bbox = [
    Math.max(-90, lat - d),
    Math.max(-180, lon - d),
    Math.min(90, lat + d),
    Math.min(180, lon + d),
  ].join(',');

  const url = `${METAR_ENDPOINT}?${new URLSearchParams({ bbox, format: 'json' }).toString()}`;
  // The API answers 204 with an empty body when no station is in the box, and
  // JSON-parsing that throws. An area with no aerodrome is an ordinary answer,
  // not a failed lookup, so it is read as text and treated as an empty list.
  const text = (await http.text(url)).trim();
  let records: MetarRecord[] = [];
  if (text !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SourceError(
        'The METAR service returned a body that is not valid JSON.',
        undefined,
        'Treat surface observations as unavailable for now and say so; do not report this as "no station nearby".',
      );
    }
    if (!Array.isArray(parsed)) {
      // A 200 carrying an error object is a source failure. Letting it fall
      // through as an empty list would report it to the user as "no station
      // reported", which is a failure disguised as an absence.
      throw new SourceError(
        'The METAR service answered with an unexpected shape instead of a list of reports.',
        undefined,
        'Treat surface observations as unavailable and say so; do not report this as "no station nearby".',
      );
    }
    records = parsed as MetarRecord[];
  }

  const candidates = records
    .map((r) => toObserved(r, lat, lon))
    .filter((o): o is ObservedConditions => o !== null)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const nearest = candidates[0];
  if (nearest === undefined) {
    return {
      observed: null,
      coverage: `No METAR station reported within about ${Math.round(d * 111)} km of this point. Surface observations are aerodrome reports, so they are sparse away from airports.`,
    };
  }
  if (nearest.distanceKm > maxDistance) {
    return {
      observed: null,
      coverage: `The nearest reporting station (${nearest.station.id}) is ${nearest.distanceKm} km away, beyond the ${maxDistance} km limit for calling it local. Use the model forecast for this point instead.`,
    };
  }
  const stale =
    nearest.ageMin > 90
      ? ` This report is ${nearest.ageMin} min old, so it may no longer describe current conditions — say the age when you quote it.`
      : '';
  return {
    observed: nearest,
    coverage: `Observed at ${nearest.station.id}${nearest.station.name === undefined ? '' : ` (${nearest.station.name})`}, ${nearest.distanceKm} km from the point, ${nearest.ageMin} min ago. This is a measurement at the station, not at the exact location asked about, and the two can differ in altitude.${stale}`,
  };
}
