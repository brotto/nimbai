import { describe, expect, it } from 'vitest';
import { HttpClient, assertAllowed } from '../http.js';
import { ImageRefSchema } from '../types.js';
import { MAX_LOOP_FRAMES, expandTimeDomain, getImageryLoop } from './loop.js';

const NOW = Date.parse('2026-10-13T06:12:00Z');

function domainXml(domain: string): string {
  return `<Domains><DimensionDomain><Domain>${domain}</Domain><Size>1</Size></DimensionDomain></Domains>`;
}
const requested: string[] = [];
function gibsFetch(domain: string): typeof fetch {
  return async (input) => {
    requested.push(String(input));
    return new Response(domainXml(domain), {
      status: 200,
      headers: { 'content-type': 'text/xml' },
    });
  };
}
const mk = (f: typeof fetch) => new HttpClient({ userAgent: 'test', fetch: f });

describe('expandTimeDomain', () => {
  it('expands comma-separated ranges ascending without duplicates', () => {
    const t = expandTimeDomain(
      '2026-10-12T20:00:00Z/2026-10-12T20:20:00Z/PT10M,2026-10-12T18:00:00Z/2026-10-12T18:10:00Z/PT10M,2026-10-12T18:10:00Z',
    );
    expect(t.map((x) => new Date(x).toISOString())).toEqual([
      '2026-10-12T18:00:00.000Z',
      '2026-10-12T18:10:00.000Z',
      '2026-10-12T20:00:00.000Z',
      '2026-10-12T20:10:00.000Z',
      '2026-10-12T20:20:00.000Z',
    ]);
  });
  it('accepts date-only starts', () => {
    expect(expandTimeDomain('2026-10-13/2026-10-13T00:20:00Z/PT10M')).toHaveLength(3);
  });
  it('ignores garbage', () => {
    expect(expandTimeDomain('nonsense')).toEqual([]);
  });
});

describe('getImageryLoop satellite', () => {
  const domain =
    '2026-10-12T18:00:00Z/2026-10-12T19:20:00Z/PT10M,2026-10-12T20:00:00Z/2026-10-13T05:50:00Z/PT10M';

  it('caps at 24 frames and returns them oldest first, with real GIBS times', async () => {
    const r = await getImageryLoop(
      mk(gibsFetch(domain)),
      { layer: 'satellite', lat: -25.55, lon: -54.58, frames: 500 },
      { now: () => NOW },
    );
    expect(r.frames).toHaveLength(MAX_LOOP_FRAMES);
    const times = r.frames.map((f) => f.validTime ?? '');
    expect(times.every((t) => t !== '')).toBe(true);
    expect([...times].sort()).toEqual(times);
    expect(new Set(times).size).toBe(24);
    expect(times[23]).toBe('2026-10-13T05:50:00Z');
    expect(times[0]).toBe('2026-10-13T02:00:00Z');
  });

  it('honours a smaller frame count and defaults to 12', async () => {
    const f3 = await getImageryLoop(
      mk(gibsFetch(domain)),
      { layer: 'satellite', lat: 10, lon: -60, frames: 3 },
      { now: () => NOW },
    );
    expect(f3.frames).toHaveLength(3);
    const def = await getImageryLoop(
      mk(gibsFetch(domain)),
      { layer: 'satellite', lat: 10, lon: -60 },
      { now: () => NOW },
    );
    expect(def.frames).toHaveLength(12);
    const one = await getImageryLoop(
      mk(gibsFetch(domain)),
      { layer: 'satellite', lat: 10, lon: -60, frames: 0 },
      { now: () => NOW },
    );
    expect(one.frames).toHaveLength(1);
  });

  it('every frame has layer, attribution, legend, valid schema and an allowed URL', async () => {
    const r = await getImageryLoop(
      mk(gibsFetch(domain)),
      { layer: 'satellite', bbox: [-60, -35, -45, -20], frames: 4 },
      { now: () => NOW },
    );
    for (const f of r.frames) {
      expect(ImageRefSchema.safeParse(f).success).toBe(true);
      expect(f.layer).toBeTruthy();
      expect(f.legend?.length).toBeGreaterThan(20);
      expect(f.attribution.source).toBe('gibs');
      expect(() => assertAllowed(f.url)).not.toThrow();
      expect(new URL(f.url).searchParams.get('TIME')).toBe(f.validTime);
      expect(new URL(f.url).searchParams.get('BBOX')).toBe('-60,-35,-45,-20');
    }
  });

  it('asks GIBS for the time domain on its own origin', async () => {
    requested.length = 0;
    await getImageryLoop(
      mk(gibsFetch(domain)),
      { layer: 'satellite', lat: 10, lon: -60 },
      { now: () => NOW },
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatch(
      /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg4326\/best\/1\.0\.0\/GOES-East_ABI_Band13_Clean_Infrared\/default\/2km\/all\//,
    );
  });

  it('uses Himawari for East Asia', async () => {
    requested.length = 0;
    const r = await getImageryLoop(
      mk(gibsFetch(domain)),
      { layer: 'satellite', lat: 35.7, lon: 139.7, frames: 2 },
      { now: () => NOW },
    );
    expect(requested[0]).toContain('Himawari_AHI_Band13_Clean_Infrared');
    expect(r.frames[0]?.layer).toContain('Himawari');
  });

  it('refuses Europe instead of faking a loop', async () => {
    await expect(
      getImageryLoop(
        mk(gibsFetch(domain)),
        { layer: 'satellite', lat: 48.85, lon: 2.35 },
        { now: () => NOW },
      ),
    ).rejects.toThrow(/No geostationary/);
  });

  it('errors when GIBS lists no frames', async () => {
    await expect(
      getImageryLoop(
        mk(gibsFetch('')),
        { layer: 'satellite', lat: 10, lon: -60 },
        { now: () => NOW },
      ),
    ).rejects.toThrow(/no recent frames|no time domain/);
  });

  it('drops frames in the future relative to now', async () => {
    const r = await getImageryLoop(
      mk(gibsFetch('2026-10-13T05:00:00Z/2026-10-13T09:00:00Z/PT10M')),
      { layer: 'satellite', lat: 10, lon: -60, frames: 24 },
      { now: () => NOW },
    );
    expect(r.frames.at(-1)?.validTime).toBe('2026-10-13T06:10:00Z');
  });
});

describe('getImageryLoop radar', () => {
  const never = mk(async () => {
    throw new Error('radar loop must not use the network');
  });
  it('returns at most 10 RIDGE frames oldest first', async () => {
    const r = await getImageryLoop(never, { layer: 'radar', lat: 32.78, lon: -96.8, frames: 24 });
    expect(r.frames).toHaveLength(10);
    expect(r.frames[0]?.url).toMatch(/KFWS_9\.gif$/);
    expect(r.frames[9]?.url).toMatch(/KFWS_0\.gif$/);
    for (const f of r.frames) {
      expect(f.legend).toBeTruthy();
      expect(f.attribution.source).toBe('nws-radar');
      expect(f).not.toHaveProperty('validTime');
      expect(() => assertAllowed(f.url)).not.toThrow();
    }
    expect(r.coverage).toMatch(/10 newest/);
  });
  it('throws outside US radar coverage', async () => {
    await expect(
      getImageryLoop(never, { layer: 'radar', lat: -25.55, lon: -54.58 }),
    ).rejects.toThrow(/No US radar coverage/);
  });
});
