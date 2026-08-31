import type { Database, SqlExecutor } from "../../db/client.js";
import { setTenant } from "../../db/client.js";
import { applyInvoiceSettlement } from "../../domain/invoice-settlement.js";
import { record } from "../../http/routes.js";
import { SquareApiError } from "./errors.js";
import { withSquareAccess, type SquareWorkerDependencies } from "./oauth.js";
import type { SquarePayment, SquareTerminalCheckout } from "./schemas.js";
import {
  findCheckoutBySquareId, mapSquareCheckoutStatus, readTerminalCheckout, type TerminalCheckoutRow
} from "./terminal.js";

/**
 * Turning a Square Terminal checkout into a payment, or refusing to.
 *
 * THE RETRIEVED PAYMENT IS THE ONLY FINANCIAL AUTHORITY. A `terminal.checkout.updated` event
 * saying COMPLETED is a wake-up call, not evidence: it is a notification we did not author,
 * delivered over a channel that retries, describing an object we have not read. So the reconciler
 * ignores every number the event carries, re-reads the checkout, re-reads each payment it names,
 * and posts from the Payment. Everything else in this file exists to decide whether that Payment
 * agrees with the invoice well enough to be posted at all.
 *
 * RECONCILIATION IS ANCHORED ON OUR OWN ROW, NEVER ON A MERCHANT ID. `square_merchant_id` is
 * deliberately not unique - one Square account may authorise two Pawsh businesses - so a merchant
 * id plus a payment id cannot say which ledger a payment belongs in. `square_terminal_checkouts`
 * can: we created that row, so it already knows the business, the invoice, the amount asked for
 * and the person who asked. An event that resolves to no such row is parked and never posted. A
 * salon taking a payment directly on its own Square account, outside Pawsh, is not a Pawsh ledger
 * event, and manufacturing one would be exactly the fabrication this project refuses.
 *
 * A MISMATCH NEVER AUTO-POSTS AND NEVER AUTO-CORRECTS. If the money that came back is not the
 * money that was asked for - a different amount, a different currency, an invoice that has moved
 * underneath the checkout - the row becomes `needs_review`, both sides are written into
 * `mismatch`, the invoice is left exactly as it was, and a person is told. There is no path in
 * this file that adjusts an amount to make it fit.
 *
 * THE TIP IS RAISED AND THE PAYMENT IS POSTED IN ONE TRANSACTION, OR NEITHER HAPPENS. A Pawsh
 * invoice fixes its tip at creation and payment recording refuses more than the balance, so a tip
 * a customer left on a terminal has nowhere to land unless the invoice is raised to meet it.
 * `postReconciledPayment` raises `tip_minor`, `total_minor` and `balance_minor` by exactly Square's
 * `tip_money` and inserts the payment for Square's total in the same transaction: the invoice's own
 * components still add up, the balance lands at zero, and there is no instant at which the ledger
 * shows a raised total with no payment against it. The raise is fenced to `tip_minor = 0` so it can
 * only ever happen once, and only to an invoice created for Terminal capture.
 */

/** How many claims an unresolvable event gets before it is parked rather than retried forever. */
export const unresolvedEventAttempts = 3;

export interface ReconciliationInvoiceState {
  status: string;
  balanceMinor: number;
  tipMinor: number;
  totalMinor: number;
}

export interface CheckoutMismatch {
  reason: string;
  detail: string;
  expected: unknown;
  received: unknown;
}

export type ReconciliationDecision =
  | { outcome: "in_flight"; status: "pending" | "in_progress" }
  | { outcome: "canceled"; cancelReason: string | null }
  | { outcome: "failed"; reason: string }
  | { outcome: "needs_review"; mismatch: CheckoutMismatch }
  | {
    outcome: "post";
    providerPaymentId: string;
    amountMinor: number;
    tipMinor: number;
    totalMinor: number;
  };

function completedPayments(payments: readonly SquarePayment[]): SquarePayment[] {
  return payments.filter((payment) => (payment.status ?? "").toUpperCase() === "COMPLETED");
}

