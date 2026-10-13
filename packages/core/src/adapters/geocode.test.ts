import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../http.js';
import { searchLocation } from './geocode.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

function clientWith(body: string, urls: string[] = []): HttpClient {
  const fakeFetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return new HttpClient({ userAgent: 'test', fetch: fakeFetch });
}

describe('searchLocation', () => {
  it('builds the request and parses real results', async () => {
    const urls: string[] = [];
    const out = await searchLocation(clientWith(fixture('open-meteo-geocode.json'), urls), {
      query: 'Foz do Iguaçu',
      limit: 2,
    });
    const url = new URL(urls[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://geocoding-api.open-meteo.com/v1/search');
    expect(url.searchParams.get('name')).toBe('Foz do Iguaçu');
    expect(url.searchParams.get('count')).toBe('2');
    expect(url.searchParams.get('format')).toBe('json');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: '-25.5478,-54.5881',
      name: 'Foz do Iguaçu',
      admin: 'Paraná',
      country: 'Brazil',
      countryCode: 'BR',
      lat: -25.54778,
      lon: -54.58806,
      timezone: 'America/Sao_Paulo',
      population: 258248,
    });
    expect(out[1]?.population).toBeUndefined();
  });

  it('returns [] when the API omits results', async () => {
    const out = await searchLocation(clientWith(fixture('open-meteo-geocode-empty.json')), {
      query: 'zzzzqqq',
    });
    expect(out).toEqual([]);
  });

  it('returns a synthetic location for lat/lon without a query, without any request', async () => {
    const urls: string[] = [];
    const out = await searchLocation(clientWith('{}', urls), { lat: -25.5, lon: -54.6 });
    expect(urls).toHaveLength(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: '-25.5000,-54.6000', lat: -25.5, lon: -54.6 });
    expect(out[0]?.name).toBe('25.5000°S, 54.6000°W');
    expect(out[0]?.country).toBeUndefined();
  });

  it('rejects when neither query nor coordinates are given', async () => {
    await expect(searchLocation(clientWith('{}'), {})).rejects.toThrow();
  });
});
