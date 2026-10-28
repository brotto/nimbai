import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, SourceError, sanitizeExternalText } from '../http.js';
import type { Bbox } from '../types.js';
import { getAlerts } from './alerts.js';

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
  it('does NOT list an INMET warning that starts tomorrow as active, but counts it', async () => {
    vi.useFakeTimers();
    try {
      // 13 Oct 2026, 12:00 Brasília (UTC-3): the 14 Oct warnings have not begun.
      vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
      const { alerts, coverage } = await getAlerts(clientWith([inmet]), {
        lat: -3.12,
        lon: -60.02,
      });
      expect(alerts.map((a) => a.event)).not.toContain('Chuvas Intensas');
      expect(coverage).toContain('começam no futuro');
    } finally {
      vi.useRealTimers();
    }
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
