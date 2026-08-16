import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { CURRENCY, ORDER_STATUSES, type OrderStatus } from '../constants';

/**
 * Order lines snapshot the product name and price at purchase time. If the shop
 * later raises a price or renames a tee, the customer's order must still show
 * what they actually bought.
 */
export interface IOrderLine {
  product: mongoose.Types.ObjectId;
  sku: string;
  name: string;
  size?: string;
  colour?: string;
  unitPriceMinor: number;
  quantity: number;
  image?: string;
  /** Who sold it. Null means Deck's own stock. */
  seller: mongoose.Types.ObjectId | null;
}

/**
 * What Deck owes one seller for this order.
 *
 * The whole charge lands in Deck's account, so this is the record of a debt,
 * not of a transfer. It is frozen at checkout: the fee percentage can change
 * next week, but what this seller earned on this sale cannot.
 *
 * `netMinor` is the payable figure — goods, less Deck's cut, plus their share
 * of the shipping the buyer paid, since they are the one posting the parcel.
 * The fee is charged on goods only: shipping is a cost passed through, and
 * taking commission on postage would mean Deck profits from the courier.
 */
export interface IOrderShare {
  seller: mongoose.Types.ObjectId;
  goodsMinor: number;
  platformFeeMinor: number;
  shippingMinor: number;
  netMinor: number;
}

export interface IShippingAddress {
  fullName: string;
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  country: string;
}

/** What we know about the Paystack transaction backing this order. */
export interface IPayment {
  provider: 'paystack';
  /** Paystack uses our order reference as its transaction reference. */
  reference: string;
  authorizationUrl?: string;
  paidAt?: Date;
  channel?: string;
  /** Amount Paystack actually confirmed, kept for reconciliation. */
  amountMinor?: number;
}

export interface IOrder extends Document {
  _id: mongoose.Types.ObjectId;
  reference: string;
  user: mongoose.Types.ObjectId;
  email: string;
  lines: IOrderLine[];
  subtotalMinor: number;
  shippingMinor: number;
  totalMinor: number;
  /** Deck's total cut across every seller's lines. */
  platformFeeMinor: number;
  /** One entry per seller with something in this order. */
  sellerShares: IOrderShare[];
  currency: string;
  status: OrderStatus;
  shippingAddress: IShippingAddress;
  payment?: IPayment;
  createdAt: Date;
  updatedAt: Date;
}

const orderLineSchema = new Schema<IOrderLine>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'MerchProduct', required: true },
    sku: { type: String, required: true },
    name: { type: String, required: true },
    size: String,
    colour: String,
    unitPriceMinor: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    image: String,
    seller: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  },
  { _id: false },
);

const orderShareSchema = new Schema<IOrderShare>(
  {
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    goodsMinor: { type: Number, required: true, min: 0 },
    platformFeeMinor: { type: Number, required: true, min: 0, default: 0 },
    shippingMinor: { type: Number, required: true, min: 0, default: 0 },
    netMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const shippingAddressSchema = new Schema<IShippingAddress>(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 80 },
    line1: { type: String, required: true, trim: true, maxlength: 120 },
    line2: { type: String, trim: true, maxlength: 120 },
    city: { type: String, required: true, trim: true, maxlength: 80 },
    postcode: { type: String, required: true, trim: true, maxlength: 20 },
    country: { type: String, required: true, trim: true, maxlength: 60 },
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder>(
  {
    /** Human-quotable identifier, e.g. DECK-7F3K2A. */
    reference: { type: String, required: true, unique: true, uppercase: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    lines: { type: [orderLineSchema], required: true },
    subtotalMinor: { type: Number, required: true, min: 0 },
    shippingMinor: { type: Number, required: true, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
    platformFeeMinor: { type: Number, default: 0, min: 0 },
    sellerShares: { type: [orderShareSchema], default: [] },
    currency: { type: String, default: CURRENCY, uppercase: true },
    status: { type: String, enum: ORDER_STATUSES, default: 'awaiting_payment', index: true },
    shippingAddress: { type: shippingAddressSchema, required: true },
    payment: {
      type: new Schema<IPayment>(
        {
          provider: { type: String, default: 'paystack' },
          reference: { type: String, required: true },
          authorizationUrl: String,
          paidAt: Date,
          channel: String,
          amountMinor: Number,
        },
        { _id: false },
      ),
      required: false,
    },
  },
  { timestamps: true },
);

orderSchema.index({ user: 1, createdAt: -1 });

export const Order: Model<IOrder> =
  mongoose.models.Order ?? mongoose.model<IOrder>('Order', orderSchema);
