import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface IComment extends Document {
  _id: mongoose.Types.ObjectId;
  item: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  body: string;
  /** 1–5 stars. Present when the comment is a review. */
  rating?: number;
  parent?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const commentSchema = new Schema<IComment>(
  {
    item: { type: Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    body: { type: String, required: true, trim: true, minlength: 2, maxlength: 2000 },
    rating: { type: Number, min: 1, max: 5 },
    parent: { type: Schema.Types.ObjectId, ref: 'Comment', default: null, index: true },
  },
  { timestamps: true },
);

commentSchema.index({ item: 1, createdAt: -1 });

export const Comment: Model<IComment> =
  mongoose.models.Comment ?? mongoose.model<IComment>('Comment', commentSchema);
