import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A person behind a product Deck listed on their behalf.
 *
 * Deliberately not a `User`. An account is somebody who signed up: it has an
 * email they gave Deck, it counts as a maker in the landing page's numbers,
 * and its profile says "this person is here". None of that is true of a
 * founder Deck found in the press. Making them accounts would need invented
 * email addresses, would inflate the community figures, and would put a real
 * person's name on a profile that implies they joined — which is close enough
 * to impersonation that it is not worth being near.
 *
 * So a founder is a record about a person, clearly labelled as unclaimed, that
 * becomes theirs only when they prove who they are (`claimedBy`). Until then
 * it holds the minimum: a name, a role, the company's own public links, and
 * where each fact came from.
 *
 * What is never stored here: personal email addresses, phone numbers, home
 * locations, or links the person did not publish about themselves in a
 * professional capacity. Data protection law (Nigeria's NDPA, the GDPR) allows
 * listing public business facts; it does not allow building dossiers.
 */
export interface IFounderLink {
  label: string;
  url: string;
}

export interface IFounder extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  /** "Co-founder & CEO, Paystack" — the role as the company describes it. */
  headline?: string;
  /** ISO 3166-1 alpha-2, upper case. Where they build from, as publicly stated. */
  country?: string;
  links: IFounderLink[];
  /** Where the facts on this record came from. Kept for takedown review. */
  sourceUrls: string[];
  /** The account that proved it is this person. Null while unclaimed. */
  claimedBy: mongoose.Types.ObjectId | null;
  claimedAt: Date | null;
  /** Staff who created the record. */
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const linkSchema = new Schema<IFounderLink>(
  {
    label: { type: String, required: true, trim: true, maxlength: 30 },
    url: { type: String, required: true, trim: true, maxlength: 300 },
  },
  { _id: false },
);

const founderSchema = new Schema<IFounder>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    headline: { type: String, trim: true, maxlength: 100 },
    country: { type: String, trim: true, uppercase: true, match: /^[A-Z]{2}$/ },
    links: { type: [linkSchema], default: [] },
    sourceUrls: [{ type: String, trim: true, maxlength: 500 }],
    claimedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    claimedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const Founder: Model<IFounder> =
  mongoose.models.Founder ?? mongoose.model<IFounder>('Founder', founderSchema);
