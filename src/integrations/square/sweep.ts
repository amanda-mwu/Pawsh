import type { Database } from "../../db/client.js";
import { SquareApiError } from "./errors.js";
import type { SquareWorkerDependencies } from "./oauth.js";
import {
  maxRefundSweepAttempts, parkRefundForReview, readPaymentRefund, reconcileRefund
} from "./refunds.js";
import { parkCheckoutForReview, reconcileCheckout } from "./reconciliation.js";
import { readTerminalCheckout } from "./terminal.js";
export { checkoutSweepGraceSeconds } from "./terminal.js";

/**
 * The third recovery path: the one that does not need anybody to turn up.
 *
 * A Terminal capture had exactly two ways to finish before this file existed. Square delivers a
 * webhook, or a person presses refresh. Both are real and both are the normal case, and neither is
 * guaranteed. A webhook can be lost, rejected by a rate limiter, or - the case that actually
 * motivated this - delivered about a checkout whose `square_checkout_id` never landed on our row,
 * so it resolves to nothing, retries a handful of times and parks. A person pressing refresh
 * requires a person who knows to. Between them was a gap in which a customer's card had been
 * charged, the invoice still said `open`, and nothing in Pawsh was asking anyone to look.
 *
 * WHAT THIS FILE ADDS IS A CLAIM SCHEDULE, NOT A NEW WAY TO POST MONEY. Every sweep calls
 * `reconcileCheckout` or `reconcileRefund` - the same two functions the webhook drain and the
 * manual refresh call, unchanged. That is deliberate and it is the whole safety argument: those
 * functions already re-read Square, already re-check the invoice under a row lock, already fence
 * every write on `payment_id is null` or `status='pending'`, and already converge on the winner
 * when `payment_provider_reference` refuses a second posting. A sweep racing a webhook is
 * therefore the same race two webhook deliveries already run, and it resolves the same way. If
 * this file had grown its own posting path it would have had to reproduce all of that, and the
 * copy would have been the one that drifted.
 *
 * CLAIMING IS `for update skip locked`, EXACTLY AS `processOutbox`, `processSquareWebhooks` AND
 * `refreshDueConnections` CLAIM. Two application instances on the same tick take disjoint rows
 * rather than the same row twice. The claim itself moves `next_sweep_at` forward and increments
 * `sweep_attempts` before any network call, so a crash between claiming and finishing costs one
 * backoff interval rather than a hot loop against Square - the same reason the connection refresh
 * does it in that order.
 *
 * IT GIVES UP, AND SAYS SO. A checkout Square will not talk to us about does not become knowable
 * by asking more often, and Square only retains Terminal checkouts for thirty days, after which
 * the read is a permanent 404. Sweeping such a row forever would generate requests nobody reads
 * and keep a possibly-charged card invisible. So after `maxSweepAttempts` the row stops being
 * swept and becomes `needs_review` - the state that means nobody knows whether money moved, which
 * is exactly the truth at that point. It is never marked failed and never marked completed,
 * because both of those are claims about money that nothing here is entitled to make.
 *
 * IT NEVER STARTS ANYTHING ON A TERMINAL, WHICH IS WHY A CHECKOUT WITH NO `square_checkout_id`
 * IS PARKED RATHER THAN RE-SENT. The capture route recovers that state by re-sending
 * `createTerminalCheckout` with the row's stored key, and Square answers a repeated key with the
 * checkout it already made - so a retry there is safe, and it is safe here too in the narrow sense
 * that it would not double-charge. It is still wrong to do from a worker. If the original request
 * never reached Square, re-sending it minutes or hours later would light up a terminal in an empty
 * salon asking a customer who is not there to present a card. A retry that a person initiates is a
 * retry somebody is standing in front of; a background one is not. So the sweep's answer to a row
 * it cannot even name at Square is to put it in front of an operator, and let the retry stay
 * theirs.
 *
 * THE CLAIM IS THE ONE QUERY IN THIS FILE THAT IS NOT TENANT-SCOPED, AND IT CANNOT BE. A worker
 * tick has no session and no `app.business_id`; its job is to find work across every salon. Each
 * claimed row carries its own `business_id`, and every call made with it - `reconcileCheckout`,
 * `reconcileRefund`, `readTerminalCheckout`, `readPaymentRefund`, and the parking writes - takes
 * that business id and filters on it, so nothing downstream of the claim is cross-tenant.
 */

