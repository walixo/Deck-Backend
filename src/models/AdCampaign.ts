import mongoose, { Schema, type Document, type Model } from 'mongoose';
import {
  AD_PLACEMENTS,
  AD_STATUSES,
  CURRENCY,
  type AdPlacement,
  type AdStatus,
} from '../constants';

/**
 * A paid placement bought by a launcher.
 *
 * The creative is stored as fields rather than free HTML: a headline, a line of
 * body, an image and a label. Deck renders it in Deck's own styling, so an ad
 * cannot smuggle in a script, restyle the page around it, or pretend to be
 * something other than an ad.
 *
 * `startAt`/`endAt` are the single source of truth for whether it is running.
 * Nothing writes "scheduled" or "finished" into the row — those are the window
 * compared against now, and a stored copy would need a cron job to stay honest.
 */
export interface IAdCampaign extends Document {
  _id: mongoose.Types.ObjectId;
  reference: string;
  advertiser: mongoose.Types.ObjectId;
  /** The launch being promoted. Also where the ad links, by default. */
  item: mongoose.Types.ObjectId;
  placement: AdPlacement;

  headline: string;
  body: string;
  imageUrl?: string;
  ctaLabel: string;

  days: number;
  startAt: Date;
  endAt: Date;

  /** Priced on the server from the rate card. Frozen once paid. */
  priceMinor: number;
  currency: string;

  status: AdStatus;
  rejectionReason?: string;
  reviewedAt?: Date;

  paidAt?: Date;
  authorizationUrl?: string;

  impressions: number;
  clicks: number;

  createdAt: Date;
  updatedAt: Date;
}

const adCampaignSchema = new Schema<IAdCampaign>(
  {
    reference: { type: String, required: true, unique: true, uppercase: true, trim: true },
    advertiser: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    item: { type: Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
    placement: { type: String, enum: AD_PLACEMENTS, required: true, index: true },

    headline: { type: String, required: true, trim: true, maxlength: 60 },
    body: { type: String, required: true, trim: true, maxlength: 140 },
    imageUrl: { type: String, trim: true },
    ctaLabel: { type: String, required: true, trim: true, maxlength: 24, default: 'Take a look' },

    days: { type: Number, required: true, min: 1, max: 90 },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true, index: true },

    priceMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, default: CURRENCY, uppercase: true },

    status: { type: String, enum: AD_STATUSES, default: 'pending_review', index: true },
    rejectionReason: { type: String, trim: true, maxlength: 400 },
    reviewedAt: Date,

    paidAt: Date,
    authorizationUrl: { type: String, trim: true },

    /* Counted on serve and on click. Honest about what they measure: a serve is
       a slot being filled, not proof a human looked at it. */
    impressions: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

/** The serving query: live campaigns for one placement, inside their window. */
adCampaignSchema.index({ placement: 1, status: 1, startAt: 1, endAt: 1, impressions: 1 });

export const AdCampaign: Model<IAdCampaign> =
  mongoose.models.AdCampaign ?? mongoose.model<IAdCampaign>('AdCampaign', adCampaignSchema);
