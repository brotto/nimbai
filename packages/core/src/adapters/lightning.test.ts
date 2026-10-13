import { describe, expect, it } from 'vitest';
import { HttpClient, assertAllowed } from '../http.js';
import { ImageRefSchema } from '../types.js';
import { getLightning } from './lightning.js';

const okFetch: typeof fetch = async () =>
  new Response('x', { status: 200, headers: { 'content-type': 'image/jpeg' } });
const urls: string[] = [];
const recording: typeof fetch = async (input) => {
  urls.push(String(input));
  return okFetch(input);
};
const down: typeof fetch = async () => new Response('nope', { status: 404 });
const mk = (f: typeof fetch) => new HttpClient({ userAgent: 'test', fetch: f });

describe('getLightning', () => {
  it('South America: GLM FED image from the SSA sector with caveat, legend and attribution', async () => {
    urls.length = 0;
    const r = await getLightning(mk(recording), { lat: -25.55, lon: -54.58 });
    expect(r.image).not.toBeNull();
    expect(r.image?.url).toBe(
      'https://cdn.star.nesdis.noaa.gov/GOES19/GLM/SECTOR/ssa/EXTENT3/latest.jpg',
    );
    expect(ImageRefSchema.safeParse(r.image).success).toBe(true);
    expect(r.image?.legend).toBeTruthy();
    expect(r.image?.attribution.source).toBe('noaa-star');
    expect(r.image).not.toHaveProperty('validTime');
    // only the small thumbnail is probed, never the original
    expect(urls).toEqual([
      'https://cdn.star.nesdis.noaa.gov/GOES19/GLM/SECTOR/ssa/EXTENT3/900x540.jpg',
    ]);
    expect(() => assertAllowed(r.image?.url ?? '')).not.toThrow();
  });

  it('caveat says optical, gridded, not cloud-to-ground, not for life or equipment protection', async () => {
    const r = await getLightning(mk(okFetch), { lat: 35.47, lon: -97.5 });
    expect(r.caveat).toMatch(/optical/i);
    expect(r.caveat).toMatch(/aggregated onto a grid/i);
    expect(r.caveat).toMatch(/NOT individual cloud-to-ground/);
    expect(r.caveat).toMatch(/NOT be used for the protection of life or equipment/);
  });

  it('image is null and gaps explain it when the source does not respond', async () => {
    const r = await getLightning(mk(down), { lat: -25.55, lon: -54.58 });
    expect(r.image).toBeNull();
    expect(r.gaps.join(' ')).toMatch(/did not respond/);
    expect(r.caveat.length).toBeGreaterThan(0);
  });

  it('image is null for a network error too', async () => {
    const boom: typeof fetch = async () => {
      throw new Error('socket hang up');
    };
    const r = await getLightning(new HttpClient({ userAgent: 'test', fetch: boom }), {
      lat: 35.47,
      lon: -97.5,
    });
    expect(r.image).toBeNull();
  });

  it('Europe: null image, honest coverage, and no network call', async () => {
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      return okFetch('' as never);
    };
    const r = await getLightning(mk(spy), { lat: 48.85, lon: 2.35 });
    expect(r.image).toBeNull();
    expect(r.coverage).toMatch(/outside/i);
    expect(called).toBe(false);
  });

  it('never exposes counts, distances or trends', async () => {
    const r = await getLightning(mk(okFetch), { lat: 35.47, lon: -97.5, minutes: 30 });
    expect(Object.keys(r).sort()).toEqual(['caveat', 'coverage', 'gaps', 'image']);
    expect(r.gaps.join(' ')).toMatch(/no flash counts/);
    expect(r.gaps.join(' ')).toMatch(/30 minutes was not applied/);
  });
});
