import { describe, expect, it } from 'vitest';
import { HttpClient, assertAllowed } from '../http.js';
import { ImageRefSchema } from '../types.js';
import { MAX_LOOP_FRAMES, expandTimeDomain, getImageryLoop, probeBbox } from './loop.js';
import { pngFromFilteredRows, solidPng } from './__fixtures__/png-builder.js';

const NOW = Date.parse('2026-10-13T06:12:00Z');

function domainXml(domain: string): string {
  return `<Domains><DimensionDomain><Domain>${domain}</Domain><Size>1</Size></DimensionDomain></Domains>`;
}
const requested: string[] = [];
/** Query params of every WMS probe the stub saw; asserted on AFTER the call, never inside the stub. */
const probeQueries: URLSearchParams[] = [];
/** Set when the stub's request signal fired (the probe aborted the stalled body). */
let sawAbort = false;
/**
 * How the stub answers a WMS probe for a given TIME. Default: a real (opaque) image.
 * fail: 404. xml-error: HTTP 200 carrying a WMS ServiceException. bad-png: a PNG the decoder
 * refuses (RGB). wrong-size: a valid RGBA PNG that is not the 16x16 asked for. hang: headers, then a
 * body that never finishes.
 */
type ProbeBehaviour =
  'real' | 'blank' | 'fail' | 'xml-error' | 'bad-png' | 'wrong-size' | 'hang' | 'hang-deaf';
