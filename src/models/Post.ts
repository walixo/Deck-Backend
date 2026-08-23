import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A blog post.
 *
 * Deck's own voice, as opposed to everything else on the site, which is other
 * people's. That distinction is why posts are staff-authored and not open to
 * makers: a launch board where anyone can publish editorial alongside the
 * rankings stops being able to say what is Deck's opinion and what is an advert.
 *
 * Draft and published are separate from `publishedAt` on purpose. A post can be
 * written today and dated for Monday, and the two questions — "is this finished"
 * and "is it live yet" — have different answers in that window.
 */
export interface IPost extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  coverUrl?: string;
  tags: string[];
  author: mongoose.Types.ObjectId;
  status: 'draft' | 'published';
  publishedAt: Date | null;
  readMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

const postSchema = new Schema<IPost>(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    excerpt: { type: String, required: true, trim: true, maxlength: 240 },
    body: { type: String, required: true, trim: true, maxlength: 40_000 },
    coverUrl: { type: String, trim: true },
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 24 }],
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
    publishedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

/* The only public query: published, newest first. */
postSchema.index({ status: 1, publishedAt: -1 });
postSchema.index({ title: 'text', excerpt: 'text', body: 'text' });

/**
 * Reading time, derived rather than stored.
 *
 * 200 words a minute is the usual figure for screen prose. Deriving it means it
 * can never disagree with the body — a stored estimate would go stale the first
 * time somebody edited a post and forgot to recompute it.
 */
postSchema.virtual('readMinutes').get(function readMinutes(this: IPost) {
  const words = this.body.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
});

postSchema.set('toJSON', { virtuals: true });
postSchema.set('toObject', { virtuals: true });

export const Post: Model<IPost> =
  mongoose.models.Post ?? mongoose.model<IPost>('Post', postSchema);
