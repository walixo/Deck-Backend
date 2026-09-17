import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * One row per launch per UTC day — the only thing that turns a view counter
 * into a chart.
 *
 * `Item.viewCount` answers "how many, ever", which is the number a card shows
 * and the only one it needs. It cannot answer "is this launch picking up or
 * dying", and that is the question a maker actually has. A running total has
 * no memory of when it grew, and there is no way to recover the shape after
 * the fact, so the buckets have to be written as the views arrive.
 *
 * UTC days to match `Item.launchDateKey` and the daily leaderboard. A maker in
 * Lagos reading a chart drawn on UTC days sees their evening traffic land on
 * the right day; the alternative — per-viewer local days — makes two people
 * disagree about what Tuesday was.
 *
 * No TTL here, unlike the `ItemView` dedupe ledger. These rows are the record
 * rather than scaffolding, and they are cheap: 365 documents per launch per
 * year, each a couple of dozen bytes. Deleting last year's traffic to save
 * kilobytes would be a strange trade.
 */
export interface IItemViewDaily extends Document {
  item: mongoose.Types.ObjectId;
  /** YYYY-MM-DD, UTC. Same shape as `Item.launchDateKey`. */
  dateKey: string;
  views: number;
}

const itemViewDailySchema = new Schema<IItemViewDaily>(
  {
    item: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
    dateKey: { type: String, required: true },
    views: { type: Number, default: 0, min: 0 },
  },
  { versionKey: false },
);

/*
 * Unique, so the upsert has something to be idempotent against: two views of
 * the same launch in the same second race to create the day's row, and the
 * index is what makes one of them lose and retry as an increment.
 *
 * It also serves the read. Every query this collection will ever see is "one
 * launch, this range of days" or "these launches, this range of days", and a
 * compound index on exactly that prefix answers both from the index alone.
 */
itemViewDailySchema.index({ item: 1, dateKey: 1 }, { unique: true });

export const ItemViewDaily: Model<IItemViewDaily> =
  mongoose.models.ItemViewDaily ??
  mongoose.model<IItemViewDaily>('ItemViewDaily', itemViewDailySchema);
