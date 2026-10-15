import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * Webhook events already handled, so a redelivery is recognised.
 *
 * Bachs delivers at least once and says to deduplicate on the event `id`. The
 * apply functions are idempotent on their own, so this is not what prevents
 * double-charging — it is what stops a redelivered event doing work twice
 * (a second notification, a second audit entry, a second transfer attempt).
 *
 * Kept for thirty days. Bachs gives up after about eighty minutes of retries
 * and a manual resend is the only thing that arrives later; a month covers any
 * of those with a wide margin, and the collection stops growing.
 */
export interface IWebhookEvent extends Document {
  eventId: string;
  type: string;
  /** Set when the event was acknowledged without being applied, and why. */
  note?: string;
  expiresAt: Date;
}

const webhookEventSchema = new Schema<IWebhookEvent>(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    note: { type: String, maxlength: 500 },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

webhookEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WebhookEvent: Model<IWebhookEvent> =
  mongoose.models.WebhookEvent ?? mongoose.model<IWebhookEvent>('WebhookEvent', webhookEventSchema);
