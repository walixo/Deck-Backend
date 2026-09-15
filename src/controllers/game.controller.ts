import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Game } from '../models/Game';
import { Score } from '../models/Score';
import { toGameResponse, toGameSummary, toScoreResponse } from '../serializers';
import { audit } from '../services/audit';
import { ApiError } from '../utils/ApiError';
import { uniqueSlug } from '../utils/slug';
import type { SubmitScoreInput } from '../validators/score.validators';
import type {
  ListGamesQuery,
  ReviewGameInput,
  SubmitGameInput,
  UpdateGameInput,
} from '../validators/game.validators';

const AUTHOR_FIELDS = 'name username avatarUrl headline verified';

/** The arcade. Approved games only, Deck's featured ones first. */
export async function listGames(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListGamesQuery;
  const skip = (query.page - 1) * query.limit;

  const filter: mongoose.FilterQuery<typeof Game> = { status: 'approved' };
  if (query.genre) filter.genre = query.genre;

  const [total, games] = await Promise.all([
    Game.countDocuments(filter),
    Game.find(filter)
      .sort({ featured: -1, plays: -1, createdAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate('author', AUTHOR_FIELDS),
  ]);

  res.json({
    success: true,
    data: games.map(toGameSummary),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.max(1, Math.ceil(total / query.limit)),
      hasMore: skip + games.length < total,
    },
  });
}

/** Everything the signed-in user has submitted, whatever its status. */
export async function listMyGames(req: Request, res: Response): Promise<void> {
  const games = await Game.find({ author: req.user!._id })
    .sort({ createdAt: -1 })
    .populate('author', AUTHOR_FIELDS);

  res.json({ success: true, data: games.map(toGameSummary) });
}

/**
 * One game.
 *
 * A pending or rejected game is readable by its author and by staff, so a
 * submitter can see and share what they sent before anyone has looked at it.
 * To everybody else it does not exist — a 404 rather than a 403, because
 * confirming "there is a game here you may not see" leaks the slug.
 */
export async function getGame(req: Request, res: Response): Promise<void> {
  const game = await Game.findOne({ slug: req.params.slug }).populate('author', AUTHOR_FIELDS);
  if (!game) throw ApiError.notFound('We could not find that game');

  if (game.status !== 'approved') {
    const viewer = req.user;
    const isAuthor = viewer && game.author && game.author._id.equals(viewer._id);
    const isStaff = viewer?.role === 'admin';
    if (!isAuthor && !isStaff) throw ApiError.notFound('We could not find that game');
  }

  res.json({ success: true, data: toGameResponse(game) });
}

/** Submit a game for review. Always lands as `pending`, never embeddable. */
export async function submitGame(req: Request, res: Response): Promise<void> {
  const input = req.body as SubmitGameInput;

  const game = await Game.create({
    title: input.title,
    slug: await uniqueSlug(input.title, async (candidate) =>
      Boolean(await Game.exists({ slug: candidate })),
    ),
    tagline: input.tagline,
    description: input.description,
    genre: input.genre,
    coverUrl: input.coverUrl ?? '',
    kind: 'external',
    playUrl: input.playUrl,
    author: req.user!._id,
    status: 'pending',
  });

  await game.populate('author', AUTHOR_FIELDS);
  res.status(201).json({ success: true, data: toGameResponse(game) });
}

/**
 * Edit a submission.
 *
 * The author may edit while it is pending or rejected, and doing so on a
 * rejected game sends it back to pending — the point of a rejection note is
 * that it can be answered. An approved listing is frozen to its author: it has
 * been reviewed, and letting the URL be swapped afterwards would make the
 * review meaningless. Staff can edit at any point.
 */
export async function updateGame(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateGameInput;
  const game = await Game.findOne({ slug: req.params.slug });
  if (!game) throw ApiError.notFound('We could not find that game');

  const isStaff = req.user!.role === 'admin';
  const isAuthor = Boolean(game.author?.equals(req.user!._id));
  if (!isAuthor && !isStaff) throw ApiError.forbidden('That is not your game');

  if (isAuthor && !isStaff && game.status === 'approved') {
    throw ApiError.forbidden(
      'Approved games cannot be edited. Ask us to take it down and submit it again.',
    );
  }

  if (input.title !== undefined) game.title = input.title;
  if (input.tagline !== undefined) game.tagline = input.tagline;
  if (input.description !== undefined) game.description = input.description;
  if (input.genre !== undefined) game.genre = input.genre;
  if (input.coverUrl !== undefined) game.coverUrl = input.coverUrl;
  if (input.playUrl !== undefined && game.kind === 'external') game.playUrl = input.playUrl;

  if (isAuthor && game.status === 'rejected') {
    game.status = 'pending';
    game.reviewNote = '';
  }

  await game.save();
  await game.populate('author', AUTHOR_FIELDS);

  if (isStaff && !isAuthor) {
    await audit(req, {
      action: 'game.edited',
      targetType: 'game',
      targetId: game._id,
      targetLabel: game.title,
      summary: `Edited "${game.title}", a game belonging to someone else`,
      after: { fields: Object.keys(input) },
    });
  }

  res.json({ success: true, data: toGameResponse(game) });
}

/** Staff's verdict on a submission. */
export async function reviewGame(req: Request, res: Response): Promise<void> {
  const input = req.body as ReviewGameInput;
  const game = await Game.findById(req.params.id);
  if (!game) throw ApiError.notFound('We could not find that game');

  const before = game.status;
  game.status = input.status;
  game.reviewNote = input.reviewNote?.trim() ?? '';
  game.reviewedBy = req.user!._id;
  game.reviewedAt = new Date();
  if (input.embeddable !== undefined) game.embeddable = input.embeddable;
  if (input.featured !== undefined) game.featured = input.featured;

  await game.save();
  await game.populate('author', AUTHOR_FIELDS);

  await audit(req, {
    action: input.status === 'approved' ? 'game.approved' : 'game.rejected',
    targetType: 'game',
    targetId: game._id,
    targetLabel: game.title,
    summary: `${input.status === 'approved' ? 'Approved' : 'Rejected'} "${game.title}"`,
    before: { status: before },
    after: { status: game.status, embeddable: game.embeddable, featured: game.featured },
  });

  res.json({ success: true, data: toGameResponse(game) });
}

/** Every submission, for the review queue. Newest first, pending at the top. */
export async function listAllGames(_req: Request, res: Response): Promise<void> {
  const games = await Game.find().sort({ createdAt: -1 }).populate('author', AUTHOR_FIELDS);

  const rank: Record<string, number> = { pending: 0, approved: 1, rejected: 2 };
  games.sort((a, b) => rank[a.status] - rank[b.status]);

  res.json({ success: true, data: games.map(toGameSummary) });
}

/** Author or staff. Removing a game removes the listing, not the game. */
export async function deleteGame(req: Request, res: Response): Promise<void> {
  const game = await Game.findOne({ slug: req.params.slug });
  if (!game) throw ApiError.notFound('We could not find that game');

  const isStaff = req.user!.role === 'admin';
  const isAuthor = Boolean(game.author?.equals(req.user!._id));
  if (!isAuthor && !isStaff) throw ApiError.forbidden('That is not your game');

  /* Deck's own games are part of the frontend build; deleting the row would
     leave a component nothing points at and a shelf with a hole in it. */
  if (game.kind === 'builtin') {
    throw ApiError.forbidden("Deck's own games are part of the site, not listings");
  }

  await game.deleteOne();

  if (isStaff && !isAuthor) {
    await audit(req, {
      action: 'game.removed',
      targetType: 'game',
      targetId: game._id,
      targetLabel: game.title,
      summary: `Removed "${game.title}" from the arcade`,
    });
  }

  res.json({ success: true, data: { removed: true } });
}

/**
 * Counts a play.
 *
 * `$inc` rather than read-modify-write: two people starting the same game in
 * the same second would otherwise each read the same number and write the same
 * number, and one of the plays would vanish. Nothing else on the document is
 * touched, so this cannot race with an edit either.
 */
export async function recordPlay(req: Request, res: Response): Promise<void> {
  const game = await Game.findOneAndUpdate(
    { slug: req.params.slug, status: 'approved' },
    { $inc: { plays: 1 } },
    { new: true, projection: { plays: 1 } },
  );
  if (!game) throw ApiError.notFound('We could not find that game');

  res.json({ success: true, data: { plays: game.plays } });
}

/** How many places the board shows. Ten is a leaderboard; fifty is a phone book. */
const BOARD_SIZE = 10;

/**
 * The all-time top scores for one game.
 *
 * Public: a leaderboard nobody can read until they sign in is not a
 * leaderboard. Only approved games have one, for the same reason only approved
 * games are listed.
 */
export async function listScores(req: Request, res: Response): Promise<void> {
  const game = await Game.findOne({ slug: req.params.slug, status: 'approved' }).select('_id');
  if (!game) throw ApiError.notFound('We could not find that game');

  const [top, total] = await Promise.all([
    Score.find({ game: game._id })
      .sort({ score: -1, achievedAt: 1 })
      .limit(BOARD_SIZE)
      .populate('user', AUTHOR_FIELDS),
    Score.countDocuments({ game: game._id }),
  ]);

  /*
   * Ties are broken by who got there first, and rank is computed here rather
   * than taken from the array index — two players on the same score share a
   * place, which is what a leaderboard means and what `index + 1` gets wrong.
   */
  let rank = 0;
  let previous: number | null = null;
  const rows = top.map((entry, index) => {
    if (entry.score !== previous) {
      rank = index + 1;
      previous = entry.score;
    }
    return toScoreResponse(entry, rank);
  });

  /* The signed-in player's own standing, even when they are not in the top ten
     — "you are 34th" is the number they actually came for. */
  let you: { rank: number; score: number } | null = null;
  if (req.user) {
    const mine = await Score.findOne({ game: game._id, user: req.user._id });
    if (mine) {
      const above = await Score.countDocuments({ game: game._id, score: { $gt: mine.score } });
      you = { rank: above + 1, score: mine.score };
    }
  }

  res.json({ success: true, data: { scores: rows, players: total, you } });
}

/**
 * Records a score, keeping only the player's best.
 *
 * `$max` rather than a read, compare and write. Two tabs finishing runs at the
 * same moment would both read the old best and both write their own, and the
 * lower one could land second and erase the higher. `$max` makes the comparison
 * the database's problem, so it cannot go backwards.
 *
 * `achievedAt` is only stamped when the score is genuinely new, which is what
 * keeps tie-breaking honest — a resubmitted equal score must not jump the
 * player ahead of somebody who reached it first.
 */
export async function submitScore(req: Request, res: Response): Promise<void> {
  const { score } = req.body as SubmitScoreInput;

  const game = await Game.findOne({ slug: req.params.slug, status: 'approved' }).select('_id');
  if (!game) throw ApiError.notFound('We could not find that game');

  const existing = await Score.findOne({ game: game._id, user: req.user!._id }).select('score');
  const improved = !existing || score > existing.score;

  await Score.updateOne(
    { game: game._id, user: req.user!._id },
    {
      $max: { score },
      ...(improved ? { $set: { achievedAt: new Date() } } : {}),
      $setOnInsert: { game: game._id, user: req.user!._id },
    },
    { upsert: true },
  );

  const above = await Score.countDocuments({ game: game._id, score: { $gt: score } });
  res.status(201).json({
    success: true,
    data: { best: Math.max(score, existing?.score ?? 0), improved, rank: above + 1 },
  });
}
