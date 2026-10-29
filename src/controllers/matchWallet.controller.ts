import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { MatchCall } from '../models/MatchCall';
import {
  MatchEntry,
  MatchGift,
  MatchLedger,
  MatchTopup,
  MatchVerification,
} from '../models/MatchMoney';
import { MatchProfile, type IMatchProfile } from '../models/MatchProfile';
import { bachsConfigured, createCheckout, getCheckout } from '../services/bachs';
import { env } from '../config/env';
import * as hub from '../services/matchHub';
import { hoursAt, matchDay } from '../services/matchHours';
import { tonight } from '../services/matchNights';
import {
  addCredit,
  applyVerifiedTopup,
  creditTopup,
  extendedPlus,
  isPlus,
  MATCH_CURRENCY,
  MATCH_PLUS_DAYS,
  MATCH_PRICES,
  MATCH_TOPUP_PACKS,
  naira,
  spend,
  topupReference,
} from '../services/matchWallet';
import { ApiError } from '../utils/ApiError';
import type {
  MatchGiftInput,
  MatchTopupInput,
  MatchVerificationInput,
} from '../validators/match.validators';

/**
 * Match's wallet, and everything bought with it.
 *
 * Top-ups are the only step that goes through Bachs's hosted checkout; the
 * money is confirmed by the webhook or by asking Bachs, never by the browser
 * coming back. Everything else — Match+, a themed night, a gift, the badge —
 * spends credit at once, because it happens in the middle of the evening.
 */

/** Poses for the selfie check: easy to do, hard to fake with an old photo. */
const POSES = [
  'a peace sign',
  'a thumbs up',
  'three fingers up',
  'a hand on your head',
  'one finger on your nose',
  'an OK sign',
];

/** Photos larger than this are refused; the screen shrinks them well below it. */
const PHOTO_MAX_BYTES = 600 * 1024;

async function profileOf(req: Request): Promise<IMatchProfile> {
  const profile = await MatchProfile.findOne({ user: req.user!._id });
  if (!profile) throw ApiError.badRequest('Set up Match first');
  return profile;
}

/** Republishes someone's flags to the hub after Match+ or a badge changes. */
function refreshPresence(profile: IMatchProfile): void {
  hub.update({
    userId: String(profile.user),
    gender: profile.gender,
    plus: isPlus(profile),
    verified: Boolean(profile.verifiedAt),
    blocked: profile.blocked.map(String),
  });
}

/** The balance, what things cost, tonight's night and the badge's state. */
export async function getWallet(req: Request, res: Response): Promise<void> {
  const profile = await profileOf(req);
  const night = tonight();
  const day = matchDay(hoursAt().opensAt);
  const [entered, verification, ledger] = await Promise.all([
    night?.theme ? MatchEntry.exists({ user: profile.user, day }) : null,
    MatchVerification.findOne({ user: profile.user }).sort({ createdAt: -1 }),
    MatchLedger.find({ user: profile.user }).sort({ createdAt: -1 }).limit(15),
  ]);
  res.json({
    success: true,
    data: {
      creditMinor: profile.creditMinor,
      currency: MATCH_CURRENCY,
      plusUntil: isPlus(profile) ? profile.plusUntil : null,
      verified: Boolean(profile.verifiedAt),
      verification: verification
        ? { status: verification.status, prompt: verification.prompt, note: verification.note }
        : null,
      tonight: night ? { ...night, entered: Boolean(entered) } : null,
      prices: { ...MATCH_PRICES, plusDays: MATCH_PLUS_DAYS },
      packs: MATCH_TOPUP_PACKS,
      payments: bachsConfigured() || !env.isProduction,
      ledger: ledger.map((row) => ({
        kind: row.kind,
        amountMinor: row.amountMinor,
        note: row.note,
        at: row.createdAt,
      })),
    },
  });
}

/**
 * Starts a top-up: a hosted checkout that brings them back to Match. Where
 * Bachs is not configured outside production, the credit is added at once and
 * marked as a test, so the whole flow can be tried locally.
 */
export async function createTopup(req: Request, res: Response): Promise<void> {
  const { amountMinor } = req.body as MatchTopupInput;
  if (!(MATCH_TOPUP_PACKS as readonly number[]).includes(amountMinor)) {
    throw ApiError.badRequest('Choose one of the top-up amounts');
  }
  const profile = await profileOf(req);
  const reference = topupReference();

  if (!bachsConfigured()) {
    if (env.isProduction) throw ApiError.badRequest('Payments are not available right now');
    const topup = await MatchTopup.create({
      reference,
      user: profile.user,
      amountMinor,
      currency: MATCH_CURRENCY,
      mode: 'test',
    });
    await creditTopup(topup, { paidAt: new Date() });
    const fresh = await MatchProfile.findById(profile._id);
    res.status(201).json({
      success: true,
      data: { reference, status: 'paid', test: true, creditMinor: fresh?.creditMinor ?? 0 },
    });
    return;
  }

  const back = `${env.matchUrl}/?topup=${encodeURIComponent(reference)}`;
  const checkout = await createCheckout({
    amountMinor,
    currency: MATCH_CURRENCY,
    email: req.user!.email,
    name: req.user!.name,
    reference,
    successUrl: back,
    cancelUrl: `${back}&cancelled=1`,
    metadata: { kind: 'match_topup' },
  });
  await MatchTopup.create({
    reference,
    user: profile.user,
    amountMinor,
    currency: MATCH_CURRENCY,
    mode: 'live',
    checkoutId: checkout.checkoutId,
    checkoutUrl: checkout.checkoutUrl,
  });
  res.status(201).json({
    success: true,
    data: { reference, status: 'pending', checkoutUrl: checkout.checkoutUrl },
  });
}