function gibsFetch(
  domain: string,
  probe: (time: string, bboxWidthDeg: number) => ProbeBehaviour = () => 'real',
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/wms/')) {
      const q = new URL(url).searchParams;
      probeQueries.push(q);
      const [w = 0, , e = 0] = (q.get('BBOX') ?? '').split(',').map(Number);
      const b = probe(q.get('TIME') ?? '', e - w);
      if (b === 'fail') return new Response('nope', { status: 404 });
      if (b === 'xml-error') {
        return new Response(
          '<?xml version="1.0"?><ServiceExceptionReport><ServiceException code="InvalidDimensionValue">bad time</ServiceException></ServiceExceptionReport>',
          { status: 200, headers: { 'content-type': 'text/xml' } },
        );
      }
      if (b === 'bad-png') {
        const rgb = pngFromFilteredRows(16, 16, [Buffer.alloc(1 + 16 * 3)], { colourType: 2 });
        return new Response(new Uint8Array(rgb), { status: 200 });
      }
      if (b === 'wrong-size') {
        return new Response(new Uint8Array(solidPng(8, 8, [90, 90, 90, 255])), { status: 200 });
      }
      if (b === 'hang' || b === 'hang-deaf') {
        // Headers arrive; the body never does. Aborting the request signal errors the stream.
        let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({ start: (c) => (ctl = c) });
        // hang-deaf ignores the signal, like a fetch that does not honour abort: only the race saves us.
        if (b === 'hang') {
          init?.signal?.addEventListener('abort', () => {
            sawAbort = true;
            ctl?.error(new Error('aborted'));
          });
        }
        return new Response(body, { status: 200 });
      }
      const rgba: [number, number, number, number] =
        b === 'blank' ? [0, 0, 0, 0] : [90, 90, 90, 255];
      return new Response(new Uint8Array(solidPng(16, 16, rgba)), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
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
    const wmts = requested.filter((u) => u.includes('/wmts/'));
    expect(wmts).toHaveLength(1);
    expect(wmts[0]).toMatch(
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
    expect(requested.every((u) => u.includes('Himawari'))).toBe(true);
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

describe('getImageryLoop satellite frame probing', () => {
  // 10-minute steps ending 06:10Z (the last one <= NOW).
  const domain = '2026-10-13T03:00:00Z/2026-10-13T09:00:00Z/PT10M';
  const T = (hhmm: string): string => `2026-10-13T${hhmm}:00Z`;
  const run = (probe: (t: string, bboxWidthDeg: number) => ProbeBehaviour, frames = 4) =>
    getImageryLoop(
      mk(gibsFetch(domain, probe)),
      { layer: 'satellite', lat: 10, lon: -60, frames },
      { now: () => NOW },
    );

  it('asks for a 16x16 PNG on every probe', async () => {
    probeQueries.length = 0;
    await run(() => 'real');
    expect(probeQueries).toHaveLength(10);
    for (const q of probeQueries) {
      expect(q.get('FORMAT')).toBe('image/png');
      expect(q.get('WIDTH')).toBe('16');
      expect(q.get('HEIGHT')).toBe('16');
    }
  });

  it('replaces a blank newest frame with an older real one and keeps the requested count', async () => {
    const r = await run((t) => (t === T('06:10') || t === T('06:00') ? 'blank' : 'real'));
    expect(r.frames.map((f) => f.validTime)).toEqual([
      T('05:20'),
      T('05:30'),
      T('05:40'),
      T('05:50'),
    ]);
    expect(r.coverage).toMatch(
      /2 dropped, newer than the oldest returned frame, for having no imagery yet/,
    );
    expect(r.coverage).toMatch(/newest 2026-10-13T05:50:00Z/);
    expect(r.coverage).not.toMatch(/missing scan/);
  });

  it('drops a blank frame in the middle of the loop', async () => {
    const r = await run((t) => (t === T('05:40') ? 'blank' : 'real'));
    expect(r.frames.map((f) => f.validTime)).toEqual([
      T('05:30'),
      T('05:50'),
      T('06:00'),
      T('06:10'),
    ]);
    expect(r.coverage).toMatch(/1 dropped, newer than the oldest returned frame/);
  });

  it('does not count blank candidates older than the returned window as drops', async () => {
    // 10 candidates (04:40..06:10), 4 requested: the loop is 05:40..06:10. The blanks at 04:40 and
    // 05:00 are older than the loop and never changed it, so they must not read as "dropped".
    const r = await run((t) => (t === T('04:40') || t === T('05:00') ? 'blank' : 'real'));
    expect(r.frames.map((f) => f.validTime)).toEqual([
      T('05:40'),
      T('05:50'),
      T('06:00'),
      T('06:10'),
    ]);
    expect(r.coverage).toMatch(/and 0 dropped, newer than the oldest returned frame/);
    expect(r.coverage).not.toMatch(/\(blank\/black/);
    expect(r.coverage).toMatch(
      /2 further blank candidate\(s\) were older than the oldest returned frame/,
    );
  });

  it('splits blanks inside and outside the returned window', async () => {
    const r = await run((t) => (t === T('04:40') || t === T('05:50') ? 'blank' : 'real'));
    expect(r.frames.map((f) => f.validTime)).toEqual([
      T('05:30'),
      T('05:40'),
      T('06:00'),
      T('06:10'),
    ]);
    expect(r.coverage).toMatch(/and 1 dropped, newer than the oldest returned frame/);
    expect(r.coverage).toMatch(/1 further blank candidate\(s\) were older/);
  });

  it('keeps a frame whose probe failed and says so in coverage', async () => {
    const r = await run((t) => (t === T('06:10') ? 'fail' : 'real'));
    expect(r.frames.at(-1)?.validTime).toBe(T('06:10'));
    expect(r.frames).toHaveLength(4);
    expect(r.coverage).toMatch(/and 0 dropped/);
    expect(r.coverage).toMatch(/1 of the 4 returned frame\(s\) could not be checked/);
    expect(r.coverage).toMatch(/are kept in the loop/);
  });

  it('keeps and counts a frame whose probe could not be read, whatever the failure', async () => {
    // Each of these must be "unknown": the frame stays, nothing is dropped, and coverage says so.
    for (const mode of ['xml-error', 'bad-png', 'wrong-size'] as const) {
      const r = await run((t) => (t === T('06:10') ? mode : 'real'));
      expect(r.frames.at(-1)?.validTime, mode).toBe(T('06:10'));
      expect(r.frames, mode).toHaveLength(4);
      expect(r.coverage, mode).toMatch(/and 0 dropped/);
      expect(r.coverage, mode).toMatch(/1 of the 4 returned frame\(s\) could not be checked/);
    }
  });

  it('a hanging probe body times out as unknown (frame kept), without hanging the loop', async () => {
    for (const mode of ['hang', 'hang-deaf'] as const) {
      sawAbort = false;
      const started = Date.now();
      const r = await getImageryLoop(
        mk(gibsFetch(domain, (t) => (t === T('06:10') ? mode : 'real'))),
        { layer: 'satellite', lat: 10, lon: -60, frames: 4 },
        { now: () => NOW, probeBodyTimeoutMs: 50 },
      );
      expect(Date.now() - started, mode).toBeLessThan(3000);
      // The stalled request is aborted, not just abandoned (a real fetch honours the signal).
      expect(sawAbort, mode).toBe(mode === 'hang');
      expect(r.frames.at(-1)?.validTime, mode).toBe(T('06:10'));
      expect(r.frames, mode).toHaveLength(4);
      expect(r.coverage, mode).toMatch(/and 0 dropped/);
      expect(r.coverage, mode).toMatch(/1 of the 4 returned frame\(s\) could not be checked/);
    }
  });

  it('never claims a kept frame is guaranteed, even when every probe succeeded', async () => {
    const r = await run(() => 'real');
    expect(r.coverage).not.toMatch(/verified/);
    // GIBS renders an extent progressively and the same URL can flip, so the
    // probe is a sample taken at call time, never a promise about the fetch.
    expect(r.coverage).toContain('not guaranteed to have imagery when YOU fetch it');
    expect(r.coverage).toContain('never as clear sky');
    expect(r.coverage).toMatch(/10 advertised time\(s\) were checked/);
  });

  it('probes at the served resolution: a frame with only the coarse level rendered is dropped', async () => {
    // lat 10, lon -60 -> 10-degree box. Served 768 px = 0.013 deg/px; a 16 px probe over the whole
    // box (0.625 deg/px) would hit the coarse pyramid level, which GIBS renders first.
    const coarseOnly = (t: string, bboxWidthDeg: number): ProbeBehaviour =>
      t === T('06:10') ? (bboxWidthDeg > 5 ? 'real' : 'blank') : 'real';
    const r = await run(coarseOnly);
    expect(r.frames.map((f) => f.validTime)).toEqual([
      T('05:30'),
      T('05:40'),
      T('05:50'),
      T('06:00'),
    ]);
    expect(r.coverage).toMatch(/1 dropped, newer than the oldest returned frame/);
    expect(r.coverage).not.toMatch(/verified/);
    // GIBS renders an extent progressively and the same URL can flip, so the
    // probe is a sample taken at call time, never a promise about the fetch.
    expect(r.coverage).toContain('not guaranteed to have imagery when YOU fetch it');
    expect(r.coverage).toContain('never as clear sky');
  });

  it('errors, rather than returning blank frames, when nothing has imagery', async () => {
    await expect(run(() => 'blank')).rejects.toThrow(/none has imagery rendered yet/);
  });

  it('is honest when fewer real frames exist than requested', async () => {
    const r = await run((t) => (t < T('05:50') ? 'blank' : 'real'), 24);
    expect(r.frames.map((f) => f.validTime)).toEqual([T('05:50'), T('06:00'), T('06:10')]);
    expect(r.coverage).toMatch(/Fewer than the 24 requested/);
  });

  it('bounds the probes to count + margin and never probes the radar path', async () => {
    requested.length = 0;
    await run(() => 'real', 4);
    expect(requested.filter((u) => u.includes('/wms/'))).toHaveLength(10);
    requested.length = 0;
    const never = mk(async (i) => {
      requested.push(String(i));
      throw new Error('radar loop must not use the network');
    });
    await getImageryLoop(never, { layer: 'radar', lat: 32.78, lon: -96.8 });
    expect(requested).toHaveLength(0);
  });
});

describe('probeBbox', () => {
  const dpp = (b: number[], px: number): number => ((b[2] as number) - (b[0] as number)) / px;
  it('covers 16 served pixels, centred on the AOI, inside the AOI', () => {
    const bbox: [number, number, number, number] = [-65, 5, -55, 15];
    const p = probeBbox(bbox, 768);
    expect(dpp(p, 16)).toBeCloseTo(10 / 768, 10);
    expect(((p[1] as number) + (p[3] as number)) / 2).toBeCloseTo(10, 10);
    expect(((p[0] as number) + (p[2] as number)) / 2).toBeCloseTo(-60, 10);
    expect(p[0]).toBeGreaterThan(-65);
    expect(p[2]).toBeLessThan(-55);
  });
  it('follows the served width', () => {
    const bbox: [number, number, number, number] = [-65, 5, -55, 15];
    expect(dpp(probeBbox(bbox, 384), 16)).toBeCloseTo(10 / 384, 10);
  });
  it('stays valid for tiny, very wide and polar boxes', () => {
    for (const bbox of [
      [10, 10, 10.001, 10.001],
      [-180, -60, 180, 60],
      [-20, 80, 20, 90],
      [-1, -90, 1, -89],
    ] as [number, number, number, number][]) {
      const p = probeBbox(bbox, 768);
      expect(p.every(Number.isFinite)).toBe(true);
      expect(p[0]).toBeLessThan(p[2]);
      expect(p[1]).toBeLessThan(p[3]);
      expect(p[0]).toBeGreaterThanOrEqual(bbox[0]);
      expect(p[2]).toBeLessThanOrEqual(bbox[2]);
      expect(p[1]).toBeGreaterThanOrEqual(bbox[1]);
      expect(p[3]).toBeLessThanOrEqual(bbox[3]);
    }
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
