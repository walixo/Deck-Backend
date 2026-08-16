/**
 * Creates a Deck admin, or promotes an existing account to one.
 *
 *   npm run create-admin -- --email you@example.com --name "Your Name" --username you
 *   npm run create-admin -- --email someone@already.signed.up   # promote
 *   npm run create-admin -- --email you@example.com --demote
 *
 * Deliberately a command and not an endpoint. Promotion to staff is the one
 * privilege that hands over everything else — the merch catalogue, every
 * order, the disbursement run, other people's roles. An HTTP route granting it
 * is a route worth attacking, and the first admin has to come from somewhere
 * that is not the internet. Running this needs shell access to the server and
 * the database, which is exactly the bar it should clear.
 *
 * A password is generated when creating a new account rather than accepted as
 * an argument: passing one would leave it in the shell history and in `ps`.
 * It is printed once, and the account holder should change it.
 */
/* eslint-disable no-console -- a CLI communicates by printing; that is the point. */
import crypto from 'node:crypto';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { User } from '../models/User';
import { audit } from '../services/audit';

interface Options {
  email?: string;
  name?: string;
  username?: string;
  demote: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { demote: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--demote') {
      options.demote = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) continue;

    if (flag === '--email') options.email = value.trim().toLowerCase();
    if (flag === '--name') options.name = value.trim();
    if (flag === '--username') options.username = value.trim().toLowerCase();
    index += 1;
  }

  return options;
}

/** Readable, and long enough that the entropy does not depend on the alphabet. */
function generatePassword(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.email) {
    console.error(
      'Usage: npm run create-admin -- --email <email> [--name "Full Name"] [--username handle] [--demote]',
    );
    process.exitCode = 1;
    return;
  }

  await connectDatabase();

  const existing = await User.findOne({ email: options.email });

  if (options.demote) {
    if (!existing) {
      console.error(`No account found for ${options.email}`);
      process.exitCode = 1;
      return;
    }

    /* Same guard the API applies: never leave Deck with no way in. */
    const admins = await User.countDocuments({ role: 'admin' });
    if (existing.role === 'admin' && admins <= 1) {
      console.error('That is the only admin left. Promote someone else first.');
      process.exitCode = 1;
      return;
    }

    existing.role = 'user';
    await existing.save();
    /* Passing no request records the actor as "Command line" — the trail should
       show that this happened off the dashboard, not pretend nobody did it. */
    await audit(null, {
      action: 'role.revoked',
      targetType: 'user',
      targetId: existing._id,
      targetLabel: `${existing.name} (@${existing.username})`,
      summary: `Removed staff access from ${existing.name} via the command line`,
      before: { role: 'admin' },
      after: { role: 'user' },
    });
    console.log(`${existing.email} is no longer an admin.`);
    return;
  }

  if (existing) {
    if (existing.role === 'admin') {
      console.log(`${existing.email} is already an admin.`);
      return;
    }
    existing.role = 'admin';
    await existing.save();
    await audit(null, {
      action: 'role.granted',
      targetType: 'user',
      targetId: existing._id,
      targetLabel: `${existing.name} (@${existing.username})`,
      summary: `Made ${existing.name} a Deck admin via the command line`,
      before: { role: 'user' },
      after: { role: 'admin' },
    });
    console.log(`Promoted ${existing.email} (@${existing.username}) to admin.`);
    return;
  }

  const username = options.username ?? options.email.split('@')[0].replace(/[^a-z0-9_]/g, '');
  if (await User.exists({ username })) {
    console.error(`The username "${username}" is taken — pass a different --username.`);
    process.exitCode = 1;
    return;
  }

  const password = generatePassword();
  // create() runs the hashing hook; insertMany would store this in the clear.
  const user = await User.create({
    name: options.name ?? username,
    username,
    email: options.email,
    password,
    role: 'admin',
  });

  await audit(null, {
    action: 'role.granted',
    targetType: 'user',
    targetId: user._id,
    targetLabel: `${user.name} (@${user.username})`,
    summary: `Created ${user.name} as a Deck admin via the command line`,
    after: { role: 'admin', created: true },
  });

  console.log(`\nCreated admin ${user.email} (@${user.username})`);
  console.log(`Temporary password: ${password}`);
  console.log('Shown once. Sign in and change it.\n');
}

main()
  .catch((error: unknown) => {
    console.error('[create-admin] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => undefined));
