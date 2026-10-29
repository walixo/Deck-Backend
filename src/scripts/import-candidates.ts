/**
 * Loads a spreadsheet of products into the import queue, for staff to review.
 *
 *   npm run import-candidates -- --template > africa.csv       # print a starter CSV
 *   npm run import-candidates -- --file africa.csv --dry-run   # check every row, write nothing
 *   npm run import-candidates -- --file africa.csv             # queue the good rows
 *   npm run import-candidates:prod -- --file africa.csv        # the same, on the server
 *
 * It never publishes. Every row lands in the queue at /admin/imports as
 * `pending`, exactly as if somebody had typed it in, and goes live only when a
 * person publishes it there. A spreadsheet is where mistakes are cheapest to
 * make and most expensive to have on the site.
 *
 * Each row goes through the same checks as the admin form — the same validator,
 * the category must exist, and nothing already on Deck or already queued for
 * the same domain — so the CSV is not a way round any of them. Bad rows are
 * reported with their line number and skipped; the rest still load.
 *
 * Columns (header row required, any order):
 *
 *   name, tagline, description, website, category, sources   — required
 *   country     two-letter code: NG, KE, GH, ZA, EG, RW ...
 *   tags        separated by ;
 *   pricing     free | freemium | paid | open-source
 *   logo        an image URL
 *   launched    2016, 2016-10 or 2016-10-04
 *   founders    people separated by ;  — each one  Name | Role | link | link
 *   sources     where the facts came from, separated by ; or spaces
 *   notes       for the reviewer, never shown publicly
 *
 * Founder links are only the ones a founder or their company published in a
 * professional capacity. No personal emails or phone numbers, ever — the
 * validator has no column for them, on purpose.
 */
/* eslint-disable no-console -- a CLI communicates by printing; that is the point. */
import fs from 'node:fs';
import { assertCategory } from '../controllers/category.controller';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { ImportCandidate } from '../models/ImportCandidate';
import { domainOf, findDuplicate } from '../services/imports';
import { ApiError } from '../utils/ApiError';
import { candidateSchema } from '../validators/import.validators';

const TEMPLATE = [
  'name,tagline,description,website,category,country,tags,pricing,logo,launched,founders,sources,notes',
  '"Example Pay","Payments for small shops in Lagos","Example Pay lets market traders take card and transfer payments from a phone, with settlement the next morning.",https://example.com,developer-tool,NG,"payments;fintech",freemium,,2021-03,"Ada Example | Co-founder & CEO | https://example.com/team","https://example.com/about; https://techcabal.com/example-article","Replace this row with real ones"',
].join('\n');

/** RFC 4180, the parts a spreadsheet export actually uses: quotes, escaped quotes, newlines in quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** "X", "LinkedIn", "GitHub" — what a founder link is, read off its host. */
function labelFor(url: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  if (host === 'x.com' || host === 'twitter.com') return 'X';
  if (host.endsWith('linkedin.com')) return 'LinkedIn';
  if (host === 'github.com') return 'GitHub';
  return 'Website';
}

function splitList(value: string | undefined, separator: RegExp): string[] {
  return (value ?? '')
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** "2016", "2016-10" or "2016-10-04" → the first day it could mean. */
function launchedFrom(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d{4}$/.test(text)) return `${text}-01-01`;
  if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;
  return text;
}

function toCandidate(cells: Record<string, string>) {
  return {
    name: cells.name,
    tagline: cells.tagline,
    description: cells.description,
    websiteUrl: cells.website,
    category: cells.category,
    country: cells.country || undefined,
    tags: splitList(cells.tags, /;/),
    pricing: cells.pricing || undefined,
    logoUrl: cells.logo || undefined,
    launchedAt: launchedFrom(cells.launched),
    founders: splitList(cells.founders, /;/).map((entry) => {
      const [name, headline, ...links] = entry.split('|').map((part) => part.trim());
      return {
        name,
        headline: headline || undefined,
        links: links.filter(Boolean).map((url) => ({ label: labelFor(url), url })),
      };
    }),
    sourceUrls: splitList(cells.sources, /[;\s]+/),
    notes: cells.notes || undefined,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--template')) {
    console.log(TEMPLATE);
    return;
  }

  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  if (!file) {
    console.error('Usage: npm run import-candidates -- --file <path.csv> [--dry-run] | --template');
    process.exitCode = 1;
    return;
  }

  const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!header) throw new Error('That file is empty');
  const columns = header.map((name) => name.trim().toLowerCase());

  await connectDatabase();

  let queued = 0;
  let skipped = 0;
  /* Domains seen earlier in this same file, so a spreadsheet with a product
     twice is caught in a dry run too, before anything is written. */
  const seen = new Set<string>();

  for (const [index, cells] of rows.entries()) {
    const line = index + 2;
    const record = Object.fromEntries(columns.map((column, i) => [column, cells[i]?.trim() ?? '']));
    const label = record.name || `(line ${line})`;

    const parsed = candidateSchema.safeParse(toCandidate(record));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      console.log(`  skip  line ${line}  ${label}: ${issue.path.join('.')} — ${issue.message}`);
      skipped += 1;
      continue;
    }

    const input = parsed.data;
    try {
      const domain = domainOf(input.websiteUrl);
      await assertCategory(input.category);
      const duplicate = seen.has(domain)
        ? 'appears twice in this file'
        : await findDuplicate(domain);
      if (duplicate) {
        console.log(`  skip  line ${line}  ${label}: ${duplicate}`);
        skipped += 1;
        continue;
      }
      seen.add(domain);

      if (!dryRun) {
        await ImportCandidate.create({
          ...input,
          country: input.country || undefined,
          logoUrl: input.logoUrl || undefined,
          domain,
          origin: 'csv',
        });
      }
      console.log(`  ${dryRun ? 'ok   ' : 'queued'}  line ${line}  ${label}`);
      queued += 1;
    } catch (error) {
      /* Field-level detail when there is some — "Pick a category from the
         list" is more use in a terminal than "Some fields need your attention". */
      const details = (error as ApiError).details as { message?: string }[] | undefined;
      const reason = details?.[0]?.message ?? (error as Error).message;
      console.log(`  skip  line ${line}  ${label}: ${reason}`);
      skipped += 1;
    }
  }

  console.log(
    `\n[import-candidates] ${queued} ${dryRun ? 'would be queued' : 'queued'}, ${skipped} skipped${dryRun ? ' — dry run, nothing written' : ''}`,
  );
  if (!dryRun && queued) console.log('Review and publish them at /admin/imports.');
}

main()
  .catch((error: unknown) => {
    console.error('[import-candidates] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => undefined));
