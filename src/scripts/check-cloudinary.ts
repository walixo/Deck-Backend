/**
 * Proves the Cloudinary credentials work, by using them.
 *
 *   npm run check:cloudinary          # from source, locally
 *   npm run check:cloudinary:prod     # on the server, where tsx is not installed
 *
 * A real round trip and not a ping: it uploads a small generated PNG through
 * the same `putImage` the app uses, fetches the returned URL back over the
 * network, checks the bytes that come back are the bytes that went out, and
 * then deletes it. Anything short of that — a credentials check, a reachability
 * check — passes in situations where uploading still fails, which makes it
 * worse than no check at all.
 *
 * Worth running twice: once locally when the keys arrive, and once from the
 * Render shell after the first deploy. The second is the one that matters,
 * because it is the environment's copy of the keys being tested rather than
 * yours.
 *
 * It touches no database and creates nothing that outlives it.
 */
/* eslint-disable no-console -- a CLI communicates by printing; that is the point. */
import { env } from '../config/env';
import { putImage, removeImage, usingCloudinary } from '../services/storage';

/**
 * The smallest thing that is honestly a PNG.
 *
 * An 8x8 solid square, written out by hand rather than read from disk so the
 * script has no fixture to lose. It has to be a real PNG: `putImage` is handed
 * bytes that the upload path has already validated against their own magic
 * number, and feeding it something else would test a route no upload takes.
 */
function testPng(): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); // width
  ihdr.writeUInt32BE(8, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  /* 10, 11, 12 stay zero: deflate, adaptive filtering, no interlace. */

  /* Eight rows of eight pixels, each row prefixed with filter type 0, stored
     uncompressed in a single deflate block — valid zlib, no dependency. */
  const raw = Buffer.concat(
    Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 0x7f)])),
  );
  const header = Buffer.from([0x78, 0x01]);
  const blockLength = Buffer.alloc(4);
  blockLength.writeUInt16LE(raw.length, 0);
  blockLength.writeUInt16LE(~raw.length & 0xffff, 2);
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(raw));
  const idat = Buffer.concat([header, Buffer.from([0x01]), blockLength, raw, adler]);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(buffer: Buffer): number {
  let a = 1;
  let b = 0;
  for (const byte of buffer) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

async function main(): Promise<void> {
  if (!usingCloudinary()) {
    console.error('Cloudinary is not configured — uploads would go to disk.');
    console.error('Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.');
    process.exitCode = 1;
    return;
  }

  console.log(`cloud:    ${env.cloudinary?.cloudName}`);

  const bytes = testPng();
  console.log(`uploading ${bytes.length} bytes…`);

  const stored = await putImage(bytes, 'png');
  console.log(`stored:   ${stored.url}`);
  console.log(`id:       ${stored.id}`);

  /* Fetched over the public internet, not through the SDK. The question this
     script exists to answer is whether a browser can load the URL that just
     went into the database — an API that says "created" does not answer it. */
  const response = await fetch(stored.url);
  if (!response.ok) {
    throw new Error(`stored URL came back ${response.status} ${response.statusText}`);
  }

  const returned = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') ?? 'unknown';
  console.log(`fetched:  ${returned.length} bytes, ${type}`);

  /* Cloudinary may re-encode, so equal bytes are not required — a PNG that
     decodes to the same image can differ. What must hold is that something
     image-shaped came back rather than an error page. */
  const isPng = returned.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isPng) {
    throw new Error(`the URL served something that is not a PNG (content-type ${type})`);
  }

  await removeImage(stored.id);
  console.log('cleaned:  test image deleted');
  console.log('\nCloudinary is working. Uploads will go there.');
}

main().catch((error: unknown) => {
  console.error('\nCloudinary check FAILED');
  console.error(error instanceof Error ? error.message : error);
  console.error(
    '\nUsual causes: a key copied with whitespace, the cloud name taken from the\n' +
      'dashboard URL rather than the Product Environment field, or an API key\n' +
      'belonging to a different environment than the secret.',
  );
  process.exitCode = 1;
});
