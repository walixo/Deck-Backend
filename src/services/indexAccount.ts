import { INDEX_ACCOUNT_USERNAME } from '../constants';
import { User, type IUser } from '../models/User';

/**
 * The account that owns the listings Deck imports.
 *
 * Every launch needs a `submittedBy`, and an imported one was submitted by
 * nobody in particular — so it is submitted by Deck itself, as "Deck Index",
 * until a founder claims it and becomes the owner.
 *
 * It cannot sign in: it has no password and no linked provider, so there is
 * nothing to log in with. Its address is on Deck's own domain, so anything a
 * notification ever sends it lands somewhere Deck controls rather than in a
 * stranger's inbox. It is excluded from every public count of people (see
 * `getStats`), because it is not one.
 *
 * Created on first use rather than by a migration, so a fresh database, a
 * staging copy and production all get it the same way, the first time a
 * listing is published.
 */
export async function indexAccount(): Promise<IUser> {
  const existing = await User.findOne({ username: INDEX_ACCOUNT_USERNAME });
  if (existing) return existing;

  try {
    return await User.create({
      name: 'Deck Index',
      username: INDEX_ACCOUNT_USERNAME,
      email: 'index@onedeck.africa',
      headline: 'Products Deck lists on their founders’ behalf, until they claim them',
      identities: [],
    });
  } catch (error) {
    /* Two publishes racing to create it: the loser finds the winner's. */
    const raced = await User.findOne({ username: INDEX_ACCOUNT_USERNAME });
    if (raced) return raced;
    throw error;
  }
}
