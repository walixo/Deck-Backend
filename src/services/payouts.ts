import mongoose from 'mongoose';
import { env } from '../config/env';
import { CURRENCY } from '../constants';
import { Payout } from '../models/Payout';
import { User, type IUser } from '../models/User';
import {
  BachsError,
  createConnectedAccount,
  createOnboardingLink,
  createTransfer,
  getConnectedAccount,
  type BachsEvent,
} from './bachs';
import { outstandingBalances } from './ledger';
import { formatMinor, notify } from './notify';

/**
 * Paying sellers, makers and game developers through Bachs sub-accounts.
 *
 * Replaces the manual disbursement run. Deck still collects every payment into
 * its own balance — nobody is paid at the moment of sale — and the ledger
 * still derives what is owed from source rows. What changed is the last step:
 * instead of staff sending a bank transfer and recording it, the transfer run
 * below sends cleared earnings to each person's sub-account on a schedule.
 */

/* --------------------------------------------------------- the account --- */

/**
 * Gives a person a sub-account if they do not have one, and returns it.
 *
 * Their Deck user id is the idempotency key, so a double-click or a retried
 * request after a timeout returns the account Bachs already created instead of
 * making a second one that the first would then shadow.
 */
export async function ensurePayoutAccount(user: IUser): Promise<IUser> {
  if (user.payoutAccount?.accountId) return user;

  const account = await createConnectedAccount({
    email: user.email,
    name: user.name,
    country: 'NG',
    idempotencyKey: `deck-account-${user._id.toString()}`,
  });

  user.payoutAccount = {
    provider: 'bachs',
    accountId: account.id,
    transfersActive: account.transfersActive,
  } as IUser['payoutAccount'];
  await user.save();
  return user;
}

/**
 * A fresh hosted onboarding link. Not stored: links expire within the hour
 * and each new one supersedes the last, so it is minted on every request.
 */
export async function onboardingLink(
  user: IUser,
  urls: { returnUrl: string; refreshUrl: string },
): Promise<string> {
  const withAccount = await ensurePayoutAccount(user);
  const accountId = withAccount.payoutAccount!.accountId;
  const { url } = await createOnboardingLink(accountId, {
    ...urls,
    /* Once someone can already receive money, the same link updates their
       details rather than starting onboarding over. */
    update: withAccount.payoutAccount!.transfersActive,
  });
  return url;
}

/**
 * Re-reads an account's status from Bachs.
 *
 * For when someone returns from onboarding and wants to know if it worked.
 * The webhook is still what normally flips the flag — this is a courtesy so
 * the page does not sit on "pending" if the webhook is slow.
 */
export async function refreshPayoutAccount(user: IUser): Promise<IUser> {
  if (!user.payoutAccount?.accountId) return user;
  const account = await getConnectedAccount(user.payoutAccount.accountId);
  if (account.transfersActive !== user.payoutAccount.transfersActive) {
    user.payoutAccount.transfersActive = account.transfersActive;
    await user.save();
  }
  return user;
}

/* ------------------------------------------------------------ webhooks --- */

/**
 * Connect events: a sub-account's capability turned on or off.
 *
 * `capability.updated` carries `data.account`, `data.capability` and
 * `data.status` (`active` or `restricted`), per Bachs's event reference. Only
 * `transfers` matters to Deck — it is the capability that lets an account
 * receive a share. Events for accounts Deck does not know (the platform's own,
 * for one) match no user and do nothing.
 *
 * `account.updated` re-reads the account rather than parsing it, so a missed
 * or out-of-order capability event is corrected by the next account change.
 */
export async function handleConnectEvent(event: BachsEvent): Promise<void> {
  const data = event.data as {
    account?: string;
    id?: string;
    capability?: string;
    status?: string;
  };

  if (event.type === 'capability.updated') {
    if (data.capability !== 'transfers' || !data.account) return;
    await setTransfersActive(data.account, data.status === 'active');
    return;
  }

  if (event.type === 'account.updated') {
    const accountId = data.account ?? data.id;
    if (!accountId) return;
    const known = await User.exists({ 'payoutAccount.accountId': accountId });
    if (!known) return;
    const account = await getConnectedAccount(accountId);
    await setTransfersActive(accountId, account.transfersActive);
  }
}

async function setTransfersActive(accountId: string, active: boolean): Promise<void> {
  const user = await User.findOne({ 'payoutAccount.accountId': accountId });
  if (!user?.payoutAccount || user.payoutAccount.transfersActive === active) return;

  user.payoutAccount.transfersActive = active;
  await user.save();

  /* Told once, when it turns on. Anything they are already owed goes out on
     the next run, so this is the moment that changes something for them. */
  if (active) {
    void notify({
      user: user._id,
      kind: 'payouts.ready',
      title: 'You can be paid now',
      body: `Your payout account is active. Earnings go to it automatically once they have cleared the ${env.payoutHoldDays}-day hold.`,
      link: '/sell',
    });
  }
}

