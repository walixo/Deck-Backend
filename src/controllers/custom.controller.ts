import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import { UPLOAD_DIR, UPLOAD_ROUTE } from '../config/uploads';
import {
  CURRENCY,
  CUSTOM_INK_SURCHARGE_ABOVE,
  CUSTOM_INK_SURCHARGE_MINOR,
  CUSTOM_PRINT_PRICING,
  CUSTOM_SIZES,
} from '../constants';
import { CustomDesign, type CustomProduct, type ICustomDesign } from '../models/CustomDesign';
import { analyseArtwork, GARMENTS, type ArtworkAnalysis } from '../services/artwork';
import { lifestyleConfigured, renderLifestyle } from '../services/lifestyle';
import { toCustomDesignResponse } from '../serializers';
import { audit } from '../services/audit';
import { ApiError } from '../utils/ApiError';
import type {
  CreateCustomDesignInput,
  ReviewCustomDesignInput,
  UpdateCustomDesignInput,
} from '../validators/custom.validators';

/** Same alphabet as order references: no 0/O/1/I, safe to read down a phone. */
function reference(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  return `DZ${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join('')}`;
}

/**
 * What Deck charges for this design on this product.
 *
 * Derived from the artwork rather than taken from the client, so the surcharge
 * cannot be avoided by lying about coverage. Returned by the preview endpoint
 * too, which is what lets the page show a live price as somebody changes
 * product — the same number, computed the same way, in both places.
 */
export function priceFor(product: CustomProduct, analysis: ArtworkAnalysis): number {
  const { baseMinor, apparel } = CUSTOM_PRINT_PRICING[product];

  /* Coverage only costs more on apparel. A sticker is cut from a printed sheet
     whatever is on it — the ink is the same square inch either way. */
  const heavy = apparel && analysis.inkCoverage > CUSTOM_INK_SURCHARGE_ABOVE;
  return baseMinor + (heavy ? CUSTOM_INK_SURCHARGE_MINOR : 0);
}

/**
 * Reads an uploaded PNG back off disk and measures it.
 *
 * The upload endpoint already verified the file's magic bytes and wrote it, so
 * this only accepts a path that endpoint produced — the strict `/uploads/<uuid>`
 * shape is enforced by the validator, and `path.basename` here is the second
 * guard against a traversal reaching outside the upload directory.
 */
async function analyseUpload(artworkUrl: string): Promise<ArtworkAnalysis> {
  const name = path.basename(artworkUrl);
  if (!/^[0-9a-f-]{36}\.png$/.test(name)) {
    throw ApiError.badRequest('Custom designs must be uploaded to Deck as a PNG');
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(path.join(UPLOAD_DIR, name));
  } catch {
    throw ApiError.badRequest('We could not read that upload — try uploading it again');
  }

  try {
    return analyseArtwork(buffer);
  } catch (cause) {
    /* The decoder's messages are written for a person ("Interlaced PNGs are not
       supported — re-export without interlacing"), so they are worth passing
       through rather than flattening to "bad file". */
    throw ApiError.badRequest(cause instanceof Error ? cause.message : 'We could not read that PNG');
  }
}

/**
 * Measures an upload without committing to anything.
 *
 * Its own endpoint because the page needs the analysis *before* somebody has
 * chosen a product — the warnings and the suggested garments are what they use
 * to choose. Creating a draft record for every file anybody drags in would fill
 * the collection with abandoned rows.
 */
export async function inspectArtwork(req: Request, res: Response): Promise<void> {
  const { artworkUrl } = req.body as { artworkUrl: string };
  const analysis = await analyseUpload(artworkUrl);

  res.json({
    success: true,
    data: {
      analysis,
      /* Every product priced for this specific artwork, so the picker can show
         real prices rather than "from". */
      pricing: Object.fromEntries(
        (Object.keys(CUSTOM_PRINT_PRICING) as CustomProduct[]).map((product) => [
          product,
          { ...CUSTOM_PRINT_PRICING[product], priceMinor: priceFor(product, analysis), currency: CURRENCY },
        ]),
      ),
      garments: GARMENTS,
      sizes: CUSTOM_SIZES,
      /* So the page knows whether to offer the render at all rather than
         showing a button that answers "not configured". */
      lifestyleAvailable: lifestyleConfigured,
    },
  });
}

