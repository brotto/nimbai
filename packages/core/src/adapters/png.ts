import { inflateSync } from 'node:zlib';

/**
 * Minimal PNG decoder, deliberately narrow: it handles exactly what NASA GIBS
 * returns (8-bit RGBA, colour type 6, non-interlaced) and refuses anything else
 * with a PngUnsupportedError instead of guessing. It is not a general decoder.
 */
export class PngUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngUnsupportedError';
  }
}

export interface DecodedRgba {
  width: number;
  height: number;
  /** width * height * 4 bytes, R G B A, scanline filters already reversed. */
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BPP = 4; // bytes per pixel for 8-bit RGBA
/**
 * Hard ceiling on what a caller may ask this decoder to decode. It exists for 16x16 probes;
 * 256x256 is generous for that and keeps a worst-case decode at 256 KiB.
 */
export const MAX_PIXELS = 256 * 256;

/** The dimensions the caller asked the server for. Anything else is refused, never decoded. */
export interface ExpectedSize {
  width: number;
  height: number;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverses PNG scanline filters 0-4 in place over `raw` (each row = 1 filter byte + stride). */
function unfilter(raw: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * BPP;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)] ?? 0;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride; // start of previous output row (invalid when y = 0)
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x] ?? 0;
      const a = x >= BPP ? (out[dst + x - BPP] ?? 0) : 0;
      const b = y > 0 ? (out[prev + x] ?? 0) : 0;
      const c = y > 0 && x >= BPP ? (out[prev + x - BPP] ?? 0) : 0;
      let r: number;
      switch (ft) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4:
          r = v + paeth(a, b, c);
          break;
        default:
          throw new PngUnsupportedError(`PNG scanline filter type ${ft} is not defined`);
      }
      out[dst + x] = r & 0xff;
    }
  }
  return out;
}

/**
 * Decodes an 8-bit, non-interlaced RGBA PNG whose size is exactly `expected`. Throws
 * PngUnsupportedError for anything else, including a different size (checked from the IHDR,
 * before anything is inflated) and image data that inflates beyond what that size implies.
 */
export function decodeRgbaPng(bytes: Uint8Array, expected: ExpectedSize): DecodedRgba {
  if (
    !Number.isInteger(expected.width) ||
    !Number.isInteger(expected.height) ||
    expected.width <= 0 ||
    expected.height <= 0 ||
    expected.width * expected.height > MAX_PIXELS
  ) {
    throw new PngUnsupportedError(
      `Unsupported expected PNG size ${expected.width}x${expected.height} (at most ${MAX_PIXELS} pixels)`,
    );
  }
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new PngUnsupportedError('Not a PNG (bad signature)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawEnd = false;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(
      bytes[pos + 4] ?? 0,
      bytes[pos + 5] ?? 0,
      bytes[pos + 6] ?? 0,
      bytes[pos + 7] ?? 0,
    );
    const start = pos + 8;
    const end = start + len;
    if (end + 4 > bytes.length) throw new PngUnsupportedError('PNG chunk runs past end of data');
    if (type === 'IHDR') {
      if (len !== 13) throw new PngUnsupportedError('Malformed PNG IHDR');
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const depth = bytes[start + 8];
      const colourType = bytes[start + 9];
      const compression = bytes[start + 10];
      const filterMethod = bytes[start + 11];
      const interlace = bytes[start + 12];
      if (depth !== 8 || colourType !== 6) {
        throw new PngUnsupportedError(
          `Only 8-bit RGBA PNG is supported (got bit depth ${depth}, colour type ${colourType})`,
        );
      }
      if (compression !== 0 || filterMethod !== 0) {
        throw new PngUnsupportedError('Unknown PNG compression or filter method');
      }
      if (interlace !== 0) throw new PngUnsupportedError('Interlaced PNG is not supported');
      if (width !== expected.width || height !== expected.height) {
        throw new PngUnsupportedError(
          `PNG is ${width}x${height} but ${expected.width}x${expected.height} was requested`,
        );
      }
      sawHeader = true;
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, end));
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    pos = end + 4; // skip CRC (corruption would surface as an inflate error or a size mismatch)
  }
  if (!sawHeader || !sawEnd || idat.length === 0) {
    throw new PngUnsupportedError('Incomplete PNG (missing IHDR, IDAT or IEND)');
  }
  const rawLength = height * (1 + width * BPP);
  let raw: Uint8Array;
  try {
    // Bounded to exactly what the header implies, so a decompression bomb is refused while it
    // inflates instead of after it has been allocated.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: rawLength });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new PngUnsupportedError(
        'PNG image data inflates beyond the size its header allows (refused)',
      );
    }
    throw new PngUnsupportedError(`PNG image data does not inflate: ${(err as Error).message}`);
  }
  if (raw.length !== rawLength) {
    throw new PngUnsupportedError('PNG image data has the wrong length for its header');
  }
  return { width, height, data: unfilter(raw, width, height) };
}

/** True when at least one pixel has non-zero alpha. */
export function hasOpaquePixel(img: DecodedRgba): boolean {
  for (let i = 3; i < img.data.length; i += BPP) {
    if ((img.data[i] ?? 0) !== 0) return true;
  }
  return false;
}
