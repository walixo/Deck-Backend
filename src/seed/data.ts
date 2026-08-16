import type { Category, PricingModel } from '../constants';

export interface SeedUser {
  name: string;
  username: string;
  email: string;
  password: string;
  headline: string;
  bio: string;
  websiteUrl?: string;
}

export interface SeedItem {
  name: string;
  tagline: string;
  description: string;
  category: Category;
  pricing: PricingModel;
  websiteUrl: string;
  repoUrl?: string;
  tags: string[];
  makers: string[];
  /** How many days ago this launched — drives the daily leaderboard. */
  daysAgo: number;
  featured?: boolean;
}

/**
 * Demo content. Every product name here is fictional — the numbers are
 * generated, so nothing should be read as data about a real product.
 */
export const seedUsers: SeedUser[] = [
  {
    name: 'Ada Okonkwo',
    username: 'ada',
    email: 'ada@deck.dev',
    password: 'deck1234',
    headline: 'Building developer tools',
    bio: 'Systems engineer turned founder. I ship small tools that remove big papercuts.',
    websiteUrl: 'https://example.com/ada',
  },
  {
    name: 'Mateo Rivera',
    username: 'mateo',
    email: 'mateo@deck.dev',
    password: 'deck1234',
    headline: 'Design engineer',
    bio: 'Interfaces, motion, and the space between them.',
  },
  {
    name: 'Priya Raman',
    username: 'priya',
    email: 'priya@deck.dev',
    password: 'deck1234',
    headline: 'ML research engineer',
    bio: 'Small models, big appetite. Writing about evaluation and inference.',
  },
  {
    name: 'Jonas Weber',
    username: 'jonas',
    email: 'jonas@deck.dev',
    password: 'deck1234',
    headline: 'Indie iOS developer',
    bio: 'Ten years of Swift. Currently obsessed with on-device inference.',
  },
  {
    name: 'Lin Zhao',
    username: 'lin',
    email: 'lin@deck.dev',
    password: 'deck1234',
    headline: 'Agent workflows & automation',
    bio: 'I turn manual checklists into skills that run themselves.',
  },
  {
    name: 'Sofia Alvarez',
    username: 'sofia',
    email: 'sofia@deck.dev',
    password: 'deck1234',
    headline: 'Full-stack generalist',
    bio: 'Shipping weekend projects since forever. Ask me about Postgres or bread.',
  },
  {
    name: 'Noah Bennett',
    username: 'noah',
    email: 'noah@deck.dev',
    password: 'deck1234',
    headline: 'Hardware tinkerer',
    bio: 'Soldering iron in one hand, oscilloscope in the other.',
  },
];

