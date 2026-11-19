import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { MatchProfile, type IMatchProfile } from '../models/MatchProfile';
import { notify, onCallStarted } from './matchHub';
import { addCredit, naira } from './matchWallet';

/**
 * Invite a friend. Everyone has a code; a friend who signs up through it is
 * linked to whoever invited them. Nothing is paid for the sign-up itself —
 * only when the friend's first call actually connects do both get free credit
 * (`env.matchInviteBonusMinor`), so a pile of empty accounts earns nothing.
 * One person is paid for at most `env.matchInviteCap` friends; the friend's
 * own bonus is paid regardless.
 *
 * The bonus is free credit (the `bonus` pot): spent first, never cashed out.
 */

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 7;

const newCode = () =>
  Array.from(randomBytes(CODE_LENGTH), (byte) => ALPHABET[byte % ALPHABET.length]).join('');

/** Normalises a typed or pasted code: case, spaces and dashes don't matter. */
export const cleanInviteCode = (raw: string) => raw.toUpperCase().replace(/[^0-9A-Z]/g, '');

/** This person's code, made the first time it is asked for. */
export async function inviteCodeFor(profile: IMatchProfile): Promise<string> {
  if (profile.inviteCode) return profile.inviteCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const updated = await MatchProfile.findOneAndUpdate(
        { _id: profile._id, inviteCode: null },
        { inviteCode: newCode() },
        { new: true },
      );
      /* Someone else's request made it first: use theirs. */
      const code = updated?.inviteCode ?? (await MatchProfile.findById(profile._id))?.inviteCode;
      if (code) {
        profile.inviteCode = code;
        return code;
      }
    } catch (error) {
      /* The rare clash with another person's code: roll again. */
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  throw new Error('Could not make an invite code');
}

/** Who a code belongs to, if anyone — never the person using it. */
export async function inviterFor(
  code: string | undefined,
  userId: mongoose.Types.ObjectId | string,
): Promise<mongoose.Types.ObjectId | null> {
  const clean = code ? cleanInviteCode(code) : '';
  if (!clean) return null;
  const owner = await MatchProfile.findOne({ inviteCode: clean }).select('user');
  if (!owner || owner.user.equals(userId)) return null;
  return owner.user;
}

/** What someone's invites have brought them, for their invite card. */
export async function inviteSummary(profile: IMatchProfile) {
  const [code, joined, rewarded] = await Promise.all([
    inviteCodeFor(profile),
    MatchProfile.countDocuments({ invitedBy: profile.user }),
    MatchProfile.countDocuments({ invitedBy: profile.user, inviteRewardedAt: { $ne: null } }),
  ]);
  const bonusMinor = env.matchInviteBonusMinor;
  const paidFor = Math.min(rewarded, env.matchInviteCap);
  return {
    code,
    link: `${env.matchUrl}/?invite=${code}`,
    bonusMinor,
    cap: env.matchInviteCap,
    /** Friends who signed up through the code. */
    joined,
    /** Friends whose first call has connected. */
    talked: rewarded,
    earnedMinor: paidFor * bonusMinor,
    /** Whether this person came through someone's invite and is still owed their bonus. */
    owed: Boolean(profile.invitedBy && !profile.inviteRewardedAt && bonusMinor > 0),
  };
}

/**
 * Someone's call connected. If it's the first one since they came through an
 * invite, both they and their inviter get the bonus — once, however many
 * calls race here, because the flag flips in one guarded update.
 */
export async function rewardFirstCall(userId: string): Promise<void> {
  const bonus = env.matchInviteBonusMinor;
  if (bonus <= 0) return;
  const friend = await MatchProfile.findOneAndUpdate(
    { user: userId, invitedBy: { $ne: null }, inviteRewardedAt: null },
    { inviteRewardedAt: new Date() },
    { new: true },
  );
  if (!friend?.invitedBy) return;
  const inviter = friend.invitedBy;
  const ref = `invite:${userId}`;

  const friendBalance = await addCredit(
    userId,
    bonus,
    'invite',
    ref,
    `Welcome bonus — you came through a friend's invite`,
  );
  notify(userId, 'invite', {
    role: 'friend',
    amountMinor: bonus,
    creditMinor: friendBalance,
    message: `${naira(bonus)} free credit — thanks for coming through a friend's invite`,
  });

  const paidFor = await MatchProfile.countDocuments({
    invitedBy: inviter,
    inviteRewardedAt: { $ne: null },
  });
  if (paidFor > env.matchInviteCap) return;
  try {
    const inviterBalance = await addCredit(
      inviter,
      bonus,
      'invite',
      ref,
      'A friend you invited had their first call',
    );
    notify(String(inviter), 'invite', {
      role: 'inviter',
      amountMinor: bonus,
      creditMinor: inviterBalance,
      message: `A friend you invited just had their first call — ${naira(bonus)} free credit`,
    });
  } catch {
    /* The inviter's profile is gone: nothing to pay into. */
  }
}

/** Starts paying invite bonuses as calls connect. Called once at start-up. */
export function startInvites(): void {
  onCallStarted((call) => {
    for (const userId of [call.male, call.female]) {
      void rewardFirstCall(userId).catch((error: Error) => {
        // eslint-disable-next-line no-console
        console.error(`[match] invite bonus for ${userId} failed: ${error.message}`);
      });
    }
  });
}
