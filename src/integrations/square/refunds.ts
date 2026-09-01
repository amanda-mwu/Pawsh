import { createHash } from "node:crypto";
import type { Database, SqlExecutor } from "../../db/client.js";
import { setTenant } from "../../db/client.js";
import { applyInvoiceSettlement } from "../../domain/invoice-settlement.js";
import { refundHeadroom, splitRefundAcrossTip, type RefundStatus } from "../../domain/refunds.js";
// Re-exported so a caller reaching for the refund module gets the presenter with it; the
// function itself lives in `domain/refunds.ts`, because nothing about "may a screen say
// refunded yet" is Square's, and `routes.ts` needs it without importing this file.
export { refundPresentation, type RefundPresentation } from "../../domain/refunds.js";
import { record } from "../../http/routes.js";
import { SquareApiError } from "./errors.js";
import { withSquareAccess, type SquareWorkerDependencies } from "./oauth.js";
import type { SquareRefund } from "./schemas.js";

/**
 * Refunding a Square payment: the row, the ceiling, and what the money actually did.
 *
 * THE ORIGINAL PAYMENT IS NEVER TOUCHED. Not its amount, not its status, not its provider
 * reference. A refund is a second row that says money went back; reinterpreting the first row
 * would make every historical report disagree with itself depending on when it was run.
 *
 * THE CEILING IS ENFORCED UNDER A LOCK, NOT BY A CONSTRAINT. "The refunds against a payment may
 * not exceed it" is a statement about a set of rows and a check constraint sees one row, so it is
 * enforced inside the transaction under `select ... from payments where id = ... for update` -
 * the same lock discipline the void route already uses. Pending refunds count against the
 * headroom: they have moved no money, but a retry that ignored them could ask Square for the same
 * money twice and Square would say yes to both.
 *
 * THE RETRIEVED REFUND IS THE AUTHORITY, NEVER THE EVENT. `refund.updated` is a notification we
 * did not author, delivered over a channel that retries, describing an object we have not read.
 * It says which refund to go and look at and nothing else. Every status this file writes comes
 * from `GET /v2/refunds/{id}`, exactly as every payment posted by the reconciler comes from
 * `GET /v2/payments/{id}`. Only `COMPLETED` counts toward the refunded total, and nothing in this
 * file will ever show a refund as done before that read says so.
 *
 * A FAILED REFUND IS KEPT FOREVER. It releases its headroom so the money can be refunded another
 * way, it keeps its `failure_reason` so somebody can find out why, and it is never deleted and
 * never mutated into a success. `status = 'failed'` and `status = 'completed'` are both terminal
 * and neither is reachable from the other.
 *
 * THE IDEMPOTENCY KEY IS DERIVED, NEVER GENERATED, for the reason a checkout's is: the request
 * reaches Square, Square refunds the money, and the response is lost on the way back. A retry with
 * a fresh key is a second refund. So the key is a hash of the business, the payment, the amount
 * and the attempt number, every one of which is on the row before Square is called - which is why
 * the row is claimed first and Square is called second, and why a `pending` row may name a
 * provider before it has a provider reference.
 */

export type { RefundStatus };

export interface PaymentRefundRow {
  id: string;
  businessId: string;
  paymentId: string;
  invoiceId: string;
  amountMinor: number;
  tipRefundedMinor: number;
  currency: string;
  provider: string | null;
  providerRefundId: string | null;
  idempotencyKey: string;
  status: RefundStatus;
  reason: string | null;
  requestedBy: string;
  attempt: number;
  createdAt: Date;
  settledAt: Date | null;
  failureReason: string | null;
  /** What Square reported that we did not ask for. Null unless `status` is `needs_review`. */
  mismatch: unknown;
}

/**
 * `mismatch::text`, never `mismatch` - the same trap `square_terminal_checkouts` documents.
 *
 * The database client is configured with `postgres.camel`, which camel-cases the keys of a jsonb
 * value on the way out as well as column names. A document written for a person to read would come
 * back in a vocabulary it was not written in. Reading it as text and parsing here returns exactly
 * the bytes that were stored. The column list is spelled out at each call site rather than shared
 * as a fragment, exactly as `terminal.ts` spells out its own: a tagged-template query that is one
 * literal is a query the driver parameterises in one obvious way.
 */
type RefundRowShape = Omit<PaymentRefundRow, "mismatch"> & { mismatchText: string | null };

