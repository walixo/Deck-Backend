/**
 * Gives every seeded launch a logo, so the launch wall has colour to sample.
 *
 *   npm run seed-artwork
 *
 * The wall panels take their background from the dominant colour of a launch's
 * logo. The seed ships no images at all, which means that feature is invisible
 * in development — the panels fall back to neutral and there is nothing to look
 * at. This paints one.
 *
 * **Why a hand-rolled PNG encoder.** The brief rules out unnecessary
 * dependencies, and `sharp`/`canvas` are both native builds pulled in purely to
 * draw thirty squares. PNG's truecolour form is genuinely simple — a header, one
 * deflated block of raw scanlines, a terminator — and `zlib` is in the standard
 * library. Forty lines here beats a native toolchain in the install.
 *
 * **Why not SVG**, which would be five lines: `config/uploads.ts` refuses it on
 * purpose. SVG can carry script and has no magic bytes to verify, so nothing in
 * Deck ever serves one from its own origin. A seed that wrote SVGs would be
 * planting exactly the file type the upload path is built to reject.
 */
/* eslint-disable no-console -- a CLI communicates by printing; that is the point. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { UPLOAD_DIR, UPLOAD_ROUTE } from '../config/uploads';
import { Item } from '../models/Item';
import { encodePng, hexToRgb } from '../utils/png';

const SIZE = 256;

/* ----------------------------------------------------------------- draw --- */


/**
 * Draws a flat brand field with a geometric mark on it.
 *
 * No text: rendering a glyph would mean a font engine, and the point is to
 * produce a *dominant colour*, not a legible wordmark. Five mark shapes keep the
 * wall from looking like one image repeated thirty times.
 */
function drawLogo(brand: string, mark: string, shape: number): Buffer {
  const [br, bg, bb] = hexToRgb(brand);
  const [mr, mg, mb] = hexToRgb(mark);
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  const c = SIZE / 2;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const dx = x - c;
      const dy = y - c;

      let onMark: boolean;
      switch (shape % 5) {
        case 0: // disc
          onMark = dx * dx + dy * dy < 66 * 66;
          break;
        case 1: // two bars
          onMark = Math.abs(dy) < 56 && Math.abs(dy) > 20 && Math.abs(dx) < 68;
          break;
        case 2: // ring
          onMark =
            dx * dx + dy * dy < 74 * 74 && dx * dx + dy * dy > 44 * 44;
          break;
        case 3: // triangle, apex up
          onMark = dy > -58 && dy < 58 && Math.abs(dx) < (58 - dy) * 0.62;
          break;
        default: // cross
          onMark = (Math.abs(dx) < 24 || Math.abs(dy) < 24) && Math.abs(dx) < 70 && Math.abs(dy) < 70;
      }

      const i = (y * SIZE + x) * 3;
      rgb[i] = onMark ? mr : br;
      rgb[i + 1] = onMark ? mg : bg;
      rgb[i + 2] = onMark ? mb : bb;
    }
  }

  return encodePng(rgb, SIZE, SIZE);
}

/**
 * Brand colours, chosen to be awkward together.
 *
 * The whole point of sampling a launch's own colour is that Deck stops choosing.
 * A palette of tasteful neighbours would prove nothing — these are deliberately
 * a fight: warm reds beside acid yellows beside deep navies, several of them
 * landing in the contrast band where the extractor has to nudge them to stay
 * legible.
 */
const BRANDS = [
  '#e4342a', '#d81b8c', '#0f9b8e', '#f5820b', '#1b3a8f', '#f2e211',
  '#7a5cff', '#2f8f2f', '#00a3c4', '#c2185b', '#ff6b35', '#5b21b6',
  '#0f766e', '#b91c1c', '#a16207', '#1e40af', '#be185d', '#15803d',
  '#7c2d12', '#4338ca', '#0891b2', '#ca8a04', '#9333ea', '#dc2626',
  '#059669', '#2563eb', '#db2777', '#65a30d', '#ea580c', '#0d9488',
];

/** Ink or white, whichever the field carries better. */
function markFor(brand: string): string {
  const [r, g, b] = hexToRgb(brand);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return l > 0.4 ? '#111111' : '#ffffff';
}

async function main() {
  await connectDatabase();

  /* Oldest first, so a given launch keeps the same colour across reruns. */
  const items = await Item.find().sort({ launchDate: 1, _id: 1 });

  let written = 0;
  let skipped = 0;

  for (const [index, item] of items.entries()) {
    if (item.logoUrl) {
      skipped += 1;
      continue;
    }

    const brand = BRANDS[index % BRANDS.length];
    const png = drawLogo(brand, markFor(brand), index);

    /* Named from the slug rather than a uuid so a rerun overwrites its own file
       instead of littering the upload directory. */
    const name = `seed-${createHash('sha1').update(item.slug).digest('hex').slice(0, 32)}.png`;
    writeFileSync(path.join(UPLOAD_DIR, name), png);

    item.logoUrl = `${UPLOAD_ROUTE}/${name}`;
    await item.save();

    written += 1;
  }

  console.log(`\n  Painted ${written} logo${written === 1 ? '' : 's'} into ${UPLOAD_DIR}`);
  if (skipped > 0) console.log(`  Skipped ${skipped} that already had one.`);
  console.log('');

  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error('[seed-artwork] failed', error);
  await disconnectDatabase();
  process.exit(1);
});
