import { Router } from 'express';
import multer from 'multer';
import { ACCEPTED_MIMES, MAX_FILE_BYTES, MAX_FILES_PER_REQUEST } from '../config/uploads';
import { uploadImages } from '../controllers/upload.controller';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/*
 * Memory storage, not disk: the controller verifies each file's magic bytes
 * before writing it, so nothing unverified ever lands in the served directory.
 * The mimetype filter here is only a cheap first pass.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_REQUEST },
  fileFilter(_req, file, callback) {
    if (!ACCEPTED_MIMES.includes(file.mimetype)) {
      callback(ApiError.badRequest(`${file.mimetype} files are not supported`));
      return;
    }
    callback(null, true);
  },
});

const router = Router();

router.post(
  '/',
  asyncHandler(requireAuth),
  upload.array('images', MAX_FILES_PER_REQUEST),
  asyncHandler(uploadImages),
);

export default router;
