import { SiteSettings, type SiteLanding } from '../models/SiteSettings';

export interface SiteView {
  launches: boolean;
  landing: SiteLanding;
}

/* Until staff flip anything: launches hidden, products on the landing page. */
const DEFAULTS: SiteView = { launches: false, landing: 'products' };
const FRESH_MS = 30_000;

let cached: { view: SiteView; at: number } | null = null;

/** What the site should show, read at most every thirty seconds. */
export async function siteView(): Promise<SiteView> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.view;
  const doc = await SiteSettings.findOne({ key: 'site' }).lean();
  const view: SiteView = doc ? { launches: doc.launches, landing: doc.landing } : DEFAULTS;
  cached = { view, at: Date.now() };
  return view;
}

/** Saves a change and drops the cache, so the next read sees it at once. */
export async function saveSite(change: Partial<SiteView>): Promise<SiteView> {
  const doc = await SiteSettings.findOneAndUpdate(
    { key: 'site' },
    { $set: change, $setOnInsert: { key: 'site' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  cached = null;
  return { launches: doc!.launches, landing: doc!.landing };
}