/* ------------------------------------------------------- transfer run --- */

/** ₦100. Anything smaller waits for the next run, so fees do not eat tiny transfers. */
export const MIN_TRANSFER_MINOR = 10_000;

export interface TransferRunResult {
  sent: number;
  retried: number;
  failed: number;
  /** Owed money that is waiting on its recipient to finish onboarding. */
  awaitingAccount: number;
}

/**
 * Sends everybody's cleared earnings to their sub-account.
 *
 * The order of operations is the safety. For each person:
 *
 *  1. If a `pending` payout already exists, a previous run died between asking
 *     Bachs and hearing back. Repeat *that exact* request — same amount, same
 *     idempotency key (the payout's own id) — and Bachs returns the original
 *     transfer instead of making a second.
 *  2. Otherwise, write a new `pending` payout for the cleared amount *before*
 *     calling Bachs. It counts as paid out from that instant, so no later run
 *     can send the same money again whatever happens next.
 *  3. Call Bachs. On success, mark it `paid`. If Bachs refuses outright (a 4xx
 *     — usually `INSUFFICIENT_BALANCE` while recent charges are still
 *     settling), mark it `failed`, which releases the amount for a later run.
 *     If Bachs could not be reached, leave it `pending` for step 1 next time.
 *
 * People without an active sub-account are skipped, not failed: their money
 * keeps accruing and goes out on the first run after they finish onboarding.
 */
export async function runTransfers(): Promise<TransferRunResult> {
  const result: TransferRunResult = { sent: 0, retried: 0, failed: 0, awaitingAccount: 0 };

  const owed = await outstandingBalances();
  const pending = await Payout.find({ provider: 'bachs', status: 'pending' });
  const pendingBySeller = new Map(pending.map((payout) => [payout.seller.toString(), payout]));

  /* Everyone with something to send: a stuck pending payout, or cleared money. */
  const sellerIds = new Set([
    ...pendingBySeller.keys(),
    ...owed.filter((row) => row.availableMinor >= MIN_TRANSFER_MINOR).map((row) => row.sellerId),
  ]);

  for (const sellerId of sellerIds) {
    const user = await User.findById(sellerId).select('name payoutAccount');
    if (!user?.payoutAccount?.transfersActive) {
      result.awaitingAccount += 1;
      continue;
    }

    let payout = pendingBySeller.get(sellerId);
    const retrying = Boolean(payout);

    if (!payout) {
      const row = owed.find((entry) => entry.sellerId === sellerId);
      if (!row || row.availableMinor < MIN_TRANSFER_MINOR) continue;
      payout = await Payout.create({
        reference: `TR-${new mongoose.Types.ObjectId().toString().toUpperCase()}`,
        seller: user._id,
        amountMinor: row.availableMinor,
        currency: CURRENCY,
        provider: 'bachs',
        status: 'pending',
        destination: user.payoutAccount.accountId,
        note: `Cleared earnings after the ${env.payoutHoldDays}-day hold`,
      });
    }

    try {
      const transfer = await createTransfer({
        destination: user.payoutAccount.accountId,
        amountMinor: payout.amountMinor,
        currency: payout.currency,
        transferGroup: payout.reference,
        description: `Deck earnings ${payout.reference}`,
        idempotencyKey: `deck-payout-${payout._id.toString()}`,
      });

      payout.status = 'paid';
      payout.transferId = transfer.id;
      payout.paidAt = new Date();
      await payout.save();
      if (retrying) result.retried += 1;
      else result.sent += 1;

      void notify({
        user: user._id,
        kind: 'payout.sent',
        title: `${formatMinor(payout.amountMinor, payout.currency)} sent to your payout account`,
        body: 'Your cleared Deck earnings are on their way.',
        link: '/sell',
      });
    } catch (error) {
      if (error instanceof BachsError && error.permanent) {
        payout.status = 'failed';
        payout.note = `Bachs refused the transfer: ${error.code ?? error.message}`.slice(0, 400);
        await payout.save();
        result.failed += 1;
        // eslint-disable-next-line no-console
        console.error(`[payouts] transfer ${payout.reference} refused:`, error.code, error.message);
      } else {
        /* Left pending on purpose — the next run repeats it with the same key. */
        // eslint-disable-next-line no-console
        console.error(`[payouts] transfer ${payout.reference} will be retried:`, error);
      }
    }
  }

  return result;
}
