import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { env } from '../config/env';
import type { VaultKey } from './VaultPartner';

/**
 * Vault's supply side: a merchant who issues gift cards, and the products they
 * issue.
 *
 * This is the half of the business Deck used to be on the other end of. Deck
 * buys other brands' cards from Reloadly (see `services/reloadly.ts`); Vault is
 * Deck being the Reloadly — a merchant signs up, lists their own card, and
 * other businesses buy it through one API.
 *
 * An issuer is deliberately not a `User`. The person who signs up owns the
 * issuer, but a card programme outlives whoever created the account, and the
 * things attached to it — a settlement balance, live cards in strangers'
 * hands — belong to the business rather than to a login.
 */

export const ISSUER_STATUSES = ['draft', 'pending', 'live', 'paused', 'rejected'] as const;
export type IssuerStatus = (typeof ISSUER_STATUSES)[number];

/**
 * Who mints the code on a card.
 *
 * `deck` — Vault generates it, holds the balance and handles redemption. A
 * merchant is live the same day with nothing to build, which is what makes
 * signup self-serve.
 *
 * `merchant` — Vault calls the merchant's endpoint and they mint a code in
 * their own system, so the card is native to their wallet or POS from the
 * moment it exists. Costs them an API, and costs Vault the retry and
 * reconciliation machinery in `services/vaultFulfil.ts`.
 *
 * Which one an issuer is on changes who is the system of record for a card's
 * balance, so it is fixed per issuer rather than per product: a merchant whose
 * own system knows about half their cards has no usable report.
 */
export const FULFILMENT_MODES = ['deck', 'merchant'] as const;
export type FulfilmentMode = (typeof FULFILMENT_MODES)[number];

export interface IVaultIssuer extends Document {
  _id: mongoose.Types.ObjectId;
  owner: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  logoUrl: string;
  /** Shown to a buyer before purchase, and on the card itself. */
  terms: string;
  supportEmail: string;
  website: string;
  currency: string;
  status: IssuerStatus;
  reviewNote: string;
  reviewedBy: mongoose.Types.ObjectId | null;
  reviewedAt: Date | null;

  fulfilment: FulfilmentMode;
  /** `merchant` mode: where Vault POSTs to have a card minted. https only. */
  fulfilUrl: string | null;
  /** HMAC key for those calls, so the merchant can verify they came from Deck. */
  fulfilSecret: string;

  /**
   * How far below face value a distributor buys at, as a percentage.
   *
   * This is the issuer's whole pitch to the distribution side and the reason
   * anyone resells a card: ₦10,000 of Chowdeck for ₦9,200. It is set per
   * issuer and overridable per product.
   */
  discountPercent: number;
  /** 0 means cards from this issuer never expire. */
  defaultExpiryDays: number;

  /**
   * Keys for the issuer's own API — checking a card and redeeming it at a till.
   *
   * Separate from a partner's, and prefixed `vli_` rather than `vlt_`, so a
   * key resolves to exactly one record without two collections being searched.
   * The two sides do opposite things — one spends money to create cards, the
   * other destroys value on them — and a credential that could do both because
   * the lookup was ambiguous is the kind of mistake that only shows up once.
   */
  keys: { test: VaultKey | null; live: VaultKey | null };

  createdAt: Date;
  updatedAt: Date;
}

const issuerKeySchema = new Schema<VaultKey>(
  {
    hash: { type: String, required: true },
    hint: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const issuerSchema = new Schema<IVaultIssuer>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    tagline: { type: String, default: '', trim: true, maxlength: 140 },
    description: { type: String, default: '', trim: true, maxlength: 4000 },
    logoUrl: { type: String, default: '' },
    terms: { type: String, default: '', maxlength: 4000 },
    supportEmail: { type: String, default: '', trim: true, lowercase: true },
    website: { type: String, default: '', trim: true },
    currency: { type: String, default: () => env.currency, uppercase: true, minlength: 3, maxlength: 3 },
    status: { type: String, enum: ISSUER_STATUSES, default: 'draft', index: true },
    reviewNote: { type: String, default: '', maxlength: 600 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },

    fulfilment: { type: String, enum: FULFILMENT_MODES, default: 'deck' },
    fulfilUrl: { type: String, default: null },
    /* Vault needs this to sign with, so it is stored as-is and kept out of
       every query by default — the same rule as a game's webhook secret. */
    fulfilSecret: { type: String, default: '', select: false },

    discountPercent: { type: Number, default: 5, min: 0, max: 90 },
    defaultExpiryDays: { type: Number, default: 365, min: 0, max: 3650 },
    keys: {
      test: { type: issuerKeySchema, default: null },
      live: { type: issuerKeySchema, default: null },
    },
  },
  { timestamps: true },
);

