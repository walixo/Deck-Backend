import type { Request, Response } from 'express';
import { ACCENTS, DEFAULT_ACCENT } from '../config/palette.generated';
import { env } from '../config/env';
import { Item } from '../models/Item';
import { renderEmbedBadge } from '../services/embedBadge';
import { ApiError } from '../utils/ApiError';


/**
 * The embeddable badge for a launch.
 *
 * Cached for an hour at the edge: it is fetched on every view of every page it
 * is embedded in, and a vote count that is up to an hour stale is a fair trade
 * for not serving a database query to every visitor of somebody else's README.
 *
 * `stale-while-revalidate` on top, so the badge never blocks on a refresh — a
 * slightly old badge renders instantly while the new one is fetched behind it.
 */
export async function getEmbedBadge(req: Request, res: Response): Promise<void> {
  const item = await Item.findOne({ slug: req.params.slug.replace(/\.svg$/, '') }).select(
    'name voteCount',
  );
  if (!item) throw ApiError.notFound('We could not find that launch');

  const style = String(req.query.style ?? 'votes');
  /* An unknown name falls back rather than failing: badges live in other
     people's READMEs, and a renamed accent should degrade to the default
     colour, not to a broken image. */
  const accent = ACCENTS[String(req.query.accent ?? DEFAULT_ACCENT)] ?? ACCENTS[DEFAULT_ACCENT];
  const dark = req.query.theme === 'dark';

  const value =
    style === 'plain' ? 'FEATURED' : `${item.voteCount} ${item.voteCount === 1 ? 'VOTE' : 'VOTES'}`;

  const svg = renderEmbedBadge({ label: 'DECK', value, accent, dark });

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  /* The badge is deliberately embeddable anywhere; nosniff still applies so a
     browser cannot be talked into treating it as something else. */
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(svg);
}

/**
 * Everything a maker needs to announce their launch elsewhere.
 *
 * Assembled on the server so the copy is identical wherever it is offered, and
 * so the URLs are absolute — a share snippet with a relative path is useless
 * the moment it leaves Deck.
 */
export async function getShareKit(req: Request, res: Response): Promise<void> {
  const item = await Item.findOne({ slug: req.params.slug }).populate(
    'submittedBy',
    'name username',
  );
  if (!item) throw ApiError.notFound('We could not find that launch');

  /*
   * Two different origins, on purpose. The badge is served by this API, so its
   * URL is this host. The page a reader lands on is the frontend, which may be
   * somewhere else entirely — taking the API's own host for both would hand
   * makers a share link pointing at the JSON server.
   */
  const apiOrigin = `${req.protocol}://${req.get('host')}`;
  const siteOrigin = env.clientOrigins[0] ?? apiOrigin;
  const pageUrl = `${siteOrigin}/item/${item.slug}`;
  const badgeUrl = `${apiOrigin}/api/share/${item.slug}/badge.svg`;

  res.json({
    success: true,
    data: {
      name: item.name,
      tagline: item.tagline,
      slug: item.slug,
      voteCount: item.voteCount,
      logoUrl: item.logoUrl,
      pageUrl,
      badgeUrl,
      embed: {
        markdown: `[![Featured on Deck](${badgeUrl})](${pageUrl})`,
        html: `<a href="${pageUrl}"><img src="${badgeUrl}" alt="Featured on Deck" height="28"></a>`,
      },
      post: `${item.name} is live on Deck — ${item.tagline}\n\n${pageUrl}`,
    },
  });
}
