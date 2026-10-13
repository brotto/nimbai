import { describe, expect, it } from 'vitest';
import { HttpClient, assertAllowed } from '../http.js';
import { ImageRefSchema } from '../types.js';
import { RADAR_SITES, getRadarLatest, radarFrames, selectRadarTarget } from './radar.js';
import { resolveAoi } from './satellite.js';

const http = new HttpClient({
  userAgent: 'test',
  fetch: () => {
    throw new Error('radar adapter must not use the network');
  },
});

describe('getRadarLatest', () => {
  it('Dallas: site image from KFWS with sites in range, legend and attribution', async () => {
    const r = await getRadarLatest(http, { lat: 32.78, lon: -96.8 });
    expect(r.image.url).toBe('https://radar.weather.gov/ridge/standard/KFWS_0.gif');
    expect(r.sites[0]?.id).toBe('KFWS');
    expect(r.sites[0]?.rangeKm).toBe(230);
    expect(ImageRefSchema.safeParse(r.image).success).toBe(true);
    expect(r.image.legend).toMatch(/dBZ/);
    expect(r.image.attribution.source).toBe('nws-radar');
    expect(r.image).not.toHaveProperty('validTime');
    expect(() => assertAllowed(r.image.url)).not.toThrow();
  });

  // Regression guard: with a curated subset of the network these points were
  // ~950 km from the nearest listed station and came back "no US radar
  // coverage", although Sitka's own PACG is minutes away.
  it('Sitka gets its own station image', async () => {
    const r = await getRadarLatest(http, { lat: 57.05, lon: -135.33 });
    expect(r.sites[0]?.id).toBe('PACG');
    expect(r.image.url).toContain('PACG');
  });

  it('Juneau is in PACG range but beyond its image crop, so it gets the mosaic — and is not reported as uncovered', async () => {
    const r = await getRadarLatest(http, { lat: 58.3, lon: -134.42 });
    expect(r.sites[0]?.id).toBe('PACG'); // 174 km: inside the 230 km detection range
    expect(r.image.url).toContain('ALASKA'); // but outside the ~150 km site crop
    expect(r.coverage).not.toMatch(/regional context/);
    expect(r.gaps.join(' ')).not.toMatch(/No WSR-88D station reaches/);
  });

  it('Honolulu is served by a Hawaii station', async () => {
    const r = await getRadarLatest(http, { lat: 21.31, lon: -157.86 });
    expect(r.sites[0]?.id).toMatch(/^PH/);
  });

  it('a point inside the mosaic box but out of every station range says so', async () => {
    // Monterrey, Mexico: inside the nominal CONUS rectangle, 291 km from the
    // nearest NEXRAD, so the mosaic must not be presented as covering it.
    const r = await getRadarLatest(http, { lat: 25.67, lon: -100.31 });
    expect(r.image.layer).toMatch(/mosaic/);
    expect(r.sites).toEqual([]);
    expect(r.coverage).toMatch(/regional context/);
    expect(r.gaps.join(' ')).toMatch(/Mexico and Canada/);
  });

  it('a large explicit bbox uses the mosaic even if a site is nearby', async () => {
    const r = await getRadarLatest(http, { bbox: [-100, 28, -92, 36] });
    expect(r.image.layer).toMatch(/mosaic/);
  });

  it('Brazil and Europe have no radar coverage: throws instead of returning a wrong image', async () => {
    await expect(getRadarLatest(http, { lat: -25.55, lon: -54.58 })).rejects.toThrow(
      /No US radar coverage/,
    );
    await expect(getRadarLatest(http, { lat: 48.85, lon: 2.35 })).rejects.toThrow(
      /No US radar coverage/,
    );
  });

  it('Puerto Rico uses TJUA', async () => {
    const r = await getRadarLatest(http, { lat: 18.4, lon: -66.1 });
    expect(r.image.url).toContain('/TJUA_0.gif');
  });

  it('site list has unique ids and plausible coordinates', () => {
    expect(new Set(RADAR_SITES.map((s) => s.id)).size).toBe(RADAR_SITES.length);
    for (const s of RADAR_SITES) {
      expect(Math.abs(s.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(s.lon)).toBeLessThanOrEqual(180);
    }
  });
});

describe('radarFrames', () => {
  it('returns at most 10 frames, oldest (_9) first, newest (_0) last', () => {
    const { target } = selectRadarTarget(resolveAoi({ lat: 32.78, lon: -96.8 }));
    const frames = radarFrames(target, 24);
    expect(frames).toHaveLength(10);
    expect(frames[0]?.url).toMatch(/KFWS_9\.gif$/);
    expect(frames[9]?.url).toMatch(/KFWS_0\.gif$/);
    expect(radarFrames(target, 3).map((f) => f.url.slice(-8))).toEqual([
      'WS_2.gif',
      'WS_1.gif',
      'WS_0.gif',
    ]);
  });
});
