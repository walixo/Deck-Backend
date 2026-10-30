/**
 * Gives imported listings their logos, from each product's own website.
 *
 *   npm run fetch-logos -- --dry-run          # find an icon for each, store nothing
 *   npm run fetch-logos                       # store them and attach them
 *   npm run fetch-logos -- --only "Paystack"  # just one
 *
 * Covers every import candidate (queued or published) with no logo, and the
 * published launch it became if that launch has none either.
 *
 * Where the logo comes from, in order:
 *
 * 1. The raster icons the company publishes for exactly this purpose — the
 *    apple-touch-icon, its web-app manifest icons, the PNG inside its favicon —
 *    largest first.
 * 2. Its SVG icon, for the many sites that publish only vector. Converted to a
 *    PNG by Cloudinary as it is stored (see `putSvgAsPng`), so no SVG is ever
 *    kept or served.
 * 3. Nigeria Logos (nigerialogos.com), Paystack's open collection of vector
 *    logos for Nigerian companies, matched on the product's website domain.
 *    Often a wordmark rather than a square icon; padded onto a square when
 *    stored. Matching by domain rather than name means an entry under a
 *    company's old brand and old domain is never picked up by accident.
 * 4. Google's public favicon cache, which holds a copy of a site's own icon
 *    and answers even when the site refuses automated requests. Fetched once
 *    here, never by a reader's browser.
 *
 * Never an `og:image`: those are usually wide banners with text on them, and a
 * banner squashed into a square logo slot looks worse than the monogram it
 * would replace. A listing with no usable icon keeps its monogram and is
 * reported, for staff to upload by hand.
 *
 * Every image is downloaded and stored in Deck's own image storage before it
 * is used. Pointing at the company's server instead would make every page view
 * a request to sixty-odd third-party sites — the kind of request Deck is
 * careful never to make without consent — and a logo that changes or moves
 * there would break here.
 *
 * Raster images go through the same magic-byte check as user uploads. Square
 * only, and rasters at least 96px: anything smaller looks blurred at the size
 * a listing shows it.
 *
 * Refuses to store anything unless Cloudinary is configured. Without it, images
 * land on this machine's disk with a relative `/uploads/…` path, which means
 * nothing to a production database being written from a laptop.
 */
/* eslint-disable no-console -- a CLI communicates by printing; that is the point. */
import { connectDatabase, disconnectDatabase } from '../config/db';
import { detectImageType, MAX_FILE_BYTES } from '../config/uploads';
import { ImportCandidate } from '../models/ImportCandidate';
import { Item } from '../models/Item';
import { putImage, putSvgAsPng, usingCloudinary } from '../services/storage';

const MIN_SIZE = 96;
/* Wordmarks wider than this become an unreadable sliver once padded onto a
   square tile. */
const MAX_WORDMARK_RATIO = 7;
const NIGERIA_LOGOS = 'https://raw.githubusercontent.com/PaystackHQ/nigerialogos/master/public';
const TIMEOUT_MS = 15_000;
/* An ordinary browser's user agent: some sites refuse requests that do not
   look like one, and this asks for nothing a browser would not. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

async function get(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function getBytes(url: string): Promise<Buffer> {
  const response = await get(url);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_FILE_BYTES) throw new Error('too large');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new Error('too large');
  return bytes;
}

interface Candidate {
  url: string;
  /** Declared size, when the page says one. Used only to order the attempts. */
  size: number;
  from: string;
  svg?: boolean;
}

const attr = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];

/** "180x180", "32x32 64x64", "any" → the largest number in it, or 0. */
function declaredSize(sizes: string | undefined): number {
  return Math.max(0, ...(sizes ?? '').split(/\s+/).map((s) => Number(s.split('x')[0]) || 0));
}

