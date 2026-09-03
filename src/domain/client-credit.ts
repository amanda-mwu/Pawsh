import { creditLedgerTotals, type CreditEntryKind, type CreditLedgerTotals } from "@pawsh/domain";
import type { SqlExecutor } from "../db/client.js";

/**
 * Reading and spending a client's credit balance.
 *
 * ONE DEFINITION OF THE BALANCE, IN ONE PLACE. The balance is `sum(amount_minor)` over
 * `customer_credit_entries` and there is no stored column beside it - see the header of migration
 * 0048 - so the only way that sum can be wrong is if two call sites compute it differently. Three
 * places need it (the payment transaction, the grant/adjust transaction, and the profile read) and
 * they all read it from here.
 *
 * It lives beside `invoice-settlement.ts` for the same reason that does: it is money arithmetic
 * over rows, shared by a route and a transaction that must not be allowed to disagree, and nothing
 * about it belongs to any one caller.
 */

/**
 * Takes the lock that makes a balance check mean something, and reports whether the client exists.
 *
 * THE LOCK IS THE ENTIRE OVERDRAFT DEFENCE. `sum(amount_minor) >= amount` is a statement about a
 * SET of rows, so no check constraint and no unique index can enforce it - a constraint sees one
 * row and an index sees one tuple. Two concurrent redemptions that both read a $50 balance before
 * either writes will both believe they can spend $50, and the partial unique indexes in 0048 will
 * not notice: they exist to stop one PAYMENT being counted twice, which is a different failure.
 *
 * So the customer row is locked first, and the sum is read under it. The second transaction blocks
 * on the lock, and when it proceeds it reads the first one's committed entry. This is the same
 * discipline the coupon cap uses (`select ... from coupons ... for update` before counting
 * redemptions), and it is why `tests/database/client-credit.test.ts` races two real redemptions
 * against one balance rather than asserting the arithmetic in isolation.
 *
 * LOCK ORDER IS INVOICE, THEN CUSTOMER. `POST /api/invoices/:id/payments` already holds
 * `select ... from invoices ... for update` when it reaches here, so the credit branch made that
 * path a two-lock transaction and the order has to be stated rather than left to whichever query
 * happens to run first - exactly as the coupon path had to fix appointment-then-coupon. The
 * grant/adjust route takes ONLY this lock and never an invoice lock, so it cannot invert the pair.
 */
export async function lockCustomerForCredit(
  tx: SqlExecutor,
  input: { businessId: string; customerId: string }
): Promise<boolean> {
  const [customer] = await tx<{ id: string }[]>`
    select id from customers
    where business_id=${input.businessId} and id=${input.customerId}
    for update
  `;
  return Boolean(customer);
}

/**
 * The spendable balance. Callers that are about to spend it must hold the lock above.
 *
 * `::int` rather than the bigint `sum` returns, matching every other money read in this schema:
 * the wire contract is integer minor units, and a balance that could exceed 2^31 minor units is
 * not a balance any grooming salon has.
 */
export async function creditBalanceMinor(
  sql: SqlExecutor,
  input: { businessId: string; customerId: string }
): Promise<number> {
  const [row] = await sql<{ balanceMinor: number }[]>`
    select coalesce(sum(amount_minor),0)::int as balance_minor
    from customer_credit_entries
    where business_id=${input.businessId} and customer_id=${input.customerId}
  `;
  return row?.balanceMinor ?? 0;
}

export interface CreditLedgerSummary extends CreditLedgerTotals {
  /** How many rows the whole ledger holds, so a preview can say there is more to see. */
  entryTotal: number;
}

/**
 * The three figures the credit tile leads with, plus the ledger size.
 *
 * ONE `group by kind` FEEDS ALL OF THEM, so `grantedMinor - usedMinor === balanceMinor` is not a
 * coincidence between three queries that could drift - it is arithmetic over one result set,
 * performed by `creditLedgerTotals` in the domain package where it is unit-tested without a
 * database.
 */
export async function creditLedgerSummary(
  sql: SqlExecutor,
  input: { businessId: string; customerId: string }
): Promise<CreditLedgerSummary> {
  const rows = await sql<{ kind: CreditEntryKind; amountMinor: number; entryCount: number }[]>`
    select kind, coalesce(sum(amount_minor),0)::int as amount_minor, count(*)::int as entry_count
    from customer_credit_entries
    where business_id=${input.businessId} and customer_id=${input.customerId}
    group by kind
  `;
  const sums: Partial<Record<CreditEntryKind, number>> = {};
  let entryTotal = 0;
  for (const row of rows) {
    sums[row.kind] = row.amountMinor;
    entryTotal += row.entryCount;
  }
  return { ...creditLedgerTotals(sums), entryTotal };
}

