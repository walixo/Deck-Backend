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
  createdAt: Date;
  updatedAt: Date;
}

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
  },
  { timestamps: true },
);

/* The arcade's only list query: approved games, Deck's featured ones first,
   then the most played. */
gameSchema.index({ status: 1, featured: -1, plays: -1 });

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

export const Game: Model<IGame> =
  mongoose.models.Game ?? mongoose.model<IGame>('Game', gameSchema);
