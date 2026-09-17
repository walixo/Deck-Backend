import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * One row per viewer per launch per window — the thing that stops a view
 * counter from being a refresh counter.
 *
 * `Item.viewCount` is the number anyone sees; this collection exists only to
 * answer "has this person already been counted for this launch recently?".
 * A unique index on `{ item, viewer }` makes that answer a write rather than a
 * read: the insert either succeeds, which means it is a new view, or it fails
 * with a duplicate key, which means it is not. One round trip, no read-then-
 * write race between two tabs opening at once.
 *
 * The rows are garbage, deliberately. A TTL index drops each one when its
 * window closes, so the collection settles at roughly "distinct viewers in the
 * last twelve hours" rather than growing forever — which is the only reason
 * this is affordable in MongoDB with no cache server in front of it.
 */
export interface IItemView extends Document {
  item: mongoose.Types.ObjectId;
  /** An opaque digest. See `services/views.ts` — no address is stored here. */
  viewer: string;
  expiresAt: Date;
}

const itemViewSchema = new Schema<IItemView>(
  {
    item: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
    viewer: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

/* The dedupe itself. Unique, because the constraint IS the logic. */
itemViewSchema.index({ item: 1, viewer: 1 }, { unique: true });

/*
 * Self-cleaning. `expireAfterSeconds: 0` means "delete when the date in this
 * field has passed", which puts the window length at the call site instead of
 * in the index — so changing it is a constant, not a migration.
 *
 * Mongo's TTL monitor sweeps about once a minute, so expiry is approximate.
 * That is fine: a row lingering ninety seconds past its window only delays the
 * moment a returning viewer can be counted again.
 */
itemViewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ItemView: Model<IItemView> =
  mongoose.models.ItemView ?? mongoose.model<IItemView>('ItemView', itemViewSchema);
