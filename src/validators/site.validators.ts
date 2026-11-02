import { z } from 'zod';
import { SITE_LANDINGS } from '../models/SiteSettings';

export const siteSettingsSchema = z
  .object({
    launches: z.boolean().optional(),
    landing: z.enum(SITE_LANDINGS).optional(),
  })
  .strict()
  .refine((value) => value.launches !== undefined || value.landing !== undefined, {
    message: 'Nothing to change',
  });

export type SiteSettingsInput = z.infer<typeof siteSettingsSchema>;
