import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * Switches for what onedeck.africa shows, flipped by staff without a deploy.
 *
 * One document, keyed `site`. `launches` shows or hides the whole launch
 * product — the board, Discover, launch pages, submitting, acquisitions and
 * the ads that sit on them. `landing` picks the home page: the launch board's,
 * or one showing Deck's products (Match and Deck Games). The launch landing
 * only shows while launches are on.
 */
export const SITE_LANDINGS = ['products', 'launches'] as const;
export type SiteLanding = (typeof SITE_LANDINGS)[number];

export interface ISiteSettings extends Document {
  key: string;
  launches: boolean;
  landing: SiteLanding;
  updatedAt: Date;
}

const siteSettingsSchema = new Schema<ISiteSettings>(
  {
    key: { type: String, required: true, unique: true, default: 'site' },
    launches: { type: Boolean, default: false },
    landing: { type: String, enum: SITE_LANDINGS, default: 'products' },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

export const SiteSettings: Model<ISiteSettings> =
  mongoose.models.SiteSettings ?? mongoose.model<ISiteSettings>('SiteSettings', siteSettingsSchema);
