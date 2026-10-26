import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

/**
 * Deck's own sample games, served from the API's origin.
 *
 * A game must never run on Deck's web origin: the player frames it with
 * `allow-same-origin`, so a game there could read the signed-in player's
 * storage. The API sits on a separate origin that holds no cookies — every
 * credential here is a Bearer token sent by the caller — so a page served from
 * it has nothing ambient to reach. That makes it a safe home for code Deck
 * wrote itself, and for nothing else.
 *
 * Each sample is one self-contained HTML file. Two placeholders are filled in
 * per environment, so the same file works locally and in production:
 * `%DECK_ORIGIN%` (where the SDK is loaded from) and `%DECK_ORIGINS%` (who the
 * SDK will talk to, and who may frame the page).
 */

const SAMPLES_DIR = path.resolve(__dirname, '../../public/samples');
const NAME = /^[a-z0-9-]{1,40}$/;

export async function serveSample(req: Request, res: Response): Promise<void> {
  const name = String(req.params.name ?? '');
  /* Asked for on the site's own host, a sample would share the site's origin. */
  const siteHosts = env.clientOrigins.map((origin) => new URL(origin).host);
  if (!NAME.test(name) || siteHosts.includes(req.get('host') ?? '')) {
    throw ApiError.notFound('No such sample');
  }

  let html: string;
  try {
    html = await readFile(path.join(SAMPLES_DIR, `${name}.html`), 'utf8');
  } catch {
    throw ApiError.notFound('No such sample');
  }

  const origins = env.clientOrigins.join(' ');
  html = html
    .replaceAll('%DECK_ORIGIN%', env.clientOrigins[0] ?? '')
    .replaceAll('%DECK_ORIGINS%', origins);

  /* Framed by Deck and nobody else; scripts and styles inline or from Deck. */
  res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'unsafe-inline' ${origins}`,
      "style-src 'unsafe-inline'",
      'img-src data:',
      `frame-ancestors ${origins}`,
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
  );
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('html').send(html);
}
