import webpush from 'web-push';
import { env } from '../config/env';

/**
 * Deck's VAPID keys, checked once at start-up. Pings and the key browsers
 * subscribe with both come from here, so a key web-push refused is never
 * handed to a browser: the ping switch is hidden instead of failing on tap.
 */

/* A bare email is accepted as the subject; web-push wants it as a mailto: URL. */
const subject = /^(mailto:|https?:)/.test(env.vapid.subject)
  ? env.vapid.subject
  : `mailto:${env.vapid.subject}`;

/* A mistyped key must not stop the server starting: pings switch off instead. */
function configure(): boolean {
  if (!env.vapid.publicKey || !env.vapid.privateKey) return false;
  try {
    webpush.setVapidDetails(subject, env.vapid.publicKey, env.vapid.privateKey);
    return true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[match] pings are off — check the VAPID settings: ${(error as Error).message}`);
    return false;
  }
}
const ready = configure();

/** The public key browsers subscribe with, or null when pings are off. */
export const pushPublicKey = () => (ready ? env.vapid.publicKey : null);
