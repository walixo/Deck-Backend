import type { ArtworkAnalysis } from './artwork';
import { putImage } from './storage';

/**
 * The one place Deck uses generative AI.
 *
 * **Why here and nowhere else.** A print mockup is a contract: the buyer is
 * approving what will be manufactured, so it has to be the actual file
 * composited at the actual size — which is what `lib/mockup` draws, with no
 * model involved. A lifestyle render is a different object with a different
 * job. It is a photograph that does not exist, for a shop page and a social
 * post: somebody wearing the thing, in a room, in a light. Nothing is being
 * approved and nothing is being manufactured from it, so a model inventing the
 * scene is exactly right.
 *
 * The two are shown together and labelled, so nobody mistakes the illustration
 * for the proof.
 *
 * **Provider.** Anthropic's models do not generate images, so this speaks to an
 * OpenAI-compatible image endpoint — the shape most providers now expose. It is
 * entirely optional: with no key configured `lifestyleConfigured` is false, the
 * endpoint answers plainly, and the button never appears. Deck has one hard
 * dependency on a third party (Paystack) and this does not become the second.
 */

const API_KEY = process.env.IMAGE_API_KEY ?? '';
const API_URL = process.env.IMAGE_API_URL ?? 'https://api.openai.com/v1/images/generations';
const MODEL = process.env.IMAGE_MODEL ?? 'gpt-image-1';

export const lifestyleConfigured = Boolean(API_KEY);

/** Reader-facing descriptions of what Deck prints, for the prompt. */
const GARMENT_WORDS: Record<string, string> = {
  white: 'a white',
  sand: 'a sand-coloured',
  grey: 'a heather grey',
  olive: 'an olive green',
  navy: 'a navy',
  black: 'a black',
};

const PRODUCT_SCENE: Record<string, string> = {
  tee: 'a person wearing {garment} cotton t-shirt, photographed from the chest up',
  hoodie: 'a person wearing {garment} heavyweight hoodie, photographed from the chest up',
  sticker: 'a vinyl sticker applied to the lid of a laptop on a desk',
  'sticker-sheet': 'a sheet of vinyl stickers lying on a wooden desk beside a notebook',
};

export interface LifestyleInput {
  product: string;
  garment: string;
  analysis: ArtworkAnalysis;
  /** The design's name — used as a hint at subject matter, never as text to draw. */
  name: string;
}

/**
 * Builds the prompt.
 *
 * Two instructions do most of the work and both are negative. **No text**,
 * because image models render lettering as convincing gibberish and a shop
 * photo with fake words on the garment is worse than no photo. And **leave the
 * print area plain**, because the artwork is composited on afterwards — asking
 * the model to draw the design would produce its guess at the file, which is
 * the exact failure this whole feature is arranged to avoid.
 */
function buildPrompt(input: LifestyleInput): string {
  const scene = (PRODUCT_SCENE[input.product] ?? PRODUCT_SCENE.tee).replace(
    '{garment}',
    GARMENT_WORDS[input.garment] ?? 'a plain',
  );

  return [
    `Editorial product photograph: ${scene}.`,
    'Natural window light, shallow depth of field, muted contemporary interior.',
    'Shot on a 50mm lens, realistic fabric texture and folds.',
    'The garment is completely plain and unprinted — no graphics, no logos, no text anywhere in the image.',
    'Leave the centre chest area unobstructed and evenly lit.',
    'No watermarks. No lettering of any kind.',
  ].join(' ');
}

export interface LifestyleResult {
  /** Public path of the generated scene. */
  url: string;
  prompt: string;
}

/**
 * Generates the scene and writes it into the upload directory.
 *
 * The response is decoded from base64 rather than fetched from a URL the
 * provider hosts: those URLs expire, and a shop page that 404s in an hour is
 * not a shop page. Deck owns the file from the moment it exists.
 */
export async function renderLifestyle(input: LifestyleInput): Promise<LifestyleResult> {
  if (!lifestyleConfigured) {
    throw new Error('Lifestyle renders are not configured on this deployment');
  }

  const prompt = buildPrompt(input);

  /* Bounded: image generation takes tens of seconds and a hung socket would
     otherwise hold a request open until the proxy gives up on it. */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ model: MODEL, prompt, size: '1024x1024', n: 1 }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Image provider returned ${response.status}: ${detail.slice(0, 200)}`);
    }

    const body = (await response.json()) as {
      data?: { b64_json?: string; url?: string }[];
    };

    const first = body.data?.[0];
    let bytes: Buffer;

    if (first?.b64_json) {
      bytes = Buffer.from(first.b64_json, 'base64');
    } else if (first?.url) {
      /* Some providers only return a URL. Fetch it once, now, while it is
         still alive, and store the bytes. */
      const image = await fetch(first.url, { signal: controller.signal });
      bytes = Buffer.from(await image.arrayBuffer());
    } else {
      throw new Error('Image provider returned no image');
    }

    /* Stored exactly like every other upload — same layer, same naming, same
       destination — so a generated render and an uploaded photo are the same
       kind of thing to everything downstream. */
    const { url } = await putImage(bytes, 'png');

    return { url, prompt };
  } finally {
    clearTimeout(timer);
  }
}
