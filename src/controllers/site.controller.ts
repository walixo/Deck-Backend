import type { Request, Response } from 'express';
import { audit } from '../services/audit';
import { saveSite, siteView } from '../services/siteSettings';
import type { SiteSettingsInput } from '../validators/site.validators';

/** What onedeck.africa shows: public, read by every page load. */
export async function getSite(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ success: true, data: await siteView() });
}

/** Staff flip the launch product on or off, or change the landing page. */
export async function updateSite(req: Request, res: Response): Promise<void> {
  const change = req.body as SiteSettingsInput;
  const before = await siteView();
  const after = await saveSite(change);
  await audit(req, {
    action: 'site.settings.changed',
    targetType: 'site',
    targetId: 'site',
    targetLabel: 'onedeck.africa',
    summary:
      [
        before.launches !== after.launches && `Launches ${after.launches ? 'shown' : 'hidden'}`,
        before.landing !== after.landing &&
          `Landing page set to ${after.landing === 'products' ? 'Match and Deck Games' : 'launches'}`,
      ]
        .filter(Boolean)
        .join(' · ') || 'Site settings saved',
    before,
    after,
  });
  res.json({ success: true, data: after });
}
