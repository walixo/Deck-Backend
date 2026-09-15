import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env';
import { UPLOAD_DIR, UPLOAD_ROUTE } from '../config/uploads';

/**
 * Where images actually go.
 *
 * One seam with two implementations behind it, chosen by whether Cloudinary is
 * configured. Everything upstream — the magic-byte validation, the generated
 * filenames, the rollback when one file in a batch fails — is unchanged and
 * unaware. The callers ask for a URL and get one.
 *
 * **Cloudinary when configured.** Set the three credentials and every upload
 * goes to the CDN and comes back as an absolute `https://res.cloudinary.com/…`
 * URL, which is what production wants: the host's disk stops being a thing that
 * has to survive a deploy, images are served from an edge near the reader
 * rather than from one box, and Render needs no paid persistent disk.
 *
 * **Disk when not.** Local development keeps working with no account, no keys
 * and no network — which matters, because the alternative is that nobody can
 * run the project without signing up for something. It is the same bargain
 * Paystack already has here: absent credentials disable the feature rather than
 * break the app.
 *
 * The consequence to keep in mind is that the two produce *different shapes* of
 * URL — a relative `/uploads/x.png` on disk, an absolute one on Cloudinary. The
 * database stores whatever it is given, so a database written in one mode and
 * read in the other will have URLs that do not resolve. In practice that only
 * bites if you copy a development dump into production.
 */

/** Where Deck's images live inside the Cloudinary account. */
const FOLDER = 'deck';

let configured = false;

function client(): typeof cloudinary | null {
  if (!env.cloudinary) return null;

  if (!configured) {
    cloudinary.config({
      cloud_name: env.cloudinary.cloudName,
      api_key: env.cloudinary.apiKey,
      api_secret: env.cloudinary.apiSecret,
      secure: true,
    });
    configured = true;
  }

  return cloudinary;
}

/** True when uploads leave this machine. Handy for a health or status page. */
export function usingCloudinary(): boolean {
  return Boolean(env.cloudinary);
}

/**
 * What a stored image is, once stored.
 *
 * `url` is what goes in the database and what a browser fetches. `id` is the
 * handle needed to delete it again, and is deliberately not the same thing:
 * on Cloudinary it is the public id, on disk it is the filename. Callers pass
 * it back to `remove` without needing to know which.
 */
export interface StoredImage {
  url: string;
  id: string;
}

/**
 * Stores one already-validated image and returns where to find it.
 *
 * `ext` comes from `detectImageType`, which reads the file's own magic bytes —
 * never from the client's filename or its declared mimetype.
 */
export async function putImage(bytes: Buffer, ext: string): Promise<StoredImage> {
  const name = crypto.randomUUID();
  const service = client();

  if (!service) {
    const filename = `${name}.${ext}`;
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOAD_DIR, filename), bytes);
    return { url: `${UPLOAD_ROUTE}/${filename}`, id: filename };
  }

  /*
   * `upload_stream` rather than the base64 data-URI form the docs lead with.
   * A 5MB image becomes a 6.7MB string that way, held in memory in full and on
   * top of the buffer it was made from — six of those in one request is real
   * pressure on a small instance for no benefit.
   */
  return new Promise<StoredImage>((resolve, reject) => {
    const stream = service.uploader.upload_stream(
      {
        folder: FOLDER,
        public_id: name,
        resource_type: 'image',
        /* The bytes have already been checked against their own signature, and
           the extension is derived from that check rather than from anything
           the client said. Letting Cloudinary sniff again would let it disagree
           with a decision this codebase has already made carefully. */
        format: ext,
        /* Deck generates its own names and never reuses one, so an overwrite
           would mean a UUID collision — something has gone wrong, and failing
           is better than silently replacing somebody else's image. */
        overwrite: false,
        invalidate: false,
      },
      (error, result) => {
        if (error || !result) {
          reject(error instanceof Error ? error : new Error('Cloudinary upload failed'));
          return;
        }
        resolve({ url: result.secure_url, id: result.public_id });
      },
    );

    stream.end(bytes);
  });
}

/**
 * Removes a stored image, quietly.
 *
 * Only ever called to clean up after a failure part-way through a batch, where
 * the error being handled is the one worth reporting — a delete that also fails
 * would replace a useful message with a confusing one. Anything left behind is
 * an orphan nobody links to, not a fault.
 */
export async function removeImage(id: string): Promise<void> {
  const service = client();

  try {
    if (service) {
      await service.uploader.destroy(id, { resource_type: 'image' });
    } else {
      await fs.rm(path.join(UPLOAD_DIR, id), { force: true });
    }
  } catch {
    /* See above. */
  }
}
