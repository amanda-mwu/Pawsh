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
  "appointments.create": "Book Appointments",
  "appointments.edit": "Edit appointments",
  "appointments.cancel": "Cancel appointments",
  "appointments.override_conflict": "Override scheduling conflicts",
  "customers.view": "Access Clients Tab",
  "customers.edit": "Edit customers",
  "pets.view": "View pets",
  "pets.edit": "Edit pets",
  "pets.care.view": "View Pet Care details",
  "pets.care.edit": "Edit Pet Care details",
  "operations.check_in": "Check in pets",
  "operations.perform_service": "Perform services",
  "operations.complete": "Complete services",
  "checkout.perform": "Check Out Appointments",
  "payments.view": "Access paid Appointments",
  "discounts.apply": "Apply discounts",
  "services.manage": "Modify service setting",
  "team.manage": "Access All Staff Settings",
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
  "sales.by_client": "Sales by client",

  // ---------------------------------------------------------------------------------------------
  // The Role Permission taxonomy, LABELLED VERBATIM.
  //
  // Capitalisation, spacing and word choice are the reference's, including where they are
  // inconsistent ("Access paid Appointments", "Access package Setting", "Can Sale Package"). An
  // owner comparing the two products row by row should find the same rows, and normalising the
  // casing would make a switch harder to find while changing nothing about what it does.
  //
  // The DESCRIPTIONS are not verbatim - see `permissionHints`.
  // ---------------------------------------------------------------------------------------------
  "appointments.view_all_staff": "Access All Staff Appointments",
  "appointments.edit_all_staff": "Edit All Staff Appointments",
  "appointments.service_price_edit": "Modify Appointment Service Price",
  "appointments.online_booking_accept": "Schedule Online Booking Appointments",
  "checkout.split_tips": "Split Tips",
  "payments.edit": "Edit payment Record",
  "calendar.blocks_create": "Add blocks",
  "calendar.blocks_edit": "Edit blocks",

  "customers.view_all": "Access All Clients",
  "customers.contact_info": "Access Client Contact info",
  "customers.archive": "Delete Client",
  "customers.merge": "Merge Client",
  "customers.credit_edit": "Edit Credit",
  "customers.bulk_update": "Bulk Update Clients",
  "customers.export": "Export filtered Clients",
  "customers.tags_edit": "Edit tags",
  "pets.breeds_edit": "Edit breeds",

  "settings.business": "Access Business Setting",
  "settings.permissions": "Access Permission Setting",
  "settings.lock_screen_code": "Set Lock Screen Login Code",
  "settings.authorize_browser": "Can authorize browser",
  "settings.revoke_browser": "Can delete authorized browser",
  "settings.availability": "Access Availability Setting",
  "settings.payroll": "Access Payroll Setting",
  "settings.appointment_schedule": "Access scheduling Setting",
  "settings.pet_options": "Access Pet Setting",
  "settings.services": "Access Service Setting",
  "settings.payments": "Access Payment Setting",
  "settings.discounts": "Access Discount/Coupon Setting",
  "settings.auto_messages": "Access Auto Message Setting",
  "settings.auto_reply": "Access Auto Reply Setting",
  "settings.mobile": "Access Mobile Setting",
  "settings.quickbooks": "Access QuickBooks Setting",
  "settings.google_calendar": "Access Google Calendar Sync",
  "settings.online_booking": "Access Book Online Setting",
  "settings.intake_form": "Access Intake Form",
  "settings.client_portal": "Access Client Portal Setting",
  "settings.review_booster": "Access Review Booster Setting",
  "settings.agreements": "Access Agreement",
  "settings.report_cards": "Access Report Card Setting",
  "report_cards.send": "Send Report Card",

  "dashboard.all_staff": "Access All Staff Dashboard",

  "cash_drawer.manage": "Access Cash Drawer Management",
  "cash_drawer.delete_records": "Delete records in Cash Drawer",
  "retail.sale_create": "Add New Sale",
  "settings.retail": "Access Retail Setting",
  "settings.packages": "Access package Setting",
  "packages.sell": "Can Sale Package",
  "settings.gift_cards": "Access Gift Card Setting",
  "gift_cards.sell": "Sale Gift Card",
  "settings.clock_in_out": "Access Clock In/Out Setting",
  "clock_in_out.all_staff": "Clock In/Out for all staff",
  "messages.view": "Access Message Center",
  "messages.call_records": "Access Call Records",
  "messages.voicemail": "Access Voicemail Records"
};

