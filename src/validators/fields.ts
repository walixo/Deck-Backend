import { z } from 'zod';

/**
 * Field shapes shared across validators.
 *
 * `imageField` in particular was defined only in `item.validators`, which meant
 * the profile validator reached for a bare `.url()` instead — and quietly made
 * avatar upload impossible, because the uploader hands back `/uploads/<id>.png`
 * and a `.url()` check rejects a path. One definition, used everywhere an image
 * is accepted, is the fix and the prevention.
 */
export const urlField = z.string().trim().url('Please enter a full URL, including https://');

/**
 * Either an absolute URL or a path handed back by `POST /api/uploads`.
 *
 * The `/uploads/<uuid>.<ext>` shape is matched strictly — a loose "starts with
 * /" check would let a client store an arbitrary path and have Deck render it.
 */
export const uploadedPath = z
  .string()
  .trim()
  .regex(
    /^\/uploads\/[0-9a-f-]{36}\.(jpg|png|gif|webp|avif)$/,
    'Images must be uploaded through Deck or given as a full URL',
  );

export const imageField = uploadedPath.or(urlField);