/**
 * What a retrieved checkout and its payments mean for an invoice - as a pure function.
 *
 * Pure so that every refusal in it is reachable from the unit suite without a database and without
 * a network: a wrong currency, a wrong amount, an invoice that was settled while the card was in
 * the reader, two payments where one was expected, Square's own totals not adding up. Those are
 * the cases that must never post, and a branch that can only be exercised against live Square is a
 * branch nobody exercises.
 *
 * The payment wins over the checkout wherever they disagree. A checkout Square reports as CANCELED
 * that nonetheless produced a COMPLETED payment is money that moved, and the customer's card was
 * charged whatever our row happens to say.
 */
export function decideReconciliation(input: {
  checkoutAmountMinor: number;
  checkoutCurrency: string;
  businessCurrency: string;
  invoice: ReconciliationInvoiceState;
  checkout: Pick<SquareTerminalCheckout, "status" | "cancel_reason" | "payment_ids">;
  payments: readonly SquarePayment[];
}): ReconciliationDecision {
  const settled = completedPayments(input.payments);
  const mapped = mapSquareCheckoutStatus(input.checkout.status);

  if (settled.length === 0) {
    if (mapped.status === "canceled") {
      return { outcome: "canceled", cancelReason: input.checkout.cancel_reason ?? null };
    }
    if (!mapped.settledAtSquare) return { outcome: "in_flight", status: mapped.status };
    // Square says the terminal finished. Either it named no payment at all, or every payment it
    // named came back as something other than COMPLETED.
    if ((input.checkout.payment_ids ?? []).length === 0) {
      return {
        outcome: "needs_review",
        mismatch: {
          reason: "completed_without_payment",
          detail: "Square reported the checkout as completed but named no payment.",
          expected: "at least one payment id",
          received: input.checkout.payment_ids ?? []
        }
      };
    }
    const statuses = input.payments.map((payment) => payment.status ?? "UNKNOWN");
    return {
      outcome: "failed",
      reason: `The terminal finished without a completed payment (${statuses.join(", ") || "no payment could be read"}).`
    };
  }

  if (settled.length > 1) {
    return {
      outcome: "needs_review",
      mismatch: {
        reason: "multiple_payments",
        detail: "Square reported more than one completed payment for this checkout. "
          + "Pawsh will not decide which one settles the invoice.",
        expected: 1,
        received: settled.map((payment) => ({
          id: payment.id, amountMinor: payment.amount_money.amount,
          tipMinor: payment.tip_money?.amount ?? 0
        }))
      }
    };
  }

  const payment = settled[0]!;
  const amountMinor = payment.amount_money.amount;
  const tipMinor = payment.tip_money?.amount ?? 0;
  const totalMinor = amountMinor + tipMinor;
  const paymentCurrency = payment.amount_money.currency.toUpperCase();
  const expectedCurrency = input.checkoutCurrency.toUpperCase();

  function refuse(reason: string, detail: string, expected: unknown, received: unknown) {
    return {
      outcome: "needs_review" as const,
      mismatch: { reason, detail, expected, received }
    };
  }

  if (paymentCurrency !== expectedCurrency
    || paymentCurrency !== input.businessCurrency.toUpperCase()) {
    return refuse("currency", "The payment settled in a different currency to the invoice.",
      { checkout: expectedCurrency, business: input.businessCurrency.toUpperCase() },
      { payment: paymentCurrency, tip: payment.tip_money?.currency ?? null });
  }
  if (payment.tip_money && payment.tip_money.currency.toUpperCase() !== expectedCurrency) {
    return refuse("tip_currency", "The tip settled in a different currency to the payment.",
      expectedCurrency, payment.tip_money.currency.toUpperCase());
  }
  if (tipMinor < 0 || amountMinor <= 0) {
    return refuse("amount_sign", "Square reported an amount Pawsh cannot post.",
      { amountMinor: "greater than zero", tipMinor: "zero or more" }, { amountMinor, tipMinor });
  }
  if (payment.total_money && payment.total_money.amount !== totalMinor) {
    return refuse("total_arithmetic",
      "Square's own total does not equal its amount plus its tip.",
      totalMinor, payment.total_money.amount);
  }
  if (amountMinor !== input.checkoutAmountMinor) {
    return refuse("amount", "The terminal took a different amount to the one it was asked for.",
      input.checkoutAmountMinor, amountMinor);
  }
  if (!["open", "partially_paid"].includes(input.invoice.status)) {
    return refuse("invoice_status",
      "The invoice was already settled or voided before this payment could be posted.",
      "open or partially_paid", input.invoice.status);
  }
  if (input.invoice.balanceMinor !== input.checkoutAmountMinor) {
    return refuse("invoice_balance",
      "The invoice balance changed while the terminal was taking the payment.",
      input.checkoutAmountMinor, input.invoice.balanceMinor);
  }
  if (tipMinor > 0 && input.invoice.tipMinor !== 0) {
    // The tip raise is only sound on an invoice whose tip was created as zero. One that already
    // carries a tip was captured some other way, and raising it again would invent money.
    return refuse("invoice_tip",
      "The invoice already carries a tip, so the tip taken on the terminal cannot be added to it.",
      0, input.invoice.tipMinor);
  }

  return { outcome: "post", providerPaymentId: payment.id, amountMinor, tipMinor, totalMinor };
}

