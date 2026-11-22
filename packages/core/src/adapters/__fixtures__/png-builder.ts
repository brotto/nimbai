import { deflateSync } from 'node:zlib';

/** Test-only: builds PNG bytes so decoder and loop tests need no binary fixtures. */

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Wraps already-filtered scanlines (each = 1 filter byte + width*bpp bytes) into a PNG.
 * `colourType`/`depth` default to GIBS's 8-bit RGBA.
 */
export function pngFromFilteredRows(
  width: number,
  height: number,
  rows: Uint8Array[],
  opts: { colourType?: number; depth?: number; interlace?: number } = {},
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = opts.depth ?? 8;
  ihdr[9] = opts.colourType ?? 6;
  ihdr[12] = opts.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Flat RGBA image, every row filter type 0. alpha 0 = what GIBS sends for missing data. */
export function solidPng(width: number, height: number, rgba: [number, number, number, number]) {
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) Buffer.from(rgba).copy(row, 1 + x * 4);
    rows.push(row);
  }
  return pngFromFilteredRows(width, height, rows);
}
