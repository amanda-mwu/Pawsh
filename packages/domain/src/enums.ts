/**
 * Domain values that existed only in SQL.
 *
 * Invoice status, payment status, payment method, pricing mode, and service category are declared
 * as PostgreSQL enums or check constraints and were never given a TypeScript home. Handlers
 * compared them as bare string literals and the web app rendered them raw, so nothing caught a
 * typo until a query returned no rows. These tuples mirror the migrations exactly; the `Record`
 * label tables below are total, so adding a value without a label fails the build.
 *
 * Sources: `migrations/0001_initial.sql` (invoice_status, payment_status, payment method check)
 * and `migrations/0012_service_pricing_and_breed_catalog.sql` (pricing_mode, category).
 */

/**
 * `partially_refunded` and `refunded` were added by migration 0038 and they replace `paid`, only
 * ever `paid`. An invoice whose money went back is not a paid invoice, and a screen that says
 * "Paid" over a refund is telling the operator something false at the exact moment they are
 * trying to work out what happened. An invoice that still owes money never reaches either value:
 * it stays `open` or `partially_paid`, because the question those two answer is "is this
 * collectable" and a refund does not change that answer.
 */
export const invoiceStatuses = [
  "draft", "open", "partially_paid", "paid", "partially_refunded", "refunded", "void"
] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];

export const invoiceStatusLabels: Record<InvoiceStatus, string> = {
  draft: "Draft",
  open: "Open",
  partially_paid: "Partially paid",
  paid: "Paid",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
  void: "Void"
};

/** An invoice still owing money. Anything else is settled or was never chargeable. */
export const invoiceOutstandingStatuses: readonly InvoiceStatus[] = ["open", "partially_paid"];

/**
 * The statuses that mean the invoice was settled - whether or not some of it later went back.
 *
 * A refunded invoice owes nothing, so anywhere that asks "was this visit paid for" must include
 * the refunded values or it will start reporting settled visits as unpaid the day a salon issues
 * its first refund.
 */
export const invoiceSettledStatuses: readonly InvoiceStatus[] = [
  "paid", "partially_refunded", "refunded"
];

export const paymentStatuses = ["recorded", "voided"] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

export const paymentStatusLabels: Record<PaymentStatus, string> = {
  recorded: "Recorded",
  voided: "Voided"
};

/**
 * How a payment settled.
 *
 * `client_credit` was added by migration 0050 and it is DELIBERATELY NOT A KIND OF `other`.
 * `other` means money collected outside Pawsh in a form Pawsh does not name - a transfer, a
 * favour, a barter. Credit is the opposite: money Pawsh itself is tracking in a ledger it owns.
 * It needs its own row in the payment-method report, because a salon that cannot separate
 * "collected $400 cash" from "honoured $400 of credit we already owed" cannot reconcile a till;
 * and it needs its own reversal rule, because voiding it returns money to a balance rather than
 * to nothing.
 *
 * This `Record` is TOTAL, which is the point: adding a method without a label fails the build.
 */
export const paymentMethods = ["cash", "external_card", "check", "other", "client_credit"] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  cash: "Cash",
  external_card: "Card",
  check: "Check",
  other: "Other",
  client_credit: "Client credit"
};

/**
 * The settlement types a salon may pick for a payment method it CONFIGURES in Settings.
 *
 * `client_credit` is absent, and its absence is load-bearing rather than tidy. A configurable
 * "Store credit" tile would let an operator record a `client_credit` payment through the ordinary
 * method picker without ever touching `customer_credit_entries` - money spent from a balance that
 * never moved, and an invoice settled against a ledger that never knew. Credit is reachable only
 * through the branch in `POST /api/invoices/:id/payments` that debits the ledger under the
 * customer row lock.
 *
 * `payment_methods.settlement_type` in migration 0034 was deliberately NOT widened by 0050, so the
 * database refuses the row even if this list is ever bypassed. This is the same list stated where
 * the form can read it.
 *
 * Written as its own tuple rather than as a filter over `paymentMethods` because `z.enum` needs a
 * literal tuple, and `satisfies` is what keeps the two lists honest: a value here that is not a
 * payment method fails the build. Widening `paymentMethods` does NOT silently widen this - which
 * is correct, because whether a new method may be configured by hand is a decision, not a default.
 */
export const configurableSettlementTypes = [
  "cash", "external_card", "check", "other"
] as const satisfies readonly PaymentMethod[];

/**
 * The card processors a salon can record.
 *
 * Configuration only. Pawsh does not talk to any of these providers, so this list names what a
 * salon may say it uses; it never names something it is connected to.
 */
export const cardProcessorProviders = ["square", "stripe", "clover_cardpointe", "authorize_net"] as const;
export type CardProcessorProvider = (typeof cardProcessorProviders)[number];

export const cardProcessorProviderLabels: Record<CardProcessorProvider, string> = {
  square: "Square",
  stripe: "Stripe",
  clover_cardpointe: "Clover / CardPointe",
  authorize_net: "Authorize.net"
};

export const pricingModes = [
  "FIXED", "TIERED", "WEIGHT_TIER", "SERVICE_TYPE_FIXED", "QUOTE_REQUIRED", "RANGE"
] as const;
export type PricingMode = (typeof pricingModes)[number];