// ---------------------------------------------------------------------------
// Applying a decision
// ---------------------------------------------------------------------------

export type ReconciliationResult =
  | "posted" | "converged" | "in_flight" | "canceled" | "failed" | "needs_review"
  | "unresolved" | "unusable_connection" | "already_settled";

async function invoiceState(
  sql: SqlExecutor, input: { businessId: string; invoiceId: string }
): Promise<{ invoice: ReconciliationInvoiceState; businessCurrency: string } | null> {
  const [row] = await sql<{
    status: string; balanceMinor: number; tipMinor: number; totalMinor: number; currency: string;
  }[]>`
    select i.status, i.balance_minor, i.tip_minor, i.total_minor, b.currency
    from invoices i join businesses b on b.id=i.business_id
    where i.business_id=${input.businessId} and i.id=${input.invoiceId}
  `;
  if (!row) return null;
  return {
    invoice: {
      status: row.status, balanceMinor: row.balanceMinor,
      tipMinor: row.tipMinor, totalMinor: row.totalMinor
    },
    businessCurrency: row.currency
  };
}

/**
 * The posting transaction: the tip raise and the payment insert, together or not at all.
 *
 * Every step re-reads under a lock rather than trusting what the decision was made from, because
 * the decision was made before this transaction opened and an invoice can move in that gap. The
 * re-reads are not duplication of `decideReconciliation`; that function explains, and this one
 * enforces under concurrency - the same division the OAuth state consumption already uses.
 *
 * CONVERGENCE IS A NORMAL OUTCOME, NOT AN ERROR. A replayed webhook, a duplicate entry in
 * `payment_ids`, an operator pressing refresh while the drain is running: all three reach here
 * with a payment already posted. Each returns `converged`, links the checkout to the payment that
 * exists, and posts nothing further. The partial unique index on `payments` is the backstop for
 * the case where two of them arrive in the same millisecond and both pass their own re-read.
 */
