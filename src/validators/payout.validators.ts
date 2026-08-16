import { z } from 'zod';

export const recordPayoutSchema = z.object({
  sellerId: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{24}$/i, 'Pick a seller'),
  /* Whole currency units at the edge, minor units inside — as everywhere else. */
  amount: z.coerce
    .number()
    .positive('A payout has to be for something')
    .max(50_000_000, 'That amount looks wrong'),
  /** Free text: bank, account, transfer id — whatever staff need to trace it. */
  destination: z.string().trim().max(200).optional().or(z.literal('')),
  note: z.string().trim().max(400).optional().or(z.literal('')),
  /** Defaults to now. Backdating lets a batch be entered after the fact. */
  paidAt: z.string().datetime().optional(),
});

export type RecordPayoutInput = z.infer<typeof recordPayoutSchema>;
