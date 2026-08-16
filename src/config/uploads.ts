import path from 'node:path';

/** Where uploaded images live on disk. Outside src/ so tsc never copies it. */
export const UPLOAD_DIR = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? 'uploads');

/** Public path prefix these files are served under. */
export const UPLOAD_ROUTE = '/uploads';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 6;

/**
 * Allowed image types, keyed by the extension we write. The client's declared
 * mimetype is never trusted on its own — every upload is matched against these
 * signatures before it touches disk.
 */
interface ImageType {
  ext: string;
  mime: string;
  matches: (buffer: Buffer) => boolean;
}

const startsWith = (buffer: Buffer, bytes: number[], offset = 0): boolean =>
  bytes.every((byte, index) => buffer[offset + index] === byte);

const ascii = (buffer: Buffer, text: string, offset = 0): boolean =>
  buffer.toString('latin1', offset, offset + text.length) === text;

export const IMAGE_TYPES: ImageType[] = [
  {
    ext: 'jpg',
    mime: 'image/jpeg',
    matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  {
    ext: 'png',
    mime: 'image/png',
    matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    ext: 'gif',
    mime: 'image/gif',
    matches: (b) => ascii(b, 'GIF87a') || ascii(b, 'GIF89a'),
  },
  {
    ext: 'webp',
    mime: 'image/webp',
    matches: (b) => ascii(b, 'RIFF') && ascii(b, 'WEBP', 8),
  },
  {
    ext: 'avif',
    mime: 'image/avif',
    // ISO-BMFF: bytes 4-7 are 'ftyp', then the brand.
    matches: (b) => ascii(b, 'ftyp', 4) && (ascii(b, 'avif', 8) || ascii(b, 'avis', 8)),
  },
];

/**
 * Identifies an upload from its magic bytes. Deliberately ignores the filename
 * and the client-declared mimetype: a file called `x.png` that is really HTML
 * would otherwise be served back from our own origin as HTML.
 *
 * SVG is not accepted — it can carry script, and it has no binary signature to
 * verify against.
 */
export function detectImageType(buffer: Buffer): ImageType | null {
  return IMAGE_TYPES.find((type) => type.matches(buffer)) ?? null;
}

export const ACCEPTED_MIMES = IMAGE_TYPES.map((type) => type.mime);
