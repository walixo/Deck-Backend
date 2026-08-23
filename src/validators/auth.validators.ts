import { z } from 'zod';
import { imageField, urlField } from './fields';

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
  name: z.string().trim().min(2, 'Please tell us your name').max(60).optional(),
  bio: z.string().trim().max(280).optional(),
  headline: z.string().trim().max(80).optional(),
  /*
   * `imageField`, not a bare URL.
   *
   * This was `.url()`, which rejects the `/uploads/<uuid>.png` path that
   * `POST /api/uploads` hands back — so uploading a profile photo through
   * Deck's own uploader failed validation every time, and the only avatar that
   * ever worked was one hosted somewhere else.
   */
  avatarUrl: imageField.or(z.literal('')).optional(),
  websiteUrl: urlField.or(z.literal('')).optional(),
});

/**
 * Changing a password.
 *
 * The current one is required even though the request is already authenticated.
 * A live session is not proof the person at the keyboard is the account holder
 * — an unlocked laptop is the whole threat — and a password change is the one
 * action that locks the real owner out of their own account.
 *
 * The confirmation field is checked here rather than only in the browser. It is
 * a typo guard, and a typo that reaches the server is exactly the case where
 * catching it matters: the new password is hashed and the original is gone.
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(8, 'Passwords need at least 8 characters').max(128),
    confirmPassword: z.string().min(1, 'Type the new password again'),
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: 'Those two do not match',
    path: ['confirmPassword'],
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    message: 'That is the password you already have',
    path: ['newPassword'],
  });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
