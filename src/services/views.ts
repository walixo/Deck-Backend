import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { env } from '../config/env';
import { Item, type IItem } from '../models/Item';
import { ItemView } from '../models/ItemView';
import { ItemViewDaily } from '../models/ItemViewDaily';
import { toDateKey } from '../utils/date';

/**
 * How long one viewer stays counted for one launch.
 *
 * Twelve hours, so a reader who opens a launch in the morning and again after
 * lunch is one view, and a reader who comes back the next day is two. Short
 * enough that the counter still reflects interest over time, long enough that
 * it is not measuring how often someone hits reload.
 */
const WINDOW_MS = 12 * 60 * 60 * 1000;

/*
 * Requests that are not a person looking at a page.
 *
 * Deliberately a short list of the honest ones. Every crawler worth excluding
 * says so in its user agent, and the ones that lie are not going to be caught
 * by a longer regex either — that way lies a fingerprinting arms race for a
 * number on a card. Link unfurlers (Slack, WhatsApp, Discord) matter more than
 * search crawlers here: one share into a busy channel can fan out to dozens of
 * preview fetches in a second, none of which is a visit.
 */
const NOT_A_READER =
  /bot|crawler|spider|crawling|slurp|facebookexternalhit|embedly|quora link preview|whatsapp|telegram|slackbot|discordbot|twitterbot|linkedinbot|preview|scraper|curl|wget|python-requests|axios|headless|lighthouse|pingdom|uptime/i;

/**
 * A stable, non-reversible handle for whoever is asking.
 *
 * A signed-in reader is their own id, so they are one viewer across their
 * phone and their laptop. Everyone else is a digest of address plus user
 * agent, salted with the server's JWT secret — which means the value is
 * useless to anyone who gets the collection (no rainbow table without the
 * salt) and dies with a secret rotation. No IP address is written down.
 */
function viewerKey(req: Request): string {
  if (req.user) return `u:${req.user._id.toString()}`;

  const fingerprint = `${req.ip ?? 'unknown'}|${req.get('user-agent') ?? ''}`;
  return `a:${createHash('sha256').update(`${env.jwtSecret}|${fingerprint}`).digest('base64url').slice(0, 32)}`;
}

/**
 * Count one page view of a launch, if it is one.
 *
 * Returns whether the counter actually moved, so the caller can reflect the
 * viewer's own visit in the response instead of showing them a number that is
 * one behind. Never throws: a view counter is the least important thing in the
 * request, and it is not allowed to turn a launch page into a 500.
 */
export async function recordView(item: IItem, req: Request): Promise<boolean> {
  const agent = req.get('user-agent');

  /* No user agent at all is a script often enough, and a browser never. */
  if (!agent || NOT_A_READER.test(agent)) return false;

  /* A maker refreshing their own launch is not an audience. Excluded here
     rather than in the window above, because it should never count at all. */
  if (req.user && req.user._id.toString() === item.submittedBy.toString()) return false;

  try {
    await ItemView.create({
      item: item._id,
      viewer: viewerKey(req),
      expiresAt: new Date(Date.now() + WINDOW_MS),
    });
  } catch (error) {
    /* 11000 is a duplicate key: already counted inside the window, which is
       the common path and not a failure. Anything else is a real problem with
       the database, and the page still renders without a view being logged. */
    if ((error as { code?: number }).code !== 11000) {
      console.error('[views] could not record a view', error);
    }
    return false;
  }

  try {
    /*
     * Two writes, because they answer two different questions.
     *
     * The counter on the launch is what a card renders — one number, read
     * thirty times per page, and far too hot to derive by summing days. The
     * daily row is what a chart needs, and it is the one that cannot be
     * reconstructed later: a total that grew silently leaves no trace of when.
     *
     * Not a transaction. That would want a replica set, and the failure it
     * guards against — the total and the buckets drifting by one view — is
     * invisible at every scale this will ever run at.
     */
    await Promise.all([
      Item.updateOne({ _id: item._id }, { $inc: { viewCount: 1 } }),
      ItemViewDaily.updateOne(
        { item: item._id, dateKey: toDateKey(new Date()) },
        { $inc: { views: 1 } },
        { upsert: true },
      ),
    ]);
  } catch (error) {
    /* The ledger row is already written, so this view is lost until the window
       closes. One view, and the alternative is failing the whole page. */
    console.error('[views] could not increment a view count', error);
    return false;
  }

  return true;
}
