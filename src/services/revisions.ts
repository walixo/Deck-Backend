import { Item, type IItem } from '../models/Item';
import type { IUser } from '../models/User';
import {
  ItemRevision,
  REVISION_FIELDS,
  type RevisionField,
  type RevisionSnapshot,
} from '../models/ItemRevision';

/**
 * Recording what a launch said, and when it changed.
 *
 * The whole feature rests on one ordering rule: the snapshot has to be taken
 * from the document *before* the incoming changes are applied. `updateItem`
 * mutates the loaded document in place, so a snapshot taken afterwards is a
 * snapshot of the new state — the history would be full of revisions that each
 * claim nothing changed. Callers must call `snapshotOf(item)` first and hand
 * the result in.
 */

/** Lifts the authored fields off a launch. */
export function snapshotOf(item: IItem): RevisionSnapshot {
  return {
    name: item.name,
    tagline: item.tagline,
    description: item.description,
    category: item.category,
    pricing: item.pricing,
    websiteUrl: item.websiteUrl,
    repoUrl: item.repoUrl,
    logoUrl: item.logoUrl,
    coverUrl: item.coverUrl,
    wallColour: item.wallColour,
    videoUrl: item.videoUrl,
    gallery: [...(item.gallery ?? [])],
    tags: [...(item.tags ?? [])],
    makers: [...(item.makers ?? [])],
  };
}

/** Order-sensitive for arrays: reordering a gallery is a real edit. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  /* An absent optional and an empty string are the same absence to a reader —
     clearing a repo URL twice should not read as two edits. */
  return (a ?? '') === (b ?? '');
}

/** Which tracked fields differ between two snapshots. */
export function changedFields(
  before: RevisionSnapshot,
  after: RevisionSnapshot,
): RevisionField[] {
  return REVISION_FIELDS.filter((field) => !sameValue(before[field], after[field]));
}

interface RecordInput {
  item: IItem;
  /** State before the edit. Omit for the first revision, where there is none. */
  previous?: RevisionSnapshot;
  editor: IUser;
  role: 'owner' | 'admin';
  note?: string;
}

/**
 * Appends a revision, unless nothing a person authored actually changed.
 *
 * Returns the version written, or null when the edit was a no-op — a PATCH that
 * resubmits the form unchanged is the common case, and it should not add a row
 * saying so.
 *
 * Never throws. A launch edit that succeeded must not be reported as failed
 * because the bookkeeping behind it did not land; the same reasoning the audit
 * service documents. The difference is that this one is awaited, so a caller
 * can show the new version number.
 */
export async function recordRevision(input: RecordInput): Promise<number | null> {
  const { item, previous, editor, role, note } = input;

  try {
    const snapshot = snapshotOf(item);
    const changed = previous ? changedFields(previous, snapshot) : [];

    if (previous && changed.length === 0) return null;

    /* Read the current head rather than counting: counting is wrong the moment
       a revision is ever removed, and the unique index would then reject. */
    const head = await ItemRevision.findOne({ item: item._id })
      .sort({ version: -1 })
      .select('version')
      .lean();

    const version = (head?.version ?? 0) + 1;

    await ItemRevision.create({
      item: item._id,
      version,
      snapshot,
      changed,
      editedBy: editor._id,
      editedByName: editor.name,
      editedByRole: role,
      note: note?.trim() || undefined,
    });

    /*
     * Counts edits, not revisions — version 1 is the launch as posted, which is
     * not a change to anything. So `editCount > 0` is exactly "this has been
     * edited since it went up", which is the one question the item page needs
     * answered before deciding whether to offer a history at all.
     *
     * `$inc` rather than a recount: it is atomic under concurrent edits, and
     * the alternative would be a second read on a path that already has one.
     * Written straight to the collection so it cannot collide with the caller's
     * own in-flight document.
     */
    if (version > 1) {
      await Item.updateOne({ _id: item._id }, { $inc: { editCount: 1 } });
    }

    return version;
  } catch (error) {
    // eslint-disable-next-line no-console -- mirrors the audit service: loud, but never fatal.
    console.error('[revisions] FAILED TO RECORD', String(item._id), error);
    return null;
  }
}
