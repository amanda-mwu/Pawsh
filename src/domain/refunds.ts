/**
 * The arithmetic of giving money back, with no database and no provider in it.
 *
 * Three rules live here because all three have to be decidable without a network, and because
 * each one is the kind of thing that is easy to state in a comment and easy to get subtly wrong
 * in a query. Every branch below is reachable from the unit suite.
 *
 * THE TIP IS REFUNDED LAST. Square hands us one `amount_money` and does not split it, so this is
 * a decision Pawsh makes rather than an observation it records. The service amount absorbs a
 * refund first; the tip is touched only once the service portion is exhausted; a full refund
 * returns the tip in full. The alternative - splitting proportionally - would claw back part of a
 * groomer's earned gratuity for a service complaint that was not theirs, on the first dollar
 * refunded, every time. Under this rule the customer still gets every cent of the disputed
 * service back before the tip is reached, and the tip only moves when the service has already
 * been returned in its entirety.
 *
 * PENDING REFUNDS HOLD HEADROOM. A refund that has been asked for and not yet settled has not
 * moved money, but the money is spoken for: a second request that ignored it could ask the
 * provider for the same money twice, and the provider would say yes to both. So `pending` counts
 * against the ceiling and `failed` releases it again. This is deliberately conservative in the
 * one direction it is safe to be conservative in - the worst case is an operator being told to
 * wait, and the worst case of the other choice is refunding more than was taken.
 *
 * `needs_review` HOLDS HEADROOM TOO, AND FOR A STRONGER REASON THAN `pending` DOES. It is the
 * state a refund reaches when the provider reported something that is not the refund we asked
 * for, so what the provider did with the money is precisely what nobody knows. Releasing the
 * headroom would invite a second refund on top of one that may well have gone through. Only
 * `failed` - which is the provider telling us plainly that nothing moved - gives it back.
 *
 * THE REFUNDED STATUSES REPLACE `paid`, AND ONLY `paid`. An invoice that still owes money is
 * `open` or `partially_paid` and stays that way through any number of refunds, because the
 * question those statuses answer is "is this collectable" and a refund does not change the
 * answer. It is only once the balance has reached zero that the difference between "settled" and
 * "settled and then returned" needs a name.
 */

import type { InvoiceStatus } from "@pawsh/domain";

/**
 * What a refund row can say about itself.
 *
 * Defined here rather than beside the Square client because none of the four values are Square's:
 * a refund is provider-agnostic, and the void route and every report read these without importing
 * an integration. `needs_review` is not a claim about money the way `completed` and `failed` are -
 * it is the absence of one, for a refund whose provider reported something we did not ask for.
 * Mirrors the `status` check constraint on `payment_refunds`.
 */
export type RefundStatus = "pending" | "completed" | "failed" | "needs_review";

export interface RefundSplit {
  /** The part of this refund that comes out of the service amount. */
  serviceMinor: number;
  /** The part that comes out of the tip. Zero until the service portion is exhausted. */
  tipMinor: number;
}

/**
 * How one refund divides between the service amount and the tip, given what came before it.
 *
 * `alreadyRefundedMinor` is the sum of every earlier refund against this payment that still
 * counts - completed and pending both - because the split has to be computed against the running
 * position, not against the payment in isolation. Two refunds of half the service amount each
 * must together consume the service amount exactly once, not twice.
 */
export function splitRefundAcrossTip(input: {
  /** The whole payment: service plus tip. */
  paymentAmountMinor: number;
  /** The gratuity component of that payment. Zero for a payment with no tip. */
  paymentTipMinor: number;
  alreadyRefundedMinor: number;
  refundAmountMinor: number;
}): RefundSplit {
  const serviceTotal = Math.max(0, input.paymentAmountMinor - input.paymentTipMinor);
  // Everything refunded so far has come out of the service amount first, by this same rule, so
  // what is left of the service amount is simply what earlier refunds did not reach.
  const serviceRemaining = Math.max(0, serviceTotal - input.alreadyRefundedMinor);
  const serviceMinor = Math.min(input.refundAmountMinor, serviceRemaining);
  return { serviceMinor, tipMinor: input.refundAmountMinor - serviceMinor };
}

export interface RefundHeadroom {
  /** Everything already spoken for: completed refunds plus refunds still in flight. */
  committedMinor: number;
  /** What may still be refunded. Never negative. */
  remainingMinor: number;
  /** True when a further refund of any size would exceed the payment. */
  exhausted: boolean;
}