export const pricingModeLabels: Record<PricingMode, string> = {
  FIXED: "Fixed price",
  TIERED: "Tiered by coat and weight",
  WEIGHT_TIER: "Tiered by weight",
  SERVICE_TYPE_FIXED: "Fixed by service type",
  QUOTE_REQUIRED: "Quote required",
  RANGE: "Price range"
};

export const serviceCategories = ["GENERAL", "DOG_BASE", "DOG_ADDON", "A_LA_CARTE", "CAT"] as const;
export type ServiceCategory = (typeof serviceCategories)[number];

export const serviceCategoryLabels: Record<ServiceCategory, string> = {
  GENERAL: "General",
  DOG_BASE: "Dog grooming",
  DOG_ADDON: "Dog add-on",
  A_LA_CARTE: "À la carte",
  CAT: "Cat grooming"
};

/**
 * How a discount states its value.
 *
 * The two are not interchangeable arithmetic. A fixed `amount` comes off the bill and can be
 * larger than what is left, so it clamps; a `percentage` is a share of whatever it is applied to
 * and therefore can never exceed its own base. `applyDiscounts` in `money.ts` is the one place
 * that distinction is spelled out.
 *
 * Source: `migrations/0048_discounts_and_coupons.sql` (`discounts.kind`, `coupons.kind`).
 */
export const discountKinds = ["amount", "percentage"] as const;
export type DiscountKind = (typeof discountKinds)[number];

export const discountKindLabels: Record<DiscountKind, string> = {
  amount: "Fixed amount",
  percentage: "Percentage"
};

/**
 * Whether a fixed amount comes off once per visit or once per pet.
 *
 * IT IS RECORDED, NOT YET MULTIPLIED. `appointments.pet_id` is a single non-null column and one
 * appointment produces one invoice, so the pet count at checkout is always exactly 1 and the two
 * scopes currently produce identical money. The operator's choice is stored anyway, because it is
 * a statement of intent that survives the day Pawsh books more than one pet on a visit.
 *
 * FOR A PERCENTAGE IT IS ARITHMETICALLY MEANINGLESS - 10% of the bill is 10% of the bill however
 * many pets it covers - so `applyDiscounts` ignores scope for percentages rather than the schema
 * forbidding the combination. An operator who picks it has said something harmless, and refusing
 * it would be a constraint that exists only to police a UI.
 *
 * Source: `migrations/0048_discounts_and_coupons.sql` (`discounts.apply_scope`).
 */
export const discountApplyScopes = ["per_appointment", "per_pet"] as const;
export type DiscountApplyScope = (typeof discountApplyScopes)[number];

export const discountApplyScopeLabels: Record<DiscountApplyScope, string> = {
  per_appointment: "Per appointment",
  per_pet: "Per pet"
};

/**
 * What a salon allows when more than one discount could come off one bill.
 *
 * `one_per_appointment` IS THE DEFAULT AND IT DESCRIBES TODAY. Before 0048 an invoice carried one
 * `discount_minor` and one `discount_type`, so exactly one discount was representable; a business
 * row defaulting to anything else would have been the migration quietly changing what checkout
 * permits. It is enforced by the server with a 409, not by the client declining to offer a second
 * row - a client convention is not a rule.
 *
 * The other two both stack, and differ ONLY in the order the fold runs. That matters because
 * discounts compound off the reduced amount: $20 off then 10% off a $100 bill is $72, and 10% off
 * then $20 off is $70. Neither is more correct, which is exactly why it is a setting.
 *
 * Source: `migrations/0048_discounts_and_coupons.sql` (`businesses.discount_stacking_mode`).
 */
export const discountStackingModes = [
  "one_per_appointment", "amount_first", "percentage_first"
] as const;
export type DiscountStackingMode = (typeof discountStackingModes)[number];

export const discountStackingModeLabels: Record<DiscountStackingMode, string> = {
  one_per_appointment: "One discount per appointment",
  amount_first: "Stack, fixed amounts first",
  percentage_first: "Stack, percentages first"
};

/**
 * What one row of a client's credit ledger records.
 *
 * `grant` and `adjustment` are staff decisions and both REQUIRE a reason; `redemption` and
 * `redemption_reversal` are written by the checkout and void transactions and are always paired
 * with the `payments` row they settled or gave back.
 *
 * The two staff kinds are separate rather than one signed `grant` because "we gave them $20" and
 * "we took $20 back" are different sentences on a screen and different events in a dispute, even
 * though the schema stores both in one signed column.
 *
 * Source: `migrations/0050_client_credit.sql` (`customer_credit_entries.kind`).
 */
export const creditEntryKinds = [
  "grant", "adjustment", "redemption", "redemption_reversal"
] as const;
export type CreditEntryKind = (typeof creditEntryKinds)[number];

export const creditEntryKindLabels: Record<CreditEntryKind, string> = {
  grant: "Credit added",
  adjustment: "Adjustment",
  redemption: "Applied to invoice",
  redemption_reversal: "Returned from voided payment"
};

/** The kinds a person writes by hand. The other two are only ever written by a money transaction. */
export const staffCreditEntryKinds = ["grant", "adjustment"] as const satisfies readonly CreditEntryKind[];
export type StaffCreditEntryKind = (typeof staffCreditEntryKinds)[number];