async function postReconciledPayment(
  db: Database,
  input: {
    checkout: TerminalCheckoutRow;
    providerPaymentId: string;
    amountMinor: number;
    tipMinor: number;
    totalMinor: number;
  }
): Promise<ReconciliationResult> {
  const { checkout } = input;
  return db.begin(async (tx) => {
    await setTenant(tx, checkout.businessId);
    const [row] = await tx<{ status: string; paymentId: string | null; amountMinor: number }[]>`
      select status, payment_id, amount_minor from square_terminal_checkouts
      where business_id=${checkout.businessId} and id=${checkout.id} for update
    `;
    if (!row) return "unresolved";
    if (row.paymentId) return "converged";

    const [alreadyPosted] = await tx<{ id: string }[]>`
      select id from payments
      where business_id=${checkout.businessId} and provider='square'
        and provider_payment_id=${input.providerPaymentId}
    `;
    if (alreadyPosted) {
      await tx`
        update square_terminal_checkouts set
          status='completed', payment_id=${alreadyPosted.id}, reconciled_at=now(),
          mismatch=null, last_error=null, updated_at=now()
        where business_id=${checkout.businessId} and id=${checkout.id}
      `;
      return "converged";
    }

    const [invoice] = await tx<{ status: string; balanceMinor: number; tipMinor: number }[]>`
      select status, balance_minor, tip_minor from invoices
      where business_id=${checkout.businessId} and id=${checkout.invoiceId} for update
    `;
    if (!invoice
      || !["open", "partially_paid"].includes(invoice.status)
      || invoice.balanceMinor !== row.amountMinor) {
      return "needs_review";
    }

    let balanceBefore = invoice.balanceMinor;
    if (input.tipMinor > 0) {
      // The one place in Pawsh where an invoice total moves after creation. Fenced three ways:
      // only from a reconciling Terminal checkout bound to this invoice by foreign key, only
      // while the tip is still the zero it was created with, and only by exactly the tip Square
      // reported. A zero-row result means the fence held and something else got here first.
      const raised = await tx<{ balanceMinor: number }[]>`
        update invoices set
          tip_minor=tip_minor+${input.tipMinor},
          total_minor=total_minor+${input.tipMinor},
          balance_minor=balance_minor+${input.tipMinor},
          updated_at=now()
        where business_id=${checkout.businessId} and id=${checkout.invoiceId} and tip_minor=0
        returning balance_minor
      `;
      if (!raised.length) return "needs_review";
      balanceBefore = raised[0]!.balanceMinor;
    }

    const [payment] = await tx<{ id: string }[]>`
      insert into payments
        (business_id, invoice_id, amount_minor, method, external_reference, recorded_by,
         provider, provider_payment_id, provider_tip_minor)
      values (${checkout.businessId}, ${checkout.invoiceId}, ${input.totalMinor}, 'external_card',
        ${input.providerPaymentId}, ${checkout.createdBy}, 'square', ${input.providerPaymentId},
        ${input.tipMinor})
      returning id
    `;
    if (!payment) throw new Error("Square payment could not be posted");

    // The same resolver the manual payment route, the void route and the refund transaction use,
    // deliberately: one way for a balance to reach zero, so a Terminal payment and a cash payment
    // leave an invoice in the same shape - and so a payment settling an invoice that already
    // carries a completed refund cannot write `paid` over the fact that money went back.
    //
    // It recomputes the balance as `total_minor - sum(recorded)`, which is the same number
    // `balanceBefore - totalMinor` produces: the tip raise above added the tip to `total_minor`
    // and the payment inserted below includes that same tip, so the two cancel exactly.
    const settlement = await applyInvoiceSettlement(tx, {
      businessId: checkout.businessId, invoiceId: checkout.invoiceId, recomputeBalance: true
    });
    const balance = settlement?.balanceMinor ?? balanceBefore - input.totalMinor;
    await tx`
      update square_terminal_checkouts set
        status='completed', payment_id=${payment.id}, reconciled_at=now(),
        cancel_reason=null, mismatch=null, last_error=null, updated_at=now()
      where business_id=${checkout.businessId} and id=${checkout.id}
    `;
    await record(tx, {
      businessId: checkout.businessId, actorId: checkout.createdBy, action: "payment.record",
      resourceType: "payment", resourceId: payment.id,
      after: {
        invoiceId: checkout.invoiceId, amountMinor: input.totalMinor, method: "external_card",
        provider: "square", providerTipMinor: input.tipMinor
      },
      eventType: "PaymentRecorded"
    });
    await record(tx, {
      businessId: checkout.businessId, actorId: checkout.createdBy,
      action: "integration.square.checkout.reconciled", resourceType: "square_terminal_checkout",
      resourceId: checkout.id,
      after: {
        providerPaymentId: input.providerPaymentId, amountMinor: input.amountMinor,
        tipMinor: input.tipMinor, totalMinor: input.totalMinor, invoiceBalanceMinor: balance
      }
    });
    return "posted";
  });
}

