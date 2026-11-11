import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { env } from '../config/env';

/**
 * Vault's demand side: a business that connects to buy issuers' cards.
 *
 * The shape deliberately mirrors `Game` on the Deck Games platform — a test
 * key and a live key, each stored as a hash with a four-character hint, plus a
 * webhook URL and a signing secret. A developer who has integrated one has
 * already integrated the other, and there is one set of habits to learn rather
 * than two.
 */

export const PARTNER_STATUSES = ['pending', 'live', 'suspended'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const VAULT_MODES = ['test', 'live'] as const;
export type VaultMode = (typeof VAULT_MODES)[number];

/**
 * An API key, stored as a hash. The key is shown once, when it is minted, and
 * never again. `hint` is its last four characters, so a partner can tell which
 * key a server is holding without Deck being able to tell them the rest.
 */
export interface VaultKey {
  hash: string;
  hint: string;
  createdAt: Date;
}

export interface IVaultPartner extends Document {
  _id: mongoose.Types.ObjectId;
  owner: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  website: string;
  logoUrl: string;
  status: PartnerStatus;
  keys: { test: VaultKey | null; live: VaultKey | null };
  /** Where Vault POSTs signed events — `order.fulfilled` above all. https only. */
  webhookUrl: string | null;
  webhookSecret: string;
  createdAt: Date;
  updatedAt: Date;
}

const keySchema = new Schema<VaultKey>(
  {
    hash: { type: String, required: true },
    hint: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const partnerSchema = new Schema<IVaultPartner>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    website: { type: String, default: '', trim: true },
    logoUrl: { type: String, default: '' },
    status: { type: String, enum: PARTNER_STATUSES, default: 'pending', index: true },
    keys: {
      test: { type: keySchema, default: null },
      live: { type: keySchema, default: null },
    },
    webhookUrl: { type: String, default: null },
    webhookSecret: { type: String, default: '', select: false },
  },
  { timestamps: true },
);

/* How a partner's server is recognised: by the hash of the key it sends.
   Sparse, because a partner in test only has no live key at all. */
partnerSchema.index({ 'keys.test.hash': 1 }, { sparse: true });
partnerSchema.index({ 'keys.live.hash': 1 }, { sparse: true });

export const VaultPartner: Model<IVaultPartner> =
  mongoose.models.VaultPartner ?? mongoose.model<IVaultPartner>('VaultPartner', partnerSchema);

/* -------------------------------------------------------------------- wallet */

export const LEDGER_KINDS = ['topup', 'order', 'refund', 'adjustment'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/**
 * One movement on a partner's prepaid balance.
 *
 * Partners prepay and orders debit, which is how Reloadly works and the only
 * model that lets an order be fulfilled synchronously — a card has to be minted
 * while the caller is still on the phone, and that cannot wait on a card
 * payment clearing.
 *
 * The balance is the sum of these rows, computed on read, never stored. This
 * follows `services/ledger.ts` and for the same reason: a stored total goes
 * wrong the first time an increment fails after its transaction committed, and
 * on a balance nobody external reconciles, nothing would ever notice. Summing
 * costs an aggregation and buys the property that it cannot silently drift.
 *
 * `amountMinor` is signed — credits positive, debits negative — so the balance
 * is a plain `$sum` with no case analysis anywhere.
 *
 * Test and live have separate balances. Test money is granted on signup and is
 * not real, so mixing the two would let a partner spend play money on live
 * cards that cost Deck real cash with an issuer.
 */
export interface IVaultLedgerEntry extends Document {
  _id: mongoose.Types.ObjectId;
  partner: mongoose.Types.ObjectId;
  mode: VaultMode;
  kind: LedgerKind;
  /** Signed. Credits positive, debits negative. */
  amountMinor: number;
  currency: string;
  /** The order, top-up or adjustment this movement came from. */
  reference: string;
  order: mongoose.Types.ObjectId | null;
  note: string;
  createdAt: Date;
}

const ledgerSchema = new Schema<IVaultLedgerEntry>(
  {
    partner: { type: Schema.Types.ObjectId, ref: 'VaultPartner', required: true },
    mode: { type: String, enum: VAULT_MODES, required: true },
    kind: { type: String, enum: LEDGER_KINDS, required: true },
    amountMinor: { type: Number, required: true },
    currency: { type: String, default: () => env.currency, uppercase: true },
    reference: { type: String, required: true },
    order: { type: Schema.Types.ObjectId, ref: 'VaultOrder', default: null },
    note: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/* The balance query, and the statement, are the same shape. */
ledgerSchema.index({ partner: 1, mode: 1, createdAt: -1 });

/*
 * No movement is ever written twice under the same reference.
 *
 * This is what makes a retried top-up callback or a replayed order safe: the
 * second write fails on the index rather than crediting the balance again.
 */
ledgerSchema.index({ partner: 1, reference: 1 }, { unique: true });

export const VaultLedgerEntry: Model<IVaultLedgerEntry> =
  mongoose.models.VaultLedgerEntry ??
  mongoose.model<IVaultLedgerEntry>('VaultLedgerEntry', ledgerSchema);

/* ------------------------------------------------------------------ topups */

export const TOPUP_STATUSES = ['pending', 'paid', 'failed', 'cancelled'] as const;
export type TopupStatus = (typeof TOPUP_STATUSES)[number];

/**
 * A partner putting real money on their live balance.
 *
 * A separate record from the ledger movement it eventually causes, because the
 * two happen at different times and only one of them is certain: the top-up
 * exists the moment someone presses pay, and the ledger entry exists only once
 * Bachs confirms. Writing the movement optimistically and reversing it on
 * failure would mean a balance that is briefly wrong in the one direction that
 * lets a partner spend money they do not have.
 *
 * Test balances never come through here — those are granted, not bought.
 */
export interface IVaultTopup extends Document {
  _id: mongoose.Types.ObjectId;
  partner: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  mode: VaultMode;
  amountMinor: number;
  currency: string;
  reference: string;
  checkoutId: string | null;
  status: TopupStatus;
  paidAt: Date | null;
  chargeId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const topupSchema = new Schema<IVaultTopup>(
  {
    partner: { type: Schema.Types.ObjectId, ref: 'VaultPartner', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mode: { type: String, enum: VAULT_MODES, default: 'live' },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, default: () => env.currency, uppercase: true },
    reference: { type: String, required: true, unique: true },
    checkoutId: { type: String, default: null, index: true },
    status: { type: String, enum: TOPUP_STATUSES, default: 'pending', index: true },
    paidAt: { type: Date, default: null },
    chargeId: { type: String, default: null },
  },
  { timestamps: true },
);

export const VaultTopup: Model<IVaultTopup> =
  mongoose.models.VaultTopup ?? mongoose.model<IVaultTopup>('VaultTopup', topupSchema);