/**
 * One sentence saying what a permission actually controls.
 *
 * The Roles editor renders this immediately below the row's label - and, for a permission that
 * gates nothing yet, DIRECTLY UNDER the "Not yet available in Pawsh" badge - and its filter
 * searches label, hint and key together. Both facts make a wrong sentence worse than none: it
 * would sit under a badge making a claim about a different feature, and it would surface the wrong
 * row to somebody searching for the right one.
 *
 * WHICH IS WHY THE LABELS ARE VERBATIM AND THESE ARE NOT. The reference's own descriptions are
 * near-restatements of its labels, and four of them are defective: "Access Client Portal Setting"
 * is described as the book-online setting, "Access Report Card Setting" as the client portal
 * setting, "Can delete authorized browser" as "Can authorized browser", and "Access Intake Form"
 * carries no description at all. Reproducing those would put a false statement in the one place a
 * reader looks to find out what a switch does. Nothing is lost by writing them correctly.
 *
 * Deliberately PARTIAL rather than a total record. A key whose label already says the whole thing
 * - "View calendar", "Revenue by staff" - gains nothing from a sentence repeating it, and inventing
 * one for all 101 would mean writing 46 descriptions the reference never had. A hint is here when
 * it carries information the label does not: what Pawsh really does with the request
 * (`customers.archive` archives, it does not erase), what else a switch reaches
 * (`team.manage` opens the roles editor), or where an absent feature will live when it ships.
 */