/* The storefront's list query: live issuers, newest first. */
issuerSchema.index({ status: 1, createdAt: -1 });

/* How a merchant's till is recognised, the same way a partner's server is. */
issuerSchema.index({ 'keys.test.hash': 1 }, { sparse: true });
issuerSchema.index({ 'keys.live.hash': 1 }, { sparse: true });

/*
 * A merchant-fulfilled issuer is not sellable without somewhere to call.
 *
 * Enforced on the model rather than only in the validator because staff tools
 * and scripts write issuers too, and an issuer in `merchant` mode with no
 * `fulfilUrl` fails at the worst possible moment — after a distributor's
 * money has already moved.
 */
issuerSchema.pre('validate', function enforceFulfilment(next) {
  if (this.fulfilment === 'merchant') {
    if (!this.fulfilUrl) {
      return next(new Error('An issuer that mints its own codes needs a fulfilment URL'));
    }
    if (!/^https:\/\//i.test(this.fulfilUrl)) {
      return next(new Error('The fulfilment URL must be https'));
    }
  } else {
    this.fulfilUrl = null;
  }
  return next();
});

export const VaultIssuer: Model<IVaultIssuer> =
  mongoose.models.VaultIssuer ?? mongoose.model<IVaultIssuer>('VaultIssuer', issuerSchema);

/* ------------------------------------------------------------------ products */

export const DENOMINATION_TYPES = ['fixed', 'range'] as const;
export type DenominationType = (typeof DENOMINATION_TYPES)[number];

export const PRODUCT_STATUSES = ['active', 'paused'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export interface IVaultProduct extends Document {
  _id: mongoose.Types.ObjectId;
  issuer: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  artworkUrl: string;
  redeemInstructions: string;
  currency: string;

  denominationType: DenominationType;
  /** `fixed`: the amounts on offer, in minor units, ascending. */
  denominationsMinor: number[];
  /** `range`: the ends a buyer may choose between, in minor units. */
  minMinor: number;
  maxMinor: number;

  /** Null inherits the issuer's. A number here overrides it. */
  discountPercent: number | null;
  /** Null inherits the issuer's default. 0 means no expiry. */
  expiryDays: number | null;

  status: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IVaultProduct>(
  {
    issuer: { type: Schema.Types.ObjectId, ref: 'VaultIssuer', required: true, index: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    artworkUrl: { type: String, default: '' },
    redeemInstructions: { type: String, default: '', maxlength: 2000 },
    currency: { type: String, default: () => env.currency, uppercase: true },

    denominationType: { type: String, enum: DENOMINATION_TYPES, default: 'fixed' },
    denominationsMinor: [{ type: Number, min: 1 }],
    minMinor: { type: Number, default: 0, min: 0 },
    maxMinor: { type: Number, default: 0, min: 0 },

    discountPercent: { type: Number, default: null, min: 0, max: 90 },
    expiryDays: { type: Number, default: null, min: 0, max: 3650 },

    status: { type: String, enum: PRODUCT_STATUSES, default: 'active', index: true },
  },
  { timestamps: true },
);

/* A product's slug only has to be unique inside its own issuer, so two
   merchants can both have a "standard" card. */
productSchema.index({ issuer: 1, slug: 1 }, { unique: true });

productSchema.pre('validate', function enforceDenominations(next) {
  if (this.denominationType === 'fixed') {
    if (!this.denominationsMinor?.length) {
      return next(new Error('A fixed-denomination card needs at least one amount'));
    }
    /* Sorted and deduplicated here so every reader — the API, the storefront,
       the dashboard — gets them in one order without each one sorting. */
    this.denominationsMinor = [...new Set(this.denominationsMinor)].sort((a, b) => a - b);
    this.minMinor = this.denominationsMinor[0];
    this.maxMinor = this.denominationsMinor[this.denominationsMinor.length - 1];
  } else {
    if (!this.minMinor || !this.maxMinor) {
      return next(new Error('A range card needs both a smallest and a largest amount'));
    }
    if (this.minMinor > this.maxMinor) {
      return next(new Error('The smallest amount cannot be above the largest'));
    }
    this.denominationsMinor = [];
  }
  return next();
});

export const VaultProduct: Model<IVaultProduct> =
  mongoose.models.VaultProduct ?? mongoose.model<IVaultProduct>('VaultProduct', productSchema);
