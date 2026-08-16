import { z } from 'zod';

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Please tell us your name').max(60),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'Usernames need at least 3 characters')
    .max(30)
    .regex(/^[a-z0-9_]+$/, 'Use letters, numbers and underscores only'),
  email: z.string().trim().toLowerCase().email('That email does not look right'),
  password: z.string().min(8, 'Passwords need at least 8 characters').max(128),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('That email does not look right'),
  password: z.string().min(1, 'Please enter your password'),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  bio: z.string().trim().max(280).optional(),
  headline: z.string().trim().max(80).optional(),
  avatarUrl: z.string().trim().url('Avatar must be a valid URL').or(z.literal('')).optional(),
  websiteUrl: z.string().trim().url('Website must be a valid URL').or(z.literal('')).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