/** Back from checkout: asks Bachs, credits if paid, and says how it went. */
export async function verifyTopup(req: Request, res: Response): Promise<void> {
  const topup = await MatchTopup.findOne({ reference: String(req.params.reference).toUpperCase() });
  if (!topup || !topup.user.equals(req.user!._id)) throw ApiError.notFound('No such top-up');
  const settled =
    topup.status === 'pending' && topup.checkoutId
      ? await applyVerifiedTopup(topup, await getCheckout(topup.checkoutId))
      : topup;
  const profile = await MatchProfile.findOne({ user: topup.user });
  res.json({
    success: true,
    data: {
      reference: settled.reference,
      status: settled.status,
      amountMinor: settled.amountMinor,
      creditMinor: profile?.creditMinor ?? 0,
    },
  });
}

/** Thirty days of Match+, from credit. Buying again adds thirty more. */
export async function buyPlus(req: Request, res: Response): Promise<void> {
  const profile = await profileOf(req);
  const until = extendedPlus(profile.plusUntil);
  await spend(profile.user, MATCH_PRICES.plus, 'plus', '', `Match+ until ${until.toDateString()}`);
  const updated = await MatchProfile.findOneAndUpdate(
    { _id: profile._id },
    { plusUntil: until },
    { new: true },
  );
  refreshPresence(updated!);
  res.json({
    success: true,
    data: { plusUntil: updated!.plusUntil, creditMinor: updated!.creditMinor },
  });
}

/** Pays into tonight's themed night. Once per night; paying twice is refused. */
export async function joinNight(req: Request, res: Response): Promise<void> {
  const profile = await profileOf(req);
  const night = tonight();
  if (!night?.theme) throw ApiError.badRequest('There is no themed night tonight');
  const day = matchDay(hoursAt().opensAt);
  if (await MatchEntry.exists({ user: profile.user, day })) {
    res.json({ success: true, data: { entered: true, creditMinor: profile.creditMinor } });
    return;
  }
  const creditMinor = await spend(
    profile.user,
    night.theme.entryMinor,
    'entry',
    day,
    `${night.theme.title} — entry`,
  );
  try {
    await MatchEntry.create({ user: profile.user, day, priceMinor: night.theme.entryMinor });
  } catch {
    /* Two taps raced and the other one entered: give this one back. */
    await addCredit(profile.user, night.theme.entryMinor, 'refund', day, 'Already entered');
  }
  res.json({ success: true, data: { entered: true, creditMinor } });
}

/**
 * Sends a rose or a drink to someone you swapped usernames with. It shows next
 * to their username on both screens, and arrives live if they are on Match.
 */
export async function sendGift(req: Request, res: Response): Promise<void> {
  const { gift } = req.body as MatchGiftInput;
  const profile = await profileOf(req);
  const call = await MatchCall.findOne({ callId: String(req.params.callId) });
  const me = profile.user;
  if (!call || (!call.male.equals(me) && !call.female.equals(me))) {
    throw ApiError.notFound('No such call');
  }
  if (!call.revealedAt) throw ApiError.conflict('Gifts are for people you both shared with');
  const to = call.male.equals(me) ? call.female : call.male;
  const price = MATCH_PRICES.gift[gift];
  const creditMinor = await spend(me, price, 'gift', call.callId, `Sent a ${gift}`);
  await MatchGift.create({ callId: call.callId, from: me, to, gift, priceMinor: price });
  hub.notify(String(to), 'gift', { callId: call.callId, gift });
  res.status(201).json({ success: true, data: { gift, creditMinor } });
}

/** Step one of the badge: the pose to make. Free; nothing is charged yet. */
export async function startVerification(req: Request, res: Response): Promise<void> {
  const profile = await profileOf(req);
  if (profile.verifiedAt) throw ApiError.conflict('You are already verified');
  const open = await MatchVerification.findOne({
    user: profile.user,
    status: { $in: ['draft', 'pending'] },
  });
  if (open?.status === 'pending') throw ApiError.conflict('Your photo is being checked');
  const prompt = POSES[crypto.randomInt(POSES.length)];
  const draft = open
    ? Object.assign(open, { prompt })
    : new MatchVerification({ user: profile.user, prompt });
  await draft.save();
  res.json({ success: true, data: { prompt } });
}

/** Step two: the selfie, paid for from credit and queued for staff. */
export async function submitVerification(req: Request, res: Response): Promise<void> {
  const { photo } = req.body as MatchVerificationInput;
  const profile = await profileOf(req);
  const draft = await MatchVerification.findOne({ user: profile.user, status: 'draft' });
  if (!draft) throw ApiError.badRequest('Start again — ask for a pose first');

  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(photo);
  if (!match) throw ApiError.badRequest('That is not a photo');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > PHOTO_MAX_BYTES) throw ApiError.badRequest('That photo is too large');

  const creditMinor = await spend(
    profile.user,
    MATCH_PRICES.badge,
    'badge',
    String(draft._id),
    `Verified badge check — ${naira(MATCH_PRICES.badge)}`,
  );
  draft.photo = bytes;
  draft.photoType = match[1];
  draft.status = 'pending';
  draft.priceMinor = MATCH_PRICES.badge;
  draft.submittedAt = new Date();
  await draft.save();
  res.json({ success: true, data: { status: 'pending', creditMinor } });
}
