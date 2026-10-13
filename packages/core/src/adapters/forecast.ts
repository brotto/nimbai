import { attributionOf } from '../sources.js';
import type { HttpClient } from '../http.js';
import type { Attribution, ForecastSeries } from '../types.js';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT_HOURS = 48;
const MAX_HOURS = 384;
const MAX_DAYS = 16;

const HOURLY_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'precipitation',
  'precipitation_probability',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'cloud_cover',
  'cape',
] as const;

const CURRENT_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'precipitation',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'cloud_cover',
  'weather_code',
  'cape',
] as const;

// Open-Meteo does not say which model blend served a default request.
const MODEL_LABEL = 'Open-Meteo (multi-model blend)';

type Nullable = number | null;

interface OpenMeteoResponse {
  hourly?: Record<string, unknown> & { time?: string[] };
  hourly_units?: Record<string, string>;
  current?: Record<string, unknown> & { time?: string };
}

export interface CurrentConditions {
  time: string;
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  humidityPct: number | null;
  precipitationMm: number | null;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  windDirectionDeg: number | null;
  cloudCoverPct: number | null;
  weatherCode: number | null;
  weatherText: string;
  cape: number | null;
  attribution: Attribution;
}

const WMO_TEXT: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow fall',
  73: 'Moderate snow fall',
  75: 'Heavy snow fall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

export function wmoText(code: number | null): string {
  if (code === null) return 'Unknown';
  return WMO_TEXT[code] ?? `Unknown (WMO ${code})`;
}

/** Open-Meteo returns UTC times without a zone designator when timezone=UTC. */
function toUtcIso(t: string): string {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(t) ? t : `${t}${t.length === 16 ? ':00' : ''}Z`;
}

function num(v: unknown): Nullable {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clampInt(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(v), min), max);
}

function baseParams(lat: number, lon: number): URLSearchParams {
  return new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: 'UTC',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
  });
}

export async function getForecast(
  http: HttpClient,
  input: { lat: number; lon: number; hours?: number; days?: number },
): Promise<ForecastSeries> {
  const params = baseParams(input.lat, input.lon);
  params.set('hourly', HOURLY_VARS.join(','));
  // Days win over hours only when hours is absent: forecast_days starts at
  // 00:00 UTC today, forecast_hours starts at the current hour.
  if (input.hours === undefined && input.days !== undefined) {
    params.set('forecast_days', String(clampInt(input.days, 1, MAX_DAYS)));
  } else {
    params.set('forecast_hours', String(clampInt(input.hours ?? DEFAULT_HOURS, 1, MAX_HOURS)));
  }

  const body = await http.json<OpenMeteoResponse>(`${ENDPOINT}?${params.toString()}`);
  const hourly = body.hourly;
  const times = (hourly?.time ?? []).map(toUtcIso);

  const variables: ForecastSeries['variables'] = {};
  for (const name of HOURLY_VARS) {
    const raw = hourly?.[name];
    if (!Array.isArray(raw)) continue;
    variables[name] = {
      unit: body.hourly_units?.[name] ?? '',
      values: raw.map(num),
    };
  }

  return { model: MODEL_LABEL, times, variables, attribution: attributionOf('open-meteo') };
}

export async function getCurrentConditions(
  http: HttpClient,
  input: { lat: number; lon: number },
): Promise<CurrentConditions> {
  const params = baseParams(input.lat, input.lon);
  params.set('current', CURRENT_VARS.join(','));

  const body = await http.json<OpenMeteoResponse>(`${ENDPOINT}?${params.toString()}`);
  const c = body.current;
  if (!c || typeof c.time !== 'string') {
    throw new Error('Open-Meteo returned no current conditions');
  }
  const weatherCode = num(c['weather_code']);

  return {
    time: toUtcIso(c.time),
    temperatureC: num(c['temperature_2m']),
    apparentTemperatureC: num(c['apparent_temperature']),
    humidityPct: num(c['relative_humidity_2m']),
    precipitationMm: num(c['precipitation']),
    windSpeedKmh: num(c['wind_speed_10m']),
    windGustKmh: num(c['wind_gusts_10m']),
    windDirectionDeg: num(c['wind_direction_10m']),
    cloudCoverPct: num(c['cloud_cover']),
    weatherCode,
    weatherText: wmoText(weatherCode),
    cape: num(c['cape']),
    attribution: attributionOf('open-meteo'),
  };
}