export async function createCustomDesign(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateCustomDesignInput;

  const analysis = await analyseUpload(input.artworkUrl);
  const apparel = CUSTOM_PRINT_PRICING[input.product].apparel;

  if (apparel && !input.size) {
    throw ApiError.badRequest('Pick a size');
  }
  if (!GARMENTS.some((garment) => garment.id === input.garment)) {
    throw ApiError.badRequest('That is not a colour Deck prints on');
  }

  const design = await CustomDesign.create({
    owner: req.user!._id,
    reference: reference(),
    name: input.name,
    artworkUrl: input.artworkUrl,
    analysis,
    product: input.product,
    garment: input.garment,
    placement: input.placement,
    scale: input.scale,
    /* Dropped rather than stored for stickers — a sticker with a size of "M"
       is a field that will eventually be believed by something. */
    size: apparel ? input.size : undefined,
    priceMinor: priceFor(input.product, analysis),
    currency: CURRENCY,
    status: 'submitted',
  });

  res.status(201).json({ success: true, data: toCustomDesignResponse(design) });
}

/** Your own designs, newest first. */
export async function listMyDesigns(req: Request, res: Response): Promise<void> {
  const designs = await CustomDesign.find({ owner: req.user!._id }).sort({ createdAt: -1 });
  res.json({ success: true, data: designs.map(toCustomDesignResponse) });
}

export async function getCustomDesign(req: Request, res: Response): Promise<void> {
  const design = await CustomDesign.findOne({ reference: req.params.reference.toUpperCase() });
  if (!design) throw ApiError.notFound('We could not find that design');

  const user = req.user!;
  if (design.owner.toString() !== user._id.toString() && user.role !== 'admin') {
    throw ApiError.notFound('We could not find that design');
  }

  res.json({ success: true, data: toCustomDesignResponse(design) });
}

/**
 * Changes the product, colour or placement of a design already submitted.
 *
 * Re-prices from the stored analysis and drops it back to `submitted`: the
 * approval was for a specific thing on a specific garment, and moving a design
 * from a chest mark to a full-front print is a different object to review.
 */
export async function updateCustomDesign(req: Request, res: Response): Promise<void> {
  const input = req.body as UpdateCustomDesignInput;

  const design = await CustomDesign.findOne({ reference: req.params.reference.toUpperCase() });
  if (!design) throw ApiError.notFound('We could not find that design');

  if (design.owner.toString() !== req.user!._id.toString()) {
    throw ApiError.forbidden('That is not your design');
  }

  if (input.product !== undefined) design.product = input.product;
  if (input.garment !== undefined) design.garment = input.garment;
  if (input.placement !== undefined) design.placement = input.placement;
  if (input.scale !== undefined) design.scale = input.scale;
  if (input.size !== undefined) design.size = input.size;
  if (input.name !== undefined) design.name = input.name;

  design.priceMinor = priceFor(design.product, design.analysis);
  design.status = 'submitted';
  design.reviewedAt = null;
  design.reviewedBy = null;
  design.reviewNote = undefined;

  await design.save();

  res.json({ success: true, data: toCustomDesignResponse(design) });
}

export async function deleteCustomDesign(req: Request, res: Response): Promise<void> {
  const design = await CustomDesign.findOne({ reference: req.params.reference.toUpperCase() });
  if (!design) throw ApiError.notFound('We could not find that design');

  if (design.owner.toString() !== req.user!._id.toString()) {
    throw ApiError.forbidden('That is not your design');
  }

  await design.deleteOne();
  res.json({ success: true, data: { deleted: true } });
}