export const permissionHints: Partial<Record<Permission, string>> = {
  // Two existing keys whose taxonomy label understates them badly enough to mislead.
  "team.manage": "Also required to view the team, send and read invitations, and open the roles editor.",
  "payments.view": "Covers the invoice on any appointment, paid or not.",

  "appointments.view_all_staff": "See appointments assigned to every staff member, not only your own.",
  "appointments.edit_all_staff": "Change appointments assigned to every staff member, not only your own.",
  "appointments.service_price_edit": "Override a service's price on one appointment. Pawsh resolves every price from the price book today.",
  "appointments.online_booking_accept": "Accept appointments clients book for themselves online.",
  "checkout.split_tips": "Divide one appointment's tip between the staff who worked it.",
  "payments.edit": "Void or refund a payment that has already been recorded. Taking the payment is Check Out Appointments.",
  "calendar.blocks_create": "Block time on a staff member's calendar so it cannot be booked.",
  "calendar.blocks_edit": "Change or remove blocked time already on the calendar.",

  "customers.view_all": "See every client, not only the ones you have appointments with.",
  "customers.contact_info": "See a client's phone number and email address.",
  "customers.archive": "Pawsh marks a client inactive rather than erasing them, so their appointments and history are kept.",
  "customers.merge": "Combine two records that describe the same client.",
  "customers.credit_edit": "Adjust the credit balance held on a client's account.",
  "customers.bulk_update": "Change a field across many clients at once.",
  "customers.export": "Download the filtered client list as a file.",
  "customers.tags_edit": "Create the tags used to label clients, and apply them.",
  "pets.breeds_edit": "Add, rename and retire the breeds a pet can be recorded as.",

  "settings.business": "Open the business profile, hours and location settings.",
  "settings.permissions": "Open the roles and permissions editor.",
  "settings.lock_screen_code": "Set the code that unlocks a shared screen. Pawsh's Login Control tab is where this will live.",
  "settings.authorize_browser": "Approve a browser for signing in to this workspace. Pawsh's Login Control tab is where this will live.",
  "settings.revoke_browser": "Withdraw approval from a browser that was allowed to sign in.",
  "settings.availability": "Open the availability settings - working hours and closed days.",
  "settings.payroll": "Open the payroll settings.",
  "settings.appointment_schedule": "Open the appointment scheduling settings.",
  "settings.pet_options": "Open the pet options settings - the lists a pet record is built from.",
  "settings.services": "Open the service settings. Changing what is in them is Modify service setting.",
  "settings.payments": "Open the tax and payment settings.",
  "settings.discounts": "Open the discount and coupon settings. Applying a discount at checkout is a separate switch.",
  "settings.auto_messages": "Open the automated message settings.",
  "settings.auto_reply": "Open the SMS auto-reply settings.",
  "settings.mobile": "Open the mobile app settings.",
  "settings.quickbooks": "Open the QuickBooks integration settings.",
  "settings.google_calendar": "Open the Google Calendar sync settings.",
  "settings.online_booking": "Open the online booking settings.",
  "settings.intake_form": "Open the settings for the form a new client fills in.",
  "settings.client_portal": "Open the client portal settings.",
  "settings.review_booster": "Open the review booster settings.",
  "settings.agreements": "Open the agreement templates clients are asked to sign.",
  "settings.report_cards": "Open the report card settings.",
  "report_cards.send": "Send a finished report card to the client.",

  "dashboard.all_staff": "See every staff member's figures on the dashboard, not only your own.",

  "cash_drawer.manage": "Open, close and reconcile the cash drawer.",
  "cash_drawer.delete_records": "Delete an entry already recorded against the cash drawer.",
  "retail.sale_create": "Ring up a retail sale.",
  "settings.retail": "Open the retail product settings.",
  "settings.packages": "Open the package settings.",
  "packages.sell": "Sell a package to a client.",
  "settings.gift_cards": "Open the gift card settings.",
  "gift_cards.sell": "Sell a gift card.",
  "settings.clock_in_out": "Open the clock in/out settings.",
  "clock_in_out.all_staff": "Clock other staff in and out, not only yourself.",
  "messages.view": "Open the message centre.",
  "messages.call_records": "See the record of calls with clients.",
  "messages.voicemail": "See voicemail clients have left."
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
 *
 * THE TWO FRACTION DIGITS ARE PINNED, and that is load-bearing rather than tidy. Left to itself
 * `Intl.NumberFormat` applies CLDR's display convention for the currency, which is how many
 * decimals a place actually shows - not the exponent ISO 4217 defines. For twelve supported
 * currencies the two disagree: AFN, ALL, IRR, KPW, LAK, LBP, MGA, MMK, RSD, SOS, SYP and YER all
 * have an ISO minor unit of two while CLDR formats them with none, because the subunit has been
 * inflated into irrelevance. Unpinned, an invoice of 1250 minor units of AFN printed as "AFN 13" -
 * the caller's exact integer silently rounded away on a document a client pays against. Pinning
 * makes the formatter state what the money model already is: minor units over one hundred, always.
 * Currencies whose CLDR convention is already two decimals, which is every other supported code
 * including USD, are formatted identically to before.
 *
 * This does not give Pawsh multi-exponent money. `currency.ts` still admits only minor-unit-2
 * currencies, for the reasons written there. This keeps the formatter honest INSIDE that rule.
 */
export function formatMinor(valueMinor: number | null | undefined, currency = "USD"): string {
  const amount = Number(valueMinor ?? 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * Pounds from the stored ounces, for display beside a weight tier.
 *
 * Retained as-is for callers that genuinely mean pounds. Anything rendering a weight to an
 * OPERATOR should use `weightFromOunces` / `formatWeight` in `weight.ts` instead, which take the
 * workspace's `weightUnit` and convert the price-tier band labels along with the number - see the
 * note there about why converting one without the other is worse than converting neither.
 */
export function poundsFromOunces(weightOunces: number | null | undefined): number | null {
  if (weightOunces === null || weightOunces === undefined) return null;
  const ounces = Number(weightOunces);
  return Number.isFinite(ounces) ? ounces / 16 : null;
}
