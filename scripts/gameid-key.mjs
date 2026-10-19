/**
 * Prints a fresh GameID signing key: an RSA private key in PEM, on one line
 * with its newlines written as \n — the shape a dashboard env var takes.
 *
 * Run it with node directly, not through `npm run`: npm prints its own
 * "> package@version script" banner on stdout, and piped to the clipboard that
 * banner ends up in the variable.
 *
 *   node scripts/gameid-key.mjs | pbcopy        # macOS: straight to clipboard
 */
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.stdout.write(pem.trim().replace(/\n/g, '\\n'));