/**
 * What is left to refund against a payment.
 *
 * Called inside the transaction that holds `select ... from payments where id = ... for update`,
 * which is what makes it an enforcement rather than an estimate: without that lock two concurrent
 * refunds each read the same headroom, each find room, and together exceed the payment.
 */
export function refundHeadroom(input: {
  paymentAmountMinor: number;
  refunds: readonly { amountMinor: number; status: RefundStatus }[];
}): RefundHeadroom {
  const committedMinor = input.refunds
    .filter((refund) => refund.status !== "failed")
    .reduce((sum, refund) => sum + refund.amountMinor, 0);
  const remainingMinor = Math.max(0, input.paymentAmountMinor - committedMinor);
  return { committedMinor, remainingMinor, exhausted: remainingMinor === 0 };
}

/**
 * The invoice status implied by what has been paid and what has gone back.
 *
 * One function, used by the refund transaction and by the void route, so the two cannot disagree
 * about what an invoice with both a refund and a voided payment on it is called. Void is the case
 * that makes sharing worth it: voiding a cash payment on an invoice that has already had its card
 * payment refunded puts money back on the table, and the honest status for that is `partially_paid`
 * rather than a refunded status that would hide a live balance from whoever chases them.
 *
 * `balanceMinor` is read, never derived here. Refunds do not move it - raising it would assert the
 * customer owes money they do not owe - so it arrives as whatever the invoice actually says.
 */
export function invoiceStatusAfterSettlement(input: {
  totalMinor: number;
  balanceMinor: number;
  /** Sum of payments still `recorded`. Voided payments are not in it. */
  paidMinor: number;
  /** Sum of refunds that have `completed`. Pending refunds have not moved money. */
  refundedMinor: number;
}): InvoiceStatus {
  // Settled first, because a zero-total invoice is created `paid` with no payments at all and
  // would otherwise fall into the "nothing recorded yet" arm below.
  if (input.balanceMinor === 0) {
    if (input.refundedMinor <= 0) return "paid";
    return input.refundedMinor >= input.paidMinor ? "refunded" : "partially_refunded";
  }
  if (input.balanceMinor >= input.totalMinor) return "open";
  return "partially_paid";
}

/** The statuses that mean money went back. Never `paid`, and never an outstanding status. */
export const invoiceRefundedStatuses: readonly InvoiceStatus[] = ["partially_refunded", "refunded"];

// ---------------------------------------------------------------------------
// Presentation
//
// Salon staff do not read Square's vocabulary, and they must never be shown a refund that has not
// happened. Both of those are one function, because a label computed in two places drifts and the
// half that drifts is the half nobody is looking at.
// ---------------------------------------------------------------------------

/** The two fields a presenter needs. Deliberately not the whole row. */
export interface RefundPresentable {
  status: RefundStatus;
  providerRefundId: string | null;
}

export interface RefundPresentation {
  label: string;
  /** True while Square may still change the outcome. */
  inFlight: boolean;
  /** True only when the retrieved Refund said COMPLETED. Nothing else may say "refunded". */
  settled: boolean;
  failed: boolean;
  /**
   * True when a person has to look at this before anything else happens.
   *
   * Reported rather than left to be inferred from the other three being false, for the reason
   * `checkoutPresentation` reports it: a client working out "not in flight, not settled, not
   * failed, therefore somebody must check Square" is a client that has re-derived a rule the
   * server already knows, and it will get it wrong the first time a fifth state exists.
   */
  needsReview: boolean;
}

export function refundPresentation(
  row: Pick<RefundPresentable, "status" | "providerRefundId">
): RefundPresentation {
  switch (row.status) {
    case "pending":
      return {
        label: row.providerRefundId ? "Refund in progress" : "Sending the refund",
        inFlight: true, settled: false, failed: false, needsReview: false
      };
    case "completed":
      return {
        label: "Refunded", inFlight: false, settled: true, failed: false, needsReview: false
      };
    case "failed":
      return {
        label: "Refund failed", inFlight: false, settled: false, failed: true, needsReview: false
      };
    case "needs_review":
      // Not in flight - nothing here is waiting on Square any more - and emphatically not failed,
      // because "the refund failed" tells an operator the customer still has their money and that
      // is the one thing this state cannot promise.
      return {
        label: "Refund needs review", inFlight: false, settled: false, failed: false,
        needsReview: true
      };
    default:
      // Unreachable while the check constraint holds, and deliberately not optimistic if it ever
      // does not: an unknown refund state is never a completed one, and it is always somebody's
      // to look at.
      return {
        label: "Refund status unknown", inFlight: true, settled: false, failed: false,
        needsReview: true
      };
  }
}
