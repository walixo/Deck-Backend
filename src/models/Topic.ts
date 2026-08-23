import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * The forum's categories.
 *
 * A short fixed list rather than a `Category` collection like launches have.
 * Launch categories are the shape of the board and staff genuinely need to add
 * them; forum sections are the shape of a conversation, and a forum that grows
 * a section per topic is a forum nobody can find anything in. Five is enough to
 * route a question and few enough to read at a glance.
 */
export const TOPIC_SECTIONS = ['ask', 'show', 'feedback', 'hiring', 'meta'] as const;
export type TopicSection = (typeof TOPIC_SECTIONS)[number];

export interface ITopic extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  slug: string;
  body: string;
  section: TopicSection;
  author: mongoose.Types.ObjectId;
  /** Denormalised so a list of topics costs one query, not one per row. */
  replyCount: number;
  /** Drives the default sort: a topic is "active" when somebody last replied. */
  lastReplyAt: Date;
  lastReplyBy: mongoose.Types.ObjectId | null;
  /** Staff can pin a topic to the top of its section, and lock it to new replies. */
  pinned: boolean;
  locked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const topicSchema = new Schema<ITopic>(
  {
    title: { type: String, required: true, trim: true, minlength: 8, maxlength: 140 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    body: { type: String, required: true, trim: true, minlength: 20, maxlength: 8000 },
    section: { type: String, enum: TOPIC_SECTIONS, required: true, index: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    replyCount: { type: Number, default: 0, min: 0 },
    /*
     * Seeded to the topic's own creation time rather than left null.
     *
     * The list sorts on this, and a null would sort a brand new topic to the
     * bottom — the exact opposite of what somebody who just posted expects.
     */
    lastReplyAt: { type: Date, default: Date.now, index: true },
    lastReplyBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    pinned: { type: Boolean, default: false },
    locked: { type: Boolean, default: false },
  },
  { timestamps: true },
);

/* The forum's only two list queries: a section by activity, and everything. */
topicSchema.index({ section: 1, pinned: -1, lastReplyAt: -1 });
topicSchema.index({ pinned: -1, lastReplyAt: -1 });
topicSchema.index({ title: 'text', body: 'text' });

export const Topic: Model<ITopic> =
  mongoose.models.Topic ?? mongoose.model<ITopic>('Topic', topicSchema);

/**
 * One reply in a topic.
 *
 * Flat, not threaded. Deck's launch comments are threaded because they are
 * reactions to a fixed thing and branch naturally; a forum thread is a
 * conversation in sequence, and nesting turns "what did people conclude" into
 * an archaeology exercise. Replying to a specific person is a quote, not a
 * subtree.
 */
export interface IReply extends Document {
  _id: mongoose.Types.ObjectId;
  topic: mongoose.Types.ObjectId;
  author: mongoose.Types.ObjectId;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

const replySchema = new Schema<IReply>(
  {
    topic: { type: Schema.Types.ObjectId, ref: 'Topic', required: true, index: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    body: { type: String, required: true, trim: true, minlength: 2, maxlength: 8000 },
  },
  { timestamps: true },
);

/* Oldest first, which is how a conversation reads. */
replySchema.index({ topic: 1, createdAt: 1 });

export const Reply: Model<IReply> =
  mongoose.models.Reply ?? mongoose.model<IReply>('Reply', replySchema);
