import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { PRICING_MODELS, type Category, type PricingModel } from '../constants';

/**
 * One authored state of a launch.
 *
 * Revision 1 is the launch as first posted; every content edit after that adds
 * another. Together they are the answer to "what did this say when I voted for
 * it?" — which is the question that matters on a board where attention is the
 * currency and a tagline can be swapped after the votes are in.
 *
 * **Snapshots, not diffs.** Each revision stores the whole authored state
 * rather than a patch against the previous one. A launch is a couple of KB, so
 * the storage argument for diffs never arrives, and the correctness argument
 * runs the other way: a diff chain has to be replayed from the beginning to
 * read any single version, so one bad entry silently corrupts every version
 * after it. Snapshots are independently readable and independently verifiable.
 * Diffs are computed from adjacent snapshots at display time, where being wrong
 * is a rendering bug rather than data loss.
 *
 * **Authored fields only.** `voteCount`, `ratingAvg` and `fundraise.raisedMinor`
 * are deliberately absent. They change constantly and nobody wrote them —
 * including them would bury the three edits that matter under a thousand
 * entries that say a vote arrived.
 *
 * Append-only, by the same reasoning and the same hooks as the audit trail: a
 * history that can be rewritten is not a history.
 */

/** The fields a person authors. Everything a revision captures, and nothing else. */
export interface RevisionSnapshot {
  name: string;
  tagline: string;
  description: string;
  category: Category;
  pricing: PricingModel;
  websiteUrl: string;
  repoUrl?: string;
  logoUrl?: string;
  coverUrl?: string;
  wallColour?: string;
  videoUrl?: string;
  gallery: string[];
  tags: string[];
  makers: string[];
}

/**
 * Which snapshot keys are tracked, in display order.
 *
 * Exported because the controller diffs against it and the serializer labels
 * from it — three copies of this list would drift the first time a field is
 * added.
 */
export const REVISION_FIELDS = [
  'name',
  'tagline',
  'description',
  'category',
  'pricing',
  'websiteUrl',
  'repoUrl',
  'logoUrl',
  'coverUrl',
  'wallColour',
  'videoUrl',
  'gallery',
  'tags',
  'makers',
] as const;

export type RevisionField = (typeof REVISION_FIELDS)[number];

export interface IItemRevision extends Document {
  _id: mongoose.Types.ObjectId;
  item: mongoose.Types.ObjectId;
  /** 1-based and gapless per item. */
  version: number;
  snapshot: RevisionSnapshot;
  /** Which fields differ from the previous revision. Empty on revision 1. */
  changed: RevisionField[];
  editedBy: mongoose.Types.ObjectId;
  /** Copied in, so the entry still reads correctly after a rename. */
  editedByName: string;
  /** Whether this was the maker or staff acting on their launch. */
  editedByRole: 'owner' | 'admin';
  /** Optional "what changed" line from the editor. */
  note?: string;
  createdAt: Date;
}

const snapshotSchema = new Schema<RevisionSnapshot>(
  {
    name: { type: String, required: true },
    tagline: { type: String, required: true },
    description: { type: String, required: true },
    /* Snapshots record what the category WAS, even if it has since been
       retired or renamed — so this never validates against the live set. */
    category: { type: String, required: true, trim: true },
    pricing: { type: String, enum: PRICING_MODELS, required: true },
    websiteUrl: { type: String, required: true },
    repoUrl: { type: String },
    logoUrl: { type: String },
    coverUrl: { type: String },
    /* Declared, or Mongoose strips them on save and every revision records the
       field as "changed" forever after — a subdocument schema silently drops
       anything it has not been told about, and the diff would then compare a
       real value against undefined on each pass. */
    wallColour: { type: String },
    videoUrl: { type: String },
    gallery: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    makers: { type: [String], default: [] },
  },
  { _id: false },
);

const itemRevisionSchema = new Schema<IItemRevision>(
  {
    item: { type: Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
    version: { type: Number, required: true, min: 1 },
    snapshot: { type: snapshotSchema, required: true },
    changed: { type: [String], default: [] },
    editedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    editedByName: { type: String, required: true, trim: true, maxlength: 120 },
    editedByRole: { type: String, enum: ['owner', 'admin'], required: true },
    note: { type: String, trim: true, maxlength: 200 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/* The history reads newest-first for one launch, which is the only access
   pattern. Unique so a racing double-submit cannot mint two version 4s. */
itemRevisionSchema.index({ item: 1, version: -1 }, { unique: true });

const REFUSE = function refuse(this: unknown, next: (error?: Error) => void) {
  next(new Error('Launch history is append-only: revisions cannot be changed or removed'));
};

for (const hook of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'findOneAndDelete',
] as const) {
  itemRevisionSchema.pre(hook, REFUSE);
}

/*
 * `deleteMany` is deliberately NOT refused, unlike the audit trail.
 *
 * Deleting a launch already removes its votes and comments; leaving its drafts
 * behind would keep the text of something the maker asked to be gone. The
 * history exists to hold an author to what they published, not to outlive the
 * publication. Single-document deletes stay blocked, so the only way to drop
 * revisions is to drop the whole launch with them.
 */

itemRevisionSchema.pre('save', function guard(next) {
  if (!this.isNew) {
    next(new Error('Launch history is append-only: revisions cannot be changed'));
    return;
  }
  next();
});

export const ItemRevision: Model<IItemRevision> =
  mongoose.models.ItemRevision ??
  mongoose.model<IItemRevision>('ItemRevision', itemRevisionSchema);
