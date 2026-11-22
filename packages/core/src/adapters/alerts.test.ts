import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, SourceError, sanitizeExternalText } from '../http.js';
import type { Bbox } from '../types.js';
import { getAlerts, parseNwsInstant } from './alerts.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

interface Route {
  match: string;
  file: string;
  status?: number;
}

function clientWith(routes: Route[], urls: string[] = []): HttpClient {
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    const route = routes.find((r) => u.startsWith(r.match));
    if (route === undefined) return new Response('not found', { status: 404 });
    return new Response(fixture(route.file), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return new HttpClient({ userAgent: 'test', fetch: fakeFetch });
}

const NWS = 'https://api.weather.gov/alerts/active';
const INMET = 'https://apiprevmet3.inmet.gov.br/avisos/ativos';
const storms: Route = { match: NWS, file: 'nws-alerts-storms.json' };
const inmet: Route = { match: INMET, file: 'inmet-avisos-ativos.json' };

interface RawFeature {
  geometry: { type: string; coordinates: number[][][] } | null;
  properties: {
    event: string;
    headline: string | null;
    description: string | null;
    instruction: string | null;
  };
}
const rawStorms = (JSON.parse(fixture('nws-alerts-storms.json')) as { features: RawFeature[] })
  .features;
const rawTornado = rawStorms.find((f) => f.properties.event === 'Tornado Warning') as RawFeature;

describe('getAlerts - INMET times carry no zone', () => {
  it('says in coverage that onset/expires are Brasília time, not UTC', async () => {
    // `upcoming` makes onset the field a reader acts on, and the INMET string
    // has no zone marker. Sorting converts it; the rendered text does not.
    const { coverage } = await getAlerts(clientWith([inmet]), {
      lat: -25.54778,
      lon: -54.58806,
    });
    expect(coverage).toContain('BRASÍLIA (UTC-3)');
    expect(coverage).toContain('Não os leia como UTC');
  });
});

// A feed built here, so the only thing separating "in force" from "upcoming"
// is how an INMET stamp (Brasília, UTC-3, no zone marker) becomes an instant.
describe('getAlerts - INMET Brasília-time boundary', () => {
  const POINT = { lat: -25.54, lon: -54.58 };
  const aviso = (id: number, severidade: string, inicio: string, fim: string) => ({
    id,
    descricao: 'Tempestade',
    severidade,
    inicio,
    fim,
    encerrado: false,
    poligono: JSON.stringify({
      type: 'Polygon',
      coordinates: [
        [
          [-55, -26],
          [-54, -26],
          [-54, -25],
          [-55, -25],
          [-55, -26],
        ],
      ],
    }),
  });
  const feedClient = (hoje: unknown[], futuro: unknown[] = []): HttpClient =>
    new HttpClient({
      userAgent: 'test',
      fetch: (async () =>
        new Response(JSON.stringify({ hoje, futuro }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
  const at = async <T>(iso: string, fn: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(iso));
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  };

  // 13:00 Brasília is 16:00Z. At 15:00Z it is 12:00 in Brasília: an hour away.
  // Read as UTC it would be 13:00Z, already past, and be wrongly in force.
  it('inicio 13:00 Brasília at 15:00Z is upcoming, not in force', async () => {
    const r = await at('2026-10-13T15:00:00Z', () =>
      getAlerts(feedClient([aviso(1, 'Perigo', '2026-10-13 13:00', '2026-10-13 23:59')]), POINT),
    );
    expect(r.alerts).toEqual([]);
    expect(r.upcoming.map((a) => a.id)).toEqual(['inmet:1']);
  });

  it('inicio 13:00 Brasília is in force once 16:00Z has passed', async () => {
    const r = await at('2026-10-13T16:01:00Z', () =>
      getAlerts(feedClient([aviso(1, 'Perigo', '2026-10-13 13:00', '2026-10-13 23:59')]), POINT),
    );
    expect(r.alerts.map((a) => a.id)).toEqual(['inmet:1']);
    expect(r.upcoming).toEqual([]);
  });

  // Mirror: fim 13:00 Brasília is 16:00Z. At 15:00Z the warning has not ended;
  // read as UTC (13:00Z) it would look expired and be silently dropped.
  it('fim 13:00 Brasília at 15:00Z is still in force, not expired', async () => {
    const r = await at('2026-10-13T15:00:00Z', () =>
      getAlerts(feedClient([aviso(1, 'Perigo', '2026-10-13 06:00', '2026-10-13 13:00')]), POINT),
    );
    expect(r.alerts.map((a) => a.id)).toEqual(['inmet:1']);
  });

  it('fim 13:00 Brasília is expired once 16:00Z has passed', async () => {
    const r = await at('2026-10-13T16:01:00Z', () =>
      getAlerts(feedClient([aviso(1, 'Perigo', '2026-10-13 06:00', '2026-10-13 13:00')]), POINT),
    );
    expect(r.alerts).toEqual([]);
    expect(r.upcoming).toEqual([]);
  });

  it('applies the severity filter to `upcoming`: the match stays, the rest goes', async () => {
    const r = await at('2026-10-13T15:00:00Z', () =>
      getAlerts(
        feedClient(
          [],
          [
            aviso(2, 'Perigo', '2026-10-14 06:00', '2026-10-14 23:59'),
            aviso(3, 'Grande Perigo', '2026-10-15 06:00', '2026-10-15 23:59'),
          ],
        ),
        { ...POINT, severity: ['Grande Perigo'] },
      ),
    );
    expect(r.upcoming.map((a) => a.id)).toEqual(['inmet:3']);
  });
});

describe('getAlerts - NWS', () => {
  it('parses a real Tornado Warning with its impact-based-warning tags', async () => {
    const urls: string[] = [];
    const { alerts, coverage } = await getAlerts(clientWith([storms], urls), {
      lat: 35.2,
      lon: -77.7,
    });
    const url = new URL(urls[0] ?? '');
    expect(url.origin + url.pathname).toBe(NWS);
    expect(url.searchParams.get('point')).toBe('35.2000,-77.7000');

    const tor = alerts.find((a) => a.event === 'Tornado Warning');
    expect(tor).toBeDefined();
    expect(tor?.severity).toBe('Extreme');
    expect(tor?.urgency).toBe('Immediate');
    expect(tor?.certainty).toBe('Observed');
    expect(tor?.tags).toEqual([
      'tornadoDetection: OBSERVED',
      'tornadoDamageThreat: CONSIDERABLE',
      'maxHailSize: 0.00',
    ]);
    expect(tor?.areaDescription).toContain('NC');
    expect(tor?.attribution.source).toBe('nws');
    expect(tor?.url).toMatch(/^https:\/\/api\.weather\.gov\/alerts\//);
    // Most severe first, and the NWS "Test Message" is not an alert.
    expect(alerts[0]?.event).toBe('Tornado Warning');
    expect(alerts.map((a) => a.event)).not.toContain('Test Message');
    expect(coverage).toContain('NWS (EUA) consultado');
  });

  it('keeps the official text verbatim: headline, description and instruction, in order', async () => {
    const { alerts } = await getAlerts(clientWith([storms]), { lat: 35.2, lon: -77.7 });
    const p = rawTornado.properties;
    const text = alerts.find((a) => a.event === 'Tornado Warning')?.text ?? '';
    const expected = sanitizeExternalText(
      [p.headline, p.description, p.instruction].join('\n\n'),
      20_000,
    );
    expect(text).toBe(expected);
    // Hard line wraps and the life-safety sentences survive untouched.
    expect(text).toContain(p.description as string);
    expect(text).toContain((p.instruction as string).trim());
    expect(text).toContain('This is a PARTICULARLY DANGEROUS SITUATION. TAKE COVER NOW!');
    expect(text.indexOf(p.headline as string)).toBe(0);
    expect(text.indexOf(p.description as string)).toBeLessThan(
      text.indexOf((p.instruction as string).trim()),
    );
  });

  it('filters by published severity, case-insensitively', async () => {
    const urls: string[] = [];
    const extreme = await getAlerts(clientWith([storms], urls), {
      lat: 35.2,
      lon: -77.7,
      severity: ['extreme'],
    });
    expect(extreme.alerts.map((a) => a.event)).toEqual(['Tornado Warning']);
    expect(new URL(urls[0] ?? '').searchParams.get('severity')).toBe('Extreme');
    expect(extreme.coverage).toContain('Filtro de severidade');

    const severe = await getAlerts(clientWith([storms]), {
      lat: 35.2,
      lon: -77.7,
      severity: ['Severe'],
    });
    expect(severe.alerts.map((a) => a.event).sort()).toEqual([
      'Flood Warning',
      'Severe Thunderstorm Warning',
    ]);

    const minor = await getAlerts(clientWith([storms]), {
      lat: 35.2,
      lon: -77.7,
      severity: ['Minor'],
    });
    expect(minor.alerts.map((a) => a.event)).toEqual(['Small Craft Advisory']);
  });

  it('does not send a non-NWS severity label to the API (it would 400)', async () => {
    const urls: string[] = [];
    await getAlerts(clientWith([storms], urls), { lat: 35.2, lon: -77.7, severity: ['Perigo'] });
    expect(new URL(urls[0] ?? '').searchParams.has('severity')).toBe(false);
  });

  it('returns an empty list, not an error, when nothing is active, and says absence is not safety', async () => {
    const { alerts, coverage } = await getAlerts(
      clientWith([{ match: NWS, file: 'nws-alerts-empty.json' }]),
      { lat: 35.2, lon: -97.4 },
    );
    expect(alerts).toEqual([]);
    expect(coverage).toContain('Ausência de alertas neste resultado não é ausência de risco');
  });

  it('treats the NWS 400 "out of bounds" as outside coverage, not as a failure', async () => {
    const urls: string[] = [];
    const { alerts, coverage } = await getAlerts(
      clientWith([{ match: NWS, file: 'nws-alerts-invalid-point.json', status: 400 }], urls),
      { lat: 40, lon: -62 },
    );
    expect(urls).toHaveLength(1);
    expect(alerts).toEqual([]);
    expect(coverage).toContain('fora da cobertura');
  });

  it('throws instead of returning a misleading empty list when the only relevant source fails', async () => {
    await expect(
      getAlerts(clientWith([{ match: NWS, file: 'nws-alerts-empty.json', status: 404 }]), {
        lat: 35.2,
        lon: -97.4,
      }),
    ).rejects.toBeInstanceOf(SourceError);
  });
});

describe('getAlerts - outside the US', () => {
  it('Germany: no request, empty list, honest coverage', async () => {
    const urls: string[] = [];
    const { alerts, coverage } = await getAlerts(clientWith([storms, inmet], urls), {
      lat: 48.1,
      lon: 11.5,
    });
    expect(urls).toEqual([]);
    expect(alerts).toEqual([]);
    expect(coverage).toContain('Não cobertos por esta consulta');
    expect(coverage).toContain('MeteoAlarm');
    expect(coverage).toContain('sem geometria');
    expect(coverage).toContain('não é ausência de risco');
  });

  // Frozen: the fixture's warnings are valid on 13 Oct 2026, and getAlerts now
  // lists only warnings in force, so on any later day this would see an empty
  // list and assert nothing.
  it('Brazil: matches INMET by polygon and keeps the official text', async () => {
    vi.useFakeTimers();
    // finally, not a trailing call: a failing expect would otherwise leak fake
    // timers into every test that runs after this one.
    try {
      vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
      const urls: string[] = [];
      const { alerts, coverage } = await getAlerts(clientWith([storms, inmet], urls), {
        lat: -25.54,
        lon: -54.58,
      });
      expect(urls).toEqual([INMET]);
      expect(alerts.map((a) => a.id)).toEqual(['inmet:56014']);
      const a = alerts[0];
      expect(a?.event).toBe('Tempestade');
      expect(a?.severity).toBe('Perigo Potencial');
      expect(a?.attribution.source).toBe('inmet');
      expect(a?.onset).toBe('2026-10-13 00:00');
      expect(a?.text).toContain('Chuva entre 20 e 30 mm/h ou até 50 mm/dia');
      expect(a?.text).toContain('Obtenha mais informações junto à Defesa Civil (telefone 199)');
      expect(coverage).toContain('INMET (Brasil) consultado');
      expect(coverage).toContain('envelope aproximado');
      expect(coverage).toContain('EUA');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Brazil: a point outside every published polygon yields no alert', async () => {
    const { alerts } = await getAlerts(clientWith([inmet]), { lat: -1.45, lon: -48.5 });
    expect(alerts).toEqual([]);
  });

  // Time is frozen: the fixture carries real dates, and the whole point of
  // these two cases is which side of `inicio`/`fim` "now" falls on.
  it('lists an INMET warning that starts tomorrow in `upcoming`, never in `alerts`', async () => {
    vi.useFakeTimers();
    try {
      // 13 Oct 2026, 12:00 Brasília (UTC-3): the 14 Oct warnings have not begun.
      vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
      const { alerts, upcoming, coverage } = await getAlerts(clientWith([inmet]), {
        lat: -3.12,
        lon: -60.02,
      });
      expect(alerts.map((a) => a.event)).not.toContain('Chuvas Intensas');
      expect(alerts.map((a) => a.id)).not.toContain('inmet:56038');
      expect(upcoming.map((a) => a.id)).toEqual(['inmet:56038']);
      expect(upcoming[0]?.event).toBe('Chuvas Intensas');
      expect(upcoming[0]?.onset).toBe('2026-10-14 00:01');
      expect(coverage).toContain('`upcoming`');
      expect(coverage).toContain('AINDA NÃO estão em vigor');
      expect(coverage).not.toContain('começam no futuro');
    } finally {
      vi.useRealTimers();
    }
  });

  // The regression this guards: upcoming avisos used to be counted before any
  // geometry test, so the feed's Brazil-wide futuro list was reported as
  // "for this location". 56038 (Amazonas) and 56046 (Mato Grosso) are both
  // upcoming here; neither polygon contains Foz do Iguaçu.
  it('does not list or count an upcoming warning whose polygon misses the point', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
      const { alerts, upcoming, coverage } = await getAlerts(clientWith([inmet]), {
        lat: -25.54,
        lon: -54.58,
      });
      expect(upcoming).toEqual([]);
      expect(alerts.map((a) => a.id)).toEqual(['inmet:56014']);
      expect(coverage).not.toMatch(/\d+ aviso\(s\)/);
      expect(coverage).not.toContain('começam no futuro');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the geometry test to upcoming warnings in a bbox query too', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
      const around = (lon: number, lat: number): Bbox => [
        lon - 0.1,
        lat - 0.1,
        lon + 0.1,
        lat + 0.1,
      ];
      const hit = await getAlerts(clientWith([inmet]), { bbox: around(-60.02, -3.12) });
      expect(hit.upcoming.map((a) => a.id)).toEqual(['inmet:56038']);
      const miss = await getAlerts(clientWith([inmet]), { bbox: around(-48.5, -1.45) });
      expect(miss.upcoming).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps in-force and upcoming apart, sorted soonest first, with no id in both', async () => {
    vi.useFakeTimers();
    try {
      // No real fixture warning has a polygon holding both an in-force and an
      // upcoming one, so the feed is built here.
      vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
      const square = (id: number, inicio: string, fim: string) => ({
        id,
        descricao: 'Tempestade',
        severidade: 'Perigo',
        inicio,
        fim,
        encerrado: false,
        poligono: JSON.stringify({
          type: 'Polygon',
          coordinates: [
            [
              [-55, -26],
              [-54, -26],
              [-54, -25],
              [-55, -25],
              [-55, -26],
            ],
          ],
        }),
      });
      const feed = {
        hoje: [square(1, '2026-10-13 00:00', '2026-10-13 23:59')],
        futuro: [
          square(3, '2026-10-15 06:00', '2026-10-15 23:59'),
          square(2, '2026-10-14 06:00', '2026-10-14 23:59'),
          // Same id as the in-force one, listed again as future.
          square(1, '2026-10-14 00:00', '2026-10-14 23:59'),
        ],
      };
      const http = new HttpClient({
        userAgent: 'test',
        fetch: (async () =>
          new Response(JSON.stringify(feed), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      });
      const { alerts, upcoming } = await getAlerts(http, { lat: -25.54, lon: -54.58 });
      expect(alerts.map((a) => a.id)).toEqual(['inmet:1']);
      expect(upcoming.map((a) => a.id)).toEqual(['inmet:2', 'inmet:3']);
      const filtered = await getAlerts(http, {
        lat: -25.54,
        lon: -54.58,
        severity: ['Grande Perigo'],
      });
      expect(filtered.upcoming).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says in coverage that NWS is split too, and that only an explicit offset is read', async () => {
    const { coverage } = await getAlerts(clientWith([storms]), { lat: 35.2, lon: -97.4 });
    expect(coverage).toContain('Alertas do NWS cujo início');
    expect(coverage).toContain('`expires` não é interpretado');
    expect(coverage).toContain('separados em `upcoming`');
    expect(coverage).toContain('deslocamento de fuso explícito');
    expect(coverage).not.toContain('NÃO são separados');
  });

  it('lists the same INMET warning once it is in force', async () => {
    vi.useFakeTimers();
    try {
      // 14 Oct 2026, 12:00 Brasília: inside the 14 Oct window.
      vi.setSystemTime(new Date('2026-10-14T15:00:00Z'));
      const { alerts } = await getAlerts(clientWith([inmet]), { lat: -3.12, lon: -60.02 });
      expect(alerts.map((a) => a.event)).toContain('Chuvas Intensas');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an INMET warning whose window has already expired', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-20T15:00:00Z'));
      const { alerts } = await getAlerts(clientWith([inmet]), { lat: -3.12, lon: -60.02 });
      expect(alerts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getAlerts - bbox and input validation', () => {
  const ring = rawTornado.geometry?.coordinates[0] ?? [];
  const xs = ring.map((p) => p[0] as number);
  const ys = ring.map((p) => p[1] as number);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;

  it('matches polygons against the box and reports the zone-only alerts it had to omit', async () => {
    const bbox: Bbox = [cx - 0.1, cy - 0.1, cx + 0.1, cy + 0.1];
    const urls: string[] = [];
    const { alerts, coverage } = await getAlerts(clientWith([storms], urls), { bbox });
    expect(new URL(urls[0] ?? '').searchParams.has('point')).toBe(false);
    expect(alerts.map((a) => a.event)).toEqual(['Tornado Warning']);
    expect(coverage).toContain('sem polígono');
    expect(coverage).toContain('foram omitidos');
  });

  it('a box that overlaps no polygon returns nothing', async () => {
    const { alerts } = await getAlerts(clientWith([storms]), { bbox: [-100, 30, -99, 31] });
    expect(alerts).toEqual([]);
  });

  it('rejects missing or malformed input', async () => {
    const http = clientWith([]);
    await expect(getAlerts(http, {})).rejects.toBeInstanceOf(RangeError);
    await expect(getAlerts(http, { lat: 10 })).rejects.toBeInstanceOf(RangeError);
    await expect(getAlerts(http, { lat: 91, lon: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(getAlerts(http, { bbox: [10, 0, 5, 1] })).rejects.toBeInstanceOf(RangeError);
  });
});

// The live active feed lists messages whose hazard has not begun (116 of 352 at
// the time of measuring). The rule: start = `onset`, else `effective`; later
// than now means `upcoming`. NWS stamps carry their own offset, so there is no
// Brasília correction here.
describe('getAlerts - NWS hazard start', () => {
  const NOW = '2026-11-22T12:00:00Z';
  const SQUARE = {
    type: 'Polygon',
    coordinates: [
      [
        [-78, 34],
        [-76, 34],
        [-76, 36],
        [-78, 36],
        [-78, 34],
      ],
    ],
  };
  interface Times {
    onset?: string | null;
    effective?: string | null;
  }
  const feature = (
    id: string,
    times: Times,
    over: { event?: string; severity?: string; geometry?: unknown } = {},
  ) => ({
    geometry: 'geometry' in over ? over.geometry : SQUARE,
    properties: {
      id,
      event: over.event ?? 'Winter Storm Warning',
      severity: over.severity ?? 'Severe',
      status: 'Actual',
      headline: `h ${id}`,
      description: 'd',
      instruction: null,
      areaDesc: 'somewhere',
      ends: '2026-11-30T00:00:00-05:00',
      expires: '2026-11-30T00:00:00-05:00',
      ...times,
    },
  });
  const POINT = { lat: 35, lon: -77 };
  const clientFor = (nws: unknown[], inmetFeed?: unknown): HttpClient =>
    new HttpClient({
      userAgent: 'test',
      fetch: (async (url: string | URL | Request) => {
        const u = String(url);
        const body = u.startsWith(NWS)
          ? { features: nws }
          : u.startsWith(INMET) && inmetFeed !== undefined
            ? inmetFeed
            : null;
        if (body === null) return new Response('nf', { status: 404 });
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
  const at = async <T>(iso: string, fn: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(iso));
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  };
  const run = (feats: unknown[], iso = NOW, input: Parameters<typeof getAlerts>[1] = POINT) =>
    at(iso, () => getAlerts(clientFor(feats), input));

  it('a future onset goes to `upcoming`, never to `alerts`', async () => {
    const r = await run([
      feature('a', { onset: '2026-11-25T04:00:00-05:00' }),
      feature('b', { onset: '2026-11-22T06:00:00-05:00' }),
    ]);
    expect(r.alerts.map((x) => x.id)).toEqual(['b']);
    expect(r.upcoming.map((x) => x.id)).toEqual(['a']);
  });

  it('reads the offset as published: no Brasília +3 correction on an NWS stamp', async () => {
    // 04:00-05:00 is 09:00Z. At 08:30Z it is still ahead; adding INMET'S +3 h to
    // the wall clock (04:00 -> 07:00Z) would call it in force.
    const f = feature('a', { onset: '2026-11-23T04:00:00-05:00' });
    const before = await run([f], '2026-11-23T08:30:00Z');
    expect(before.alerts).toEqual([]);
    expect(before.upcoming.map((x) => x.id)).toEqual(['a']);
    const after = await run([f], '2026-11-23T09:30:00Z');
    expect(after.alerts.map((x) => x.id)).toEqual(['a']);
    expect(after.upcoming).toEqual([]);
  });

  it('the boundary is exclusive: a start at exactly now is already in force', async () => {
    const f = feature('a', { onset: '2026-11-23T09:00:00Z' });
    expect((await run([f], '2026-11-23T09:00:00Z')).alerts).toHaveLength(1);
    expect((await run([f], '2026-11-23T08:59:59Z')).upcoming).toHaveLength(1);
  });

  it('falls back to `effective` for the split, and leaves the published `onset` untouched', async () => {
    const future = '2026-11-24T10:00:00-05:00';
    const cases: [string, Times, string | undefined][] = [
      ['absent', { effective: future }, undefined],
      ['null', { onset: null, effective: future }, undefined],
      ['unreadable', { onset: 'garbage', effective: future }, 'garbage'],
    ];
    for (const [label, times, published] of cases) {
      const r = await run([feature('a', times)]);
      expect(r.alerts, label).toEqual([]);
      expect(r.upcoming, label).toHaveLength(1);
      // `effective` is the issue time, not the hazard start: it never appears as `onset`.
      expect(r.upcoming[0]?.onset, label).toBe(published);
    }
    const past = await run([feature('b', { effective: '2026-11-22T01:00:00-05:00' })]);
    expect(past.alerts.map((x) => x.id)).toEqual(['b']);
  });

  it('sorts by the computed start even where `onset` is absent, without writing it anywhere', async () => {
    // X has no `onset`; its `effective` (the start used) is earlier than Y's onset.
    const r = await run([
      feature('Y', { onset: '2026-11-26T00:00:00Z' }),
      feature('X', { effective: '2026-11-24T00:00:00Z' }),
    ]);
    expect(r.upcoming.map((x) => x.id)).toEqual(['X', 'Y']);
    expect(r.upcoming[0]?.onset).toBeUndefined();
  });

  it('`onset` wins over `effective` when both read', async () => {
    // Issued earlier (effective past) but the hazard begins later.
    const r = await run([
      feature('a', { onset: '2026-11-25T00:00:00Z', effective: '2026-11-21T00:00:00Z' }),
    ]);
    expect(r.alerts).toEqual([]);
    expect(r.upcoming).toHaveLength(1);
  });

  // Conscious choice, as for INMET: not knowing when an official warning starts
  // is no reason to hide it from view.
  it('fails open: with no readable start the alert stays in `alerts`', async () => {
    const r = await run([
      feature('none', {}),
      feature('junk', { onset: 'soon', effective: 'tomorrow' }),
      // An offset-less stamp is not read in the host zone; it counts as unreadable.
      feature('naive', { onset: '2026-12-25T04:00:00' }),
      feature('nulls', { onset: null, effective: null }),
    ]);
    expect(r.alerts.map((x) => x.id).sort()).toEqual(['junk', 'naive', 'none', 'nulls']);
    expect(r.upcoming).toEqual([]);
  });

  it('keeps the bbox geometry and zone-only handling for both lists', async () => {
    const bbox: Bbox = [-79, 33, -75, 37];
    const r = await run(
      [
        feature('in-now', { onset: '2026-11-22T00:00:00Z' }),
        feature('in-later', { onset: '2026-11-25T00:00:00Z' }),
        feature(
          'out-later',
          { onset: '2026-11-25T00:00:00Z' },
          {
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-100, 30],
                  [-99, 30],
                  [-99, 31],
                  [-100, 31],
                  [-100, 30],
                ],
              ],
            },
          },
        ),
        feature('zone-later', { onset: '2026-11-25T00:00:00Z' }, { geometry: null }),
      ],
      NOW,
      { bbox },
    );
    expect(r.alerts.map((x) => x.id)).toEqual(['in-now']);
    expect(r.upcoming.map((x) => x.id)).toEqual(['in-later']);
    expect(r.coverage).toContain('sem polígono');
  });

  it('a malformed `onset`/`effective` (number, object, array) is unreadable, not a crash', async () => {
    const bad: unknown[] = [12345, { a: 1 }, ['x'], true];
    for (const v of bad) {
      const r = await run([
        feature('m', { onset: v as never, effective: v as never }),
        feature('ok', { onset: '2026-11-25T00:00:00Z' }),
      ]);
      expect(
        r.alerts.map((x) => x.id),
        String(JSON.stringify(v)),
      ).toEqual(['m']);
      expect(r.upcoming.map((x) => x.id)).toEqual(['ok']);
    }
    // And one malformed American feature does not take a good INMET result with it.
    const inmetFeed = {
      hoje: [
        {
          id: 9,
          descricao: 'Tempestade',
          severidade: 'Perigo',
          inicio: '2026-11-22 00:00',
          fim: '2026-11-22 23:59',
          encerrado: false,
          poligono: JSON.stringify(SQUARE),
        },
      ],
      futuro: [],
    };
    const r = await at(NOW, () =>
      getAlerts(clientFor([feature('m', { onset: 12345 as never })], inmetFeed), {
        bbox: [-80, -27, -53, 36],
      }),
    );
    expect(r.alerts.map((x) => x.id).sort()).toEqual(['inmet:9', 'm']);
  });

  it('applies the severity filter to NWS `upcoming`', async () => {
    const feats = [
      feature('s', { onset: '2026-11-25T00:00:00Z' }, { severity: 'Severe' }),
      feature('m', { onset: '2026-11-26T00:00:00Z' }, { severity: 'Minor' }),
    ];
    const r = await at(NOW, () => getAlerts(clientFor(feats), { ...POINT, severity: ['Severe'] }));
    expect(r.upcoming.map((x) => x.id)).toEqual(['s']);
  });

  it('sorts a mixed NWS/INMET `upcoming` by true start instant', async () => {
    const square = (id: number, inicio: string) => ({
      id,
      descricao: 'Tempestade',
      severidade: 'Perigo',
      inicio,
      fim: '2026-11-30 23:59',
      encerrado: false,
      poligono: JSON.stringify(SQUARE),
    });
    // True instants (UTC), now = 22 Nov 12:00Z:
    //   E  nws   2026-11-22T20:00-05:00 -> 23 Nov 01:00Z
    //   A  inmet 2026-11-23 05:00 (Brasília) -> 23 Nov 08:00Z
    //   B  nws   2026-11-23T04:00-05:00 -> 23 Nov 09:00Z
    //   C  inmet 2026-11-23 07:00 (Brasília) -> 23 Nov 10:00Z
    //   D  nws   2026-11-23T06:00-05:00 -> 23 Nov 11:00Z
    const feats = [
      feature('D', { onset: '2026-11-23T06:00:00-05:00' }),
      feature('B', { onset: '2026-11-23T04:00:00-05:00' }),
      feature('E', { onset: '2026-11-22T20:00:00-05:00' }),
    ];
    const inmetFeed = {
      hoje: [],
      futuro: [square(3, '2026-11-23 07:00'), square(1, '2026-11-23 05:00')],
    };
    const r = await at(NOW, () =>
      getAlerts(clientFor(feats, inmetFeed), { bbox: [-80, -27, -53, 36] }),
    );
    expect(r.upcoming.map((x) => x.id)).toEqual(['E', 'inmet:1', 'B', 'inmet:3', 'D']);
    expect(r.alerts).toEqual([]);
  });

  it('parseNwsInstant accepts only an explicit offset', () => {
    for (const v of [12345, {}, [], true, Symbol('x')]) expect(parseNwsInstant(v)).toBeNull();
    expect(parseNwsInstant('2026-11-23T04:00:00-05:00')).toBe(Date.UTC(2026, 10, 23, 9));
    expect(parseNwsInstant('2026-11-23T09:00:00Z')).toBe(Date.UTC(2026, 10, 23, 9));
    expect(parseNwsInstant('2026-11-23T09:00:00.5+00:00')).toBe(
      Date.UTC(2026, 10, 23, 9, 0, 0, 500),
    );
    expect(parseNwsInstant('2026-11-23T09:00:00')).toBeNull();
    expect(parseNwsInstant('2026-11-23 09:00')).toBeNull();
    expect(parseNwsInstant('')).toBeNull();
    expect(parseNwsInstant(null)).toBeNull();
    expect(parseNwsInstant(undefined)).toBeNull();
  });
});
