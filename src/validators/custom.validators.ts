import { z } from 'zod';
import { CUSTOM_SIZES } from '../constants';
import { CUSTOM_PLACEMENTS, CUSTOM_PRODUCTS } from '../models/CustomDesign';

/**
 * Artwork must be a PNG Deck itself stored.
 *
 * Narrower than the shared `imageField`, which also accepts an absolute URL to
 * somebody else's host. That is fine for a logo Deck only ever renders; it is
 * not fine for a file Deck is going to download, decode and send to a printer.
 * PNG specifically, because transparency is the difference between a printed
 * mark and a printed rectangle.
 */
const artworkField = z
  .string()
  .trim()
  .regex(
    /^\/uploads\/[0-9a-f-]{36}\.png$/,
    'Upload your artwork to Deck as a PNG — JPEGs cannot carry a transparent background',
  );

export const inspectArtworkSchema = z.object({ artworkUrl: artworkField });

export const createCustomDesignSchema = z.object({
  artworkUrl: artworkField,
  name: z.string().trim().min(2, 'Give it a name so you can find it again').max(80),
  product: z.enum(CUSTOM_PRODUCTS),
  garment: z.string().trim().min(2).max(24),
  placement: z.enum(CUSTOM_PLACEMENTS).default('centre-chest'),
  /* Print width as a share of the printable area. Bounded rather than free so
     a slider bug cannot submit a print wider than the garment. */
  scale: z.coerce.number().int().min(10).max(100).default(60),
  size: z.enum(CUSTOM_SIZES).optional(),
});

/* Artwork is deliberately not editable: changing the file changes everything
   the analysis and the review were about. Upload a new design instead. */
export const updateCustomDesignSchema = createCustomDesignSchema.omit({ artworkUrl: true }).partial();

export const reviewCustomDesignSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().min(4, 'Say why — the person who uploaded it sees this').max(300),
});

export type InspectArtworkInput = z.infer<typeof inspectArtworkSchema>;
export type CreateCustomDesignInput = z.infer<typeof createCustomDesignSchema>;
export type UpdateCustomDesignInput = z.infer<typeof updateCustomDesignSchema>;
export type ReviewCustomDesignInput = z.infer<typeof reviewCustomDesignSchema>;