/** Every icon the page and its manifest offer, best first. */
async function iconsFor(website: string): Promise<{ icons: Candidate[]; base: string }> {
  const response = await get(website);
  const base = response.url;
  const html = await response.text();
  const icons: Candidate[] = [];
  const resolve = (href: string) => new URL(href, base).toString();

  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    const href = attr(tag, 'href');
    /* Safari's mask-icon is a one-colour silhouette, not the logo. */
    if (!href || rel.includes('mask-icon')) continue;
    const vector = /\.svg($|\?)/i.test(href) || (attr(tag, 'type') ?? '').includes('svg');

    if (rel.includes('apple-touch-icon')) {
      icons.push({
        url: resolve(href),
        size: declaredSize(attr(tag, 'sizes')) || 180,
        from: 'apple-touch-icon',
      });
    } else if (rel.split(/\s+/).includes('icon')) {
      icons.push({
        url: resolve(href),
        size: declaredSize(attr(tag, 'sizes')),
        from: vector ? 'svg icon' : 'icon',
        svg: vector,
      });
    } else if (rel === 'manifest') {
      try {
        const manifestUrl = resolve(href);
        const manifest = (await (await get(manifestUrl)).json()) as {
          icons?: { src: string; sizes?: string; type?: string }[];
        };
        for (const icon of manifest.icons ?? []) {
          const svg = Boolean(icon.type?.includes('svg') || /\.svg($|\?)/i.test(icon.src));
          icons.push({
            url: new URL(icon.src, manifestUrl).toString(),
            size: declaredSize(icon.sizes),
            from: svg ? 'manifest svg' : 'manifest',
            svg,
          });
        }
      } catch {
        /* A broken manifest is common and costs nothing — the other sources remain. */
      }
    }
  }

  /* The conventional locations, for sites that rely on them without a tag. */
  icons.push({
    url: resolve('/apple-touch-icon.png'),
    size: 180,
    from: 'apple-touch-icon (default path)',
  });
  icons.push({ url: resolve('/favicon.ico'), size: 0, from: 'favicon.ico' });

  const seen = new Set<string>();
  return {
    base,
    icons: icons
      .filter((icon) => !seen.has(icon.url) && seen.add(icon.url))
      .sort((a, b) => b.size - a.size),
  };
}

/** The largest PNG stored inside an .ico, if it holds any. BMP entries are skipped. */
function pngFromIco(bytes: Buffer): Buffer | null {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  let best: Buffer | null = null;
  let bestSize = 0;
  for (let index = 0; index < bytes.readUInt16LE(4); index += 1) {
    const entry = 6 + index * 16;
    if (entry + 16 > bytes.length) break;
    const size = bytes[entry] || 256;
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    const data = bytes.subarray(offset, offset + length);
    if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47 && size > bestSize) {
      best = data;
      bestSize = size;
    }
  }
  return best;
}

