import { z } from 'zod';

export const listNotificationsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(15),
  /* An ISO timestamp from the last row of the previous page. Keyset rather
     than offset — see the controller for why. */
  before: z.string().datetime().optional(),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsSchema>;