/* -------------------------------------------------------------- staff --- */

export async function listCustomQueue(_req: Request, res: Response): Promise<void> {
  const designs = await CustomDesign.find({ status: { $ne: 'draft' } })
    .sort({ status: 1, createdAt: 1 })
    .populate('owner', 'name username avatarUrl verified');

  const group = (status: ICustomDesign['status']) =>
    designs.filter((design) => design.status === status).map(toCustomDesignResponse);

  res.json({
    success: true,
    data: {
      submitted: group('submitted'),
      approved: group('approved'),
      rejected: group('rejected'),
    },
  });
}

/**
 * The decision. Always audited, in both directions.
 *
 * This is the one review on Deck that ends with a physical object in the post
 * with Deck's return address on it — so "we approved this and here is who and
 * why" needs to survive longer than anybody's memory of it.
 */
export async function reviewCustomDesign(req: Request, res: Response): Promise<void> {
  const { approve, note } = req.body as ReviewCustomDesignInput;

  const design = await CustomDesign.findOne({ reference: req.params.reference.toUpperCase() });
  if (!design) throw ApiError.notFound('We could not find that design');

  if (design.status !== 'submitted') {
    throw ApiError.badRequest('That design is not waiting on a decision');
  }

  design.status = approve ? 'approved' : 'rejected';
  design.reviewedAt = new Date();
  design.reviewedBy = req.user!._id;
  design.reviewNote = note;
  await design.save();

  await audit(req, {
    action: approve ? 'custom.approved' : 'custom.rejected',
    targetType: 'custom',
    targetId: design._id,
    targetLabel: design.reference,
    summary: approve
      ? `Approved custom print ${design.reference} ("${design.name}") for ${design.product} — ${note}`
      : `Turned down custom print ${design.reference} ("${design.name}") — ${note}`,
    after: { product: design.product, garment: design.garment, priceMinor: design.priceMinor, note },
  });

  res.json({ success: true, data: toCustomDesignResponse(design) });
}

/** Where the finished artwork lives, so print can fetch the original file. */
export function artworkPath(design: ICustomDesign): string {
  return `${UPLOAD_ROUTE}/${path.basename(design.artworkUrl)}`;
}

/**
 * Generates a lifestyle scene for a design.
 *
 * Owner only, and rate-limited by the simplest possible rule: one render per
 * design. These cost real money per call, and a button that can be held down is
 * a bill. Re-rendering means deleting the one you have.
 *
 * Failures come back as a plain message rather than a 500 — the provider being
 * down or out of credit is an ordinary condition here, and the design and its
 * accurate mockup are unaffected either way.
 */
export async function generateLifestyle(req: Request, res: Response): Promise<void> {
  if (!lifestyleConfigured) {
    throw ApiError.badRequest('Lifestyle renders are not switched on for this deployment');
  }

  const design = await CustomDesign.findOne({ reference: req.params.reference.toUpperCase() });
  if (!design) throw ApiError.notFound('We could not find that design');

  if (design.owner.toString() !== req.user!._id.toString()) {
    throw ApiError.forbidden('That is not your design');
  }
  if (design.lifestyleUrl) {
    throw ApiError.badRequest('This design already has a lifestyle render');
  }

  try {
    const result = await renderLifestyle({
      product: design.product,
      garment: design.garment,
      analysis: design.analysis,
      name: design.name,
    });

    design.lifestyleUrl = result.url;
    design.lifestylePrompt = result.prompt;
    await design.save();

    res.json({ success: true, data: toCustomDesignResponse(design) });
  } catch (cause) {
    // eslint-disable-next-line no-console -- a paid call failing is worth a log line.
    console.error('[lifestyle] render failed', design.reference, cause);
    throw ApiError.badRequest(
      cause instanceof Error && cause.name === 'AbortError'
        ? 'The image provider took too long. Try again in a moment.'
        : 'We could not make that render. Your design and its mockup are unaffected.',
    );
  }
}
