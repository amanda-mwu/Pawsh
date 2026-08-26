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

export const invoiceStatuses = ["draft", "open", "partially_paid", "paid", "void"] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];

export const invoiceStatusLabels: Record<InvoiceStatus, string> = {
  draft: "Draft",
  open: "Open",
  partially_paid: "Partially paid",
  paid: "Paid",
  void: "Void"
};

/** An invoice still owing money. Anything else is settled or was never chargeable. */
export const invoiceOutstandingStatuses: readonly InvoiceStatus[] = ["open", "partially_paid"];

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
