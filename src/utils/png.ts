import zlib from 'node:zlib';

/**
 * A minimal PNG encoder, for seed artwork.
 *
 * **Why hand-rolled.** The brief rules out unnecessary dependencies, and
 * `sharp`/`canvas` are both native builds pulled in purely to draw flat
 * rectangles. PNG's truecolour form is genuinely simple — a header, one
 * deflated block of raw scanlines, a terminator — and `zlib` is in the standard
 * library. Forty lines here beats a native toolchain in the install.
 *
 * **Why not SVG**, which would be five lines: `config/uploads.ts` refuses it on
 * purpose. SVG can carry script and has no magic bytes to verify, so nothing in
 * Deck ever serves one from its own origin. A seed that wrote SVGs would be
 * planting exactly the file type the upload path is built to reject.
 *
 * Lifted out of `seed-artwork` when a second seed needed it. Two copies of a
 * CRC table is how one of them ends up subtly wrong.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** length + type + data + crc(type+data), which is every PNG chunk. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Encodes raw RGB (3 bytes per pixel, row-major) as an 8-bit truecolour PNG.
 *
 * Takes width and height separately: the logo seed draws squares, but a gallery
 * shot is 16:9 and a square one letterboxed into an `aspect-video` slot is the
 * fastest way to make a slider look broken.
 */
export function encodePng(rgb: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  /* Each scanline is prefixed with its filter type. 0 means "none" — the images
     are flat colour, so filtering would buy nothing but complexity. */
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export type Rgb = [number, number, number];

export const hexToRgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];
