import fs from 'node:fs';
import path from 'node:path';
import express, { type Application, type Request, type Response } from 'express';
import { Item } from '../models/Item';

/**
 * Per-launch Open Graph tags.
 *
 * Deck is a single-page app, so every route is served the same `index.html` —
 * which means every link anyone shares unfurls as "Deck" with Deck's own blurb,
 * whether it points at the home page or at somebody's launch. Crawlers do not
 * run the JavaScript that would fix it.
 *
 * The fix is to render the shell with the right tags already in it for
 * `/item/:slug`. That only works if this server is the one answering those
 * requests, so it activates when a built frontend is present and stays out of
 * the way otherwise — in development Vite serves the app and nothing here runs.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Strips the tags the shell ships with, so the per-launch ones do not duplicate.
 *
 * `[\s\S]*?` rather than `[^>]*`: the source `index.html` writes its
 * description across several lines, and although the bundler currently
 * collapses it, a build that stopped doing so would leave two description tags
 * on every launch page — with the generic one first, which is the one crawlers
 * would read. Matching across newlines costs nothing and removes the trap.
 */
function stripDefaults(html: string): string {
  return html.replace(
    /\s*<meta\s+(?:name|property)="(?:description|og:[^"]+|twitter:[^"]+)"[\s\S]*?>/g,
    '',
  );
}

function metaFor(
  item: {
    name: string;
    tagline: string;
    slug: string;
    coverUrl?: string;
    logoUrl?: string;
    voteCount: number;
  },
  origin: string,
): string {
  const title = `${item.name} — on Deck`;
  const description = item.tagline;
  const url = `${origin}/item/${item.slug}`;

  /*
   * The product's own artwork, not a generated card. It is already uploaded,
   * already a raster, and already the picture of the thing being shared —
   * generating a card would mean adding an image renderer to say something the
   * cover already says.
   */
  const image = item.coverUrl ?? item.logoUrl;
  const absolute = image?.startsWith('http') ? image : image ? `${origin}${image}` : undefined;

  return [
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Deck">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    absolute ? `<meta property="og:image" content="${escapeHtml(absolute)}">` : '',
    /* summary_large_image only when there is an image worth showing large. */
    `<meta name="twitter:card" content="${absolute ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    absolute ? `<meta name="twitter:image" content="${escapeHtml(absolute)}">` : '',
  ]
    .filter(Boolean)
    .join('\n    ');
}

/**
 * Serves the built frontend, with launch pages given their own meta tags.
 *
 * A no-op when there is no build to serve, so running the API on its own — in
 * development, or behind a separately-hosted frontend — is unaffected.
 */
const DIST = path.resolve(process.cwd(), '../Frontend/dist');
const SHELL = path.join(DIST, 'index.html');

/** Whether there is a built frontend for this server to serve. */
export function hasFrontendBuild(): boolean {
  return fs.existsSync(SHELL);
}

export function mountFrontend(app: Application): boolean {
  const dist = DIST;
  const shellPath = SHELL;

  if (!hasFrontendBuild()) return false;

  const shell = fs.readFileSync(shellPath, 'utf8');

  app.get('/item/:slug', async (req: Request, res: Response) => {
    const origin = `${req.protocol}://${req.get('host')}`;

    try {
      const item = await Item.findOne({ slug: req.params.slug }).select(
        'name tagline slug coverUrl logoUrl voteCount',
      );

      if (item) {
        const html = stripDefaults(shell).replace(
          '</head>',
          `    ${metaFor(item, origin)}\n  </head>`,
        );
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
        return;
      }
    } catch {
      /* A database hiccup must not take the page down — the app still renders
         and fetches its own data; only the unfurl is degraded. */
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(shell);
  });

  /* Hashed asset filenames, so they can be cached hard. */
  app.use(express.static(dist, { index: false, maxAge: '1y', immutable: true }));

  /* Everything else is a client route. Anything under /api has already been
     handled above this, so a miss here is a page, not a missing endpoint. */
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(shell);
  });

  return true;
}
