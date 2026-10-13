import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../http.js';
import { getCurrentConditions, getForecast, wmoText } from './forecast.js';

const body = readFileSync(
  new URL('./__fixtures__/open-meteo-forecast.json', import.meta.url),
  'utf8',
);

function client(urls: string[]): HttpClient {
  const fakeFetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return new HttpClient({ userAgent: 'test', fetch: fakeFetch });
}

describe('getForecast', () => {
  it('requests hourly variables in metric units with UTC time', async () => {
    const urls: string[] = [];
    await getForecast(client(urls), { lat: -25.5, lon: -54.6, hours: 3 });
    const q = new URL(urls[0] ?? '').searchParams;
    expect(q.get('latitude')).toBe('-25.5');
    expect(q.get('longitude')).toBe('-54.6');
    expect(q.get('timezone')).toBe('UTC');
    expect(q.get('forecast_hours')).toBe('3');
    expect(q.get('forecast_days')).toBeNull();
    expect(q.get('wind_speed_unit')).toBe('kmh');
    expect(q.get('temperature_unit')).toBe('celsius');
    expect(q.get('precipitation_unit')).toBe('mm');
    expect(q.get('hourly')?.split(',')).toEqual(
      expect.arrayContaining([
        'temperature_2m',
        'cape',
        'wind_gusts_10m',
        'precipitation_probability',
      ]),
    );
  });

  it('uses forecast_days when only days is given, and clamps', async () => {
    const urls: string[] = [];
    await getForecast(client(urls), { lat: 0, lon: 0, days: 99 });
    expect(new URL(urls[0] ?? '').searchParams.get('forecast_days')).toBe('16');
  });

  it('parses the series with UTC ISO times and units', async () => {
    const s = await getForecast(client([]), { lat: -25.5, lon: -54.6 });
    expect(s.model).toBe('Open-Meteo (multi-model blend)');
    expect(s.times).toEqual([
      '2026-10-13T00:00:00Z',
      '2026-10-13T01:00:00Z',
      '2026-10-13T02:00:00Z',
    ]);
    expect(s.variables['temperature_2m']).toEqual({ unit: '°C', values: [19.2, 19.4, 19.4] });
    expect(s.variables['wind_speed_10m']?.unit).toBe('km/h');
    expect(s.variables['cape']?.unit).toBe('J/kg');
    expect(s.attribution.source).toBe('open-meteo');
  });
});

describe('getCurrentConditions', () => {
  it('maps the current block', async () => {
    const urls: string[] = [];
    const c = await getCurrentConditions(client(urls), { lat: -25.5, lon: -54.6 });
    const q = new URL(urls[0] ?? '').searchParams;
    expect(q.get('current')?.split(',')).toContain('weather_code');
    expect(q.get('hourly')).toBeNull();
    expect(c).toMatchObject({
      time: '2026-10-13T06:00:00Z',
      temperatureC: 19.6,
      apparentTemperatureC: 22.2,
      humidityPct: 98,
      precipitationMm: 0,
      windSpeedKmh: 5.8,
      windGustKmh: 13.7,
      windDirectionDeg: 4,
      cloudCoverPct: 95,
      weatherCode: 3,
      weatherText: 'Overcast',
      cape: 710,
    });
    expect(c.attribution.source).toBe('open-meteo');
  });
});

describe('wmoText', () => {
  it.each([
    [0, 'Clear sky'],
    [63, 'Moderate rain'],
    [95, 'Thunderstorm'],
    [99, 'Thunderstorm with heavy hail'],
    [null, 'Unknown'],
    [42, 'Unknown (WMO 42)'],
  ])('%s -> %s', (code, text) => {
    expect(wmoText(code)).toBe(text);
  });
});