/** One tick's worth of work. Bounded for the reason the other drains are: a tick must end. */
export const checkoutSweepBatch = 10;
export const refundSweepBatch = 10;

/**
 * How many sweeps a checkout gets before it stops being swept and starts waiting for a person.
 *
 * With the backoff below this spans roughly a day, which comfortably outlasts Square's own webhook
 * retry schedule of about eleven attempts over twenty-four hours. That ordering is the point: the
 * sweep should still be trying while redelivery is still possible, and should give up only once
 * the channel that was supposed to resolve this has given up too.
 */
export const maxCheckoutSweepAttempts = 8;

export interface SweepSummary {
  claimed: number;
  reconciled: number;
  parked: number;
}

interface ClaimedRow {
  id: string;
  businessId: string;
  sweepAttempts: number;
}

/**
 * Re-reads every open Terminal checkout that is due, and reconciles it.
 *
 * Safe to run concurrently with itself, with the webhook drain, and with an operator pressing
 * refresh, because it introduces no write that those paths did not already perform.
 */
export async function sweepOpenCheckouts(
  db: Database,
  dependencies: SquareWorkerDependencies
): Promise<SweepSummary> {
  // `sweep_attempts` on the right-hand side of SET is the pre-update value; RETURNING reports the
  // post-update one, so `sweepAttempts` below counts this attempt. Same shape as the webhook
  // drain's `attempts`.
  const claimed = await db<ClaimedRow[]>`
    with claim as (
      select id from square_terminal_checkouts
      where status in ('pending', 'in_progress') and next_sweep_at <= now()
      order by next_sweep_at for update skip locked limit ${checkoutSweepBatch}
    )
    update square_terminal_checkouts checkout set
      sweep_attempts=checkout.sweep_attempts+1,
      next_sweep_at=now() + least(interval '6 hours',
        interval '2 minutes' * power(2, checkout.sweep_attempts)),
      updated_at=now()
    from claim where checkout.id=claim.id
    returning checkout.id, checkout.business_id, checkout.sweep_attempts
  `;

  let reconciled = 0;
  let parked = 0;
  for (const row of claimed) {
    const checkout = await readTerminalCheckout(db, {
      businessId: row.businessId, checkoutId: row.id
    });
    // Reconciled by a webhook between the claim and this read. Nothing to do, and the row has
    // already left the claim predicate.
    if (!checkout || !["pending", "in_progress"].includes(checkout.status)) continue;

    if (row.sweepAttempts > maxCheckoutSweepAttempts) {
      await parkCheckoutForReview(db, checkout, {
        reason: "unresolved_after_sweeps",
        detail: checkout.squareCheckoutId
          ? "Pawsh could not get a usable answer from Square about this terminal payment after "
            + "repeated attempts, so it cannot say whether the customer's card was charged. "
            + "Check this checkout in Square before taking payment again."
          // Careful about what this claims. A row with no `square_checkout_id` is one whose
          // create response we never read - which is NOT the same as one Square never received.
          // The request may have landed and the reply been lost, in which case Square holds a
          // checkout and the terminal may have taken the money.
          : "Pawsh never learned a Square checkout id for this attempt, so it cannot ask Square "
            + "what happened to it. The terminal may or may not have taken a payment. Check this "
            + "in Square before taking payment again.",
        expected: "a readable Square checkout",
        received: { sweepAttempts: row.sweepAttempts, squareCheckoutId: checkout.squareCheckoutId }
      });
      parked += 1;
      continue;
    }

    try {
      await reconcileCheckout(db, dependencies, {
        businessId: row.businessId, checkoutId: row.id
      });
      reconciled += 1;
    } catch (error) {
      // A transient Square failure is what the backoff already booked; anything else is recorded
      // the same way, because the sweep's answer to every failure is "come back later, and give
      // up eventually". Nothing is written to the checkout here: leaving it exactly as it was is
      // what keeps the retry a retry rather than a new attempt with a new key.
      await noteSweepFailure(db, "square_terminal_checkouts", row.id, error);
    }
  }
  return { claimed: claimed.length, reconciled, parked };
}

