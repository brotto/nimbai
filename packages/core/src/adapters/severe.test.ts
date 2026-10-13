import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, SourceError } from '../http.js';
import { getSevereRisk } from './severe.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

const NWS = 'https://api.weather.gov/alerts/active';
const INMET = 'https://apiprevmet3.inmet.gov.br/avisos/ativos';
const SPC = 'https://www.spc.noaa.gov/products/outlook/';

const SPC_FILES = [
  'day1otlk_cat',
  'day1otlk_torn',
  'day1otlk_hail',
  'day1otlk_wind',
  'day2otlk_cat',
  'day2otlk_torn',
  'day2otlk_hail',
  'day2otlk_wind',
  'day3otlk_cat',
  'day3otlk_prob',
];

/** Serves the real fixtures; `status` overrides per URL substring. */
function client(urls: string[] = [], status: Record<string, number> = {}): HttpClient {
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    const forced = Object.entries(status).find(([k]) => u.includes(k));
    if (forced !== undefined) return new Response('error', { status: forced[1] });
    let file: string | undefined;
    if (u.startsWith(NWS)) file = 'nws-alerts-storms.json';
    else if (u.startsWith(INMET)) file = 'inmet-avisos-ativos.json';
    else if (u.startsWith(SPC)) {
      const name = u.slice(SPC.length).replace('.nolyr.geojson', '');
      if (SPC_FILES.includes(name)) file = `spc-${name}.json`;
    }
    if (file === undefined) return new Response('not found', { status: 404 });
    return new Response(fixture(file), { status: 200 });
  }) as typeof fetch;
  return new HttpClient({ userAgent: 'test', fetch: fakeFetch });
}

