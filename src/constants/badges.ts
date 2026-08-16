/**
 * Every badge Deck awards.
 *
 * Three families, so the set rewards more than one way of being here: making
 * things, taking part, and trading. A board that only celebrates launches tells
 * everyone who comments and votes that they are furniture.
 *
 * `threshold` is what the counter has to reach. `metric` names which counter,
 * and the evaluator is the only thing that knows how to compute each one — so
 * adding a badge on an existing metric is one line here and nothing else.
 */
export const BADGE_METRICS = [
  'launches',
  'votesReceived',
  'topFinishes',
  'podiumFinishes',
  'wellReviewed',
  'commentsWritten',
  'votesGiven',
  'contributionsMade',
  'fundraiseFunded',
  'merchSold',
] as const;

export type BadgeMetric = (typeof BADGE_METRICS)[number];

export type BadgeFamily = 'making' | 'community' | 'trade';

export interface BadgeDefinition {
  id: string;
  name: string;
  description: string;
  family: BadgeFamily;
  metric: BadgeMetric;
  threshold: number;
  /** Drawn as two letters in the badge tile; the design has no icon set. */
  mark: string;
}

export const BADGES: BadgeDefinition[] = [
  /* ------------------------------------------------------------- making -- */
  {
    id: 'first-launch',
    name: 'Shipped it',
    description: 'Put your first product on Deck',
    family: 'making',
    metric: 'launches',
    threshold: 1,
    mark: '01',
  },
  {
    id: 'serial-launcher',
    name: 'Serial launcher',
    description: 'Launched five products',
    family: 'making',
    metric: 'launches',
    threshold: 5,
    mark: '05',
  },
  {
    id: 'prolific',
    name: 'Prolific',
    description: 'Launched twenty-five products',
    family: 'making',
    metric: 'launches',
    threshold: 25,
    mark: '25',
  },
  {
    id: 'hundred-votes',
    name: 'Crowd favourite',
    description: 'A hundred votes across your launches',
    family: 'making',
    metric: 'votesReceived',
    threshold: 100,
    mark: '100',
  },
  {
    id: 'thousand-votes',
    name: 'Landslide',
    description: 'A thousand votes across your launches',
    family: 'making',
    metric: 'votesReceived',
    threshold: 1000,
    mark: '1K',
  },
  {
    id: 'podium',
    name: 'On the podium',
    description: 'Finished a day in the top three',
    family: 'making',
    metric: 'podiumFinishes',
    threshold: 1,
    mark: 'P3',
  },
  {
    id: 'chart-topper',
    name: 'Number one',
    description: 'Topped the daily board',
    family: 'making',
    metric: 'topFinishes',
    threshold: 1,
    mark: 'N1',
  },
  {
    id: 'well-reviewed',
    name: 'Well reviewed',
    description: 'A launch rated 4.5 or better from five reviews',
    family: 'making',
    metric: 'wellReviewed',
    threshold: 1,
    mark: '4.5',
  },

  /* ---------------------------------------------------------- community -- */
  {
    id: 'first-vote',
    name: 'Voter',
    description: 'Voted on your first launch',
    family: 'community',
    metric: 'votesGiven',
    threshold: 1,
    mark: 'V',
  },
  {
    id: 'hundred-votes-given',
    name: 'Kingmaker',
    description: 'Voted a hundred times',
    family: 'community',
    metric: 'votesGiven',
    threshold: 100,
    mark: 'VV',
  },
  {
    id: 'commenter',
    name: 'In the thread',
    description: 'Left twenty-five comments',
    family: 'community',
    metric: 'commentsWritten',
    threshold: 25,
    mark: 'C',
  },

  /* -------------------------------------------------------------- trade -- */
  {
    id: 'backer',
    name: 'Backer',
    description: 'Put money behind someone else’s launch',
    family: 'trade',
    metric: 'contributionsMade',
    threshold: 1,
    mark: 'B',
  },
  {
    id: 'patron',
    name: 'Patron',
    description: 'Backed five launches',
    family: 'trade',
    metric: 'contributionsMade',
    threshold: 5,
    mark: 'B5',
  },
  {
    id: 'funded',
    name: 'Funded',
    description: 'Hit a fundraise target',
    family: 'trade',
    metric: 'fundraiseFunded',
    threshold: 1,
    mark: '%',
  },
  {
    id: 'shopkeeper',
    name: 'Shopkeeper',
    description: 'Sold your first piece of merch',
    family: 'trade',
    metric: 'merchSold',
    threshold: 1,
    mark: 'S',
  },
];

export const BADGE_IDS = BADGES.map((badge) => badge.id);

export function badgeById(id: string): BadgeDefinition | undefined {
  return BADGES.find((badge) => badge.id === id);
}
