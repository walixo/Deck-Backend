import { z } from 'zod';
import { AUDIT_ACTIONS, ORDER_STATUSES } from '../constants';

export const listUsersSchema = z.object({
  search: z.string().trim().max(80).optional(),
  role: z.enum(['user', 'admin']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const updateRoleSchema = z.object({
  role: z.enum(['user', 'admin']),
});

export const listOrdersSchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Only the two forward steps. The controller enforces which is legal from the
 * order's current state; this just keeps anything else out of the handler.
 */
export const updateOrderStatusSchema = z.object({
  status: z.enum(['shipped', 'delivered']),
});

export const listAuditSchema = z.object({
  action: z.enum(AUDIT_ACTIONS).optional(),
  actor: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{24}$/i, 'That is not a valid account')
    .optional(),
  /** Everything that ever happened to one product, order or account. */
  targetId: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export type ListAuditQuery = z.infer<typeof listAuditSchema>;
export type ListUsersQuery = z.infer<typeof listUsersSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
