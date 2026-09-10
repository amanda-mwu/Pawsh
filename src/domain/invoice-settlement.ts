import type { InvoiceStatus } from "@pawsh/domain";
import type { SqlExecutor } from "../db/client.js";
import { invoiceStatusAfterSettlement } from "./refunds.js";

/**
 * The one place an invoice's settled status is written.
 *
 * SHARED BY THE REFUND TRANSACTION AND THE VOID ROUTE, deliberately, so the two cannot disagree
 * about what an invoice carrying both a refund and a voided payment is called. Voiding a cash
 * payment on an invoice whose card payment was already refunded puts money back on the table, and
 * the honest status for that is `partially_paid` - an outstanding status, not a refunded one -
 * because somebody now has to collect it. Deriving that in two places would eventually produce
 * two answers, and the wrong one would be whichever screen nobody was looking at.
 *
 * It lives here rather than beside the Square refund code because nothing about it is Square's: a
 * refund row is provider-agnostic, and the caller that needs this most - `POST
 * /api/payments/:id/void` - has nothing to do with any provider at all.
 *
 * `recomputeBalance` is the only difference between the callers. A void changes what has been
 * paid, so the balance follows it. A refund does not touch the balance: raising it would assert
 * the customer owes money they do not owe and would put the invoice back in front of whoever
 * chases outstanding balances. Neither caller ever touches `total_minor` or `tip_minor` - lowering
 * the tip would unlatch the `where tip_minor = 0` fence that lets Terminal reconciliation raise a
 * tip exactly once, and a second raise could then land on the same invoice.
 *
 * A `draft` or `void` invoice keeps its status and its balance. Those are not settlement states
 * and a sum of payments has no business renaming them.
 *
 * IT TAKES THE INVOICE ROW LOCK ITSELF, in the same statement it reads the row with, and that is
 * the point rather than a convenience. This function reads `balance_minor` and `status` and writes
 * both back as literals; a read of those two that is not under `for update` is a lost update
 * waiting for a second writer, because the value written is the value read and nothing revisits it.
 *
 * IT USED TO EXPECT THE CALLER TO HAVE TAKEN THE LOCK, and three of the four callers had - the
 * manual payment route, the void route and the Terminal reconciler all take it before they call.
 * `completePaymentRefund` did not: it locked the PAYMENT row, which is the right lock for counting
 * refund headroom and no lock at all on the invoice. So a refund could read `balance_minor`, a
 * payment could settle the invoice to zero and commit, and the refund's write would then land last
 * and put the old balance back - an invoice claiming money on a bill that was already paid, and a
 * salon collecting it twice. Requiring the lock by comment is what let one caller not take it.
 *
 * RE-TAKING A LOCK THE CALLER ALREADY HOLDS COSTS NOTHING. `for update` on a row this transaction
 * has already locked does not wait and does not queue behind anyone; it is the same lock, already
 * owned. The three callers that lock the invoice earlier - and lock it for more than this - are
 * unaffected, and they keep their own locks because they read the invoice to DECIDE with before
 * they get here.
 *
 * THE LOCK ORDER THIS ESTABLISHES IS PAYMENTS, THEN INVOICES, THEN CUSTOMERS. `POST
 * /api/payments/:id/void` already took payment-then-invoice, so the refund transaction reaching
 * here while holding the payment lock takes the pair in the same order. Nothing takes them the
 * other way round: the payment route locks the invoice and then INSERTS a payment, which locks
 * only the row it creates, and the Terminal reconciler locks the checkout, then the invoice, then
 * inserts. There is no invoice-then-existing-payment path to deadlock against.
 */
export interface InvoiceSettlement {
  totalMinor: number;
  balanceMinor: number;
  /** Sum of payments still `recorded`. Voided payments are not in it. */
  paidMinor: number;
  /** Sum of refunds that have `completed`. Pending refunds have moved no money. */
  refundedMinor: number;
  status: InvoiceStatus;
}

export async function applyInvoiceSettlement(
  tx: SqlExecutor,
  input: { businessId: string; invoiceId: string; recomputeBalance: boolean }
): Promise<InvoiceSettlement | null> {
  const [invoice] = await tx<{ totalMinor: number; balanceMinor: number; status: string }[]>`
    select total_minor, balance_minor, status from invoices
    where business_id=${input.businessId} and id=${input.invoiceId}
    for update
  `;
  if (!invoice) return null;
  const [paid] = await tx<{ paidMinor: number }[]>`
    select coalesce(sum(amount_minor),0)::int as paid_minor from payments
    where business_id=${input.businessId} and invoice_id=${input.invoiceId} and status='recorded'
  `;
  const [refunded] = await tx<{ refundedMinor: number }[]>`
    select coalesce(sum(amount_minor),0)::int as refunded_minor from payment_refunds
    where business_id=${input.businessId} and invoice_id=${input.invoiceId} and status='completed'
  `;
  const paidMinor = paid?.paidMinor ?? 0;
  const refundedMinor = refunded?.refundedMinor ?? 0;
  const balanceMinor = input.recomputeBalance
    ? invoice.totalMinor - paidMinor
    : invoice.balanceMinor;
  const status = invoiceStatusAfterSettlement({
    totalMinor: invoice.totalMinor, balanceMinor, paidMinor, refundedMinor
  });
  if (invoice.status === "draft" || invoice.status === "void") {
    return {
      totalMinor: invoice.totalMinor, balanceMinor: invoice.balanceMinor, paidMinor,
      refundedMinor, status: invoice.status
    };
  }
  await tx`
    update invoices set balance_minor=${balanceMinor}, status=${status}, updated_at=now()
    where business_id=${input.businessId} and id=${input.invoiceId}
  `;
  return { totalMinor: invoice.totalMinor, balanceMinor, paidMinor, refundedMinor, status };
}