// Wichita, KS: inside the real Day 1 Slight Risk of the fixtures (valid 2026-10-13T12Z..14T12Z).
const WICHITA = { lat: 37.69, lon: -97.34 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T14:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('getSevereRisk - United States', () => {
  it('separates official warnings from SPC outlooks and never mislabels one as the other', async () => {
    const { items, coverage, gaps } = await getSevereRisk(client(), WICHITA);

    const warnings = items.filter((i) => i.kind === 'official_warning');
    const outlooks = items.filter((i) => i.kind === 'official_outlook');
    expect(warnings.map((w) => w.label)).toEqual([
      expect.stringContaining('Tornado Warning'),
      expect.stringContaining('Severe Thunderstorm Warning'),
    ]);
    // Convective only: Flood Warning and Small Craft Advisory are not severe-storm risk.
    expect(items.map((i) => i.label).join('|')).not.toMatch(/Flood|Small Craft|Test/);
    expect(warnings[0]?.label).toContain('tornadoDetection: OBSERVED');
    expect(warnings.every((w) => w.attribution.source === 'nws')).toBe(true);

    // Every SPC product is an outlook, never a warning.
    expect(outlooks.length).toBeGreaterThanOrEqual(3);
    expect(outlooks.every((o) => o.label.startsWith('SPC '))).toBe(true);
    expect(
      items.filter((i) => i.label.startsWith('SPC ')).every((i) => i.kind === 'official_outlook'),
    ).toBe(true);
    expect(outlooks.every((o) => o.attribution.source === 'spc')).toBe(true);

    // Not produced in this phase.
    expect(items.some((i) => i.kind === 'favourable_environment')).toBe(false);
    expect(items.some((i) => i.kind === 'automated_guidance')).toBe(false);

    expect(coverage).toContain('Ausência de aviso ou de outlook não é ausência de risco');
    expect(gaps.join(' ')).toContain('STP/SCP');
    expect(gaps.join(' ')).toContain('ProbSevere');
    expect(gaps.join(' ')).toContain('MRMS');
  });

  it('reads the real SPC outlooks at the point: category, probabilities and validity window', async () => {
    const { items } = await getSevereRisk(client(), WICHITA);
    const cat = items.find((i) => i.label.startsWith('SPC Day 1 categorical'));
    expect(cat?.label).toBe('SPC Day 1 categorical outlook: Slight Risk');
    expect(cat?.probability).toBeUndefined();
    expect(cat?.validFrom).toBe('2026-10-13T12:00:00+00:00');
    expect(cat?.validTo).toBe('2026-10-14T12:00:00+00:00');
    expect(cat?.detail).toContain('not a warning');
    expect(cat?.url).toBe('https://www.spc.noaa.gov/products/outlook/day1otlk.html');

    const hail = items.find((i) => i.label.startsWith('SPC Day 1 hail'));
    expect(hail?.probability).toBe(0.15);
    expect(hail?.label).toBe('SPC Day 1 hail probability: 15%');
    expect(hail?.detail).toContain('within 25 miles');
    expect(hail?.detail).toContain('not a warning');

    // The highest category wins even though the point also lies in the "nolyr" TSTM/MRGL footprints.
    expect(items.filter((i) => i.label.startsWith('SPC Day 1 categorical'))).toHaveLength(1);
  });

  it('drops outlooks whose validity has lapsed', async () => {
    vi.setSystemTime(new Date('2026-10-14T13:00:00Z'));
    const { items } = await getSevereRisk(client(), WICHITA);
    expect(items.filter((i) => i.label.startsWith('SPC Day 1'))).toEqual([]);
  });

  it('says so when no SPC risk area contains the point instead of implying safety', async () => {
    const { items, coverage } = await getSevereRisk(client(), { lat: 45, lon: -120 });
    expect(items.filter((i) => i.kind === 'official_outlook')).toEqual([]);
    expect(coverage).toContain('nenhuma área de risco o cobre');
    expect(coverage).toContain('não é ausência de risco');
  });

  it('reports a missing SPC product as a gap and keeps the others', async () => {
    const { items, gaps } = await getSevereRisk(client([], { day3otlk_prob: 404 }), WICHITA);
    expect(gaps.join(' ')).toContain('Day 3 any-severe probability (HTTP 404)');
    expect(items.some((i) => i.label.startsWith('SPC Day 1'))).toBe(true);
  });

  it('throws when every source consulted fails, rather than returning an empty "all clear"', async () => {
    await expect(
      getSevereRisk(client([], { 'api.weather.gov': 404, 'spc.noaa.gov': 404 }), WICHITA),
    ).rejects.toBeInstanceOf(SourceError);
  });
});

describe('getSevereRisk - outside the US', () => {
  it('Brazil: INMET storm warning is an official_warning and the tornado gap is explicit', async () => {
    const urls: string[] = [];
    const { items, coverage, gaps } = await getSevereRisk(client(urls), {
      lat: -25.54,
      lon: -54.58,
    });
    expect(urls.some((u) => u.startsWith(SPC))).toBe(false);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('official_warning');
    expect(items[0]?.label).toBe('Tempestade');
    expect(items[0]?.attribution.source).toBe('inmet');
    expect(items[0]?.detail).toContain('Chuva entre 20 e 30 mm/h');
    expect(gaps).toContain('Não existe aviso oficial de tornado por polígono no Brasil.');
    expect(gaps.join(' ')).toContain('polígono aproximado');
    expect(coverage).toContain('SPC Convective Outlook não consultado');
  });

  it('Germany: no request, no items, and the gaps say why', async () => {
    const urls: string[] = [];
    const { items, coverage, gaps } = await getSevereRisk(client(urls), { lat: 48.1, lon: 11.5 });
    expect(urls).toEqual([]);
    expect(items).toEqual([]);
    expect(gaps.join(' ')).toContain('MeteoAlarm');
    expect(gaps.join(' ')).toContain('STP/SCP');
    expect(coverage).toContain('não é ausência de risco');
  });

  it('rejects invalid coordinates', async () => {
    await expect(getSevereRisk(client(), { lat: 120, lon: 0 })).rejects.toBeInstanceOf(RangeError);
  });
});
