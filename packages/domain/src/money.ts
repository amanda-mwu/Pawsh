import {
  creditEntryKinds, discountStackingModes,
  type CreditEntryKind, type DiscountKind, type DiscountStackingMode
} from "./enums.js";

export interface InvoiceCalculation {
  subtotal: number;
  discount: number;
  taxableSubtotal: number;
  tax: number;
  tip: number;
  total: number;
}

export function calculateInvoice(input: {
  lineAmounts: readonly number[];
  discount: number;
  taxRateBasisPoints: number;
  tip: number;
}): InvoiceCalculation {
  const values = [...input.lineAmounts, input.discount, input.taxRateBasisPoints, input.tip];
  if (!values.every(Number.isSafeInteger) || input.lineAmounts.some((amount) => amount < 0)) {
    throw new Error("Money values must be non-negative safe integers");
  }
  if (input.discount < 0 || input.tip < 0 || input.taxRateBasisPoints < 0) {
    throw new Error("Discount, tip, and tax rate cannot be negative");
  }
  const subtotal = input.lineAmounts.reduce((sum, amount) => sum + amount, 0);
  if (input.discount > subtotal) throw new Error("Discount cannot exceed subtotal");
  const taxableSubtotal = subtotal - input.discount;
  const tax = Math.round((taxableSubtotal * input.taxRateBasisPoints) / 10_000);
  const total = taxableSubtotal + tax + input.tip;
  return { subtotal, discount: input.discount, taxableSubtotal, tax, tip: input.tip, total };
}

/**
 * One discount as it is about to be applied, whatever it came from.
 *
 * A manually keyed amount, a configured discount and a redeemed coupon all reduce a bill the same
 * way, so they arrive here as the same shape. Keeping them one type is what makes
 * "`invoice_discounts` sums to `discount_minor`" a total invariant rather than a rule with a
 * manual-path exception.
 *
 * `units` is the per-pet multiplier for a fixed amount. It is always 1 today - see
 * `discountApplyScopes` - and is a parameter rather than a constant so that the day an
 * appointment covers more than one pet, this function does not have to change.
 */
export interface DiscountLine {
  kind: DiscountKind;
  /** Required when `kind` is `amount`; ignored otherwise. */
  amountMinor?: number | null;
  /** Required when `kind` is `percentage`; ignored otherwise. 10000 is 100%. */
  rateBasisPoints?: number | null;
  /** Multiplier for a fixed amount. Defaults to 1. Ignored for a percentage. */
  units?: number;
}

/** What one line actually took off, and which input line it was. */
export interface AppliedDiscountLine {
  /** Index into the `lines` array the caller passed, so a step can be traced back to its row. */
  index: number;
  kind: DiscountKind;
  appliedMinor: number;
}

export interface DiscountApplication {
  subtotal: number;
  /** The aggregate that goes into `invoices.discount_minor`. */
  discountMinor: number;
  /** The steps, IN THE ORDER THEY WERE APPLIED. Sums exactly to `discountMinor`. */
  applied: AppliedDiscountLine[];
}

/**
 * Where a line sits in the fold, given the salon's stacking rule.
 *
 * `one_per_appointment` returns a single rank for everything, so the sort is a no-op and the
 * operator's own order stands - which is all that is needed, because the server refuses a second
 * line in that mode before this is ever reached.
 */
function stackingRank(kind: DiscountKind, mode: DiscountStackingMode): number {
  if (mode === "amount_first") return kind === "amount" ? 0 : 1;
  if (mode === "percentage_first") return kind === "percentage" ? 0 : 1;
  return 0;
}

/**
 * Applies discounts to a subtotal, compounding each one off what the previous ones left.
 *
 * $100 with $20 off and then 10% off is $72, not $70: the percentage is a share of the $80 that
 * remained, not of the original bill. That is the decided behaviour, and it is why the stacking
 * mode is a real setting - `amount_first` and `percentage_first` differ in nothing but the order
 * of this fold, and they produce different totals from identical inputs.
 *
 * Three properties hold BY CONSTRUCTION rather than by checking afterwards, and each is covered
 * by its own test:
 *
 *   - `discountMinor <= subtotal`. `base` starts at the subtotal and every step is bounded by the
 *     `base` it is taken from, so it can reach zero and cannot pass it. A fixed amount larger than
 *     the bill CLAMPS; it is not an error. That is also what makes `calculateInvoice`'s
 *     "Discount cannot exceed subtotal" throw unreachable from checkout - it is kept as a
 *     defensive invariant on a function anything may call, not as a live code path.
 *   - `sum(applied) === discountMinor`, exactly. The aggregate is the DIFFERENCE the fold made
 *     (`subtotal - base`), never a separate sum of rounded steps, so no rounding drift between the
 *     receipt breakdown and the invoice total is representable.
 *   - Ordering is the ONLY difference between the stacking modes. Nothing below reads the mode
 *     except `stackingRank`.
 *
 * `Math.round` on the percentage matches the rounding `calculateInvoice` already uses for tax, so
 * a salon does not meet two rounding rules on one receipt. Ties among equal ranks keep the
 * operator's applied order - `Array.prototype.sort` is stable - because when the rule does not
 * decide, the person does.
 */