async function applyNonPosting(
  db: Database,
  checkout: TerminalCheckoutRow,
  decision: Exclude<ReconciliationDecision, { outcome: "post" }>
): Promise<ReconciliationResult> {
  return db.begin(async (tx) => {
    await setTenant(tx, checkout.businessId);
    if (decision.outcome === "in_flight") {
      await tx`
        update square_terminal_checkouts set status=${decision.status}, updated_at=now()
        where business_id=${checkout.businessId} and id=${checkout.id}
          and status in ('pending','in_progress')
      `;
      return "in_flight";
    }
    if (decision.outcome === "canceled") {
      await tx`
        update square_terminal_checkouts set
          status='canceled', cancel_reason=${decision.cancelReason}, updated_at=now()
        where business_id=${checkout.businessId} and id=${checkout.id} and payment_id is null
      `;
      return "canceled";
    }
    if (decision.outcome === "failed") {
      await tx`
        update square_terminal_checkouts set
          status='failed', last_error=${decision.reason.slice(0, 500)}, updated_at=now()
        where business_id=${checkout.businessId} and id=${checkout.id} and payment_id is null
      `;
      await record(tx, {
        businessId: checkout.businessId, actorId: checkout.createdBy,
        action: "integration.square.checkout.failed", resourceType: "square_terminal_checkout",
        resourceId: checkout.id, after: { reason: decision.reason }
      });
      return "failed";
    }
    await tx`
      update square_terminal_checkouts set
        status='needs_review', mismatch=${tx.json(decision.mismatch as never)}, updated_at=now()
      where business_id=${checkout.businessId} and id=${checkout.id} and payment_id is null
    `;
    await record(tx, {
      businessId: checkout.businessId, actorId: checkout.createdBy,
      action: "integration.square.checkout.needs_review",
      resourceType: "square_terminal_checkout", resourceId: checkout.id,
      after: decision.mismatch
    });
    return "needs_review";
  });
}

/**
 * Reconciles one checkout row against Square, end to end.
 *
 * Shared by the webhook drain and by the operator's manual refresh, which is how "the webhook
 * never arrived" is recoverable: the two paths are the same code, so a salon pressing refresh
 * cannot reach an outcome the drain could not have reached on its own.
 */
export async function reconcileCheckout(
  db: Database,
  dependencies: SquareWorkerDependencies,
  input: { businessId: string; checkoutId: string }
): Promise<ReconciliationResult> {
  const checkout = await readTerminalCheckout(db, input);
  if (!checkout) return "unresolved";
  if (checkout.status === "completed" && checkout.paymentId) return "already_settled";
  if (!checkout.squareCheckoutId) {
    // Claimed locally but never bound to a Square checkout. There is nothing at Square to read,
    // and inventing an outcome for it would be worse than leaving the attempt where the operator
    // can retry it with the same key.
    return "in_flight";
  }

  const retrieved = await withSquareAccess(db, dependencies, checkout.businessId, async (token) => {
    const remote = await dependencies.client.retrieveTerminalCheckout({
      accessToken: token, checkoutId: checkout.squareCheckoutId!
    });
    const payments: SquarePayment[] = [];
    // A duplicate entry in `payment_ids` is Square repeating itself, not two payments.
    for (const paymentId of [...new Set(remote.payment_ids ?? [])]) {
      payments.push(await dependencies.client.retrievePayment({
        accessToken: token, paymentId
      }));
    }
    return { remote, payments };
  });

  if (!retrieved.ok) {
    // The authorisation went away underneath a live checkout. The invoice stays unpaid and the
    // attempt is honestly failed; no success is shown for money we cannot confirm moved.
    const reason = retrieved.reason === "revoked"
      ? "The Square connection was revoked while this payment was being taken."
      : "This business has no usable Square connection.";
    await applyNonPosting(db, checkout, { outcome: "failed", reason });
    return "unusable_connection";
  }

  const state = await invoiceState(db, {
    businessId: checkout.businessId, invoiceId: checkout.invoiceId
  });
  if (!state) return "unresolved";

  const decision = decideReconciliation({
    checkoutAmountMinor: checkout.amountMinor,
    checkoutCurrency: checkout.currency,
    businessCurrency: state.businessCurrency,
    invoice: state.invoice,
    checkout: retrieved.value.remote,
    payments: retrieved.value.payments
  });

  if (decision.outcome !== "post") return applyNonPosting(db, checkout, decision);
  try {
    return await postReconciledPayment(db, {
      checkout,
      providerPaymentId: decision.providerPaymentId,
      amountMinor: decision.amountMinor,
      tipMinor: decision.tipMinor,
      totalMinor: decision.totalMinor
    });
  } catch (error) {
    // `payment_provider_reference` refused a second posting of this Square payment. That is the
    // index doing exactly what it exists for: two paths reached the same payment at the same
    // moment. The whole transaction rolled back, tip raise included, so converging on the payment
    // that won is all that is left to do.
    if ((error as { code?: string }).code !== "23505") throw error;
    return linkExistingPayment(db, checkout, decision.providerPaymentId);
  }
}

