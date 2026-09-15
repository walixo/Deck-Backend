import zlib from 'node:zlib';

/**
 * Decodes a PNG to raw RGBA.
 *
 * Written rather than installed for the same reason the encoder next door was:
 * `sharp` and `canvas` are native builds, and the whole job here is to read a
 * few thousand pixels out of an uploaded file so Deck can tell somebody whether
 * their artwork will print. PNG's structure is a chunk list, one deflate stream
 * and five scanline filters — `zlib` does the hard part and the rest is a
 * hundred lines.
 *
 * **What it accepts.** Bit depths 8 and 16, colour types 0/2/3/4/6, with
 * `tRNS` transparency for palette and non-alpha images. That is every PNG a
 * design tool exports.
 *
 * **What it refuses.** Adam7 interlacing, which needs seven sub-image passes
 * and is essentially extinct outside progressive web images from the 90s.
 * Refusing loudly beats decoding it wrong and telling somebody their logo is
 * the wrong colour.
 */

export interface DecodedPng {
  width: number;
  height: number;
  /** Row-major RGBA, four bytes per pixel. */
  rgba: Buffer;
  /** Whether the source could carry transparency at all. */
  hasAlphaChannel: boolean;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel in the *unfiltered* stream, which is what filtering steps by. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(buffer: Buffer): DecodedPng {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('That does not look like a PNG');
  }

  let width = 0;
  let height = 0;
  let depth = 8;
  let colourType = 6;
  let palette: Buffer | null = null;
  let paletteAlpha: Buffer | null = null;
  let transparent: number[] | null = null;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colourType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not supported — re-export without interlacing');
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      /* Two different meanings depending on colour type: a per-entry alpha
         table for palette images, or a single colour to treat as transparent
         for the others. */
      if (colourType === 3) paletteAlpha = Buffer.from(data);
      else if (colourType === 0) transparent = [data.readUInt16BE(0)];
      else if (colourType === 2) {
        transparent = [data.readUInt16BE(0), data.readUInt16BE(2), data.readUInt16BE(4)];
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }

    /* 4 length + 4 type + data + 4 CRC. The CRC is not verified: a corrupt
       file fails at inflate or produces obvious garbage, and the cost of being
       wrong here is a bad mockup rather than a security boundary. */
    offset += 12 + length;
  }

  if (!width || !height) throw new Error('That PNG has no image header');
  if (depth !== 8 && depth !== 16) throw new Error(`Unsupported bit depth: ${depth}`);

  const channels = CHANNELS[colourType];
  if (!channels) throw new Error(`Unsupported PNG colour type: ${colourType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));

  /* Filtering operates on bytes-per-pixel, which for 16-bit is two per channel.
     Palette images are always one byte per pixel regardless of depth. */
  const bpp = colourType === 3 ? 1 : channels * (depth === 16 ? 2 : 1);
  const stride = colourType === 3 ? width : width * bpp;
  const unfiltered = unfilter(raw, width, height, bpp, stride);

  const rgba = Buffer.alloc(width * height * 4);
  const step = depth === 16 ? 2 : 1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const s = y * stride + x * (colourType === 3 ? 1 : channels * step);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;

      if (colourType === 3) {
        const index = unfiltered[s];
        if (palette) {
          r = palette[index * 3];
          g = palette[index * 3 + 1];
          b = palette[index * 3 + 2];
        }
        a = paletteAlpha && index < paletteAlpha.length ? paletteAlpha[index] : 255;
      } else if (colourType === 0 || colourType === 4) {
        /* 16-bit is read as its high byte. Deck is measuring hue and coverage,
           not colour-managing a print file — the low byte cannot change either
           answer perceptibly. */
        r = g = b = unfiltered[s];
        if (colourType === 4) a = unfiltered[s + step];
        else if (transparent && unfiltered[s] === transparent[0] >> (depth === 16 ? 8 : 0)) a = 0;
      } else {
        r = unfiltered[s];
        g = unfiltered[s + step];
        b = unfiltered[s + 2 * step];
        if (colourType === 6) a = unfiltered[s + 3 * step];
        else if (transparent && r === transparent[0] && g === transparent[1] && b === transparent[2]) {
          a = 0;
        }
      }

      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }

  return {
    width,
    height,
    rgba,
    hasAlphaChannel: colourType === 4 || colourType === 6 || Boolean(paletteAlpha) || Boolean(transparent),
  };
}

/**
 * Reverses PNG's five scanline filters.
 *
 * Each row is prefixed with the filter that was applied to it, and every filter
 * predicts a byte from its neighbours — left, above, and above-left. The
 * predictions reference the *already reconstructed* previous row, which is why
 * this has to run top to bottom and cannot be parallelised per row.
 */
function unfilter(raw: Buffer, width: number, height: number, bpp: number, stride: number): Buffer {
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;

    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x];
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const above = y > 0 ? out[up + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[up + x - bpp] : 0;

      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + above;
          break;
        case 3:
          restored = value + ((left + above) >> 1);
          break;
        case 4:
          restored = value + paeth(left, above, upLeft);
          break;
        default:
          throw new Error(`Unknown PNG filter type: ${filter}`);
      }

      out[dst + x] = restored & 0xff;
    }
  }

  return out;
}

/** PNG's predictor: whichever neighbour the gradient is closest to. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
