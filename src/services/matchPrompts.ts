import { randomInt } from 'node:crypto';

/**
 * Icebreakers: one question both people see when a call connects, so the
 * first fifteen seconds of two minutes with a stranger aren't spent on "so…".
 *
 * Light, quick to answer and impossible to get wrong — nothing about money,
 * religion, politics, bodies or exes. Either person may ask for another; both
 * always see the same one, because the hub picks it.
 */
export const MATCH_PROMPTS = [
  'Best jollof you’ve ever had — where was it?',
  'What’s a song you’d never skip?',
  'Beach day or a night out?',
  'What did you want to be when you were ten?',
  'What’s the last thing that made you laugh out loud?',
  'Suya or shawarma — defend your answer.',
  'If you could live in any city for a year, which one?',
  'What’s your go-to order when you can’t decide?',
  'What’s a small thing that makes your day better?',
  'Morning person or night owl?',
  'What’s the best trip you’ve ever taken?',
  'Which show could you rewatch forever?',
  'What’s something you’re weirdly good at?',
  'Who would you call first with good news?',
  'What would your perfect Saturday look like?',
  'What’s a skill you’d love to learn this year?',
  'Afrobeats, amapiano or something else entirely?',
  'What’s the best advice anyone ever gave you?',
  'Sweet or savoury breakfast?',
  'What are you looking forward to this month?',
  'What’s your most-used emoji?',
  'If you had a free day tomorrow, what would you do first?',
  'Which fictional character do you think you’d get on with?',
  'What’s a food you hated as a child but love now?',
  'Rain or sunshine — which is better for your mood?',
  'What’s one thing on your bucket list?',
  'What did you do last weekend?',
  'Are you more of a planner or a just-go person?',
  'What’s the most underrated place in your city?',
  'Tea, coffee, or neither?',
] as const;

/** A prompt for a new call, never the one just shown when asked for another. */
export function pickPrompt(not?: string): string {
  if (MATCH_PROMPTS.length < 2) return MATCH_PROMPTS[0];
  for (;;) {
    const prompt = MATCH_PROMPTS[randomInt(MATCH_PROMPTS.length)];
    if (prompt !== not) return prompt;
  }
}
