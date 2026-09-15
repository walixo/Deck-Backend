import { decodePng } from '../utils/pngDecode';

/**
 * What Deck can tell somebody about the artwork they just uploaded.
 *
 * This is the intelligence in the custom-print flow, and all of it is
 * measurement rather than generation. That is deliberate — see the note on
 * `PRODUCTS` below for why a *generated* mockup would be the wrong thing to
 * show a buyer. What matters before somebody pays to have a file printed is a
 * short list of facts:
 *
 *   - Is it big enough for the size they want it printed at?
 *   - Does it have a transparent background, or will it print as a white box?
 *   - What colour is it, so Deck can suggest a garment it will show up on?
 *   - How much ink does it use, which is what makes some prints cost more?
 *
 * Every one of those is arithmetic over pixels. None of them needs a model, and
 * a model would get all four less reliably.
 */

export interface ArtworkAnalysis {
  width: number;
  height: number;
  /** Longest edge in inches at print quality. Drives the size recommendation. */
  maxInchesAtGoodDpi: number;
  /** True when the file can carry transparency AND actually uses it. */
  transparent: boolean;
  /** Share of pixels that are meaningfully opaque. Low means lots of white space. */
  inkCoverage: number;
  /** The colour a person would name if asked what colour the artwork is. */
  dominantHex: string;
  /** How light the artwork is overall, 0–1. Decides light or dark garments. */
  luminance: number;
  /** Garment colours this will actually show up on, best first. */
  suggestedGarments: string[];
  /** Anything the buyer should fix before ordering. Empty means good to print. */
  warnings: string[];
}

/** Below this, a print looks soft. Above it, nobody can tell by eye. */
const GOOD_DPI = 150;

/** An alpha under this is a soft edge or a stray halo, not part of the mark. */
const OPAQUE = 200;

/**
 * The garment colours Deck stocks, as hex plus a reader-facing name.
 *
 * Ordered light to dark so the suggestion logic can walk it in either
 * direction depending on how light the artwork is.
 */
export const GARMENTS = [
  { id: 'white', label: 'White', hex: '#f7f7f5' },
  { id: 'sand', label: 'Sand', hex: '#d9cfbe' },
  { id: 'grey', label: 'Heather grey', hex: '#9b9b98' },
  { id: 'olive', label: 'Olive', hex: '#4c5340' },
  { id: 'navy', label: 'Navy', hex: '#232b3d' },
  { id: 'black', label: 'Black', hex: '#17181a' },
] as const;

export type GarmentId = (typeof GARMENTS)[number]['id'];

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminanceOf(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function saturationOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2 / 255;
  const d = (max - min) / 255;
  return l > 0.5 ? d / (2 - max / 255 - min / 255) : d / (max / 255 + min / 255);
}

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

export function analyseArtwork(buffer: Buffer): ArtworkAnalysis {
  const { width, height, rgba, hasAlphaChannel } = decodePng(buffer);

  const warnings: string[] = [];

  /*
   * Sampled, not exhaustive.
   *
   * A 4000×4000 upload is 16 million pixels and every question below is
   * statistical — a stride that lands on ~40,000 of them answers all of them to
   * more precision than anybody needs, and keeps this well under a frame's
   * worth of work on the request thread.
   */
  const target = 40_000;
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / target)));

  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let sampled = 0;
  let opaque = 0;
  let anyTransparent = false;
  let lumSum = 0;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
      sampled += 1;

      if (a < OPAQUE) {
        anyTransparent = true;
        continue;
      }
      opaque += 1;
      lumSum += luminanceOf(r, g, b);

      /* Near-neutrals are excluded from the *hue* vote for the same reason the
         logo sampler excludes them: almost every design is a coloured mark on
         white or black, and counting the backdrop returns "white" every time. */
      if (saturationOf(r, g, b) < 0.18) continue;
      const l = luminanceOf(r, g, b);
      if (l > 0.9 || l < 0.02) continue;

      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bin = bins.get(key);
      if (bin) {
        bin.n += 1;
        bin.r += r;
        bin.g += g;
        bin.b += b;
      } else {
        bins.set(key, { n: 1, r, g, b });
      }
    }
  }

  /* Weighted by saturation, so a mark split between grey and hot pink comes
     back pink — which is what anybody would say if you asked them. */
  let best: { n: number; r: number; g: number; b: number } | null = null;
  let bestScore = 0;
  for (const bin of bins.values()) {
    const score = bin.n * (0.5 + saturationOf(bin.r / bin.n, bin.g / bin.n, bin.b / bin.n));
    if (score > bestScore) {
      bestScore = score;
      best = bin;
    }
  }

  const dominantHex = best
    ? hex(best.r / best.n, best.g / best.n, best.b / best.n)
    : /* A genuinely greyscale design has no dominant hue, and inventing one
         would send the garment suggestion somewhere arbitrary. */
      '#111111';

  const inkCoverage = sampled > 0 ? opaque / sampled : 0;
  const luminance = opaque > 0 ? lumSum / opaque : 0;
  const maxInchesAtGoodDpi = Math.round((Math.max(width, height) / GOOD_DPI) * 10) / 10;

  const transparent = hasAlphaChannel && anyTransparent;

  if (!transparent) {
    warnings.push(
      'No transparent background — this will print as a solid rectangle. Re-export as a PNG with transparency unless the rectangle is the design.',
    );
  }
  if (maxInchesAtGoodDpi < 4) {
    warnings.push(
      `At ${width}×${height} this only holds up to about ${maxInchesAtGoodDpi}" across. Small stickers are fine; anything larger will look soft.`,
    );
  }
  if (inkCoverage > 0.85 && transparent) {
    warnings.push(
      'Nearly the whole canvas is inked. On apparel that is a heavy print — it will feel stiff and cost more.',
    );
  }
  if (width < 500 || height < 500) {
    warnings.push('Under 500px on a side. Upload the largest version you have.');
  }

  return {
    width,
    height,
    maxInchesAtGoodDpi,
    transparent,
    inkCoverage: Math.round(inkCoverage * 1000) / 1000,
    dominantHex,
    luminance: Math.round(luminance * 1000) / 1000,
    suggestedGarments: suggestGarments(luminance),
    warnings,
  };
}

/**
 * Which garments the artwork will actually read on.
 *
 * Ranked by contrast between the artwork's average lightness and the garment,
 * which is the same 3:1 non-text floor the rest of Deck uses. A pale design on
 * white and a dark design on black are the two ways a custom print arrives and
 * disappoints somebody, and both are predictable before anything is printed.
 */
function suggestGarments(luminance: number): string[] {
  return [...GARMENTS]
    .map((garment) => {
      const g = parseInt(garment.hex.slice(1), 16);
      const gl = luminanceOf((g >> 16) & 255, (g >> 8) & 255, g & 255);
      return { id: garment.id, ratio: contrast(luminance, gl) };
    })
    .sort((a, b) => b.ratio - a.ratio)
    .filter((entry) => entry.ratio >= 3)
    .map((entry) => entry.id);
}
