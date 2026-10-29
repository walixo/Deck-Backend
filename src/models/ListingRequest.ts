import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * Somebody asking about a listing Deck made without them: "this is mine" or
 * "take this down".
 *
 * Both arrive as requests a person reads rather than as buttons that act. A
 * claim hands a product — its votes, comments and page — to whoever makes it,
 * so it needs proof, and until the automatic proofs exist (a domain email, a
 * tag on the site) a member of staff is the proof. A removal is honoured, but
 * by staff, so that a competitor cannot quietly delete a rival's listing.
 *
 * The contact email is the one thing collected about the requester, and only
 * because a request that cannot be answered is not worth taking.
 */
export const LISTING_REQUEST_KINDS = ['claim', 'removal'] as const;
export type ListingRequestKind = (typeof LISTING_REQUEST_KINDS)[number];

export const LISTING_REQUEST_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ListingRequestStatus = (typeof LISTING_REQUEST_STATUSES)[number];

export interface IListingRequest extends Document {
  _id: mongoose.Types.ObjectId;
  item: mongoose.Types.ObjectId;
  kind: ListingRequestKind;
  name: string;
  email: string;
  /** "I'm the co-founder", "I work there", "I'm a customer". */
  relationship?: string;
  message?: string;
  /** Set when the requester was signed in, so a claim can be handed straight to them. */
  account?: mongoose.Types.ObjectId;
  status: ListingRequestStatus;
  resolvedBy?: mongoose.Types.ObjectId;
  resolvedAt?: Date;
  resolutionNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

const listingRequestSchema = new Schema<IListingRequest>(
  {
    item: { type: Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
    kind: { type: String, enum: LISTING_REQUEST_KINDS, required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    relationship: { type: String, trim: true, maxlength: 80 },
    message: { type: String, trim: true, maxlength: 1000 },
    account: { type: Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: LISTING_REQUEST_STATUSES, default: 'open', index: true },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
    resolutionNote: { type: String, trim: true, maxlength: 400 },
  },
  { timestamps: true },
);

listingRequestSchema.index({ status: 1, createdAt: 1 });

export const ListingRequest: Model<IListingRequest> =
  mongoose.models.ListingRequest ??
  mongoose.model<IListingRequest>('ListingRequest', listingRequestSchema);