function hydrateRefund(row: RefundRowShape): PaymentRefundRow {
  const { mismatchText, ...rest } = row;
  return { ...rest, mismatch: mismatchText ? JSON.parse(mismatchText) : null };
}

/** How long a freshly claimed refund is left to the webhook before the sweep looks at it. */
export const refundSweepGraceSeconds = 120;

/**
 * How many sweeps a refund gets before it stops being swept and starts waiting for a person.
 *
 * A refund Square will not talk to us about is not a refund that becomes knowable by asking again
 * more often. After this many attempts the honest thing is to say so once, in a state an operator
 * can find, rather than to keep a row in the drain forever generating requests nobody reads.
 */
export const maxRefundSweepAttempts = 8;

/**
 * What Square reported that Pawsh did not ask for.
 *
 * The same four fields as `CheckoutMismatch`, deliberately, because it is the same job: a document
 * a person reads before any money is called settled. Held as a document rather than as columns
 * because the shape of a disagreement is not knowable up front.
 */
export interface RefundMismatch {
  reason: string;
  detail: string;
  expected: unknown;
  received: unknown;
}

export const paymentRefundIdempotencyVersion = "pawsh.square.payment-refund.v1";

/**
 * The idempotency key for one logical refund attempt.
 *
 * SHA-256 over a canonical array, base64url encoded: 43 characters, inside Square's 45-character
 * limit for the Refunds API. That limit is NOT the Terminal one - Terminal allows 64 - which is
 * why this is a separate function rather than a shared generator whose output happens to fit
 * both today. A key that overflowed would be rejected by Square at the worst possible moment.
 *
 * Every input is a column on the row, so the key can be re-derived from the row afterwards and
 * checked, which is what makes "deterministic" an assertion a test can make rather than a claim
 * in a comment. The version string leads so that changing what goes into the key can never make
 * two different derivations collide.
 */
export function paymentRefundIdempotencyKey(input: {
  businessId: string;
  paymentId: string;
  amountMinor: number;
  attempt: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    paymentRefundIdempotencyVersion,
    input.businessId,
    input.paymentId,
    input.amountMinor,
    input.attempt
  ]), "utf8").digest("base64url");
}

/**
 * Square's refund vocabulary, mapped onto ours.
 *
 * PENDING is in flight. COMPLETED is the only value that means money went back. REJECTED and
 * FAILED are both terminal refusals and are told apart only by the sentence written into
 * `failure_reason`, because the operator's next action is the same for both.
 *
 * An unrecognised status resolves to `pending` and says so. That is the explicit choice rather
 * than the absent one: guessing `completed` would show a refund as done that may never happen,
 * and guessing `failed` would release headroom for money Square may still be moving, which is how
 * one refund becomes two. Staying in flight is the only answer that cannot create money.
 */
