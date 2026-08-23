/**
 * Gives every launch that predates the revision system its revision 1.
 *
 *   npm run backfill-revisions
 *
 * Without this, the first edit of an older launch writes version 1 holding the
 * *edited* text — so the history would open on a revision labelled "as posted"
 * that is nothing of the kind, with no earlier entry to diff it against.
 *
 * The snapshot taken here is the launch's current state, which for an unedited
 * launch is exactly the state it was posted in. `createdAt` is set from the
 * launch rather than from now, so the history reads with the right dates.
 *
 * Idempotent: launches that already have a revision are skipped, so this is
 * safe to run twice, and safe to run again after new launches appear.
 */
/* eslint-disable no-console -- a CLI communicates by printing; that is the point. */
import { connectDatabase, disconnectDatabase } from '../config/db';
import { Item } from '../models/Item';
import { ItemRevision } from '../models/ItemRevision';
import { User } from '../models/User';
import { snapshotOf } from '../services/revisions';

async function main() {
  await connectDatabase();

  const items = await Item.find().sort({ launchDate: 1 });
  const alreadyDone = new Set(
    (await ItemRevision.distinct('item')).map((id) => String(id)),
  );

  /*
   * Every launch that predates versioning is the start of its own chain.
   *
   * Done in bulk before the loop because it is a single predicate, and because
   * a launch with no lineage does not appear in its own version strip — the
   * strip queries `{ lineage }`, which matches nothing when the field is unset.
   */
  const orphaned = await Item.updateMany({ lineage: { $exists: false } }, [
    { $set: { lineage: '$_id' } },
  ]);
  if (orphaned.modifiedCount > 0) {
    console.log(`  Rooted ${orphaned.modifiedCount} launch lineages.`);
  }

  let written = 0;
  let skipped = 0;
  let recounted = 0;

  for (const item of items) {
    if (alreadyDone.has(String(item._id))) {
      skipped += 1;
    } else {
      const author = await User.findById(item.submittedBy).select('name');

      await ItemRevision.create({
        item: item._id,
        version: 1,
        snapshot: snapshotOf(item),
        changed: [],
        editedBy: item.submittedBy,
        /* Falls back rather than throwing: a launch whose author was removed
           still deserves a history, and "Unknown" is a truthful label for it. */
        editedByName: author?.name ?? 'Unknown',
        editedByRole: 'owner',
        createdAt: item.launchDate,
      });

      written += 1;
    }

    /*
     * Reconcile the denormalised counter against the revisions themselves.
     *
     * `editCount` is maintained by an `$inc` on the write path, which is right
     * for the hot case but is a second source of truth — and a second source of
     * truth drifts. The revisions are the record; this recomputes from them, so
     * running the script is also the repair for a counter that has slipped.
     */
    const revisions = await ItemRevision.countDocuments({ item: item._id });
    const edits = Math.max(0, revisions - 1);
    if (item.editCount !== edits) {
      await Item.updateOne({ _id: item._id }, { $set: { editCount: edits } });
      recounted += 1;
    }
  }

  console.log(`\n  Backfilled ${written} launch${written === 1 ? '' : 'es'}.`);
  if (skipped > 0) console.log(`  Skipped ${skipped} that already had history.`);
  if (recounted > 0) console.log(`  Corrected editCount on ${recounted}.`);
  console.log('');

  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error('[backfill-revisions] failed', error);
  await disconnectDatabase();
  process.exit(1);
});