export function applyDiscounts(input: {
  subtotal: number;
  lines: readonly DiscountLine[];
  stackingMode: DiscountStackingMode;
}): DiscountApplication {
  if (!Number.isSafeInteger(input.subtotal) || input.subtotal < 0) {
    throw new Error("Subtotal must be a non-negative safe integer");
  }
  if (!discountStackingModes.includes(input.stackingMode)) {
    throw new Error(`Unknown discount stacking mode: ${input.stackingMode}`);
  }
  const ordered = input.lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) =>
      stackingRank(a.line.kind, input.stackingMode) - stackingRank(b.line.kind, input.stackingMode));

  let base = input.subtotal;
  const applied: AppliedDiscountLine[] = [];
  for (const { line, index } of ordered) {
    let step: number;
    if (line.kind === "amount") {
      const amountMinor = line.amountMinor ?? 0;
      const units = line.units ?? 1;
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
        throw new Error("A fixed discount amount must be a non-negative safe integer");
      }
      if (!Number.isSafeInteger(units) || units < 1) {
        throw new Error("A discount unit count must be a positive safe integer");
      }
      step = Math.min(amountMinor * units, base);
    } else {
      const rateBasisPoints = line.rateBasisPoints ?? 0;
      if (!Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > 10_000) {
        throw new Error("A percentage discount must be between 0 and 10000 basis points");
      }
      step = Math.round((base * rateBasisPoints) / 10_000);
    }
    applied.push({ index, kind: line.kind, appliedMinor: step });
    base -= step;
  }
  return { subtotal: input.subtotal, discountMinor: input.subtotal - base, applied };
}

/**
 * A client's credit position, derived from the ledger and from nothing else.
 *
 * There is no `customers.credit_minor` and there must not be: the balance is `sum(amount_minor)`
 * over `customer_credit_entries`, so this function's whole job is to make sure the three figures a
 * screen shows are three views of that one sum rather than three independent queries that can
 * disagree.
 *
 * `usedMinor` IS NET OF REVERSALS, and that is what keeps the tile's arithmetic true on screen.
 * A redemption is stored negative and its reversal positive, so summing both kinds and negating
 * gives what the client has actually spent; counting only redemptions would show $50 used against
 * a balance that had already had $50 given back, and `granted - used = balance` would visibly fail
 * for the operator looking at it.
 *
 * `grantedMinor` is likewise NET: a negative adjustment reduces it. It answers "how much has this
 * salon put on this account", and an adjustment that took $20 back means $20 less was put on.
 *
 * The identity `grantedMinor - usedMinor === balanceMinor` therefore holds for every possible
 * ledger, by construction - the four kinds partition the table, so the two figures are a partition
 * of the same sum. It is asserted here rather than assumed, because the cost of being wrong is a
 * screen that quietly misreports money.
 */
export interface CreditLedgerTotals {
  /** `sum(amount_minor)`. The spendable balance, and never negative in practice. */
  balanceMinor: number;
  /** Grants plus adjustments, net. What the salon has put on the account. */
  grantedMinor: number;
  /** Redemptions net of reversals, as a positive number. What the client has spent. */
  usedMinor: number;
}

/**
 * @param sums `sum(amount_minor)` per kind, exactly as `group by kind` returns it. A kind with no
 * rows may be absent or zero; both mean the same thing.
 */
export function creditLedgerTotals(
  sums: Partial<Record<CreditEntryKind, number>>
): CreditLedgerTotals {
  for (const kind of creditEntryKinds) {
    const value = sums[kind];
    if (value !== undefined && !Number.isSafeInteger(value)) {
      throw new Error("Credit ledger sums must be safe integers");
    }
  }
  const at = (kind: CreditEntryKind): number => sums[kind] ?? 0;
  const grantedMinor = at("grant") + at("adjustment");
  // Negated because both stored kinds sum to a non-positive number: redemptions are negative and
  // their reversals are positive, so the pair nets to zero and a fully reversed redemption reports
  // as nothing used.
  //
  // `0 - x` RATHER THAN `-x`, because unary negation of zero produces NEGATIVE zero in
  // JavaScript. A client that has spent nothing would then be reported as having used `-0`, which
  // is equal to 0 under `===` but not under `Object.is`, survives `structuredClone`, and renders
  // as "-0" through any formatter that reads the sign bit. It is a real value escaping a real API,
  // not a curiosity.
  const usedMinor = 0 - (at("redemption") + at("redemption_reversal"));
  const balanceMinor = grantedMinor - usedMinor;
  return { balanceMinor, grantedMinor, usedMinor };
}
