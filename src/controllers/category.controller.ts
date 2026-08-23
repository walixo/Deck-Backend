import type { Request, Response } from 'express';
import { Category } from '../models/Category';
import { Item } from '../models/Item';
import { audit } from '../services/audit';
import { ApiError } from '../utils/ApiError';
import { slugify } from '../utils/slug';
import type { CategoryInput, UpdateCategoryInput } from '../validators/category.validators';

/**
 * Rejects a launch whose category does not exist, with a field-shaped error.
 *
 * Zod cannot do this: validation runs before any database call, and the set of
 * valid slugs is a query now rather than a compile-time union. Shape is checked
 * there, existence here.
 *
 * Retired categories fail too. A launch already filed under one keeps it — the
 * slug is still readable everywhere — but nothing new may be filed there, which
 * is the whole point of retiring rather than deleting.
 */
export async function assertCategory(slug: string): Promise<void> {
  const category = await Category.findOne({ slug }).select('active').lean();

  if (!category) {
    throw ApiError.badRequest('Some fields need your attention', [
      { field: 'category', message: 'Pick a category from the list' },
    ]);
  }

  if (!category.active) {
    throw ApiError.badRequest('Some fields need your attention', [
      { field: 'category', message: 'That category is no longer taking new launches' },
    ]);
  }
}

/**
 * Every category, with how many launches sit in each.
 *
 * Public and unauthenticated — it drives the browse strip, the submit form's
 * picker and every label on the site. Retired ones are included when they still
 * hold launches, so an old launch's chip is never blank; they are marked
 * inactive so the picker can leave them out.
 */
export async function listCategories(_req: Request, res: Response): Promise<void> {
  const [categories, rows] = await Promise.all([
    Category.find().sort({ order: 1, label: 1 }),
    Item.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]),
  ]);

  const counts = new Map(rows.map((row) => [row._id, row.count]));

  res.json({
    success: true,
    data: categories
      .filter((category) => category.active || (counts.get(category.slug) ?? 0) > 0)
      .map((category) => ({
        id: category._id.toString(),
        slug: category.slug,
        label: category.label,
        icon: category.icon,
        blurb: category.blurb,
        order: category.order,
        active: category.active,
        count: counts.get(category.slug) ?? 0,
      })),
  });
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const input = req.body as CategoryInput;

  /* Derived from the label unless one is given, the same way launches get
     theirs — a slug typed by hand is a slug with a typo in it eventually. */
  const slug = slugify(input.slug || input.label);

  if (await Category.exists({ slug })) {
    throw ApiError.conflict(`There is already a category at "${slug}"`);
  }

  const category = await Category.create({ ...input, slug });

  await audit(req, {
    action: 'category.created',
    targetType: 'category',
    targetId: category._id,
    targetLabel: category.label,
    summary: `Added the category "${category.label}"`,
    after: { slug: category.slug, icon: category.icon },
  });

  res.status(201).json({ success: true, data: category });
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateCategoryInput;

  const category = await Category.findById(req.params.id);
  if (!category) throw ApiError.notFound('We could not find that category');

  /*
   * The slug is immutable, deliberately.
   *
   * It is the foreign key every launch stores and every filter URL carries.
   * Changing it would orphan launches and break links people have shared, and
   * the fix — rewriting every item and every revision snapshot — is exactly the
   * kind of quiet mass mutation this codebase avoids. Retire it and make a new
   * one instead.
   */
  const before = { label: category.label, icon: category.icon, active: category.active };
  Object.assign(category, input);
  await category.save();

  await audit(req, {
    action: 'category.updated',
    targetType: 'category',
    targetId: category._id,
    targetLabel: category.label,
    summary: category.active
      ? `Updated the category "${category.label}"`
      : `Retired the category "${category.label}"`,
    before,
    after: { label: category.label, icon: category.icon, active: category.active },
  });

  res.json({ success: true, data: category });
}

/**
 * Removes a category, but only while nothing is filed under it.
 *
 * Anything with launches gets retired instead — `active: false` — which keeps
 * every existing launch readable and its chip labelled while closing the
 * category to new ones. Deleting a slug that items still reference would leave
 * those launches pointing at nothing.
 */
export async function deleteCategory(req: Request, res: Response): Promise<void> {
  const category = await Category.findById(req.params.id);
  if (!category) throw ApiError.notFound('We could not find that category');

  const inUse = await Item.countDocuments({ category: category.slug });
  if (inUse > 0) {
    throw ApiError.badRequest(
      `"${category.label}" still has ${inUse} ${inUse === 1 ? 'launch' : 'launches'}. Retire it instead — that closes it to new launches without breaking the old ones.`,
    );
  }

  const label = category.label;
  await category.deleteOne();

  await audit(req, {
    action: 'category.removed',
    targetType: 'category',
    targetId: req.params.id,
    targetLabel: label,
    summary: `Deleted the empty category "${label}"`,
    before: { slug: category.slug },
  });

  res.json({ success: true, data: { id: req.params.id } });
}
