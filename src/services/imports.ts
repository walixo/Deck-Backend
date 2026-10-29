import type mongoose from 'mongoose';
import { assertCategory } from '../controllers/category.controller';
import { Founder } from '../models/Founder';
import { ImportCandidate, type IImportCandidate } from '../models/ImportCandidate';
import { Item, type IItem } from '../models/Item';
import { ApiError } from '../utils/ApiError';
import { toDateKey } from '../utils/date';
import { slugify, uniqueSlug } from '../utils/slug';
import { indexAccount } from './indexAccount';

/**
 * Turning checked candidates into listings.
 *
 * Shared by the admin queue and the CSV loader, so a product cannot reach the
 * site by a path that skips the duplicate check or the category check.
 */

/*
 * Hosts where many unrelated products live side by side. On these the domain
 * says nothing — two Hugging Face models or two GitHub projects are different
 * products — so the key keeps the owner and project from the path as well.
 */
const SHARED_HOSTS = new Set([
  'huggingface.co',
  'github.com',
  'gitlab.com',
  'play.google.com',
  'apps.apple.com',
  'medium.com',
]);

/**
 * The duplicate key for a product's website.
 *
 * Normally the host without `www.`: two entries for one product rarely agree
 * on how its name is written, but they almost always agree on its domain.
 * Subdomains are kept (`app.x.com` and `x.com` can be different products).
 * On a shared host it is the host plus the first two path segments —
 * `huggingface.co/lelapa/inkubalm-0.4b` — because the host alone would make
 * every model on Hugging Face a duplicate of every other.
 *
 * Stored on candidates as `domain`, a name kept from before shared hosts.
 */
export function domainOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw ApiError.badRequest('That website address is not a valid URL');
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!SHARED_HOSTS.has(host)) return host;

  const path = parsed.pathname.split('/').filter(Boolean).slice(0, 2).join('/').toLowerCase();
  return path ? `${host}/${path}` : host;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A launch already living at this key, if there is one.
 *
 * Matched on the website URL, since launches do not store a key of their own;
 * anchored so `pay.com` does not match `paystack.com`, and so
 * `github.com/a/b` does not match `github.com/a/bc`.
 */
async function launchOnDomain(domain: string) {
  const pattern = new RegExp(`^https?://(www\\.)?${escapeRegex(domain)}(?=[/:?#]|$)`, 'i');
  return Item.findOne({ websiteUrl: pattern }).select('name slug');
}

/** Anything already on Deck or already queued for the same domain. */
export async function findDuplicate(
  domain: string,
  excludeCandidate?: mongoose.Types.ObjectId,
): Promise<string | null> {
  const item = await launchOnDomain(domain);
  if (item) return `${item.name} is already on Deck (/item/${item.slug})`;

  const candidate = await ImportCandidate.findOne({
    domain,
    status: { $in: ['pending', 'published'] },
    ...(excludeCandidate ? { _id: { $ne: excludeCandidate } } : {}),
  }).select('name status');
  if (candidate) return `${candidate.name} is already in the import queue (${candidate.status})`;

  return null;
}

export async function assertNoDuplicate(
  domain: string,
  excludeCandidate?: mongoose.Types.ObjectId,
): Promise<void> {
  const duplicate = await findDuplicate(domain, excludeCandidate);
  if (duplicate) throw ApiError.conflict(duplicate);
}

/**
 * Publishes a pending candidate as an imported launch.
 *
 * Founders are created here unless the candidate points at an existing record,
 * and only here — so a founder never exists without a product beside them.
 * The launch date is the product's real one when known; the board never sees
 * it either way, because imported launches do not compete.
 */
export async function publishCandidate(
  candidate: IImportCandidate,
  staffId: mongoose.Types.ObjectId,
): Promise<IItem> {
  if (candidate.status !== 'pending') {
    throw ApiError.badRequest('Only a pending candidate can be published');
  }

  await assertCategory(candidate.category);
  /* Checked again here, not just when it was queued: a maker may have launched
     the same product themselves in the meantime, and theirs wins. */
  const existing = await launchOnDomain(candidate.domain);
  if (existing) {
    throw ApiError.conflict(`${existing.name} is already on Deck (/item/${existing.slug})`);
  }

  const owner = await indexAccount();

  const founderIds: mongoose.Types.ObjectId[] = [];
  for (const entry of candidate.founders) {
    if (entry.founderId) {
      const found = await Founder.findById(entry.founderId).select('_id');
      if (!found) throw ApiError.badRequest(`Founder record for ${entry.name} no longer exists`);
      founderIds.push(found._id);
      continue;
    }

    const founder = await Founder.create({
      name: entry.name,
      slug: await uniqueSlug(slugify(entry.name), async (slug) =>
        Boolean(await Founder.exists({ slug })),
      ),
      headline: entry.headline,
      country: candidate.country,
      links: entry.links,
      sourceUrls: candidate.sourceUrls,
      createdBy: staffId,
    });
    founderIds.push(founder._id);
  }

  const launchDate = candidate.launchedAt ?? new Date();

  const item = await Item.create({
    name: candidate.name,
    slug: await uniqueSlug(candidate.name, async (slug) => Boolean(await Item.exists({ slug }))),
    tagline: candidate.tagline,
    description: candidate.description,
    category: candidate.category,
    tags: candidate.tags,
    pricing: candidate.pricing,
    websiteUrl: candidate.websiteUrl,
    logoUrl: candidate.logoUrl || undefined,
    makers: candidate.founders.map((founder) => founder.name),
    submittedBy: owner._id,
    source: 'imported',
    sourceUrls: candidate.sourceUrls,
    founders: founderIds,
    country: candidate.country,
    launchDate,
    launchDateKey: toDateKey(launchDate),
  });

  candidate.status = 'published';
  candidate.item = item._id;
  candidate.reviewedBy = staffId;
  candidate.reviewedAt = new Date();
  await candidate.save();

  return item;
}