/**
 * Re-reads every refund still in flight that is due, and applies what Square says.
 *
 * The refund equivalent, and it matters for the same reason plus one of its own: a refund whose
 * `createRefund` response was lost holds a derived key and no provider reference, so no
 * `refund.updated` event can ever resolve to it - `findRefundByProviderId` has nothing to match.
 * Until this sweep existed, that row could only be finished by a person pressing refresh.
 * `reconcileRefund` re-sends the stored key, which Square answers with the refund it already made.
 */
export async function sweepPendingRefunds(
  db: Database,
  dependencies: SquareWorkerDependencies
): Promise<SweepSummary> {
  const claimed = await db<ClaimedRow[]>`
    with claim as (
      select id from payment_refunds
      where status='pending' and next_sweep_at <= now()
      order by next_sweep_at for update skip locked limit ${refundSweepBatch}
    )
    update payment_refunds refund set
      sweep_attempts=refund.sweep_attempts+1,
      next_sweep_at=now() + least(interval '6 hours',
        interval '2 minutes' * power(2, refund.sweep_attempts))
    from claim where refund.id=claim.id
    returning refund.id, refund.business_id, refund.sweep_attempts
  `;

  let reconciled = 0;
  let parked = 0;
  for (const row of claimed) {
    const refund = await readPaymentRefund(db, { businessId: row.businessId, refundId: row.id });
    if (!refund || refund.status !== "pending") continue;

    if (row.sweepAttempts > maxRefundSweepAttempts) {
      await parkRefundForReview(db, refund, {
        reason: "Pawsh could not confirm this refund with Square after repeated attempts, so it "
          + "cannot say whether the money went back. A manager needs to check this in Square.",
        mismatch: {
          reason: "unconfirmed_after_sweeps",
          detail: "Repeated attempts to read this refund from Square did not produce a usable "
            + "answer. The refund has not been recorded as done and its headroom is still held, "
            + "so no further refund can be taken against this payment until somebody resolves it.",
          expected: "a readable Square refund",
          received: { sweepAttempts: row.sweepAttempts, providerRefundId: refund.providerRefundId }
        },
        action: "payment.refund.unconfirmed"
      });
      parked += 1;
      continue;
    }

    try {
      await reconcileRefund(db, dependencies, { businessId: row.businessId, refundId: row.id });
      reconciled += 1;
    } catch (error) {
      await noteSweepFailure(db, "payment_refunds", row.id, error);
    }
  }
  return { claimed: claimed.length, reconciled, parked };
}

/**
 * Records why a sweep could not finish, without changing what the row claims about money.
 *
 * Deliberately narrow. A sweep failure is "we could not find out", never "this did not happen", so
 * the only thing written is a sentence. `SquareApiError.message` is a mapped code plus Square's own
 * `detail`; it never contains a token, because the client never puts one in an error.
 *
 * Both writes are fenced on the row still being open. Without that fence a sweep that failed while
 * a webhook concurrently settled the row would write a failure sentence onto a completed refund,
 * which `payment_refund_failure_reason` refuses outright - the constraint would turn a logged
 * warning into a thrown error inside the worker tick.
 */
async function noteSweepFailure(
  db: Database,
  table: "square_terminal_checkouts" | "payment_refunds",
  id: string,
  error: unknown
): Promise<void> {
  const reason = (error instanceof SquareApiError
    ? error.message
    : "Pawsh could not reach Square to check this.").slice(0, 500);
  if (table === "square_terminal_checkouts") {
    await db`
      update square_terminal_checkouts set last_error=${reason}, updated_at=now()
      where id=${id} and status in ('pending', 'in_progress')
    `;
    return;
  }
  await db`
    update payment_refunds set failure_reason=${reason}
    where id=${id} and status='pending'
  `;
}
