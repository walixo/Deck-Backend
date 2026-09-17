import { z } from 'zod';

export const launchViewsSchema = z.object({
  /*
   * How many days of history to draw.
   *
   * Floored at 7 because a sparkline needs a shape and three points is not
   * one, capped at 90 because the response carries a number per launch per day
   * and a maker with thirty launches asking for two years is a megabyte of
   * JSON to draw a thumbnail.
   */
  days: z.coerce.number().int().min(7).max(90).default(30),
});

export type LaunchViewsQuery = z.infer<typeof launchViewsSchema>;