export const seedItems: SeedItem[] = [
  {
    name: 'Lumen 3',
    tagline: 'A 7B reasoning model that runs comfortably on a laptop',
    description:
      'Lumen 3 is a compact reasoning model tuned for long-horizon planning and tool use. It fits in 8GB of memory with 4-bit quantisation and holds its own on multi-step tasks that usually need a much larger model.\n\nWeights, evaluation harness, and the full training recipe are open. There is a hosted playground if you would rather not download anything, plus GGUF and MLX builds for local runtimes.',
    category: 'ai-model',
    pricing: 'open-source',
    websiteUrl: 'https://example.com/lumen',
    repoUrl: 'https://github.com/example/lumen',
    tags: ['llm', 'local-first', 'reasoning', 'open-weights'],
    makers: ['Priya Raman', 'Ada Okonkwo'],
    daysAgo: 0,
    featured: true,
  },
  {
    name: 'Driftwood',
    tagline: 'Version control for your prompts, with real diffs and rollbacks',
    description:
      'Driftwood treats prompts like source code. Every edit is a commit, every deploy is tagged, and every regression is a diff you can actually read.\n\nHook it into your evaluation suite and Driftwood will flag the exact revision where quality dropped, then roll back with one click. Works with any provider.',
    category: 'ai-tool',
    pricing: 'freemium',
    websiteUrl: 'https://example.com/driftwood',
    tags: ['prompts', 'evaluation', 'devtools'],
    makers: ['Lin Zhao'],
    daysAgo: 0,
    featured: true,
  },
  {
    name: 'Standup Scribe',
    tagline: 'A Claude skill that turns messy standup notes into a clean digest',
    description:
      'Drop your raw standup notes in and Standup Scribe produces a structured digest: what shipped, what is blocked, who needs a decision, and the follow-ups nobody wrote down.\n\nIt is a single skill folder — copy it into your skills directory and it is available immediately. No services, no API keys.',
    category: 'claude-skill',
    pricing: 'free',
    websiteUrl: 'https://example.com/standup-scribe',
    repoUrl: 'https://github.com/example/standup-scribe',
    tags: ['claude-skill', 'productivity', 'meetings'],
    makers: ['Lin Zhao'],
    daysAgo: 0,
  },
  {
    name: 'Ferrite',
    tagline: 'A terminal file manager that finally feels fast',
    description:
      'Ferrite is a keyboard-driven file manager written in Rust. Fuzzy jump to any directory, preview images and PDFs inline, and run bulk renames with a real editor buffer.\n\nStartup is under 20ms on a cold cache. Configuration is a single TOML file you will actually understand.',
    category: 'developer-tool',
    pricing: 'open-source',
    websiteUrl: 'https://example.com/ferrite',
    repoUrl: 'https://github.com/example/ferrite',
    tags: ['cli', 'rust', 'terminal'],
    makers: ['Ada Okonkwo'],
    daysAgo: 0,
  },
  {
    name: 'Tidepool',
    tagline: 'Read-it-later that summarises before you forget you saved it',
    description:
      'Tidepool saves articles and gives each one a two-line summary the moment it lands, so your backlog is skimmable instead of shameful.\n\nWeekly digests group what you saved by theme. Offline reading, no ads, and an export button that gives you everything back as Markdown.',
    category: 'mobile-app',
    pricing: 'freemium',
    websiteUrl: 'https://example.com/tidepool',
    tags: ['ios', 'reading', 'summaries'],
    makers: ['Jonas Weber'],
    daysAgo: 0,
  },
  {
    name: 'Halcyon UI',
    tagline: 'Accessible React primitives with dark mode built in, not bolted on',
    description:
      'Forty unstyled, fully accessible React components with a theming layer that treats light and dark as equal citizens. Every component ships with keyboard interaction tests and documented ARIA behaviour.\n\nTailwind-first, but the tokens are plain CSS variables so you can bring your own styling approach.',
    category: 'developer-tool',
    pricing: 'open-source',
    websiteUrl: 'https://example.com/halcyon',
    repoUrl: 'https://github.com/example/halcyon',
    tags: ['react', 'accessibility', 'design-system', 'tailwind'],
    makers: ['Mateo Rivera'],
    daysAgo: 1,
    featured: true,
  },
  {
    name: 'Beacon',
    tagline: 'Uptime monitoring that explains outages instead of just paging you',
    description:
      'Beacon watches your endpoints from twelve regions and, when something breaks, correlates the failure with your recent deploys, DNS changes, and upstream provider incidents.\n\nThe alert you receive already contains the likely cause. Status pages are included and take about a minute to set up.',
    category: 'developer-tool',
    pricing: 'freemium',
    websiteUrl: 'https://example.com/beacon',
    tags: ['monitoring', 'devops', 'observability'],
    makers: ['Sofia Alvarez'],
    daysAgo: 1,
  },
  {
    name: 'Mosaic Vision',
    tagline: 'Open vision-language model for documents, charts, and screenshots',
    description:
      'Mosaic Vision reads dense documents — invoices, scientific charts, UI screenshots — and returns structured output rather than prose. Table extraction holds up on scans and photographs.\n\nApache licensed, 3B parameters, with a fine-tuning script that runs on a single consumer GPU.',
    category: 'ai-model',
    pricing: 'open-source',
    websiteUrl: 'https://example.com/mosaic-vision',
    repoUrl: 'https://github.com/example/mosaic-vision',
    tags: ['vision', 'ocr', 'open-weights', 'documents'],
    makers: ['Priya Raman'],
    daysAgo: 1,
  },
  {
    name: 'Changelog Cartographer',
    tagline: 'A Claude skill that writes release notes from your git history',
    description:
      'Point it at a commit range and it produces release notes in three registers at once: a one-line summary for social, a user-facing changelog, and a technical section for the team.\n\nIt groups by user-visible impact rather than by commit order, and it flags breaking changes it finds in diffs even when nobody labelled them.',
    category: 'claude-skill',
    pricing: 'free',
    websiteUrl: 'https://example.com/changelog-cartographer',
    repoUrl: 'https://github.com/example/changelog-cartographer',
    tags: ['claude-skill', 'git', 'release-notes'],
    makers: ['Ada Okonkwo'],
    daysAgo: 1,
  },
  {
    name: 'Grainstore',
    tagline: 'Local-first notes with sync you can host yourself',
    description:
      'Grainstore keeps every note as a plain Markdown file on your disk. Sync is a small binary you run on any machine you already own — no accounts, no vendor.\n\nBacklinks, full-text search across ten thousand notes in milliseconds, and a mobile client that works fully offline.',
    category: 'website',
    pricing: 'paid',
    websiteUrl: 'https://example.com/grainstore',
    tags: ['notes', 'local-first', 'markdown', 'self-hosted'],
    makers: ['Sofia Alvarez', 'Jonas Weber'],
    daysAgo: 2,
  },
  {
    name: 'Slate Keyboard',
    tagline: 'A 60% mechanical keyboard with an e-ink layer display',
    description:
      'Slate puts a thin e-ink strip above the number row that shows your current layer, so custom layouts stop being something you have to memorise.\n\nHot-swappable switches, QMK firmware, aluminium case, and a battery that genuinely lasts months because the display only draws power when it changes.',
    category: 'hardware',
    pricing: 'paid',
    websiteUrl: 'https://example.com/slate',
    tags: ['keyboard', 'hardware', 'qmk'],
    makers: ['Noah Bennett'],
    daysAgo: 2,
    featured: true,
  },
  {
    name: 'Understudy',
    tagline: 'Screenshot tests that survive a redesign',
    description:
      'Understudy compares renders semantically instead of pixel by pixel, so moving a button four pixels does not fail your whole suite — but deleting it does.\n\nRuns in CI in under a minute for a few hundred components, with review links that show before, after, and what it thinks changed.',
    category: 'developer-tool',
    pricing: 'freemium',
    websiteUrl: 'https://example.com/understudy',
    tags: ['testing', 'ci', 'frontend'],
    makers: ['Mateo Rivera'],
    daysAgo: 2,
  },
  {
    name: 'Cadence',
    tagline: 'Habit tracking that adapts when your week falls apart',
    description:
      'Most habit apps punish a missed day. Cadence looks at your actual calendar and reschedules, then shows a trend line instead of a streak you are terrified to break.\n\nWidgets, Apple Health import, and a weekly review that takes ninety seconds.',
    category: 'mobile-app',
    pricing: 'freemium',
    websiteUrl: 'https://example.com/cadence',
    tags: ['ios', 'habits', 'health'],
    makers: ['Jonas Weber'],
    daysAgo: 3,
  },
  {
    name: 'Quarry',
    tagline: 'Natural language over your own database, with the SQL always visible',
    description:
      'Quarry connects to your warehouse read-only, learns your schema and naming conventions, and answers questions in SQL you can inspect before it runs.\n\nEvery answer shows the query, the row count, and the assumptions it made. Nothing executes without your click.',
    category: 'ai-tool',
    pricing: 'paid',
    websiteUrl: 'https://example.com/quarry',
    tags: ['sql', 'analytics', 'data'],
    makers: ['Sofia Alvarez'],
    daysAgo: 3,
  },
  {
    name: 'Pathfinder',
    tagline: 'A Claude skill for reviewing pull requests like a senior engineer',
    description:
      'Pathfinder reads the diff in the context of the surrounding codebase, not in isolation. It flags the change that will break a caller three files away, and stays quiet about formatting.\n\nComes with a configurable severity policy so it comments on what your team actually cares about.',
    category: 'claude-skill',
    pricing: 'free',
    websiteUrl: 'https://example.com/pathfinder',
    repoUrl: 'https://github.com/example/pathfinder',
    tags: ['claude-skill', 'code-review', 'git'],
    makers: ['Lin Zhao', 'Ada Okonkwo'],
    daysAgo: 3,
  },
  {
    name: 'Nightjar',
    tagline: 'Speech-to-text that keeps up with real conversation',
    description:
      'Nightjar is a streaming ASR model with diarisation built in. It handles overlapping speakers, code-switching, and technical vocabulary without a custom dictionary.\n\nRuns locally at faster than real time on Apple silicon. Ninety-two languages.',
    category: 'ai-model',
    pricing: 'open-source',
    websiteUrl: 'https://example.com/nightjar',
    repoUrl: 'https://github.com/example/nightjar',
    tags: ['speech', 'transcription', 'open-weights'],
    makers: ['Priya Raman'],
    daysAgo: 4,
  },
  {
    name: 'Loamy',
    tagline: 'Seed and reset your dev database in one command',
    description:
      'Loamy generates realistic fixtures from your actual schema — believable names, valid foreign keys, sensible distributions — and lets you snapshot and restore any state instantly.\n\nWorks with Mongo and Postgres. Snapshots are files you can commit.',
    category: 'developer-tool',
    pricing: 'open-source',
    websiteUrl: 'https://example.com/loamy',
    repoUrl: 'https://github.com/example/loamy',
    tags: ['database', 'fixtures', 'devtools'],
    makers: ['Ada Okonkwo'],
    daysAgo: 4,
  },
  {
    name: 'Foldspace',
    tagline: 'A calm, single-page portfolio builder for people who ship',
    description:
      'Foldspace pulls your projects from GitHub, your writing from RSS, and lays it out as one considered page. No drag-and-drop canvas, no 400 templates — six typographic systems that all look good.\n\nCustom domains, a real dark mode, and a Lighthouse score in the high nineties by default.',
    category: 'website',
    pricing: 'freemium',
    websiteUrl: 'https://example.com/foldspace',
    tags: ['portfolio', 'no-code', 'design'],
    makers: ['Mateo Rivera'],
    daysAgo: 4,
  },
  {
    name: 'Signal Desk',
    tagline: 'Turn support tickets into a ranked product backlog',
    description:
      'Signal Desk clusters incoming tickets by underlying cause instead of by keyword, then weights each cluster by how many customers and how much revenue it touches.\n\nThe output is a backlog your product team can act on, refreshed daily.',
    category: 'ai-tool',
    pricing: 'paid',
    websiteUrl: 'https://example.com/signal-desk',
    tags: ['support', 'product', 'clustering'],
    makers: ['Lin Zhao'],
    daysAgo: 5,
  },
  {
    name: 'Pocket Lathe',
    tagline: 'A desktop CNC small enough for a bookshelf',
    description:
      'Pocket Lathe machines aluminium, brass, and hardwood in a footprint the size of a printer. Rigid steel frame, closed-loop steppers, and an enclosure that keeps chips off your desk.\n\nOpen firmware, standard tooling, and a bill of materials you can repair from.',
    category: 'hardware',
    pricing: 'paid',
    websiteUrl: 'https://example.com/pocket-lathe',
    tags: ['cnc', 'making', 'hardware'],
    makers: ['Noah Bennett'],
    daysAgo: 5,
  },
  {
    name: 'Ledgerly',
    tagline: 'Bookkeeping for freelancers who hate bookkeeping',
    description:
      'Connect your bank, and Ledgerly categorises everything, chases unpaid invoices on a schedule you set, and keeps a running estimate of what you owe in tax.\n\nQuarterly summaries your accountant will accept without a follow-up email.',
    category: 'website',
    pricing: 'paid',
    websiteUrl: 'https://example.com/ledgerly',
    tags: ['finance', 'freelance', 'invoicing'],
    makers: ['Sofia Alvarez'],
    daysAgo: 5,
  },
  {
    name: 'Marginalia',
    tagline: 'Annotate any PDF and get a study guide back',
    description:
      'Highlight as you read; Marginalia builds an outline, a glossary of the terms you highlighted, and spaced-repetition cards from your own notes rather than from the whole document.\n\nSyncs across devices and exports to Anki.',
    category: 'mobile-app',
    pricing: 'freemium',
    websiteUrl: 'https://example.com/marginalia',
    tags: ['ios', 'pdf', 'learning'],
    makers: ['Jonas Weber'],
    daysAgo: 6,
  },
  {
    name: 'Tinder Box',
    tagline: 'A Claude skill that scaffolds a new service the way your team does it',
    description:
      'Tinder Box learns the conventions in your existing repositories — folder layout, error handling, test style, logging — and scaffolds new services that match, instead of generating a generic template.\n\nOne file to configure, and it explains each convention it inferred so you can correct it.',
    category: 'claude-skill',
    pricing: 'free',
    websiteUrl: 'https://example.com/tinder-box',
    repoUrl: 'https://github.com/example/tinder-box',
    tags: ['claude-skill', 'scaffolding', 'conventions'],
    makers: ['Ada Okonkwo'],
    daysAgo: 6,
  },
  {
    name: 'Harborlight',
    tagline: 'Self-hosted analytics that respects your visitors',
    description:
      'No cookies, no fingerprinting, no consent banner needed. Harborlight gives you the five numbers you actually check, plus funnels when you need them.\n\nA single binary and a SQLite file. Runs happily on the smallest VPS you can rent.',
    category: 'developer-tool',
    pricing: 'open-source',
    websiteUrl: 'https://example.com/harborlight',
    repoUrl: 'https://github.com/example/harborlight',
    tags: ['analytics', 'privacy', 'self-hosted'],
    makers: ['Sofia Alvarez'],
    daysAgo: 7,
  },
  {
    name: 'Understory',
    tagline: 'Embedding model tuned for code search across mixed repositories',
    description:
      'Understory embeds code and prose in the same space, so a plain-English query finds the function that implements it even when the words never appear in the source.\n\n768 dimensions, MIT licensed, with an incremental indexer for monorepos.',
    category: 'ai-model',
    pricing: 'open-source',
    websiteUrl: 'https://example.com/understory',
    repoUrl: 'https://github.com/example/understory',
    tags: ['embeddings', 'code-search', 'open-weights'],
    makers: ['Priya Raman', 'Ada Okonkwo'],
    daysAgo: 7,
  },
  {
    name: 'Threadbare',
    tagline: 'Every meeting becomes a decision log, not a transcript',
    description:
      'Threadbare listens once and writes down only what changed: decisions made, owners assigned, and questions still open. No 4,000-word transcript nobody opens.\n\nPosts to your channel of choice within a minute of the call ending.',
    category: 'ai-tool',
    pricing: 'freemium',
    websiteUrl: 'https://example.com/threadbare',
    tags: ['meetings', 'summaries', 'teams'],
    makers: ['Lin Zhao'],
    daysAgo: 8,
  },
  {
    name: 'Wanderlight',
    tagline: 'Trip planning that starts from how you want the days to feel',
    description:
      'Tell Wanderlight you want two slow mornings and one long walk, and it builds an itinerary around that instead of cramming in landmarks.\n\nOffline maps, real opening hours, and a shared mode where everyone edits the same plan.',
    category: 'mobile-app',
    pricing: 'freemium',
    websiteUrl: 'https://example.com/wanderlight',
    tags: ['travel', 'ios', 'maps'],
    makers: ['Jonas Weber', 'Mateo Rivera'],
    daysAgo: 9,
  },
  {
    name: 'Copperplate',
    tagline: 'A variable typeface built for dense interfaces',
    description:
      'Copperplate is a humanist sans with a tall x-height and a tabular figure set, designed to stay legible at 12px in tables and dashboards.\n\nSeven weights, an optical size axis, and a licence that covers apps as well as websites.',
    category: 'website',
    pricing: 'paid',
    websiteUrl: 'https://example.com/copperplate',
    tags: ['typography', 'design', 'fonts'],
    makers: ['Mateo Rivera'],
    daysAgo: 10,
  },
  {
    name: 'Bramble',
    tagline: 'A soil sensor mesh for people who keep killing their plants',
    description:
      'Each Bramble node reads moisture, light, and temperature, then relays over a low-power mesh to a base station that speaks plain HTTP.\n\nBattery life measured in seasons. Firmware and hardware files are both open.',
    category: 'hardware',
    pricing: 'paid',
    websiteUrl: 'https://example.com/bramble',
    repoUrl: 'https://github.com/example/bramble',
    tags: ['iot', 'sensors', 'gardening'],
    makers: ['Noah Bennett'],
    daysAgo: 11,
  },
  {
    name: 'Keel',
    tagline: 'Type-safe API clients generated from your Express routes',
    description:
      'Keel reads your route definitions and validation schemas, then emits a fully typed client with TanStack Query hooks. Change a route, and the compiler tells you which components broke.\n\nZero runtime dependency in the generated output.',
    category: 'developer-tool',
    pricing: 'open-source',
    websiteUrl: 'https://example.com/keel',
    repoUrl: 'https://github.com/example/keel',
    tags: ['typescript', 'api', 'codegen'],
    makers: ['Ada Okonkwo', 'Sofia Alvarez'],
    daysAgo: 12,
  },
];

export const seedComments: string[] = [
  'Been waiting for something like this. The setup took under five minutes and it just worked.',
  'Genuinely impressive. The dark mode is the first one I have not immediately turned off.',
  'Using this on a client project already. One request: please add a CLI flag for CI runs.',
  'The docs deserve their own upvote. Clear, short, and every example actually runs.',
  'Tried the alternatives last month and gave up. This one held up on a real codebase.',
  'Small thing, but the keyboard shortcuts being discoverable made me stick with it.',
  'Performance is the headline for me — noticeably faster than what we had before.',
  'Congrats on the launch! Curious how you are thinking about self-hosting.',
  'The onboarding is doing a lot of quiet work here. Nothing felt like homework.',
  'This solved a problem I had stopped believing was solvable. Thank you.',
  'Would pay for this. The free tier is generous enough that I got to that conclusion honestly.',
  'One edge case: it stumbled on a monorepo with mixed package managers. Everything else was smooth.',
];
