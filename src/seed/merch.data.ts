import type { MerchCategory } from '../constants';

export interface SeedMerch {
  name: string;
  tagline: string;
  description: string;
  category: MerchCategory;
  /** Whole currency units (naira by default); the seeder converts to minor units. */
  price: number;
  featured?: boolean;
  variants: { sku: string; size?: string; colour?: string; stock: number }[];
}

const TEE_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

/** Builds one variant per size with a shared stock level. */
function sizes(prefix: string, stock: number, colour?: string) {
  return TEE_SIZES.map((size) => ({
    sku: `${prefix}-${size}`,
    size,
    colour,
    // Ends of the size run always sell through first.
    stock: size === 'XS' || size === 'XXL' ? Math.max(0, Math.round(stock / 3)) : stock,
  }));
}

export const seedMerch: SeedMerch[] = [
  {
    name: 'Launch Day Tee',
    tagline: 'Heavyweight cotton, one very small logo',
    description:
      'A 240gsm cotton tee in the same ink we print the site in. Boxy fit, taped neck, and a logo small enough that nobody will ask you about it at the airport.\n\nPrinted in small runs. When a size goes, it goes.',
    category: 'apparel',
    price: 16_000,
    featured: true,
    variants: sizes('TEE-LAUNCH-BLK', 24, 'Black'),
  },
  {
    name: 'Ship It Hoodie',
    tagline: 'For the part of the launch that happens at 2am',
    description:
      'Midweight fleece, 400gsm, with a lined hood and a kangaroo pocket sized for a phone and a pair of headphones.\n\nRuns true to size. If you are between sizes, take the smaller one — it grows.',
    category: 'apparel',
    price: 34_000,
    featured: true,
    variants: sizes('HOOD-SHIP-BON', 14, 'Bone'),
  },
  {
    name: 'Upvote Cap',
    tagline: 'Six panels, one embroidered triangle',
    description:
      'Unstructured six-panel in washed cotton twill, with a brass slider at the back. The triangle is embroidered, not printed, so it survives the wash.',
    category: 'accessories',
    price: 14_000,
    variants: [
      { sku: 'CAP-UPVOTE-BLK', colour: 'Black', stock: 40 },
      { sku: 'CAP-UPVOTE-BON', colour: 'Bone', stock: 22 },
    ],
  },
  {
    name: 'Sticker Pack — Vol. 1',
    tagline: 'Twelve die-cut vinyl stickers',
    description:
      'Twelve weatherproof vinyl die-cuts: the mark, the upvote triangle, the category glyphs and four in-jokes you will have to work out for yourself.\n\nMatte laminate, so they photograph well on a laptop lid.',
    category: 'stickers',
    price: 6_000,
    featured: true,
    variants: [{ sku: 'STK-VOL1', stock: 180 }],
  },
  {
    name: 'Leaderboard Poster',
    tagline: 'A3 riso print, two colours',
    description:
      'A two-colour riso print of the daily board, on 170gsm uncoated stock. Each run is slightly misregistered, which is the point of riso.\n\nShips flat in a rigid envelope.',
    category: 'print',
    price: 12_000,
    variants: [{ sku: 'PRT-BOARD-A3', size: 'A3', stock: 35 }],
  },
  {
    name: 'Field Notes — Launch Log',
    tagline: 'Pocket notebook, dot grid, three-pack',
    description:
      'Three 48-page pocket notebooks with a dot grid and a launch checklist inside the back cover. Saddle-stitched, no glue to crack.',
    category: 'accessories',
    price: 9_000,
    variants: [{ sku: 'NTB-LOG-3PK', stock: 60 }],
  },
  {
    name: 'Mono Mug',
    tagline: '350ml, thick walls, no slogan',
    description:
      'A plain glazed stoneware mug with the mark on the base rather than the side. Dishwasher safe, microwave safe, opinion-free.',
    category: 'accessories',
    price: 11_000,
    variants: [{ sku: 'MUG-MONO', stock: 0 }],
  },
  {
    name: 'Grid Tote',
    tagline: '12oz canvas, screen-printed grid',
    description:
      'A 12oz natural canvas tote with the site grid screen-printed across one face. Long handles, boxed base, holds a laptop and a week of shopping.',
    category: 'accessories',
    price: 13_000,
    variants: [{ sku: 'TOT-GRID', stock: 48 }],
  },
];
