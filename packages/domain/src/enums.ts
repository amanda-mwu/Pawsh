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

export const paymentMethods = ["cash", "external_card", "check", "other"] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  cash: "Cash",
  external_card: "Card",
  check: "Check",
  other: "Other"
};

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
