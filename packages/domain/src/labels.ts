/**
 * Display strings for the domain vocabulary.
 *
 * These lived only in `public/app.js` until now, which meant every new client became another
 * hand-typed copy. They are transcribed here verbatim from that file so the web app can adopt
 * this module without any visible change, and this module is canonical from now on: a new status
 * or permission is not finished until it has a label here.
 *
 * Every table is typed as a total `Record` over its domain tuple, so adding a value to
 * `appointmentStatuses`, `permissions`, or `petHealthIssues` fails the build here until its label
 * is supplied. That is the whole point — the compiler, not a reviewer, keeps the sets in step.
 */
import type { AppointmentStatus } from "./appointments.js";
import type { Permission } from "./permissions.js";
import type { PetHealthIssue } from "./pet-care.js";
import type { PricingClass } from "./pricing.js";
import type { RabiesAppointmentStatus, RabiesVerificationStatus } from "./rabies.js";

/** Short code and full label, matching the calendar badges the web app renders. */
export interface StatusBadge { code: string; label: string }

export const appointmentStatusBadges: Record<AppointmentStatus, StatusBadge> = {
  scheduled: { code: "SCH", label: "Scheduled" },
  checked_in: { code: "CHK", label: "Checked in" },
  in_service: { code: "SVC", label: "In service" },
  completed: { code: "CMP", label: "Completed" },
  cancelled: { code: "CAN", label: "Cancelled" },
  no_show: { code: "NOS", label: "No show" }
};

export function appointmentStatusLabel(status: AppointmentStatus): string {
  return appointmentStatusBadges[status].label;
}

/**
 * Rabies labels cover both the per-appointment evaluation and the stored verification state.
 * `unverified` belongs only to the verification status; the web app had it in one flat table,
 * which is why a key that no appointment can ever carry appeared alongside the others.
 */
export const rabiesAppointmentStatusLabels: Record<RabiesAppointmentStatus, string> = {
  valid_for_appointment: "Valid for appointment",
  expires_before_appointment: "Expires before appointment",
  expired: "Expired",
  not_provided: "Not provided"
};

export const rabiesVerificationStatusLabels: Record<RabiesVerificationStatus, string> = {
  not_provided: "Not provided",
  unverified: "Unverified",
  staff_verified: "Staff verified"
};

/**
 * The appointment states a groomer must act on before service can proceed — everything except a
 * currently valid record.
 *
 * The web app carries two disagreeing definitions of this: its detail panel warns on four states
 * while its calendar card warns on only `not_provided` and `expires_before_appointment`. A pet
 * whose rabies record is `expired` is therefore flagged when you open the appointment but not on
 * the card you scan while walking the floor. The card is the one that under-warns, so this takes
 * the wider set; the web card should be corrected to match.
 */
export const rabiesNeedsAttention: readonly RabiesAppointmentStatus[] = [
  "not_provided", "expires_before_appointment", "expired"
];

export const petHealthIssueLabels: Record<PetHealthIssue, string> = {
  diabetes_mellitus: "Diabetes mellitus",
  epilepsy: "Epilepsy",
  heart_condition: "Heart condition",
  arthritis: "Arthritis",
  obesity: "Obesity",
  distemper: "Distemper",
  fleas_ticks_mites: "Fleas, ticks & mites",
  cancer: "Cancer",
  blind: "Blind",
  deaf: "Deaf"
};

export const permissionLabels: Record<Permission, string> = {
  "calendar.view": "View calendar",
  "appointments.view": "View appointments",
  "appointments.create": "Create appointments",
  "appointments.edit": "Edit appointments",
  "appointments.cancel": "Cancel appointments",
  "appointments.override_conflict": "Override scheduling conflicts",
  "customers.view": "View customers",
  "customers.edit": "Edit customers",
  "pets.view": "View pets",
  "pets.edit": "Edit pets",
  "pets.care.view": "View Pet Care details",
  "pets.care.edit": "Edit Pet Care details",
  "operations.check_in": "Check in pets",
  "operations.perform_service": "Perform services",
  "operations.complete": "Complete services",
  "checkout.perform": "Perform checkout",
  "payments.view": "View payments",
  "discounts.apply": "Apply discounts",
  "services.manage": "Manage services",
  "team.manage": "Manage team",
  "reports.view": "Access Report",
  "settings.manage": "Manage settings",

  "dashboard.view": "Access Dashboard",
  "dashboard.revenue": "Revenue",
  "dashboard.revenue_by_staff": "Revenue by staff",
  "dashboard.commission_by_staff": "Commission by staff",
  "dashboard.tips_by_staff": "Tips by staff",
  "dashboard.sales_items": "Sales items",
  "dashboard.payment_status": "Payment status",
  "dashboard.sales_by_method": "Sales by method",
  "dashboard.summary": "Summary",

  "payroll.report": "Payroll report",
  "payroll.commission_by_staff": "Commission by staff",
  "payroll.staff_commission_detail": "Staff commission detail",
  "payroll.clock_in_out_by_staff": "Clock in out by staff",
  "payroll.clock_in_out_detail": "Clock in out detail",
  "payroll.tips_by_staff": "Tips by staff",
  "payroll.tips_collected_detail": "Tips collected detail",
  "payroll.clock_in_out_by_day": "Clock in out by day",
  "payroll.special_service_rates": "Special service rates report",

  "sales.all": "All Sales",
  "sales.by_payment_method": "Sales by payment method",
  "sales.by_service": "Sales by service",
  "sales.by_product": "Sales by product",
  "sales.by_staff": "Sales by staff",
  "sales.by_client": "Sales by client"
};

export const pricingClassLabels: Record<PricingClass, string> = {
  SMOOTH_SINGLE: "Smooth single",
  STANDARD: "Standard",
  EXTRA_FLOOF: "Extra floof"
};

/**
 * Currency formatting.
 *
 * `Intl.NumberFormat` with `style: "currency"` is the same call the web app makes, but React
 * Native's Hermes engine ships a reduced ICU and can render a bare code instead of a symbol, or
 * throw on an unexpected currency. Falling back to a plain two-decimal string with the code keeps
 * a receipt readable rather than blank, which matters more than the symbol.
 *
 * Input is always integer minor units, matching every `*Minor` field the API returns.
 */
export function formatMinor(valueMinor: number | null | undefined, currency = "USD"): string {
  const amount = Number(valueMinor ?? 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Pounds from the stored ounces, for display beside a weight tier. */
export function poundsFromOunces(weightOunces: number | null | undefined): number | null {
  if (weightOunces === null || weightOunces === undefined) return null;
  const ounces = Number(weightOunces);
  return Number.isFinite(ounces) ? ounces / 16 : null;
}
