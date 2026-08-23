/**
 * Puts a handful of topics and replies in the forum.
 *
 *   npm run seed-forum
 *
 * A forum with nothing in it looks broken rather than new, and the index's whole
 * design — sorted by last activity, "replied 3 hours ago", pinned rows on top —
 * is invisible until several threads exist with different activity times.
 *
 * Idempotent: topics are matched on their slug, so a second run adds nothing.
 */
/* eslint-disable no-console -- a CLI communicates by printing; that is the point. */
import { connectDatabase, disconnectDatabase } from '../config/db';
import { Reply, Topic, type TopicSection } from '../models/Topic';
import { User } from '../models/User';
import { slugify } from '../utils/slug';

interface Seed {
  title: string;
  section: TopicSection;
  body: string;
  pinned?: boolean;
  /** Hours ago the topic was posted. Replies land after it. */
  agoHours: number;
  replies: string[];
}

const SEEDS: Seed[] = [
  {
    title: 'Read this before posting',
    section: 'meta',
    pinned: true,
    agoHours: 900,
    body:
      'Three things and then we will leave you alone.\n' +
      'Put the actual question in the title — "pricing?" is not a question anybody can answer without opening the post.\n' +
      'Self-promotion belongs in Show, not Ask.\n' +
      'If somebody solves your problem, say so in the thread. The next person to hit it will find this by search.',
    replies: [
      'Can we get a section for job postings? Half of Show is people quietly advertising.',
      'Added Hiring. Move anything that belongs there.',
    ],
  },
  {
    title: 'How do you price a Claude skill?',
    section: 'ask',
    agoHours: 30,
    body:
      'I have a skill that turns a messy standup thread into a clean digest. It saves my team maybe two hours a week.\n' +
      'Everything comparable I can find is either free or buried inside a $200/seat product. Is there a middle? What have people actually charged and had somebody pay?',
    replies: [
      'Charge per seat, not per skill. The moment you price the artefact you are competing with free, and there is always a free one.',
      'We went flat $9/month and nobody blinked. The thing that mattered was a free tier that did one real job, not a trial that expired.',
      'Counterpoint: two hours a week at any professional rate is well north of $9. You are leaving money on the table because the artefact feels small, not because the value is.',
    ],
  },
  {
    title: 'Show: a desktop CNC small enough for a bookshelf',
    section: 'show',
    agoHours: 8,
    body:
      'Been building this for eight months in a room in Lagos. Aluminium frame, 200x150 bed, cuts hardwood and soft metal.\n' +
      'The hard part was not the motion system, it was bed rigidity at that size. Third revision finally holds tolerance across the full travel.\n' +
      'Photos on the launch. Happy to answer anything about the build.',
    replies: [
      'The rigidity work is the whole product. Everybody gets the steppers right and then wonders why the cuts drift.',
      'What did you settle on for the bed in the end?',
    ],
  },
  {
    title: 'Feedback wanted: is my tagline doing anything?',
    section: 'feedback',
    agoHours: 52,
    body:
      'Current tagline is "The modern way to manage your workflows." I have read it so many times I genuinely cannot tell any more.\n' +
      'The product watches your git history and writes release notes. Be blunt.',
    replies: [
      'It is doing nothing. "Modern" and "workflows" could be in front of any product built in the last decade.',
      'Your second sentence is the tagline. "Writes your release notes from your git history." Ship that.',
    ],
  },
  {
    title: 'Looking for a backend contractor, 3 months, remote',
    section: 'hiring',
    agoHours: 120,
    body:
      'Node and Mongo, payments experience useful. Roughly three months, part time is fine, timezone does not matter as long as there is some overlap with WAT.\n' +
      'Reply here or find me on my profile.',
    replies: ['Sent you a note.'],
  },
];

async function run(): Promise<void> {
  await connectDatabase();

  const people = await User.find().limit(6);
  if (people.length === 0) {
    console.log('No users found. Run `npm run seed` first.');
    await disconnectDatabase();
    return;
  }

  let added = 0;

  for (const [index, seed] of SEEDS.entries()) {
    const slug = slugify(seed.title);
    if (await Topic.exists({ slug })) {
      console.log(`· ${seed.title} — already there`);
      continue;
    }

    const author = people[index % people.length];
    const postedAt = new Date(Date.now() - seed.agoHours * 60 * 60 * 1000);

    const topic = await Topic.create({
      title: seed.title,
      slug,
      body: seed.body,
      section: seed.section,
      author: author._id,
      pinned: seed.pinned ?? false,
      createdAt: postedAt,
      lastReplyAt: postedAt,
    });

    /* Replies land after the topic and before now, evenly spaced, so the index's
       "replied N ago" column shows a spread rather than five identical times. */
    let last = postedAt;
    let lastBy = author._id;

    for (const [replyIndex, body] of seed.replies.entries()) {
      const responder = people[(index + replyIndex + 1) % people.length];
      const at = new Date(
        postedAt.getTime() +
          ((Date.now() - postedAt.getTime()) * (replyIndex + 1)) / (seed.replies.length + 1),
      );

      await Reply.create({ topic: topic._id, author: responder._id, body, createdAt: at });
      last = at;
      lastBy = responder._id;
    }

    await Topic.updateOne(
      { _id: topic._id },
      { $set: { replyCount: seed.replies.length, lastReplyAt: last, lastReplyBy: lastBy } },
    );

    added += 1;
    console.log(`✓ ${seed.title} — ${seed.replies.length} replies`);
  }

  console.log(added > 0 ? `\nAdded ${added} topics. Open /forum.` : '\nNothing to add.');
  await disconnectDatabase();
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
