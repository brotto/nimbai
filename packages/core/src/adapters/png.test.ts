import { describe, expect, it } from 'vitest';
import { MAX_PIXELS, PngUnsupportedError, decodeRgbaPng, hasOpaquePixel } from './png.js';
import { pngFromFilteredRows, solidPng } from './__fixtures__/png-builder.js';

const row = (ft: number, bytes: number[]): Buffer => Buffer.from([ft, ...bytes]);
const decode = (png: Uint8Array, w: number, h: number) =>
  decodeRgbaPng(png, { width: w, height: h });
const pixels = (png: Uint8Array, w: number, h: number): number[] =>
  Array.from(decode(png, w, h).data);

// Every fixture below is written out by hand: filtered bytes AND expected pixels. Nothing here
// re-runs a predictor, so a wrong predictor or tie-break cannot round-trip its way to a pass.
describe('scanline filters (hand-computed)', () => {
  it('reverses Sub, Up and Average, including odd sums that must floor', () => {
    const png = pngFromFilteredRows(2, 3, [
      row(1, [10, 20, 30, 40, 1, 2, 3, 4]),
      row(2, [1, 1, 1, 1, 255, 0, 2, 3]),
      row(3, [0, 0, 0, 0, 2, 2, 2, 2]),
    ]);
    expect(pixels(png, 2, 3)).toEqual([
      ...[10, 20, 30, 40, 11, 22, 33, 44],
      ...[11, 21, 31, 41, 10, 22, 35, 47],
      // Average: left pixel (a=0): floor(b/2); right pixel: floor((a+b)/2), e.g. (5+10)>>1 = 7.
      ...[5, 10, 15, 20, 9, 18, 27, 35],
    ]);
  });

  it('row 0 with Up: the previous row is all zeroes, so the bytes pass through', () => {
    const png = pngFromFilteredRows(2, 1, [row(2, [9, 8, 7, 6, 5, 4, 3, 2])]);
    expect(pixels(png, 2, 1)).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it('row 0 with Average: only the left neighbour counts, halved', () => {
    const png = pngFromFilteredRows(2, 1, [row(3, [10, 20, 30, 40, 8, 8, 8, 8])]);
    // right = 8 + floor(left / 2)
    expect(pixels(png, 2, 1)).toEqual([10, 20, 30, 40, 13, 18, 23, 28]);
  });

  it('row 0 with Paeth: above and upper-left are zero, so the predictor is the left byte', () => {
    const png = pngFromFilteredRows(2, 1, [row(4, [10, 20, 30, 40, 1, 2, 3, 4])]);
    expect(pixels(png, 2, 1)).toEqual([10, 20, 30, 40, 11, 22, 33, 44]);
  });

  // Paeth, one channel per case. Row 0 (filter 0) holds c (left pixel) and b (right pixel); in row 1
  // the left pixel decodes to a, and the right pixel is  v + predictor(a, b, c)  mod 256.
  // For the left pixel of row 1 the predictor is b (a = c = 0), so its stored byte is  a - c  mod 256.
  //
  //   case  (a,  b,  c)    p   pa  pb  pc   branch                predictor
  //   1     (100,200,200)  100  0 100 100   pa smallest           a = 100
  //   2     (200,100,200)  100 100   0 100   pb smallest           b = 100
  //   3     (100,200,150)  150  50  50   0   pc smallest           c = 150
  //   4     (80, 110,100)   90  10  20  10   TIE pa == pc < pb     a = 80   (pa <= pc must win)
  //   5     (110, 80,100)   90  20  10  10   TIE pb == pc < pa     b = 80   (pb <= pc must win)
  //   6     (250, 10,  5)  255   5 245 250   pa smallest, wraps    a = 250  (20 + 250 = 270 -> 14)
  //   7     (7,    9,  3)   13   6   4  10   pb smallest           b = 9
  //   8     (30,  45, 40)   35   5  10   5   TIE pa == pc < pb     a = 30
  it('Paeth: forces each branch and both tie-breaks (cases 1-4)', () => {
    const png = pngFromFilteredRows(2, 2, [
      row(0, [200, 200, 150, 100, 200, 100, 200, 110]),
      row(4, [156, 0, 206, 236, 1, 2, 3, 4]),
    ]);
    expect(pixels(png, 2, 2)).toEqual([
      ...[200, 200, 150, 100, 200, 100, 200, 110],
      ...[100, 200, 100, 80, 101, 102, 153, 84],
    ]);
  });

  it('Paeth: second tie, byte wrap and a plain b (cases 5-8)', () => {
    const png = pngFromFilteredRows(2, 2, [
      row(0, [100, 5, 3, 40, 80, 10, 9, 45]),
      row(4, [10, 245, 4, 246, 1, 20, 3, 4]),
    ]);
    expect(pixels(png, 2, 2)).toEqual([
      ...[100, 5, 3, 40, 80, 10, 9, 45],
      ...[110, 250, 7, 30, 81, 14, 12, 34],
    ]);
  });
});

describe('decodeRgbaPng', () => {
  it('reads alpha from decoded pixels, not from the stored bytes', () => {
    // Stored bytes are all zero on row 1 (Up), but the decoded pixels repeat row 0.
    const png = pngFromFilteredRows(1, 2, [row(0, [9, 9, 9, 255]), row(2, [0, 0, 0, 0])]);
    expect(pixels(png, 1, 2)).toEqual([9, 9, 9, 255, 9, 9, 9, 255]);
    // And the reverse: stored bytes non-zero, decoded alpha all zero.
    const blank = pngFromFilteredRows(1, 2, [row(0, [0, 0, 0, 0]), row(1, [5, 5, 5, 0])]);
    expect(pixels(blank, 1, 2)).toEqual([0, 0, 0, 0, 5, 5, 5, 0]);
    expect(hasOpaquePixel(decode(blank, 1, 2))).toBe(false);
  });

  it('refuses what it cannot decode instead of guessing', () => {
    expect(() => decode(new Uint8Array([1, 2, 3]), 1, 1)).toThrow(PngUnsupportedError);
    const rgb = pngFromFilteredRows(1, 1, [row(0, [1, 2, 3])], { colourType: 2 });
    expect(() => decode(rgb, 1, 1)).toThrow(/8-bit RGBA/);
    const il = pngFromFilteredRows(1, 1, [row(0, [1, 2, 3, 4])], { interlace: 1 });
    expect(() => decode(il, 1, 1)).toThrow(/Interlaced/);
    const badFilter = pngFromFilteredRows(1, 1, [row(7, [1, 2, 3, 4])]);
    expect(() => decode(badFilter, 1, 1)).toThrow(/filter type 7/);
    const jpegLike = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
    expect(() => decode(jpegLike, 1, 1)).toThrow(/Not a PNG/);
  });

  it('refuses image data that is too short for its header (no silent zero padding)', () => {
    // Header says 2x2, only one row of data: an unchecked decoder would read the rest as zeroes
    // and report a blank image.
    const short = pngFromFilteredRows(2, 2, [row(0, [1, 2, 3, 4, 5, 6, 7, 8])]);
    expect(() => decode(short, 2, 2)).toThrow(/wrong length/);
  });

  it('refuses image data that is too long for its header', () => {
    const long = pngFromFilteredRows(1, 1, [row(0, [1, 2, 3, 4]), row(0, [5, 6, 7, 8])]);
    expect(() => decode(long, 1, 1)).toThrow(PngUnsupportedError);
  });
});

describe('size limits', () => {
  it('refuses a PNG whose size is not the one the caller asked for, before inflating', () => {
    // A probe that asked for 16x16 and got something else is "unknown", not a decode.
    const eight = solidPng(8, 8, [1, 2, 3, 255]);
    expect(() => decode(eight, 16, 16)).toThrow(/8x8 but 16x16 was requested/);
    // 4000x4000 in the header with a few bytes of data: refused on the header alone.
    const huge = pngFromFilteredRows(4000, 4000, [row(0, [0, 0, 0, 0])]);
    expect(() => decode(huge, 16, 16)).toThrow(/4000x4000 but 16x16 was requested/);
    // The right size still decodes.
    expect(decode(solidPng(16, 16, [1, 2, 3, 255]), 16, 16).width).toBe(16);
  });

  it('enforces the hard pixel ceiling even when the caller asks for a big size', () => {
    expect(MAX_PIXELS).toBeLessThanOrEqual(256 * 256);
    // A well-formed 300x300 image that matches the request but exceeds the ceiling.
    const big = solidPng(300, 300, [1, 2, 3, 255]);
    expect(() => decode(big, 300, 300)).toThrow(/Unsupported expected PNG size/);
  });

  it('rejects nonsensical expected sizes', () => {
    const one = solidPng(1, 1, [1, 2, 3, 255]);
    expect(() => decode(one, 0, 1)).toThrow(PngUnsupportedError);
    expect(() => decode(one, 1, 0)).toThrow(PngUnsupportedError);
    expect(() => decode(one, 1.5, 1)).toThrow(PngUnsupportedError);
  });

  it('refuses a decompression bomb while inflating, not after', () => {
    // 16x16 header (needs 1040 bytes) over image data that inflates to 64 MiB. Without a bound,
    // inflate allocates all 64 MiB before the length check; with it, inflate stops at 1040 bytes
    // and the error says so (the unbounded path reports "wrong length" instead).
    const bomb = pngFromFilteredRows(16, 16, [Buffer.alloc(64 * 1024 * 1024)]);
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => decode(bomb, 16, 16)).toThrow(/inflates beyond the size its header allows/);
    expect(() => decode(bomb, 16, 16)).toThrow(PngUnsupportedError);
  });
});

describe('hasOpaquePixel', () => {
  it('distinguishes solid blank from solid opaque', () => {
    expect(hasOpaquePixel(decode(solidPng(4, 4, [0, 0, 0, 0]), 4, 4))).toBe(false);
    expect(hasOpaquePixel(decode(solidPng(4, 4, [1, 2, 3, 255]), 4, 4))).toBe(true);
  });

  it('treats any non-zero alpha as imagery, not only 255', () => {
    // GIBS anti-aliases edges; a frame whose only pixels are translucent still has imagery.
    expect(hasOpaquePixel(decode(solidPng(4, 4, [0, 0, 0, 1]), 4, 4))).toBe(true);
    expect(hasOpaquePixel(decode(solidPng(4, 4, [0, 0, 0, 128]), 4, 4))).toBe(true);
  });

  it('reads the alpha byte, not the colour bytes', () => {
    // Bright colour, alpha 0: blank. Alpha only on the very last pixel: not blank.
    expect(hasOpaquePixel(decode(solidPng(4, 4, [255, 255, 255, 0]), 4, 4))).toBe(false);
    const last = pngFromFilteredRows(2, 1, [row(0, [0, 0, 0, 0, 0, 0, 0, 7])]);
    expect(hasOpaquePixel(decode(last, 2, 1))).toBe(true);
  });
});