/** One ledger line, as the profile and the full-ledger dialog render it. */
export interface CreditLedgerEntry {
  id: string;
  kind: CreditEntryKind;
  amountMinor: number;
  /** The balance immediately after this entry, computed by the SERVER. Never re-derived by a client. */
  balanceAfterMinor: number;
  reason: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  paymentId: string | null;
  createdAt: Date;
  createdBy: string | null;
  createdByName: string | null;
  /** Shared by the two rows of a pair, so the interface can group them without inventing a key. */
  pairId: string | null;
  /** On a reversal: the redemption it gave back. */
  reversesEntryId: string | null;
  /** On a redemption: when its reversal was written. Null while it still stands. */
  reversedAt: Date | null;
  /** On an adjustment: the entry it compensates for. */
  correctsEntryId: string | null;
  /** On a corrected entry: when the compensating adjustment was written. */
  correctedAt: Date | null;
}

interface CreditLedgerRow {
  id: string; kind: CreditEntryKind; amountMinor: number; balanceAfterMinor: number;
  reason: string | null; invoiceId: string | null; invoiceNumber: string | null;
  paymentId: string | null; createdAt: Date; createdBy: string | null;
  createdByName: string | null; correctsEntryId: string | null;
  reversesEntryId: string | null; reversedAt: Date | null; correctedAt: Date | null;
}

/**
 * A page of the ledger, newest first, with the running balance already computed.
 *
 * `balanceAfterMinor` IS COMPUTED HERE AND NOT IN THE BROWSER. A client that accumulated the
 * amounts it was sent would be forming a second opinion about money - and on any page but the
 * first it would be a wrong one, because it cannot see the entries above it. The window function
 * runs over the client's WHOLE ledger in chronological order and the page is taken afterwards, so
 * page three's figures are the same numbers page one would have shown.
 *
 * The window scans one customer's entries rather than one page of them, which is the honest cost
 * of a running balance that is correct on every page. It is bounded by
 * `customer_credit_entry_ledger` and by how much credit history one client can accumulate; if a
 * salon ever has a client with a ledger large enough for this to matter, the fix is a stored
 * checkpoint, not a client-side sum.
 *
 * THE PAIR JOINS EXIST SO BOTH ROWS OF A PAIR RENDER WITHOUT A SECOND FETCH. A redemption needs to
 * know it was reversed, and its reversal needs to name what it reversed; an entry that was
 * corrected needs to say so, and the correction needs to point back. Each is a left join that is
 * at most one-to-one: the two reversal joins by the partial unique indexes on `payment_id`, and
 * the correction by an explicit `limit 1` - nothing stops two adjustments naming the same entry,
 * so the FIRST one is reported rather than the row count being silently multiplied.
 */
export async function creditLedgerPage(
  sql: SqlExecutor,
  input: { businessId: string; customerId: string; limit: number; offset: number }
): Promise<CreditLedgerEntry[]> {
  const rows = await sql<CreditLedgerRow[]>`
    with ledger as (
      select entry.*,
        sum(entry.amount_minor) over (
          order by entry.created_at, entry.id
          rows between unbounded preceding and current row
        )::int as balance_after_minor
      from customer_credit_entries entry
      where entry.business_id=${input.businessId} and entry.customer_id=${input.customerId}
    )
    select l.id, l.kind, l.amount_minor, l.balance_after_minor, l.reason,
      l.invoice_id, l.payment_id, l.corrects_entry_id, l.created_at, l.created_by,
      invoice.invoice_number,
      actor.display_name as created_by_name,
      redemption.id as reverses_entry_id,
      reversal.created_at as reversed_at,
      correction.created_at as corrected_at
    from ledger l
    left join invoices invoice
      on invoice.business_id=l.business_id and invoice.id=l.invoice_id
    left join business_memberships membership
      on membership.business_id=l.business_id and membership.user_id=l.created_by
    left join employees actor
      on actor.business_id=l.business_id and actor.membership_id=membership.id
    left join customer_credit_entries reversal
      on reversal.business_id=l.business_id and reversal.payment_id=l.payment_id
        and reversal.kind='redemption_reversal' and l.kind='redemption'
    left join customer_credit_entries redemption
      on redemption.business_id=l.business_id and redemption.payment_id=l.payment_id
        and redemption.kind='redemption' and l.kind='redemption_reversal'
    left join lateral (
      select correcting.created_at from customer_credit_entries correcting
      where correcting.business_id=l.business_id and correcting.corrects_entry_id=l.id
      order by correcting.created_at, correcting.id limit 1
    ) correction on true
    order by l.created_at desc, l.id desc
    limit ${input.limit} offset ${input.offset}
  `;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    amountMinor: row.amountMinor,
    balanceAfterMinor: row.balanceAfterMinor,
    reason: row.reason,
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoiceNumber,
    paymentId: row.paymentId,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    // A redemption and its reversal share the payment that produced both. A correction and the
    // entry it corrects share the corrected entry's id - which is the correcting row's
    // `correctsEntryId` and the corrected row's own `id`, so the two agree without a second query.
    pairId: row.paymentId ?? row.correctsEntryId ?? (row.correctedAt ? row.id : null),
    reversesEntryId: row.reversesEntryId,
    reversedAt: row.reversedAt,
    correctsEntryId: row.correctsEntryId,
    correctedAt: row.correctedAt
  }));
}
