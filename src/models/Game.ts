import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * A game on Deck's arcade.
 *
 * Two sorts share this collection. `builtin` games are Deck's own, rendered by
 * a component the frontend already ships — there is nothing to fetch and
 * nothing to trust. `external` games belong to somebody else and live at their
 * URL.
 *
 * They share a collection because they share a shelf: the arcade lists them
 * together, ranked together, and a reader should not have to care who wrote
 * which. Splitting them would mean two queries, two shapes and two sort orders
 * to merge on every page load, for a distinction that only matters at the
 * moment of rendering the play button.
 */
export const GAME_GENRES = ['arcade', 'puzzle', 'action', 'strategy', 'idle', 'other'] as const;
export type GameGenre = (typeof GAME_GENRES)[number];

export const GAME_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

/**
 * The shape a game is built for. The player sizes its frame from this — a
 * portrait game in a landscape box is a column of black bars — and on a phone
 * held the wrong way it asks to be turned rather than shrinking the game.
 * `both` means the game reflows to whatever it is given.
 */
export const GAME_ORIENTATIONS = ['landscape', 'portrait', 'both'] as const;
export type GameOrientation = (typeof GAME_ORIENTATIONS)[number];

export type GameKeyMode = 'test' | 'live';

/** Room sizes a game may ask for. Two is the least a "multi" can mean. */
export const MULTIPLAYER_MIN = 2;
export const MULTIPLAYER_MAX = 16;

/**
 * Whether a game plays with other people through Deck, and how many.
 *
 * Off by default: a single-player game should never see a lobby. When on,
 * the game can create, join and quick-match rooms through the SDK, and Deck
 * relays messages between the players in a room.
 */
export interface GameMultiplayer {
  enabled: boolean;
  minPlayers: number;
  maxPlayers: number;
}

/**
 * A developer API key, stored as a hash. The key itself is shown once, at the
 * moment it is minted, and never again — the same rule as a password. `hint`
 * is the last four characters, so a developer can tell which key a server is
 * holding without Deck being able to tell them the rest.
 */
export interface GameKey {
  hash: string;
  hint: string;
  createdAt: Date;
}

export interface IGame extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  slug: string;
  tagline: string;
  description: string;
  genre: GameGenre;
  coverUrl: string;
  /** Deck's own, or somebody else's. */
  kind: 'builtin' | 'external';
  /**
   * For `builtin`: which component renders it. A key the frontend maps to a
   * component it already has, never a path and never anything evaluated.
   */
  component: string | null;
  /** For `external`: where the game actually is. */
  playUrl: string | null;
  /**
   * Whether Deck will render it in an iframe rather than link out.
   *
   * Staff-only, and false for everything submitted. Framing a stranger's page
   * inside Deck puts their JavaScript on a Deck-branded screen: it can imitate
   * Deck's own UI, ask for a password with Deck's chrome around it, and be
   * changed to do so long after review. Linking out costs a click and moves the
   * whole risk to a page that is visibly not Deck.
   */
  embeddable: boolean;
  /** Null for Deck's own games, which nobody submitted. */
  author: mongoose.Types.ObjectId | null;
  status: GameStatus;
  reviewNote: string;
  reviewedBy: mongoose.Types.ObjectId | null;
  reviewedAt: Date | null;
  /** Denormalised counter, bumped with `$inc`. Never recomputed. */
  plays: number;
  featured: boolean;

  /* ------------------------------------------- Deck Games platform --- */

  orientation: GameOrientation;
  /** Uses the Deck Games SDK — players, purchases, scores through Deck. */
  sdk: boolean;
  /** Shown as the maker. Empty means the author's own name. */
  studio: string;
  /**
   * Where the developer's work-in-progress build lives, for test play. Only
   * ever loaded for the author (and staff), in test mode. May be
   * `http://localhost` — browsers treat it as secure, so a developer can play
   * their local build inside Deck's real player.
   */
  testUrl: string | null;
  /** Where Deck POSTs signed events — `purchase.paid` above all. https only. */
  webhookUrl: string | null;
  /** HMAC key for those events. Excluded from every query by default. */
  webhookSecret: string;
  keys: { test: GameKey | null; live: GameKey | null };
  multiplayer: GameMultiplayer;

  createdAt: Date;
  updatedAt: Date;
}

const keySchema = new Schema<GameKey>(
  {
    hash: { type: String, required: true },
    hint: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const gameSchema = new Schema<IGame>(
  {
    title: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    tagline: { type: String, required: true, trim: true, minlength: 10, maxlength: 140 },
    description: { type: String, required: true, trim: true, minlength: 40, maxlength: 4000 },
    genre: { type: String, enum: GAME_GENRES, required: true, index: true },
    coverUrl: { type: String, default: '' },
    kind: { type: String, enum: ['builtin', 'external'], default: 'external' },
    component: { type: String, default: null },
    playUrl: { type: String, default: null },
    embeddable: { type: Boolean, default: false },
    author: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    status: { type: String, enum: GAME_STATUSES, default: 'pending', index: true },
    reviewNote: { type: String, default: '', maxlength: 600 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    plays: { type: Number, default: 0, min: 0 },
    featured: { type: Boolean, default: false },

    orientation: { type: String, enum: GAME_ORIENTATIONS, default: 'landscape' },
    sdk: { type: Boolean, default: false },
    studio: { type: String, default: '', trim: true, maxlength: 60 },
    testUrl: { type: String, default: null },
    webhookUrl: { type: String, default: null },
    webhookSecret: { type: String, default: '', select: false },
    keys: {
      test: { type: keySchema, default: null },
      live: { type: keySchema, default: null },
    },
    multiplayer: {
      enabled: { type: Boolean, default: false },
      minPlayers: { type: Number, default: 2, min: MULTIPLAYER_MIN, max: MULTIPLAYER_MAX },
      maxPlayers: { type: Number, default: 4, min: MULTIPLAYER_MIN, max: MULTIPLAYER_MAX },
    },
  },
  { timestamps: true },
);

/* The arcade's only list query: approved games, Deck's featured ones first,
   then the most played. */
gameSchema.index({ status: 1, featured: -1, plays: -1 });

/* How a developer's server is recognised: by the hash of the key it sends.
   Sparse, because most games have no key of one kind or the other. */
gameSchema.index({ 'keys.test.hash': 1 }, { sparse: true });
gameSchema.index({ 'keys.live.hash': 1 }, { sparse: true });

/*
 * A game must be playable in exactly one way.
 *
 * Enforced here rather than in the validator alone, because the validator only
 * sees a submission and this also has to hold for anything staff or a script
 * writes. A builtin with a `playUrl` would silently link out instead of running
 * Deck's own component; an external without one is a shelf entry with no game
 * behind it.
 */
gameSchema.pre('validate', function enforcePlayable(next) {
  if (this.kind === 'builtin') {
    if (!this.component) return next(new Error('A built-in game needs a component key'));
    this.playUrl = null;
  } else {
    if (!this.playUrl) return next(new Error('A hosted game needs a URL to play it at'));
    this.component = null;
  }
  next();
});

export const Game: Model<IGame> = mongoose.models.Game ?? mongoose.model<IGame>('Game', gameSchema);