export function mapSquareRefundStatus(status: string | undefined): {
  status: RefundStatus;
  recognised: boolean;
  failureReason: string | null;
} {
  switch ((status ?? "").toUpperCase()) {
    case "COMPLETED":
      return { status: "completed", recognised: true, failureReason: null };
    case "PENDING":
      return { status: "pending", recognised: true, failureReason: null };
    case "REJECTED":
      return {
        status: "failed", recognised: true,
        failureReason: "The card issuer rejected the refund. Nothing was returned to the customer."
      };
    case "FAILED":
      return {
        status: "failed", recognised: true,
        failureReason: "Square could not complete the refund. Nothing was returned to the customer."
      };
    default:
      return { status: "pending", recognised: false, failureReason: null };
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readPaymentRefund(
  sql: SqlExecutor, input: { businessId: string; refundId: string }
): Promise<PaymentRefundRow | null> {
  const [row] = await sql<RefundRowShape[]>`
    select id, business_id, payment_id, invoice_id, amount_minor, tip_refunded_minor, currency,
      provider, provider_refund_id, idempotency_key, status, reason, requested_by, attempt,
      created_at, settled_at, failure_reason, mismatch::text as mismatch_text from payment_refunds
    where business_id=${input.businessId} and id=${input.refundId}
  `;
  return row ? hydrateRefund(row) : null;
}

export async function listPaymentRefunds(
  sql: SqlExecutor, input: { businessId: string; paymentId: string }
): Promise<PaymentRefundRow[]> {
  const rows = await sql<RefundRowShape[]>`
    select id, business_id, payment_id, invoice_id, amount_minor, tip_refunded_minor, currency,
      provider, provider_refund_id, idempotency_key, status, reason, requested_by, attempt,
      created_at, settled_at, failure_reason, mismatch::text as mismatch_text from payment_refunds
    where business_id=${input.businessId} and payment_id=${input.paymentId}
    order by created_at, id
  `;
  return rows.map(hydrateRefund);
}

export async function listInvoiceRefunds(
  sql: SqlExecutor, input: { businessId: string; invoiceId: string }
): Promise<PaymentRefundRow[]> {
  const rows = await sql<RefundRowShape[]>`
    select id, business_id, payment_id, invoice_id, amount_minor, tip_refunded_minor, currency,
      provider, provider_refund_id, idempotency_key, status, reason, requested_by, attempt,
      created_at, settled_at, failure_reason, mismatch::text as mismatch_text from payment_refunds
    where business_id=${input.businessId} and invoice_id=${input.invoiceId}
    order by created_at, id
  `;
  return rows.map(hydrateRefund);
}

/**
 * Our own row for a Square refund id, which is the only anchor a `refund.updated` event may use.
 *
 * Not keyed on merchant, for the reason reconciliation is not: `square_merchant_id` is
 * deliberately not unique, so one merchant id can name two Pawsh businesses. We created this row,
 * so it already knows the business, the payment and the amount, and nothing about the incoming
 * event is trusted to supply any of them.
 *
 * NOT SCOPED BY BUSINESS, AND THAT IS STRUCTURAL RATHER THAN AN OVERSIGHT. A `refund.updated` body
 * carries a Square refund id and a merchant id, and neither of those is a tenant - resolving the
 * business IS what this query is for, so it has nothing to filter by. What makes taking the first
 * row correct is `payment_refund_identifier` in 0039: a partial unique index on
 * `(provider, provider_refund_id)` across the whole table, so at most one row in this deployment
 * can ever hold a given Square refund id. Before 0039 the backing index was unique only within a
 * business, and this query could return an arbitrary one of two rows in different salons.
 */
export async function findRefundByProviderId(
  sql: SqlExecutor, providerRefundId: string
): Promise<PaymentRefundRow | null> {
  const [row] = await sql<RefundRowShape[]>`
    select id, business_id, payment_id, invoice_id, amount_minor, tip_refunded_minor, currency,
      provider, provider_refund_id, idempotency_key, status, reason, requested_by, attempt,
      created_at, settled_at, failure_reason, mismatch::text as mismatch_text from payment_refunds
    where provider='square' and provider_refund_id=${providerRefundId}
  `;
  return row ? hydrateRefund(row) : null;
}

// ---------------------------------------------------------------------------
// Claiming a refund
// ---------------------------------------------------------------------------

export type RefundRefusal =
  | "payment_not_found"
  | "payment_voided"
  | "payment_not_refundable"
  | "refund_exceeds_remaining"
  | "currency_unknown";

export type RefundClaim =
  | {
    claimed: true;
    refund: PaymentRefundRow;
    /** The Square payment id, read from the row and never from a request body. */
    providerPaymentId: string;
    remainingMinor: number;
  }
  | { claimed: false; reason: RefundRefusal; remainingMinor: number };

/**
 * Claims the refund row before Square is called, which is the order that makes a retry safe.
 *
 * Local row first, Square second. The other order has a window in which Square holds a refund
 * nothing here knows about, and the only way out of that window is a key we can re-derive - which
 * we could not, because the row that would have told us the attempt number was never written.
 *
 * The payment is locked `for update` for the whole of this, which is what makes the sum ceiling
 * an enforcement rather than an estimate. Two concurrent refunds of one payment serialise here;
 * without the lock they each read the same headroom, each find room, and together exceed the
 * payment.
 */
export async function claimPaymentRefund(
  tx: SqlExecutor,
  input: {
    businessId: string;
    paymentId: string;
    amountMinor: number;
    reason: string | null;
    userId: string;
  }
): Promise<RefundClaim> {
  const [payment] = await tx<{
    invoiceId: string; amountMinor: number; status: string; provider: string | null;
    providerPaymentId: string | null; providerTipMinor: number | null; currency: string | null;
  }[]>`
    select p.invoice_id, p.amount_minor, p.status, p.provider, p.provider_payment_id,
      p.provider_tip_minor, b.currency
    from payments p join businesses b on b.id=p.business_id
    where p.business_id=${input.businessId} and p.id=${input.paymentId}
    for update of p
  `;
  if (!payment) return { claimed: false, reason: "payment_not_found", remainingMinor: 0 };
  if (payment.status !== "recorded") {
    return { claimed: false, reason: "payment_voided", remainingMinor: 0 };
  }
  // Refunds are for money that left through a processor. Cash, cheque, "other" and a card keyed
  // by hand into somebody else's machine were never taken by Pawsh, so there is nothing here to
  // send back - voiding the record is the correction for those, and it still is.
  if (!payment.provider || !payment.providerPaymentId) {
    return { claimed: false, reason: "payment_not_refundable", remainingMinor: 0 };
  }
  const currency = (payment.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { claimed: false, reason: "currency_unknown", remainingMinor: 0 };
  }

  const existing = await tx<{ amountMinor: number; status: RefundStatus; attempt: number }[]>`
    select amount_minor, status, attempt from payment_refunds
    where business_id=${input.businessId} and payment_id=${input.paymentId}
  `;
  const headroom = refundHeadroom({
    paymentAmountMinor: payment.amountMinor,
    refunds: existing.map((row) => ({ amountMinor: row.amountMinor, status: row.status }))
  });
  if (input.amountMinor > headroom.remainingMinor) {
    return {
      claimed: false, reason: "refund_exceeds_remaining",
      remainingMinor: headroom.remainingMinor
    };
  }

  // The tip is refunded LAST. `committedMinor` is the running position - completed and pending
  // both - so two refunds that together consume the service amount consume it exactly once.
  const split = splitRefundAcrossTip({
    paymentAmountMinor: payment.amountMinor,
    paymentTipMinor: payment.providerTipMinor ?? 0,
    alreadyRefundedMinor: headroom.committedMinor,
    refundAmountMinor: input.amountMinor
  });

  const attempt = existing.reduce((highest, row) => Math.max(highest, row.attempt), 0) + 1;
  const idempotencyKey = paymentRefundIdempotencyKey({
    businessId: input.businessId,
    paymentId: input.paymentId,
    amountMinor: input.amountMinor,
    attempt
  });
  // `next_sweep_at` is set here rather than left to the column default so the grace period is a
  // constant in this module beside the other ones, and so the sweep is a backstop rather than a
  // competitor: the request that claimed this row is about to call Square itself, and the webhook
  // that follows normally settles it within seconds.
  const [created] = await tx<RefundRowShape[]>`
    insert into payment_refunds
      (business_id, payment_id, invoice_id, amount_minor, tip_refunded_minor, currency, provider,
       idempotency_key, status, reason, requested_by, attempt, next_sweep_at)
    values (${input.businessId}, ${input.paymentId}, ${payment.invoiceId}, ${input.amountMinor},
      ${split.tipMinor}, ${currency}, ${payment.provider}, ${idempotencyKey}, 'pending',
      ${input.reason}, ${input.userId}, ${attempt},
      now() + make_interval(secs => ${refundSweepGraceSeconds}))
    returning id, business_id, payment_id, invoice_id, amount_minor, tip_refunded_minor, currency,
      provider, provider_refund_id, idempotency_key, status, reason, requested_by, attempt,
      created_at, settled_at, failure_reason, mismatch::text as mismatch_text
  `;
  if (!created) throw new Error("Refund could not be claimed");
  return {
    claimed: true,
    refund: hydrateRefund(created),
    providerPaymentId: payment.providerPaymentId,
    remainingMinor: headroom.remainingMinor - input.amountMinor
  };
}

// ---------------------------------------------------------------------------
// Applying what Square said
// ---------------------------------------------------------------------------

/** Binds our row to the refund Square created. An identity, not a financial fact. */
export async function bindProviderRefund(
  sql: SqlExecutor,
  input: { businessId: string; refundId: string; providerRefundId: string }
): Promise<void> {
  await sql`
    update payment_refunds set provider_refund_id=${input.providerRefundId}
    where business_id=${input.businessId} and id=${input.refundId}
      and status='pending' and provider_refund_id is null
  `;
}

/** A transient refusal that leaves the refund pending, so a retry reuses the same key. */
export async function noteRefundError(
  sql: SqlExecutor,
  input: { businessId: string; refundId: string; reason: string }
): Promise<void> {
  await sql`
    update payment_refunds set failure_reason=${input.reason.slice(0, 500)}
    where business_id=${input.businessId} and id=${input.refundId} and status='pending'
  `;
}

export type RefundOutcome =
  | "pending" | "completed" | "failed" | "converged" | "unresolved" | "mismatch"
  | "unusable_connection";

/**
 * Marks a refund completed and re-derives the invoice status, together or not at all.
 *
 * Fenced on `status='pending'`: a replayed `refund.updated` and an operator pressing refresh in
 * the same second both reach here, and the second one must change nothing rather than settle the
 * refund twice. A zero-row update is convergence, which is a normal outcome and not an error.
 */
export async function completePaymentRefund(
  db: Database, refund: PaymentRefundRow, providerRefundId: string
): Promise<RefundOutcome> {
  return db.begin(async (tx) => {
    await setTenant(tx, refund.businessId);
    // The payment lock, taken in the same order the claim takes it, so a completion and a second
    // refund of the same payment cannot interleave.
    await tx`
      select id from payments where business_id=${refund.businessId} and id=${refund.paymentId}
      for update
    `;
    const [settled] = await tx<{ id: string }[]>`
      update payment_refunds set
        status='completed', settled_at=now(), failure_reason=null,
        provider_refund_id=coalesce(provider_refund_id, ${providerRefundId})
      where business_id=${refund.businessId} and id=${refund.id} and status='pending'
      returning id
    `;
    if (!settled) return "converged";
    const invoice = await applyInvoiceSettlement(tx, {
      businessId: refund.businessId, invoiceId: refund.invoiceId, recomputeBalance: false
    });
    await record(tx, {
      businessId: refund.businessId, actorId: refund.requestedBy,
      action: "payment.refund.completed", resourceType: "payment_refund", resourceId: refund.id,
      reason: refund.reason,
      before: { status: "pending" },
      after: {
        status: "completed", paymentId: refund.paymentId, invoiceId: refund.invoiceId,
        amountMinor: refund.amountMinor, tipRefundedMinor: refund.tipRefundedMinor,
        providerRefundId,
        invoiceStatus: invoice?.status ?? null,
        invoiceRefundedMinor: invoice?.refundedMinor ?? null
      }
    });
    return "completed";
  });
}

/**
 * Records that a refund did not happen, and releases the headroom it was holding.
 *
 * The row is kept forever. It is the only evidence that somebody tried, and a salon that cannot
 * see a failed attempt will try again believing it is the first time.
 */
export async function failPaymentRefund(
  db: Database, refund: PaymentRefundRow, reason: string
): Promise<RefundOutcome> {
  return db.begin(async (tx) => {
    await setTenant(tx, refund.businessId);
    const [failed] = await tx<{ id: string }[]>`
      update payment_refunds set status='failed', failure_reason=${reason.slice(0, 500)}
      where business_id=${refund.businessId} and id=${refund.id} and status='pending'
      returning id
    `;
    if (!failed) return "converged";
    await record(tx, {
      businessId: refund.businessId, actorId: refund.requestedBy,
      action: "payment.refund.failed", resourceType: "payment_refund", resourceId: refund.id,
      before: { status: "pending" },
      after: {
        status: "failed", paymentId: refund.paymentId, amountMinor: refund.amountMinor,
        failureReason: reason.slice(0, 500)
      }
    });
    return "failed";
  });
}

/**
 * Refuses to settle a refund whose retrieved amount is not the amount we asked for.
 *
 * `completed` would post an amount we do not recognise; `failed` would release headroom for money
 * Square may well have moved. Neither is true, so the row rests at `needs_review` instead - which
 * is the state `square_terminal_checkouts` has had since 0036 for exactly this situation and which
 * `payment_refunds` was missing until 0039.
 *
 * Leaving it `pending` was the previous answer and it was wrong in two ways that compound. On
 * screen a mismatched refund was indistinguishable from one Square had simply not finished yet, so
 * the operator was told to wait for something that was never going to arrive. And in the drain it
 * stayed claimable forever, re-reading a refund whose answer had already been read and understood.
 * `needs_review` fixes both: it is out of `payment_refund_sweep_due` and into
 * `payment_refund_review`, which is a list somebody is expected to work through.
 *
 * The headroom is still held. That is not an accident of the state change - it is the point. What
 * Square did with this money is precisely what nobody knows, and releasing it would invite a
 * second refund on top of one that may already have gone through.
 */
async function refuseMismatchedRefund(
  db: Database,
  refund: PaymentRefundRow,
  mismatch: RefundMismatch
): Promise<RefundOutcome> {
  return parkRefundForReview(db, refund, {
    reason: "Square reported a refund that does not match the one Pawsh asked for, so it has not "
      + "been recorded as done. A manager needs to check this in Square.",
    mismatch,
    action: "payment.refund.mismatch"
  });
}

/**
 * Stops a refund waiting on Square and starts it waiting on a person.
 *
 * The one write that reaches `needs_review`, shared by the mismatch path and by the sweep that has
 * run out of attempts, so a refund parked either way is indistinguishable afterwards and one
 * operator list shows both. Fenced on `status='pending'` exactly as every other transition here
 * is: a replayed `refund.updated` and an operator pressing refresh in the same second both reach
 * it, and the second must change nothing rather than overwrite a refund another path has since
 * settled or failed. A zero-row update is convergence, not an error.
 */
export async function parkRefundForReview(
  db: Database,
  refund: PaymentRefundRow,
  input: { reason: string; mismatch: RefundMismatch; action: string }
): Promise<RefundOutcome> {
  await db.begin(async (tx) => {
    await setTenant(tx, refund.businessId);
    await tx`
      update payment_refunds set
        status='needs_review',
        failure_reason=${input.reason.slice(0, 500)},
        mismatch=${tx.json(input.mismatch as never)}
      where business_id=${refund.businessId} and id=${refund.id} and status='pending'
    `;
    await record(tx, {
      businessId: refund.businessId, actorId: refund.requestedBy,
      action: input.action, resourceType: "payment_refund", resourceId: refund.id,
      after: { ...input.mismatch, paymentId: refund.paymentId, amountMinor: refund.amountMinor }
    });
  });
  return "mismatch";
}

/**
 * Reads one refund from Square and applies what it says, end to end.
 *
 * Shared by the webhook drain and by the operator's manual refresh, which is how "the webhook
 * never arrived" is recoverable: the two paths are the same code, so a salon pressing refresh
 * cannot reach an outcome the drain could not have reached on its own.
 *
 * A refund still holding no provider reference never reached Square - or the response that would
 * have named it was lost - so this re-sends the create with the row's stored key. Square answers a
 * repeated key with the refund it already made rather than refunding twice, which is the whole
 * reason the key is derived and stored before the first call.
 */
export async function reconcileRefund(
  db: Database,
  dependencies: SquareWorkerDependencies,
  input: { businessId: string; refundId: string }
): Promise<RefundOutcome> {
  const refund = await readPaymentRefund(db, input);
  if (!refund) return "unresolved";
  if (refund.status !== "pending") return "converged";

  const retrieved = await withSquareAccess(
    db, dependencies, refund.businessId,
    async (token): Promise<SquareRefund> => {
      if (refund.providerRefundId) {
        return dependencies.client.retrieveRefund({
          accessToken: token, refundId: refund.providerRefundId
        });
      }
      const [payment] = await db<{ providerPaymentId: string | null }[]>`
        select provider_payment_id from payments
        where business_id=${refund.businessId} and id=${refund.paymentId}
      `;
      if (!payment?.providerPaymentId) throw new Error("Refund names a payment with no provider id");
      const original = await dependencies.client.retrievePayment({
        accessToken: token, paymentId: payment.providerPaymentId
      });
      const created = await dependencies.client.createRefund({
        accessToken: token,
        idempotencyKey: refund.idempotencyKey,
        paymentId: payment.providerPaymentId,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        reason: refund.reason ?? undefined,
        paymentVersionToken: original.version_token
      });
      // The create response names the refund; it does not settle it. The read below is what says
      // whether money moved, so this is only ever used as an identity.
      return dependencies.client.retrieveRefund({ accessToken: token, refundId: created.id });
    }
  );

  if (!retrieved.ok) {
    // The authorisation went away underneath a refund we cannot confirm. Failing it would claim
    // the customer did not get their money; completing it would claim they did. Neither is known,
    // so the row stays pending, keeps its headroom, and says why.
    const reason = retrieved.reason === "revoked"
      ? "The Square connection was revoked, so Pawsh cannot confirm this refund."
      : "This business has no usable Square connection, so Pawsh cannot confirm this refund.";
    await db.begin(async (tx) => {
      await setTenant(tx, refund.businessId);
      await noteRefundError(tx, { businessId: refund.businessId, refundId: refund.id, reason });
    });
    return "unusable_connection";
  }

  return applyRetrievedRefund(db, refund, retrieved.value);
}

/**
 * What one retrieved Refund means for one of our rows.
 *
 * Separated from the fetch so every branch - completed, pending, rejected, an unrecognised
 * status, an amount that does not match, a currency that does not match - is reachable from a
 * test without a network.
 */
export async function applyRetrievedRefund(
  db: Database, refund: PaymentRefundRow, retrieved: SquareRefund
): Promise<RefundOutcome> {
  await db.begin(async (tx) => {
    await setTenant(tx, refund.businessId);
    await bindProviderRefund(tx, {
      businessId: refund.businessId, refundId: refund.id, providerRefundId: retrieved.id
    });
  });

  const mapped = mapSquareRefundStatus(retrieved.status);
  if (mapped.status === "failed") {
    return failPaymentRefund(db, refund, mapped.failureReason ?? "Square refused the refund.");
  }
  if (mapped.status === "pending") return "pending";

  // COMPLETED, and therefore the only branch allowed to say money went back. Square's own numbers
  // are checked against ours before anything is written: a refund that settled for a different
  // amount or in a different currency is not the refund this row describes.
  if (retrieved.amount_money.amount !== refund.amountMinor) {
    return refuseMismatchedRefund(db, refund, {
      reason: "amount",
      detail: "Square settled a refund for a different amount to the one Pawsh asked for.",
      expected: refund.amountMinor, received: retrieved.amount_money.amount
    });
  }
  if (retrieved.amount_money.currency.toUpperCase() !== refund.currency.toUpperCase()) {
    return refuseMismatchedRefund(db, refund, {
      reason: "currency",
      detail: "Square settled a refund in a different currency to the one Pawsh asked for.",
      expected: refund.currency, received: retrieved.amount_money.currency.toUpperCase()
    });
  }
  return completePaymentRefund(db, refund, retrieved.id);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The Square refund id a `refund.updated` body is about, or nothing. */
export function squareRefundIdFromEvent(payload: unknown): string | undefined {
  const object = (payload as { data?: { object?: Record<string, unknown> } } | null)?.data?.object;
  const refund = object?.refund as { id?: unknown } | undefined;
  return typeof refund?.id === "string" && refund.id ? refund.id : undefined;
}

/** How many claims an unresolvable refund event gets before it is parked rather than retried. */
export const unresolvedRefundEventAttempts = 3;

/**
 * The drain's entry point for `refund.updated`.
 *
 * Never settles from the event body. The event supplies one thing - which of our refunds to go
 * and look at - and everything after that is a read of Square's own state.
 *
 * A refund id we do not recognise may not have committed yet, so it is retried a few times; a
 * body with no refund id at all can never become ours and is parked. A refund the salon issued
 * directly in its own Square dashboard, outside Pawsh, resolves to no row of ours and is parked
 * too: manufacturing a Pawsh refund row for it would be inventing a ledger entry.
 */
export async function reconcileRefundFromEvent(
  db: Database,
  dependencies: SquareWorkerDependencies,
  input: { payload: unknown; attempts: number }
): Promise<
  | { disposition: "processed"; businessIds: string[] }
  | { disposition: "retry"; reason: string }
  | { disposition: "parked"; reason: string }
> {
  const providerRefundId = squareRefundIdFromEvent(input.payload);
  if (!providerRefundId) {
    return {
      disposition: "parked",
      reason: "The event names no refund, so it is not a Pawsh ledger event."
    };
  }
  const refund = await findRefundByProviderId(db, providerRefundId);
  if (!refund) {
    if (input.attempts < unresolvedRefundEventAttempts) {
      return { disposition: "retry", reason: `No Pawsh refund matches ${providerRefundId}.` };
    }
    return {
      disposition: "parked",
      reason: `No Pawsh refund matches ${providerRefundId}, so it was not issued through Pawsh.`
    };
  }
  try {
    await reconcileRefund(db, dependencies, {
      businessId: refund.businessId, refundId: refund.id
    });
  } catch (error) {
    if (error instanceof SquareApiError && error.retryable) {
      return { disposition: "retry", reason: error.message };
    }
    throw error;
  }
  return { disposition: "processed", businessIds: [refund.businessId] };
}
