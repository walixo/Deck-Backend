import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import {
  detectImageType,
  MAX_FILES_PER_REQUEST,
  UPLOAD_DIR,
  UPLOAD_ROUTE,
} from '../config/uploads';
import { ApiError } from '../utils/ApiError';

/**
 * Accepts image uploads and returns the paths to store on an item.
 *
 * Files arrive in memory so every one can be verified before it reaches disk.
 * Filenames are generated here and never derived from client input, which rules
 * out path traversal and collisions in one step.
 */
export async function uploadImages(req: Request, res: Response): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];

  if (files.length === 0) {
    throw ApiError.badRequest('Choose at least one image to upload');
  }

  if (files.length > MAX_FILES_PER_REQUEST) {
    throw ApiError.badRequest(`You can upload at most ${MAX_FILES_PER_REQUEST} images at a time`);
  }

  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  const written: string[] = [];

  try {
    for (const file of files) {
      const type = detectImageType(file.buffer);
      if (!type) {
        throw ApiError.badRequest(
          `"${file.originalname}" is not a supported image. Use JPEG, PNG, GIF, WebP or AVIF.`,
        );
      }

      const filename = `${crypto.randomUUID()}.${type.ext}`;
      await fs.writeFile(path.join(UPLOAD_DIR, filename), file.buffer);
      written.push(filename);
    }
  } catch (error) {
    // One bad file should not leave the earlier ones orphaned on disk.
    await Promise.all(
      written.map((filename) => fs.rm(path.join(UPLOAD_DIR, filename), { force: true })),
    );
    throw error;
  }

  res.status(201).json({
    success: true,
    data: written.map((filename) => ({ url: `${UPLOAD_ROUTE}/${filename}` })),
  });
}
