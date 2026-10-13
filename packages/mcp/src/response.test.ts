import { describe, expect, it } from 'vitest';
import { ok } from './response.js';

const attribution = {
  source: 'nws',
  text: 'Source: NOAA/NWS',
  license: 'public domain',
};

describe('ok() text mirror', () => {
  it('keeps the attribution and the safety notice even when the body is huge', () => {
    const big = { blob: 'x'.repeat(200_000) };
    const result = ok({
      summary: 'Summary line.',
      data: big,
      attributions: [attribution],
      safetyNotice: true,
    });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('Source: NOAA/NWS');
    expect(text).toContain('Not for protection of life or property');
    expect(text).toContain('body truncated');
    expect(text.length).toBeLessThanOrEqual(60_000);
    // The structured result is never truncated.
    expect((result.structuredContent as typeof big).blob.length).toBe(200_000);
  });

  it('survives a summary long enough to exhaust the budget on its own', () => {
    const result = ok({
      summary: 'y'.repeat(70_000),
      data: { a: 1 },
      attributions: [attribution],
      safetyNotice: true,
    });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('Source: NOAA/NWS');
    expect(text).toContain('Not for protection of life or property');
  });

  it('deduplicates attributions by source', () => {
    const result = ok({
      summary: 's',
      data: {},
      attributions: [attribution, { ...attribution, text: 'duplicate' }],
    });
    expect((result.structuredContent as { attribution: unknown[] }).attribution).toHaveLength(1);
  });
});