async function linkExistingPayment(
  db: Database, checkout: TerminalCheckoutRow, providerPaymentId: string
): Promise<ReconciliationResult> {
  return db.begin(async (tx) => {
    await setTenant(tx, checkout.businessId);
    const [existing] = await tx<{ id: string }[]>`
      select id from payments where business_id=${checkout.businessId}
        and provider='square' and provider_payment_id=${providerPaymentId}
    `;
    if (!existing) return "needs_review";
    await tx`
      update square_terminal_checkouts set
        status='completed', payment_id=${existing.id}, reconciled_at=now(),
        mismatch=null, last_error=null, updated_at=now()
      where business_id=${checkout.businessId} and id=${checkout.id} and payment_id is null
    `;
    return "converged";
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventResolution =
  | { resolved: true; checkout: TerminalCheckoutRow }
  | { resolved: false; retryable: boolean; reason: string };

/**
 * Finds the Pawsh checkout an event is about, or says why there is not one.
 *
 * The two "no row" cases are different and must not be collapsed. A checkout id we do not
 * recognise may simply not have committed yet - Square can notify faster than our own transaction
 * commits - so it is retryable. A payment with no `terminal_checkout_id` at all can never become
 * ours no matter how long we wait: it is a payment the salon took on its own Square account, and
 * the honest end state for it is parked.
 */
export async function resolveEventCheckout(
  sql: SqlExecutor,
  input: { eventType: string; payload: unknown }
): Promise<EventResolution> {
  const squareCheckoutId = squareCheckoutIdFromEvent(input);
  if (squareCheckoutId === undefined) {
    return {
      resolved: false, retryable: false,
      reason: "The event names no Pawsh terminal checkout, so it is not a Pawsh ledger event."
    };
  }
  const checkout = await findCheckoutBySquareId(sql, squareCheckoutId);
  if (checkout) return { resolved: true, checkout };
  return {
    resolved: false, retryable: true,
    reason: `No Pawsh terminal checkout matches ${squareCheckoutId}.`
  };
}

function squareCheckoutIdFromEvent(input: { eventType: string; payload: unknown }): string | undefined {
  const data = (input.payload as { data?: { object?: Record<string, unknown> } } | null)?.data?.object;
  if (!data) return undefined;
  if (input.eventType === "terminal.checkout.updated") {
    const checkout = data.checkout as { id?: unknown } | undefined;
    return typeof checkout?.id === "string" && checkout.id ? checkout.id : undefined;
  }
  const payment = data.payment as { terminal_checkout_id?: unknown } | undefined;
  return typeof payment?.terminal_checkout_id === "string" && payment.terminal_checkout_id
    ? payment.terminal_checkout_id
    : undefined;
}

/**
 * The drain's entry point for the two reconciling event types.
 *
 * Never posts from the event body. The event supplies one thing - which of our checkouts to go and
 * look at - and everything after that is a read of Square's own state through
 * `reconcileCheckout`.
 */
export async function reconcileFromEvent(
  db: Database,
  dependencies: SquareWorkerDependencies,
  input: { eventType: string; payload: unknown; attempts: number }
): Promise<
  | { disposition: "processed"; businessIds: string[] }
  | { disposition: "retry"; reason: string }
  | { disposition: "parked"; reason: string }
> {
  const resolution = await resolveEventCheckout(db, input);
  if (!resolution.resolved) {
    if (resolution.retryable && input.attempts < unresolvedEventAttempts) {
      return { disposition: "retry", reason: resolution.reason };
    }
    return { disposition: "parked", reason: resolution.reason };
  }
  try {
    await reconcileCheckout(db, dependencies, {
      businessId: resolution.checkout.businessId, checkoutId: resolution.checkout.id
    });
  } catch (error) {
    if (error instanceof SquareApiError && error.retryable) {
      return { disposition: "retry", reason: error.message };
    }
    throw error;
  }
  return { disposition: "processed", businessIds: [resolution.checkout.businessId] };
}
