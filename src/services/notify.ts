import type mongoose from 'mongoose';
import { env } from '../config/env';
import type { NotificationKind } from '../constants';
import { Notification } from '../models/Notification';

/** Ninety days from now — the TTL the model expires rows against. */
const LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * One thing that happened, described once, independently of how it is told.
 *
 * `link` is a path and not a URL on purpose. In the panel it is routed
 * in-app; in an email it has to be absolute, and the origin to prefix it with
 * is a deployment detail the call sites should not have to know. Channels
 * absolutise it themselves — see `absoluteLink`.
 */
export interface NotificationEvent {
  user: mongoose.Types.ObjectId | string;
  kind: NotificationKind;
  title: string;
  body?: string;
  /** An in-app path, starting with a slash. */
  link: string;
  /** Who caused it. If this is the recipient, nothing is sent at all. */
  actor?: mongoose.Types.ObjectId | string | null;
}

/**
 * Somewhere a notification can be delivered.
 *
 * The in-app panel is the only one registered today. Email is the obvious
 * second, and the reason this is a list rather than a function body: adding it
 * should be writing one channel and putting it in `CHANNELS`, not going back
 * through fifteen call sites that each built their own copy inline. Every
 * event already carries everything an email needs — a subject line, a
 * sentence, and somewhere to go.
 */
interface Channel {
  name: string;
  /** Whether this channel handles this event. */
  wants(event: NotificationEvent): boolean;
  send(event: NotificationEvent): Promise<void>;
}

/**
 * Which events would justify arriving in somebody's inbox.
 *
 * Deliberately a minority. The bell can afford to mention every reply; an
 * email cannot, and a service that emails on every comment gets filtered to a
 * folder nobody opens — taking the important messages with it. What is left
 * here is the set a person would want to hear about while they are nowhere
 * near the site: a decision about them, their money, or their parcel.
 *
 * Nothing reads this yet. It is the policy an email channel will consult, and
 * it is written down now because deciding it later, under pressure, is how
 * everything ends up on the list.
 */
export const EMAILABLE_KINDS = new Set<NotificationKind>([
  'account.verified',
  'fundraise.reviewed',
  'fundraise.contribution',
  'acquisition.reviewed',
  'merch.reviewed',
  'game.reviewed',
  'custom.reviewed',
  'content.moderated',
  'order.status',
]);

/**
 * A path turned into something that survives leaving the site.
 *
 * `clientOrigins[0]` is the canonical public address — the same value the
 * share kit builds links from, which is why DEPLOY.md insists the production
 * domain stays first in `CLIENT_ORIGIN`.
 */
export function absoluteLink(path: string): string {
  const origin = env.clientOrigins[0] ?? '';
  return `${origin.replace(/\/+$/, '')}${path}`;
}

const inApp: Channel = {
  name: 'in-app',
  wants: () => true,
  async send(event) {
    await Notification.create({
      user: event.user.toString(),
      kind: event.kind,
      title: event.title,
      body: event.body,
      link: event.link,
      actor: event.actor ?? undefined,
      expiresAt: new Date(Date.now() + LIFETIME_MS),
    });
  },
};

/*
 * When email arrives, it goes here:
 *
 *   const email: Channel = {
 *     name: 'email',
 *     wants: (event) => EMAILABLE_KINDS.has(event.kind),
 *     send: (event) => sendEmail(event),
 *   };
 *
 * It will also want a per-account opt-out before it ships. Under the GDPR a
 * service email about an order is fine without consent; anything that reads as
 * marketing is not, and the line between them is exactly the list above.
 */
const CHANNELS: Channel[] = [inApp];

/**
 * Tell someone something happened.
 *
 * Fire and forget, and deliberately unable to fail the thing that triggered
 * it. A comment that posts successfully but 500s because a notification write
 * failed is strictly worse than a comment that posts with nobody told — so
 * every error is logged and swallowed, per channel, so that one broken
 * delivery cannot take out another.
 *
 * Self-notification is dropped here rather than at each call site. Every
 * caller would otherwise need the same comparison, and the one that forgets it
 * produces "you commented on your own launch", which is the kind of thing that
 * makes people turn notifications off.
 */
export async function notify(event: NotificationEvent): Promise<void> {
  if (event.actor && event.actor.toString() === event.user.toString()) return;

  await Promise.all(
    CHANNELS.filter((channel) => channel.wants(event)).map(async (channel) => {
      try {
        await channel.send(event);
      } catch (error) {
        console.error(`[notify] ${channel.name} failed for ${event.kind}`, error);
      }
    }),
  );
}

/**
 * Vote counts worth interrupting somebody for.
 *
 * Individual upvotes are not notifiable — on a launch having a good day they
 * would arrive every few seconds, and each one on its own says nothing. A
 * threshold does say something, and the gaps widen as the numbers grow so that
 * a popular launch does not generate more noise than a quiet one.
 */
const VOTE_MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500];

/** The milestone this vote just crossed, if it crossed one. */
export function milestoneFor(voteCount: number): number | null {
  return VOTE_MILESTONES.includes(voteCount) ? voteCount : null;
}

/** Trims a comment down to something that fits on one line of a panel. */
export function excerpt(text: string, length = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1).trimEnd()}…`;
}

/**
 * Minor units as something a person reads.
 *
 * Notification copy is the one place amounts get written as prose rather than
 * rendered by the client's money component, so the formatting has to happen
 * here. Integer minor units throughout, divided once at the very end — never
 * carried through the arithmetic as a float.
 */
export function formatMinor(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(minor / 100);
}