/** Width and height, read from the file's own header. Null when it cannot tell. */
function dimensions(bytes: Buffer, ext: string): { width: number; height: number } | null {
  try {
    if (ext === 'png') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (ext === 'gif') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    if (ext === 'webp') {
      const chunk = bytes.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') {
        return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
      }
    }
    if (ext === 'jpg') {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        const length = bytes.readUInt16BE(offset + 2);
        /* Start-of-frame markers carry the size; C4, C8 and CC are not frames. */
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

interface Found {
  bytes: Buffer;
  /** `svg` is stored through Cloudinary's conversion; everything else as-is. */
  ext: string;
  width: number;
  height: number;
  from: string;
  url: string;
}

/** A raster icon, if it is a real image, square and big enough; otherwise why it is not. */
async function tryRaster(url: string, from: string): Promise<{ found?: Found; reason?: string }> {
  let bytes = await getBytes(url);
  if (url.toLowerCase().includes('.ico')) bytes = pngFromIco(bytes) ?? bytes;
  const type = detectImageType(bytes);
  if (!type)
    return { reason: 'its icons are a format Deck cannot use (usually an old BMP favicon)' };
  const size = dimensions(bytes, type.ext);
  if (!size) return {};
  if (Math.abs(size.width - size.height) > size.width * 0.1) {
    return { reason: `the largest icon is not square (${size.width}×${size.height})` };
  }
  if (size.width < MIN_SIZE) return { reason: `the largest icon is only ${size.width}px` };
  return { found: { bytes, ext: type.ext, ...size, from, url } };
}

/**
 * An SVG icon, if it really is an SVG and draws a square.
 *
 * Squareness is read off the root element's viewBox, or its width and height.
 * One with neither is let through: it scales to whatever box it is given, and
 * the conversion pads it onto a square either way.
 */
async function trySvg(url: string, from: string): Promise<Found | null> {
  const bytes = await getBytes(url);
  const text = bytes.toString('utf8');
  const root = text.match(/<svg\b[^>]*>/i)?.[0];
  if (!root) return null;

  const viewBox = attr(root, 'viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = viewBox?.[2] ?? parseFloat(attr(root, 'width') ?? '');
  const height = viewBox?.[3] ?? parseFloat(attr(root, 'height') ?? '');
  if (width && height && Math.abs(width - height) > width * 0.1) return null;

  return { bytes, ext: 'svg', width: 512, height: 512, from, url };
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

let nigeriaIndex: Promise<{ title: string; filename: string; url: string }[]> | null = null;

/** Nigeria Logos' index, fetched once per run. Empty if it cannot be read. */
function nigeriaLogos() {
  nigeriaIndex ??= get(`${NIGERIA_LOGOS}/logos.json`)
    .then(
      (response) => response.json() as Promise<{ title: string; filename: string; url: string }[]>,
    )
    .catch(() => []);
  return nigeriaIndex;
}

/** The Nigeria Logos vector for this exact domain, if the collection has one. */
async function fromNigeriaLogos(website: string): Promise<Found | null> {
  const host = hostOf(website);
  const entry = (await nigeriaLogos()).find((logo) => hostOf(logo.url) === host);
  if (!entry || !/^[a-z0-9_-]+$/i.test(entry.filename)) return null;

  const url = `${NIGERIA_LOGOS}/logos/${entry.filename}/${entry.filename}.svg`;
  const bytes = await getBytes(url);
  const root = bytes.toString('utf8').match(/<svg\b[^>]*>/i)?.[0];
  if (!root) return null;

  const viewBox = attr(root, 'viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = viewBox?.[2] ?? parseFloat(attr(root, 'width') ?? '');
  const height = viewBox?.[3] ?? parseFloat(attr(root, 'height') ?? '');
  if (width && height && Math.max(width, height) / Math.min(width, height) > MAX_WORDMARK_RATIO) {
    return null;
  }

  return {
    bytes,
    ext: 'svg',
    width: 512,
    height: 512,
    from: `Nigeria Logos (${entry.title})`,
    url,
  };
}

/** The best logo the site, Nigeria Logos, or Google's copy of its icon can offer. */
async function findLogo(website: string): Promise<{ found?: Found; reason: string }> {
  let icons: Candidate[] = [];
  let reason = 'no usable icon on the site';
  try {
    ({ icons } = await iconsFor(website));
  } catch (error) {
    reason = `site would not load (${(error as Error).message})`;
  }

  for (const icon of icons.filter((entry) => !entry.svg)) {
    try {
      const result = await tryRaster(icon.url, icon.from);
      if (result.found) return { found: result.found, reason: '' };
      if (result.reason) reason = result.reason;
    } catch {
      /* Missing default paths are expected; try the next one. */
    }
  }

  for (const icon of icons.filter((entry) => entry.svg)) {
    try {
      const found = await trySvg(icon.url, icon.from);
      if (found) return { found, reason: '' };
    } catch {
      /* Try the next one. */
    }
  }

  try {
    const found = await fromNigeriaLogos(website);
    if (found) return { found, reason: '' };
  } catch {
    /* Not in the collection, or GitHub did not answer. */
  }

  /* Last resort: Google's cached copy of the site's own icon. It answers even
     for sites that block automated requests, and refuses rather than upscales
     when it has nothing at this size, so the size check still means something. */
  try {
    const origin = new URL(website).origin;
    const cached = `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(origin)}&size=256`;
    const result = await tryRaster(cached, 'Google favicon cache');
    if (result.found) return { found: result.found, reason: '' };
    if (result.reason)
      reason = `${reason}; in Google's copy, ${result.reason.replace('its icons are', 'the icon is')}`;
  } catch {
    /* Nothing cached either. */
  }

  return { reason };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1]?.toLowerCase() : undefined;

  if (!dryRun && !usingCloudinary()) {
    console.error(
      'Cloudinary is not configured here, so logos would be saved to this machine with paths production cannot serve. Set the CLOUDINARY_* variables, or use --dry-run.',
    );
    process.exitCode = 1;
    return;
  }

  await connectDatabase();

  const candidates = await ImportCandidate.find({
    status: { $in: ['pending', 'published'] },
    $or: [{ logoUrl: { $exists: false } }, { logoUrl: '' }, { logoUrl: null }],
  }).sort({ createdAt: 1 });

  const missing: string[] = [];
  let attached = 0;

  for (const candidate of candidates) {
    if (only && candidate.name.toLowerCase() !== only) continue;

    const { found, reason } = await findLogo(candidate.websiteUrl);
    if (!found) {
      console.log(`  none   ${candidate.name}: ${reason}`);
      missing.push(candidate.name);
      continue;
    }

    const label = `${found.width}×${found.height} ${found.ext} from ${found.from}`;
    if (dryRun) {
      console.log(`  found  ${candidate.name}  (${label})`);
      attached += 1;
      continue;
    }

    const stored =
      found.ext === 'svg' ? await putSvgAsPng(found.bytes) : await putImage(found.bytes, found.ext);
    candidate.logoUrl = stored.url;
    await candidate.save();

    /* A published candidate's launch gets it too — unless staff already gave
       that launch a logo by hand, which wins. */
    if (candidate.item) {
      await Item.updateOne(
        {
          _id: candidate.item,
          $or: [{ logoUrl: { $exists: false } }, { logoUrl: '' }, { logoUrl: null }],
        },
        { $set: { logoUrl: stored.url } },
      );
    }

    console.log(`  logo   ${candidate.name}  (${label})`);
    attached += 1;
  }

  console.log(
    `\n[fetch-logos] ${attached} ${dryRun ? 'found' : 'attached'}, ${missing.length} without a usable icon${dryRun ? ' — dry run, nothing stored' : ''}`,
  );
  if (missing.length) {
    console.log('Upload these by hand from Admin → Imports → Edit:', missing.join(', '));
  }
}

main()
  .catch((error: unknown) => {
    console.error('[fetch-logos] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => undefined));
