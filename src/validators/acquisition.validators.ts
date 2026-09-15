import { z } from 'zod';
import { ACQUISITION_ASSETS } from '../models/Acquisition';

/**
 * Listing a launch for acquisition.
 *
 * Money arrives in whole major units and is converted to minor in the
 * controller, the same convention the fundraise form uses — nobody types kobo.
 *
 * The floors are low and the ceiling is high on purpose. Deck has no view on
 * what a product is worth; the point of the asking price is that it is the
 * seller's number, boldly stated, rather than something Deck negotiated them
 * into. The cap only exists so a fat-fingered extra three zeroes is caught
 * before it is on the front page.
 */
const majorAmount = (min: number, max: number, label: string) =>
  z.coerce
    .number({ invalid_type_error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(min, `${label} must be at least ${min.toLocaleString()}`)
    .max(max, `${label} looks wrong — check the zeroes`);

export const createAcquisitionSchema = z.object({
  asking: majorAmount(50_000, 50_000_000_000, 'Asking price'),
  negotiable: z.boolean().default(true),
  reason: z
    .string()
    .trim()
    .min(40, 'Say why you are selling — at least 40 characters')
    .max(1500),
  /* At least one, because "what do I actually get" is the question every buyer
     asks first and an empty list answers it with silence. */
  assets: z
    .array(z.enum(ACQUISITION_ASSETS))
    .min(1, 'Say what is included')
    .max(ACQUISITION_ASSETS.length),
  monthlyRevenue: majorAmount(0, 50_000_000_000, 'Monthly revenue').default(0),
  monthlyCost: majorAmount(0, 50_000_000_000, 'Monthly cost').default(0),
  activeUsers: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
  notes: z.string().trim().max(1500).optional(),
});

export const updateAcquisitionSchema = createAcquisitionSchema.partial();

/** Approve or turn down a listing. A note is required either way. */
export const reviewAcquisitionSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().min(4, 'Say why — the seller sees this').max(300),
});

/**
 * Making an offer.
 *
 * The message is required and has a real floor. An acquisition offer with no
 * words attached is not a serious offer, and a seller reading twelve bare
 * numbers has no way to tell a buyer from a tyre-kicker — which is exactly the
 * failure that makes marketplaces like this stop working.
 */
export const createBidSchema = z.object({
  amount: majorAmount(50_000, 50_000_000_000, 'Offer'),
  message: z
    .string()
    .trim()
    .min(20, 'Tell the seller who you are and what you would do with it')
    .max(1500),
});

export const listAcquisitionsSchema = z.object({
  sort: z.enum(['newest', 'price-high', 'price-low', 'most-bids']).default('newest'),
  search: z.string().trim().max(80).optional(),
  /** Filter to listings inside a price band, in whole major units. */
  maxPrice: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
});

export type CreateAcquisitionInput = z.infer<typeof createAcquisitionSchema>;
export type UpdateAcquisitionInput = z.infer<typeof updateAcquisitionSchema>;
export type ReviewAcquisitionInput = z.infer<typeof reviewAcquisitionSchema>;
export type CreateBidInput = z.infer<typeof createBidSchema>;
export type ListAcquisitionsQuery = z.infer<typeof listAcquisitionsSchema>;
