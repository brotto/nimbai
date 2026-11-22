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

  // 56046 (Tempestade) starts on the 14th and covers the Mato Grosso do Sul point below (outside the in-force 56014); 56038 (Chuvas
  // Intensas, not convective) covers Manaus. At 13 Oct 11:00 Brasília neither
  // is in force.
  it('Brazil: an upcoming convective warning is returned apart from `items`, marked not in force', async () => {
    const { items, upcoming, coverage, gaps } = await getSevereRisk(client(), {
      lat: -23.5,
      lon: -55.5,
    });
    expect(items.filter((i) => i.kind === 'official_warning')).toEqual([]);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.kind).toBe('official_warning');
    expect(upcoming[0]?.label).toBe(
      '[AINDA NÃO EM VIGOR; início 2026-10-14 00:00 horário de Brasília (UTC-3)] Tempestade',
    );
    expect(upcoming[0]?.validFrom).toBe('2026-10-14 00:00');
    expect(upcoming[0]?.attribution.source).toBe('inmet');
    expect(coverage).toContain('`upcoming`');
    expect(gaps.join(' ')).toContain('polígono aproximado');
  });

  it('Brazil: an upcoming warning that is not convective is not surfaced as severe-weather risk', async () => {
    const { items, upcoming } = await getSevereRisk(client(), { lat: -3.12, lon: -60.02 });
    expect(items).toEqual([]);
    expect(upcoming).toEqual([]);
  });

  it('Brazil: an in-force warning is in `items`, never in `upcoming`', async () => {
    const { items, upcoming } = await getSevereRisk(client(), { lat: -25.54, lon: -54.58 });
    expect(items.map((i) => i.label)).toEqual(['Tempestade']);
    expect(upcoming).toEqual([]);
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

// NWS stamps carry their own offset. The "[AINDA NÃO EM VIGOR; ...]" label names
// Brasília only for INMET, whose stamps have no zone.
describe('getSevereRisk - NWS warnings that have not started', () => {
  const nwsFeature = (id: string, event: string, onset: string | null) => ({
    geometry: null,
    properties: {
      id,
      event,
      severity: 'Severe',
      status: 'Actual',
      headline: `${event} headline`,
      description: 'official text',
      instruction: null,
      areaDesc: 'Sedgwick, KS',
      onset,
      effective: onset,
      ends: '2026-10-15T00:00:00-05:00',
    },
  });
  const nwsClient = (features: unknown[]): HttpClient =>
    new HttpClient({
      userAgent: 'test',
      fetch: (async (url: string | URL | Request) => {
        const u = String(url);
        if (!u.startsWith(NWS)) return new Response('nf', { status: 404 });
        return new Response(JSON.stringify({ features }), { status: 200 });
      }) as typeof fetch,
    });
  // Plain US point outside CONUS outlooks' reach is not needed: SPC 404s are tolerated.
  const MIDWEST = { lat: 37.69, lon: -97.34 };

  it('keeps the label on one line when the published start is not', async () => {
    // `onset` here is unreadable (a newline breaks the offset), so `effective`
    // decides the split while the label still shows what NWS published.
    // `sanitizeExternalText` keeps newlines so official text keeps its
    // paragraphs; a label is one line, so it must collapse them.
    const broken = {
      geometry: null,
      properties: {
        ...nwsFeature('brk', 'Tornado Watch', null).properties,
        onset: '2026-10-14T03:00:00\n-05:00',
        effective: '2026-10-14T03:00:00-05:00',
      },
    };
    const { items, upcoming } = await getSevereRisk(nwsClient([broken]), MIDWEST);
    expect(items).toHaveLength(0);
    expect(upcoming).toHaveLength(1);
    const label = upcoming[0]?.label ?? '';
    expect(label).not.toMatch(/[\n\r]/);
    expect(label).toContain('[AINDA NÃO EM VIGOR; início 2026-10-14T03:00:00 -05:00]');
  });

  it('a convective NWS watch that starts later goes to `upcoming`, with its own offset in the label', async () => {
    const { items, upcoming, gaps } = await getSevereRisk(
      nwsClient([
        nwsFeature('w1', 'Tornado Warning', '2026-10-13T08:00:00-05:00'),
        nwsFeature('w2', 'Tornado Watch', '2026-10-14T03:00:00-05:00'),
        nwsFeature('w3', 'Flood Warning', '2026-10-14T03:00:00-05:00'),
      ]),
      MIDWEST,
    );
    expect(items.filter((i) => i.kind === 'official_warning').map((i) => i.label)).toEqual([
      'Tornado Warning',
    ]);
    expect(upcoming.map((i) => i.label)).toEqual([
      '[AINDA NÃO EM VIGOR; início 2026-10-14T03:00:00-05:00] Tornado Watch',
    ]);
    expect(upcoming[0]?.validFrom).toBe('2026-10-14T03:00:00-05:00');
    expect(upcoming[0]?.attribution.source).toBe('nws');
    expect(upcoming[0]?.label).not.toContain('Brasília');
    // Not an INMET item: the approximate-polygon caveat does not apply.
    expect(gaps.join(' ')).not.toContain('polígono aproximado');
    // Nothing that has not started is among the items in force.
    expect(items.map((i) => i.label).join('|')).not.toContain('Watch');
  });

  it('an NWS warning with no readable published start has a bare label and no validFrom', async () => {
    // Split on `effective`; `onset` is absent, so nothing is published as the start.
    const f = nwsFeature('w5', 'Tornado Watch', null);
    f.properties.effective = '2026-10-14T03:00:00-05:00';
    const { upcoming } = await getSevereRisk(nwsClient([f]), MIDWEST);
    expect(upcoming.map((i) => i.label)).toEqual(['[AINDA NÃO EM VIGOR] Tornado Watch']);
    expect(upcoming[0]?.validFrom).toBeUndefined();
  });

  it('a published onset is sanitized before it reaches the label: control chars stripped, length capped', async () => {
    const f = nwsFeature('w6', 'Tornado Watch', `bad\u0000${'x'.repeat(500)}`);
    f.properties.effective = '2026-10-14T03:00:00-05:00';
    const { upcoming } = await getSevereRisk(nwsClient([f]), MIDWEST);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.label).not.toContain('\u0000');
    expect(upcoming[0]?.label.length).toBeLessThan(120);
  });

  it('the same NWS watch is in `items` once it has begun', async () => {
    vi.setSystemTime(new Date('2026-10-14T09:00:00Z')); // 04:00-05:00 on the 14th
    const { items, upcoming } = await getSevereRisk(
      nwsClient([nwsFeature('w2', 'Tornado Watch', '2026-10-14T03:00:00-05:00')]),
      MIDWEST,
    );
    expect(items.filter((i) => i.kind === 'official_warning').map((i) => i.label)).toEqual([
      'Tornado Watch',
    ]);
    expect(upcoming).toEqual([]);
  });

  it('an NWS warning with no readable start stays in `items` (fail-open)', async () => {
    const { items, upcoming } = await getSevereRisk(
      nwsClient([nwsFeature('w4', 'Severe Thunderstorm Warning', null)]),
      MIDWEST,
    );
    expect(items.some((i) => i.label === 'Severe Thunderstorm Warning')).toBe(true);
    expect(upcoming).toEqual([]);
  });

  it('keeps naming Brasília, and only there, for an INMET item', async () => {
    const { upcoming } = await getSevereRisk(client(), { lat: -23.5, lon: -55.5 });
    expect(upcoming[0]?.label).toContain('horário de Brasília (UTC-3)');
  });
});
