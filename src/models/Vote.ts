import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface IVote extends Document {
  _id: mongoose.Types.ObjectId;
  item: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const voteSchema = new Schema<IVote>(
  {
    item: { type: Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true },
);

// One vote per user per item.
voteSchema.index({ item: 1, user: 1 }, { unique: true });

export const Vote: Model<IVote> = mongoose.models.Vote ?? mongoose.model<IVote>('Vote', voteSchema);
