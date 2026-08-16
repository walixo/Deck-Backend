/**
 * The "Featured on Deck" badge a maker can paste into a README or their own
 * site — the shields.io shape, in Deck's own styling.
 *
 * SVG rather than a raster, deliberately: it is served on every view of every
 * page that embeds it, so it needs to be tiny and cacheable, and it has to stay
 * crisp on a retina display without shipping three sizes. GitHub, npm and every
 * static host render an `<img src="…svg">` without complaint.
 *
 * The social share card is a different problem with a different answer — see
 * the note in the share controller.
 */

/** Escapes text for XML. Untrusted product names go through here. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Approximates rendered width for the monospace-ish face used here.
 *
 * The badge cannot measure text — there is no layout engine — so the box is
 * sized from a per-character estimate. Slightly generous on purpose: a badge
 * with a little too much padding looks designed, one that clips its own label
 * looks broken.
 */
function widthOf(text: string, size: number): number {
  let width = 0;
  for (const char of text) {
    if (/[A-Z]/.test(char)) width += size * 0.68;
    else if (/[iIl1.,:' ]/.test(char)) width += size * 0.32;
    else width += size * 0.58;
  }
  return Math.ceil(width);
}

export interface EmbedBadgeOptions {
  label: string;
  value: string;
  /** Accent fill for the value half. */
  accent: string;
  dark: boolean;
}

export function renderEmbedBadge({ label, value, accent, dark }: EmbedBadgeOptions): string {
  const FONT = "ui-monospace,SFMono-Regular,Menlo,Monaco,'Cascadia Mono',Consolas,monospace";
  const size = 11;
  const height = 28;
  const padding = 10;

  const labelWidth = widthOf(label, size) + padding * 2;
  const valueWidth = widthOf(value, size) + padding * 2;
  const total = labelWidth + valueWidth;

  /* The badge is embedded on somebody else's page, so it carries its own
     colours rather than inheriting — but it offers a dark variant, because a
     black-on-white badge on a dark README is a bright rectangle. */
  const edge = dark ? '#f7f6f2' : '#111111';
  const surface = dark ? '#1e1e1e' : '#ffffff';
  const labelInk = dark ? '#f7f6f2' : '#111111';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${height}" viewBox="0 0 ${total} ${height}" role="img" aria-label="${escapeXml(`${label}: ${value}`)}">
  <title>${escapeXml(`${label}: ${value}`)}</title>
  <g shape-rendering="crispEdges">
    <rect x="0" y="0" width="${labelWidth}" height="${height}" fill="${surface}"/>
    <rect x="${labelWidth}" y="0" width="${valueWidth}" height="${height}" fill="${accent}"/>
    <rect x="1" y="1" width="${total - 2}" height="${height - 2}" fill="none" stroke="${edge}" stroke-width="2"/>
    <rect x="${labelWidth}" y="1" width="2" height="${height - 2}" fill="${edge}"/>
  </g>
  <g font-family="${FONT}" font-size="${size}" font-weight="700" letter-spacing="0.6">
    <text x="${labelWidth / 2}" y="${height / 2}" fill="${labelInk}" text-anchor="middle" dominant-baseline="central">${escapeXml(label)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="${height / 2}" fill="#111111" text-anchor="middle" dominant-baseline="central">${escapeXml(value)}</text>
  </g>
</svg>`;
}
