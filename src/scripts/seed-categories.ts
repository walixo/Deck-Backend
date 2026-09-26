/**
 * Adds the starting launch categories to a database that has none of them.
 *
 *   npm run seed-categories -- --dry-run      # say what would change, write nothing
 *   npm run seed-categories                   # locally, from source
 *   npm run seed-categories:prod              # on the production host
 *
 * Why this exists: the only other place categories came from was `npm run
 * seed`, which wipes the database first and so must never touch production.
 * A fresh production database therefore had no categories at all, and with an
 * empty collection `assertCategory` rejects every launch — nobody can submit
 * anything until the list exists.
 *
 * Safe to run against production, and safe to run twice. It inserts the
 * categories from `SEED_CATEGORIES` whose slug is not there yet and touches
 * nothing else: no deletes, and no updates to a category that already exists.
 * That last part is deliberate, and the opposite of `seed-games`. Categories
 * are edited in the admin area — relabelled, reordered, retired — and a script
 * that "restored" them to the code's version would silently undo those
 * decisions. The database is the source of truth; this only fills a gap.
 *
 * Each insert is written to the audit trail as "Command line", the same way
 * `create-admin` records itself, so the trail shows where they came from.
 */
/* eslint-disable no-console -- a CLI communicates by printing; that is the point. */
import { connectDatabase, disconnectDatabase } from '../config/db';
import { SEED_CATEGORIES } from '../constants';
import { Category } from '../models/Category';
import { audit } from '../services/audit';

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');

  await connectDatabase();

  const existing = new Set(
    (await Category.find().select('slug').lean()).map((category) => category.slug),
  );
  const missing = SEED_CATEGORIES.filter((category) => !existing.has(category.slug));

  console.log(
    `[seed-categories] ${existing.size} already in the database, ${missing.length} to add`,
  );

  if (missing.length === 0) return;

  if (dryRun) {
    for (const category of missing)
      console.log(`  would add  ${category.slug}  (${category.label})`);
    console.log('[seed-categories] dry run — nothing written');
    return;
  }

  for (const input of missing) {
    const category = await Category.create({ ...input });

    await audit(null, {
      action: 'category.created',
      targetType: 'category',
      targetId: category._id,
      targetLabel: category.label,
      summary: `Added the category "${category.label}" via the command line`,
      after: { slug: category.slug, icon: category.icon },
    });

    console.log(`  added  ${category.slug}  (${category.label})`);
  }
}

main()
  .catch((error: unknown) => {
    console.error('[seed-categories] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => undefined));
