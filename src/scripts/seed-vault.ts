/* eslint-disable no-console */
import { connectDatabase, disconnectDatabase } from '../config/db';
import { User } from '../models/User';
import { VaultIssuer, VaultProduct } from '../models/VaultIssuer';
import { VaultPartner } from '../models/VaultPartner';
import { grantTestBalance } from '../services/vault';
import { mintApiKey, mintFulfilSecret, mintWebhookSecret } from '../services/vaultKeys';

/**
 * A demonstrable Vault: two merchants issuing cards and one distributor
 * connected to buy them.
 *
 * Re-runnable. Everything is matched on a natural key and updated rather than
 * inserted, so running it twice does not produce two Chowdecks — except the
 * API keys, which are minted fresh every run because a key that could be
 * reprinted on demand would not be a key.
 */

const MERCHANTS = [
  {
    email: 'merchant@chowdeck.test',
    name: 'Chowdeck Merchant',
    username: 'chowdeckops',
    issuer: {
      name: 'Chowdeck',
      slug: 'chowdeck',
      tagline: 'Groceries and meals, delivered in minutes',
      description:
        'Chowdeck gift cards spend on anything in the app: restaurant orders, groceries from Chowdeck Mart, and delivery fees. Credit lands in the recipient’s wallet the moment they enter the code.',
      terms:
        'Redeemable in the Chowdeck app against orders and delivery. Non-refundable and not exchangeable for cash. Unused balance expires 12 months after issue.',
      discountPercent: 8,
      products: [
        { name: 'Chowdeck Gift Card', denominations: [2000, 5000, 10000, 20000] },
        { name: 'Chowdeck Mart', denominations: [5000, 15000, 50000] },
      ],
    },
  },
  {
    email: 'merchant@shuttlers.test',
    name: 'Shuttlers Ops',
    username: 'shuttlersops',
    issuer: {
      name: 'Shuttlers',
      slug: 'shuttlers',
      tagline: 'Shared bus rides across Lagos',
      description:
        'A Shuttlers card tops up ride credit for any route on the network. Popular with companies covering staff commutes.',
      terms: 'Redeemable against any Shuttlers route. Valid 12 months from issue.',
      discountPercent: 6,
      products: [{ name: 'Ride Credit', denominations: [5000, 10000, 25000] }],
    },
  },
];

const DISTRIBUTOR = {
  email: 'partner@payhub.test',
  name: 'Payhub Nigeria',
  username: 'payhubng',
  partner: { name: 'Payhub', slug: 'payhub', website: 'https://payhub.example' },
};

async function upsertUser(input: { email: string; name: string; username: string }) {
  const existing = await User.findOne({ email: input.email });
  if (existing) return existing;

  /* `create`, not `insertMany`: the password-hashing hook only runs on save. */
  return User.create({
    email: input.email,
    name: input.name,
    username: input.username,
    password: 'vault1234',
  });
}

async function seed(): Promise<void> {
  await connectDatabase();

  const printed: string[] = [];

  for (const merchant of MERCHANTS) {
    const user = await upsertUser(merchant);
    const spec = merchant.issuer;

    const issuer =
      (await VaultIssuer.findOne({ slug: spec.slug })) ??
      new VaultIssuer({ slug: spec.slug, owner: user._id });

    issuer.owner = user._id;
    issuer.name = spec.name;
    issuer.tagline = spec.tagline;
    issuer.description = spec.description;
    issuer.terms = spec.terms;
    issuer.discountPercent = spec.discountPercent;
    issuer.supportEmail = merchant.email;
    /* Live from the start: this seed exists so the loop can be demonstrated,
       and an issuer sitting in review demonstrates nothing. */
    issuer.status = 'live';
    issuer.fulfilment = 'deck';
    if (!issuer.fulfilSecret) issuer.fulfilSecret = mintFulfilSecret();

    const issuerKey = mintApiKey('issuer', 'live');
    issuer.keys.live = { hash: issuerKey.hash, hint: issuerKey.hint, createdAt: new Date() };
    await issuer.save();

    for (const product of spec.products) {
      const slug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      await VaultProduct.findOneAndUpdate(
        { issuer: issuer._id, slug },
        {
          issuer: issuer._id,
          slug,
          name: product.name,
          denominationType: 'fixed',
          denominationsMinor: product.denominations.map((amount) => amount * 100),
          currency: issuer.currency,
          status: 'active',
          redeemInstructions: `Enter the code in the ${spec.name} app under Wallet → Redeem.`,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
      );
    }

    printed.push(`  ${spec.name.padEnd(12)} issuer key (live)  ${issuerKey.key}`);
    console.log(`[vault] issuer ${spec.name}: ${spec.products.length} product(s), live`);
  }

  /* ------------------------------------------------------------ distributor */

  const partnerUser = await upsertUser(DISTRIBUTOR);
  const partner =
    (await VaultPartner.findOne({ slug: DISTRIBUTOR.partner.slug })) ??
    new VaultPartner({ slug: DISTRIBUTOR.partner.slug, owner: partnerUser._id });

  partner.owner = partnerUser._id;
  partner.name = DISTRIBUTOR.partner.name;
  partner.website = DISTRIBUTOR.partner.website;
  partner.status = 'live';
  if (!partner.webhookSecret) partner.webhookSecret = mintWebhookSecret();

  const testKey = mintApiKey('partner', 'test');
  const liveKey = mintApiKey('partner', 'live');
  partner.keys.test = { hash: testKey.hash, hint: testKey.hint, createdAt: new Date() };
  partner.keys.live = { hash: liveKey.hash, hint: liveKey.hint, createdAt: new Date() };
  await partner.save();

  await grantTestBalance(partner);

  console.log(`[vault] distributor ${partner.name}: live, sandbox balance granted`);

  console.log('\n  Keys — shown once, here, because they are only stored hashed:\n');
  for (const line of printed) console.log(line);
  console.log(`  Payhub       partner key (test)  ${testKey.key}`);
  console.log(`  Payhub       partner key (live)  ${liveKey.key}`);
  console.log('\n  Sign in to any of these at vault.onedeck.africa with password vault1234:');
  for (const merchant of MERCHANTS) console.log(`    ${merchant.email}`);
  console.log(`    ${DISTRIBUTOR.email}\n`);

  await disconnectDatabase();
}

seed().catch(async (error) => {
  console.error('[vault] seed failed:', error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
