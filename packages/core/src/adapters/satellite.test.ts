import { describe, expect, it } from 'vitest';
import { HttpClient, assertAllowed } from '../http.js';
import { ImageRefSchema } from '../types.js';
import { getSatelliteLatest, selectGoesSector, resolveAoi, GOES_SECTORS } from './satellite.js';

const noNetwork: typeof fetch = () => {
  throw new Error('satellite adapter must not use the network');
};
const http = new HttpClient({ userAgent: 'test', fetch: noNetwork });

describe('selectGoesSector', () => {
  it('maps Foz do Iguacu (South America) to the SSA sector', () => {
    expect(selectGoesSector(resolveAoi({ lat: -25.55, lon: -54.58 }))?.id).toBe('ssa');
  });
  it('maps Manaus to the NSA sector', () => {
    expect(selectGoesSector(resolveAoi({ lat: -3.1, lon: -60.0 }))?.id).toBe('nsa');
  });
  it('maps Oklahoma City to CONUS', () => {
    expect(selectGoesSector(resolveAoi({ lat: 35.47, lon: -97.5 }))?.id).toBe('conus');
  });
  it('returns nothing for Paris (outside GOES-East useful view)', () => {
    expect(selectGoesSector(resolveAoi({ lat: 48.85, lon: 2.35 }))).toBeUndefined();
  });
  it('uses the bbox: a box spanning two sectors gets a sector that contains all of it', () => {
    const s = selectGoesSector(resolveAoi({ bbox: [-60, -35, -45, -20] }));
    expect(s?.id).toBe('ssa');
  });
  it('has unique ids', () => {
    expect(new Set(GOES_SECTORS.map((s) => s.id)).size).toBe(GOES_SECTORS.length);
  });
});

describe('getSatelliteLatest', () => {
  it('South America: STAR SSA GeoColor with thumbnail, attribution and legend', async () => {
    const r = await getSatelliteLatest(http, { lat: -25.55, lon: -54.58 });
    expect(r.image.url).toBe(
      'https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/ssa/GEOCOLOR/latest.jpg',
    );
    expect(r.image.thumbnailUrl).toBe(
      'https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/ssa/GEOCOLOR/900x540.jpg',
    );
    expect(r.satellite).toContain('GOES-19');
    expect(ImageRefSchema.safeParse(r.image).success).toBe(true);
    expect(r.image.legend?.length).toBeGreaterThan(20);
    expect(r.image.attribution.source).toBe('noaa-star');
  });

  it('does not invent validTime', async () => {
    const r = await getSatelliteLatest(http, { lat: 35.47, lon: -97.5, product: 'ir' });
    expect(r.image).not.toHaveProperty('validTime');
    expect(r.image.sourceLatencyMin).toBeGreaterThan(0);
    expect(r.image.url).toBe('https://cdn.star.nesdis.noaa.gov/GOES19/ABI/CONUS/13/latest.jpg');
  });

  it('maps products to STAR band codes', async () => {
    const wv = await getSatelliteLatest(http, { lat: -25.55, lon: -54.58, product: 'wv' });
    expect(wv.image.url).toContain('/ssa/09/latest.jpg');
    const vis = await getSatelliteLatest(http, { lat: -25.55, lon: -54.58, product: 'visible' });
    expect(vis.image.url).toContain('/ssa/02/latest.jpg');
  });

  it('CONUS visible avoids the missing latest.jpg and uses the 5000x3000 file', async () => {
    const r = await getSatelliteLatest(http, { lat: 35.47, lon: -97.5, product: 'visible' });
    expect(r.image.url).toBe('https://cdn.star.nesdis.noaa.gov/GOES19/ABI/CONUS/02/5000x3000.jpg');
  });

  it('Canada non-GeoColor bands avoid the missing latest.jpg', async () => {
    const r = await getSatelliteLatest(http, { lat: 55, lon: -100, product: 'ir' });
    expect(r.image.url).toBe(
      'https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/can/13/4500x2250.jpg',
    );
    expect(r.image.thumbnailUrl).toBe(
      'https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/can/13/560x280.jpg',
    );
  });

  it('Europe: no STAR image, falls back to a labelled polar-orbit GIBS composite', async () => {
    const r = await getSatelliteLatest(http, { lat: 48.85, lon: 2.35 });
    expect(r.image.url.startsWith('https://gibs.earthdata.nasa.gov/')).toBe(true);
    expect(r.image.layer).toContain('VIIRS');
    expect(r.coverage).toMatch(/NOT a real-time/);
    expect(r.image.attribution.source).toBe('gibs');
    expect(r.image.legend).toBeTruthy();
  });

  it('Europe water vapour is refused rather than faked', async () => {
    await expect(
      getSatelliteLatest(http, { lat: 48.85, lon: 2.35, product: 'wv' }),
    ).rejects.toThrow(/water-vapour/);
  });

  it('Japan uses Himawari via GIBS', async () => {
    const r = await getSatelliteLatest(http, { lat: 35.7, lon: 139.7, product: 'ir' });
    expect(r.satellite).toBe('Himawari-9');
    expect(new URL(r.image.url).searchParams.get('LAYERS')).toBe(
      'Himawari_AHI_Band13_Clean_Infrared',
    );
  });

  it('Hawaii uses GOES-West via GIBS', async () => {
    const r = await getSatelliteLatest(http, { lat: 21.3, lon: -157.8 });
    expect(new URL(r.image.url).searchParams.get('LAYERS')).toBe('GOES-West_ABI_GeoColor');
  });

  it('every generated URL is inside the source catalogue', async () => {
    const cases = [
      { lat: -25.55, lon: -54.58 },
      { lat: 35.47, lon: -97.5, product: 'visible' as const },
      { lat: 48.85, lon: 2.35 },
      { lat: 35.7, lon: 139.7 },
      { lat: 21.3, lon: -157.8, product: 'ir' as const },
    ];
    for (const c of cases) {
      const r = await getSatelliteLatest(http, c);
      expect(() => assertAllowed(r.image.url)).not.toThrow();
      if (r.image.thumbnailUrl !== undefined)
        expect(() => assertAllowed(r.image.thumbnailUrl as string)).not.toThrow();
    }
  });

  it('rejects missing or invalid input', async () => {
    await expect(getSatelliteLatest(http, {})).rejects.toThrow();
    await expect(getSatelliteLatest(http, { lat: 100, lon: 0 })).rejects.toThrow();
    await expect(getSatelliteLatest(http, { bbox: [10, 10, 5, 20] })).rejects.toThrow();
  });
});
