import type { AppointmentStatus } from "./appointments.js";

export const permissions = [
  "calendar.view",
  "appointments.view",
  "appointments.create",
  "appointments.edit",
  "appointments.cancel",
  "appointments.override_conflict",
  "customers.view",
  "customers.edit",
  "pets.view",
  "pets.edit",
  "pets.care.view",
  "pets.care.edit",
  "operations.check_in",
  "operations.perform_service",
  "operations.complete",
  "checkout.perform",
  "payments.view",
  "discounts.apply",
  "services.manage",
  "team.manage",
  "reports.view",
  "settings.manage",

  // ---------------------------------------------------------------------------------------------
  // Reporting and dashboard taxonomy.
  //
  // Two masters, and children grouped beneath them. `reports.view` and `dashboard.view` each gate
  // an endpoint on their own; the children narrow WHAT COMES BACK from it, by omitting fields from
  // the response rather than by asking the client to hide panels. A client-side hide is not a
  // permission, it is a suggestion.
  //
  // SOME OF THESE GATE NOTHING YET, ON PURPOSE. Pawsh has no payroll, no time clock, no product
  // catalogue and no commission model, so the switches for those exist so that the day the feature
  // ships it is already granted to the right people, instead of every workspace having to
  // rediscover its own access rules. `unenforcedPermissions` names exactly which ones, and the
  // catalog reports it as `enforced: false` so the editor can say so rather than implying a
  // restriction that is not there.
  // ---------------------------------------------------------------------------------------------
  "dashboard.view",
  "dashboard.revenue",
  "dashboard.revenue_by_staff",
  "dashboard.commission_by_staff",
  "dashboard.tips_by_staff",
  "dashboard.sales_items",
  "dashboard.payment_status",
  "dashboard.sales_by_method",
  "dashboard.summary",

  "payroll.report",
  "payroll.commission_by_staff",
  "payroll.staff_commission_detail",
  "payroll.clock_in_out_by_staff",
  "payroll.clock_in_out_detail",
  "payroll.tips_by_staff",
  "payroll.tips_collected_detail",
  "payroll.clock_in_out_by_day",
  "payroll.special_service_rates",

  "sales.all",
  "sales.by_payment_method",
  "sales.by_service",
  "sales.by_product",
  "sales.by_staff",
  "sales.by_client",

  // ---------------------------------------------------------------------------------------------
  // The full Role Permission taxonomy.
  //
  // 55 keys arriving together, in the order the groups below present them. EVERY ONE OF THEM IS
  // UNENFORCED ON ARRIVAL - see `unenforcedPermissions` - including the ones whose route could be
  // split today. That is deliberate and it is the whole shape of this change: the catalog lands as
  // a pure addition that alters no route, and each key graduates in a later change that splits
  // exactly one route family and can be reviewed on its own. Adding keys and splitting routes in
  // one step is how a silent authorization hole gets in, because nothing then distinguishes "this
  // switch is new" from "this switch has just started refusing somebody".
  //
  // A key here is therefore a PROMISE ABOUT WHAT WILL BE GATED, recorded now so that the day the
  // route splits, every workspace already says who should have it. The editor is told the truth in
  // the meantime: `enforced: false`, which it renders as "Not yet available in Pawsh".
  // ---------------------------------------------------------------------------------------------

  // Appointment. The reference's Book, Cancel, Check Out and Access-paid rows are
  // `appointments.create`, `appointments.cancel`, `checkout.perform` and `payments.view`, which
  // already exist: they are RELABELLED in `permissionLabels`, not duplicated. A parallel key would
  // be a second switch over one route, and the two would disagree the moment somebody set one.
  "appointments.view_all_staff",
  "appointments.edit_all_staff",
  "appointments.service_price_edit",
  "appointments.online_booking_accept",
  "checkout.split_tips",
  "payments.edit",
  "calendar.blocks_create",
  "calendar.blocks_edit",

  // Clients and pets. `customers.archive` is the reference's "Delete Client": Pawsh archives a
  // client rather than erasing them, and the label says delete while the hint says what happens.
  "customers.view_all",
  "customers.contact_info",
  "customers.archive",
  "customers.merge",
  "customers.credit_edit",
  "customers.bulk_update",
  "customers.export",
  "customers.tags_edit",
  "pets.breeds_edit",

  // Setting. `settings.manage` is KEPT and becomes this group's master, exactly as `reports.view`
  // and `dashboard.view` are masters: it goes on gating the ~25 routes it gates today, and the
  // children take those routes over one family at a time. Until a child's routes are genuinely
  // split it gates nothing, which is precisely what `unenforcedPermissions` says about every one
  // of them. Retiring the master instead would have meant remapping ~25 routes in the same change
  // that added 55 keys, where a missed route either fails outright or silently opens.
  "settings.business",
  "settings.permissions",
  "settings.lock_screen_code",
  "settings.authorize_browser",
  "settings.revoke_browser",
  "settings.availability",
  "settings.payroll",
  "settings.appointment_schedule",
  "settings.pet_options",
  "settings.services",
  "settings.payments",
  "settings.discounts",
  "settings.auto_messages",
  "settings.auto_reply",
  "settings.mobile",
  "settings.quickbooks",
  "settings.google_calendar",
  "settings.online_booking",
  "settings.intake_form",
  "settings.client_portal",
  "settings.review_booster",
  "settings.agreements",
  "settings.report_cards",
  "report_cards.send",

  // Dashboard scope. NOT a projection child like `dashboard.revenue_by_staff`, which decides
  // whether the per-staff panel exists at all; this decides WHOSE ROWS fill every panel. The two
  // compose: both on with this one off is a per-staff breakdown containing one row - your own.
  "dashboard.all_staff",

  // Cash drawer, retail, packages, gift cards, the time clock and the message centre. These are
  // not idle: `sales.by_product` is already unenforced because `salesItems.productsMinor` is a
  // structural zero, and the five `payroll.clock_in_out_*` children are already unenforced for
  // want of a time clock. When retail ships, or a clock, these graduate alongside the report
  // children that describe the same absent thing.
  "cash_drawer.manage",
  "cash_drawer.delete_records",
  "retail.sale_create",
  "settings.retail",
  "settings.packages",
  "packages.sell",
  "settings.gift_cards",
  "gift_cards.sell",
  "settings.clock_in_out",
  "clock_in_out.all_staff",
  "messages.view",
  "messages.call_records",
  "messages.voicemail"
] as const;

export type Permission = (typeof permissions)[number];

export const permissionPresets: Record<string, readonly Permission[]> = {
  groomer: [
    "calendar.view", "appointments.view", "pets.view", "pets.care.view",
    "operations.check_in", "operations.perform_service", "operations.complete"
  ],
  receptionist: [
    "calendar.view", "appointments.view", "appointments.create", "appointments.edit",
    "appointments.cancel", "customers.view", "customers.edit", "pets.view", "pets.edit",
    "pets.care.view", "operations.check_in", "checkout.perform", "payments.view"
  ],
  manager: permissions
};

/**
 * THE ROLES PAWSH SHIPS WITH, and the one place their identity is written down.
 *
 * A built-in role is a Pawsh system template rather than something the salon authored: its name is
 * its identity, so it cannot be renamed, and it cannot be deleted - a salon that does not use one
 * DISABLES it, which keeps the assignment history and the canonical name intact for the day it is
 * wanted back. Custom roles stay renameable and deletable under the existing in-use rules.
 *
 * The permissions are NOT restated here. They are `permissionPresets`, so the three built-ins and
 * the three presets can never say different things - which is precisely the drift that had already
 * begun: migration 0041 seeded these same three from the presets as they stood then, and when the
 * reporting taxonomy arrived 0043 had to go back and grant it to what 0041 had written. A second
 * hand-maintained copy would have needed a third migration nobody would have remembered to write.
 *
 * `migrations/0041_roles.sql` and `migrations/0043_report_dashboard_taxonomy.sql` still carry SQL
 * literals, because a migration that has run in production is a historical record and must not be
 * edited to follow a constant. `tests/domain/permission-catalog.test.ts` pins their combined
 * effect to this list instead, so the frozen literals and the live definitions cannot silently
 * disagree about what a Groomer, a Receptionist or a Manager is.
 */
export interface BuiltInRoleDefinition {
  name: string;
  permissions: readonly Permission[];
}

/**
 * ORDER IS PART OF THE DEFINITION. `roles.sort_order` is written from this array's position
 * (0044), and the roles list orders by `built_in desc, sort_order, lower(name)`, so the top staff
 * role sits directly under Owner because it is FIRST HERE - not because "Manager" happens to sort
 * before "Receptionist". Alphabetical order gave Groomer, Manager, Receptionist, which put the
 * most powerful of the three in the middle, and would have gone on quietly misplacing every
 * built-in added later: an "Assistant" would have landed at the top and nothing would have caught
 * it. Reordering this array is how the editor's order changes; nothing else needs to move.
 */
export const builtInRoles: readonly BuiltInRoleDefinition[] = [
  { name: "Manager", permissions: permissionPresets.manager! },
  { name: "Groomer", permissions: permissionPresets.groomer! },
  { name: "Receptionist", permissions: permissionPresets.receptionist! }
];

/** The `sort_order` a built-in role is provisioned with: its position here, in tens. */
export function builtInRoleSortOrder(name: string): number {
  const index = builtInRoles.findIndex((role) => role.name.toLowerCase() === name.toLowerCase());
  return index < 0 ? customRoleSortOrder : (index + 1) * 10;
}

/**
 * Where a role with no stated position sorts: after every built-in, ties broken by name.
 *
 * Custom roles are salon-authored and Pawsh has no opinion about their order, so they share one
 * value and fall back to `lower(name)`. It is the column default in 0044, so a role created
 * through the API lands here without the route having to say so.
 */
export const customRoleSortOrder = 100;

export function can(
  membership: { isOwner: boolean; permissions: readonly string[] },
  permission: Permission
): boolean {
  return membership.isOwner || membership.permissions.includes(permission);
}

/**
 * A named group of permissions, as the Roles editor presents them.
 *
 * `masterKey` is the permission that turns the whole group on. It is a REAL permission in its own
 * right - `reports.view` gates the reports endpoint whether or not any child is granted - not a
 * synthetic header, so a group whose master is off still resolves normally through `can()`. Groups
 * with no master are plain headings and carry null.
 */
export interface PermissionGroup {
  id: string;
  label: string;
  masterKey: Permission | null;
  permissions: readonly Permission[];
}

/**
 * Permissions that are STORED AND RETURNED BUT GATE NOTHING YET.
 *
 * A permission lands here when the feature it would protect does not exist. It is not a mistake
 * and it is not dead weight: the switch is in place so the day the feature ships it is already
 * granted to the people who should have it, instead of every workspace having to rediscover its
 * own access rules. But the Roles editor must SAY SO, because a switch that looks like it does
 * something and does not is worse than no switch - an owner would believe they had restricted
 * something. `GET /api/permissions` reports this as `enforced: false` per permission.
 *
 * Emptying this set is how a feature graduates. Nothing else needs to change.
 */
export const unenforcedPermissions: ReadonlySet<Permission> = new Set<Permission>([
  // No commission model exists anywhere in the schema - no rate, no plan, no ledger - which is why
  // `/api/reports` reports `commissionMinor: null` rather than zero. There is nothing to withhold.
  "dashboard.commission_by_staff",

  // No payroll and no time clock. Pawsh records appointments, not shifts, so every one of these
  // would be protecting a report that does not exist.
  "payroll.report",
  "payroll.commission_by_staff",
  "payroll.staff_commission_detail",
  "payroll.clock_in_out_by_staff",
  "payroll.clock_in_out_detail",
  "payroll.tips_by_staff",
  "payroll.tips_collected_detail",
  "payroll.clock_in_out_by_day",
  "payroll.special_service_rates",

  // `sales.by_payment_method` and `sales.by_staff` ARE enforced and are deliberately absent here -
  // they share their backing data with the dashboard children of the same shape.
  //
  // The rest are not: "all sales" is not a distinct projection from the report the master already
  // gates; per-service is returned as `services`, which is a count of services performed rather
  // than money and so does not answer this question; there is no product model at all, which is
  // why `salesItems.productsMinor` is a structural zero; and invoices are not aggregated per
  // client anywhere.
  "sales.all",
  "sales.by_service",
  "sales.by_product",
  "sales.by_client",

  // ---------------------------------------------------------------------------------------------
  // EVERY KEY OF THE ROLE PERMISSION TAXONOMY, WITHOUT EXCEPTION.
  //
  // Most are here for the ordinary reason: Pawsh has no retail, no packages, no gift cards, no
  // cash drawer, no time clock, no client merge, no account credit, no export, no client tags, no
  // online booking and no desktop login control, so there is nothing for the switch to protect.
  //
  // But roughly a dozen COULD be enforced today - `payments.edit` over void and refund,
  // `customers.contact_info` over the fields the customer projections return, `pets.breeds_edit`
  // over four breed routes, `calendar.blocks_create` over one, `messages.view` over the message
  // centre, and eight `settings.*` children over route families `settings.manage` holds. They are
  // here anyway, and that is the shape of this change rather than an oversight: the catalog lands
  // as a pure addition that alters no route, and each of those graduates in its own change that
  // splits exactly one family and can be reviewed on its own. Until then, the honest thing to tell
  // an owner is that the switch does not gate anything yet, because it does not.
  //
  // The four scope keys - `appointments.view_all_staff`, `appointments.edit_all_staff`,
  // `customers.view_all`, `dashboard.all_staff` - are the sharpest and must graduate last, with a
  // decision of their own. They are the only permissions here whose ABSENCE removes access: a
  // groomer who sees the whole calendar today would see only their own the moment they are
  // enforced. That is a deliberate reduction, not a split, and it is not this change's to make.
  // ---------------------------------------------------------------------------------------------
  "appointments.view_all_staff",
  "appointments.edit_all_staff",
  "appointments.service_price_edit",
  "appointments.online_booking_accept",
  "checkout.split_tips",
  "payments.edit",
  "calendar.blocks_create",
  "calendar.blocks_edit",

  "customers.view_all",
  "customers.contact_info",
  "customers.archive",
  "customers.merge",
  "customers.credit_edit",
  "customers.bulk_update",
  "customers.export",
  "customers.tags_edit",
  "pets.breeds_edit",

  "settings.business",
  "settings.permissions",
  "settings.lock_screen_code",
  "settings.authorize_browser",
  "settings.revoke_browser",
  "settings.availability",
  "settings.payroll",
  "settings.appointment_schedule",
  "settings.pet_options",
  "settings.services",
  "settings.payments",
  "settings.discounts",
  "settings.auto_messages",
  "settings.auto_reply",
  "settings.mobile",
  "settings.quickbooks",
  "settings.google_calendar",
  "settings.online_booking",
  "settings.intake_form",
  "settings.client_portal",
  "settings.review_booster",
  "settings.agreements",
  "settings.report_cards",
  "report_cards.send",

  "dashboard.all_staff",

  "cash_drawer.manage",
  "cash_drawer.delete_records",
  "retail.sale_create",
  "settings.retail",
  "settings.packages",
  "packages.sell",
  "settings.gift_cards",
  "gift_cards.sell",
  "settings.clock_in_out",
  "clock_in_out.all_staff",
  "messages.view",
  "messages.call_records",
  "messages.voicemail"
]);

/**
 * The permission catalog, grouped for presentation.
 *
 * EVERY PERMISSION IN THE TUPLE MUST APPEAR IN EXACTLY ONE GROUP. A permission missing from here
 * is one an owner can never grant through the UI, and one appearing twice is a checkbox that
 * disagrees with itself. `tests/domain/permission-catalog.test.ts` enforces both.
 */
export const permissionGroups: readonly PermissionGroup[] = [
  // -------------------------------------------------------------------------------------------
  // THE PERMISSIONS SHEET.
  //
  // Eleven groups. Operations, Money, Reporting and Administration are gone - not because their
  // permissions went anywhere, but because they were Pawsh's own headings and the taxonomy has
  // its own. `operations.*` are appointment status transitions (`permissionForTransition` derives
  // them from the target status) and checkout and payment belong to the same appointment, so both
  // groups fold into Appointment. Administration's three split: `settings.manage` becomes the
  // Setting master, and `team.manage` and `services.manage` become rows inside it.
  //
  // Blocked time sits under Appointment rather than with clients: a block is a calendar object
  // with an employee and a time range, and nothing about a client.
  // -------------------------------------------------------------------------------------------
  {
    id: "appointment", label: "Appointment", masterKey: null,
    permissions: [
      "appointments.view_all_staff", "appointments.edit_all_staff",
      "calendar.view", "appointments.view", "appointments.create", "appointments.edit",
      "appointments.cancel", "appointments.override_conflict",
      "operations.check_in", "operations.perform_service", "operations.complete",
      "checkout.perform", "checkout.split_tips",
      "payments.view", "payments.edit", "discounts.apply",
      "appointments.service_price_edit", "appointments.online_booking_accept",
      "calendar.blocks_create", "calendar.blocks_edit"
    ]
  },
  {
    // "Clients & pets", not the reference's "Client". The reference has no pet rows at all and
    // Pawsh has five, so calling a group holding `pets.care.edit` "Client" would mislabel it.
    id: "clients", label: "Clients & pets", masterKey: null,
    permissions: [
      "customers.view", "customers.view_all", "customers.edit", "customers.contact_info",
      "customers.archive", "customers.merge", "customers.credit_edit", "customers.bulk_update",
      "customers.export", "customers.tags_edit",
      "pets.view", "pets.edit", "pets.breeds_edit", "pets.care.view", "pets.care.edit"
    ]
  },
  {
    // `settings.manage` is BOTH the master and a listed row. Listing it is what satisfies the
    // exactly-one-group rule - being another group's `masterKey` is not membership - and the
    // editor renders a master once per sheet, above the rows, rather than twice.
    id: "setting", label: "Setting", masterKey: "settings.manage",
    permissions: [
      "settings.manage",
      "settings.business", "team.manage", "settings.permissions",
      "settings.lock_screen_code", "settings.authorize_browser", "settings.revoke_browser",
      "settings.availability", "settings.payroll", "settings.appointment_schedule",
      "settings.pet_options", "settings.services", "services.manage", "settings.payments",
      "settings.discounts", "settings.auto_messages", "settings.auto_reply", "settings.mobile",
      "settings.quickbooks", "settings.google_calendar", "settings.online_booking",
      "settings.intake_form", "settings.client_portal", "settings.review_booster",
      "settings.agreements", "settings.report_cards", "report_cards.send"
    ]
  },
  {
    // The old `reporting` group held `reports.view` and `dashboard.view` with no master, purely
    // to satisfy the exactly-one-group rule, and the editor rendered NOTHING for it: a group with
    // no master whose every row is a master shown elsewhere is filtered out. Splitting it in two
    // gives the taxonomy's Dashboard and Report groups a real home and makes a dead group mean
    // something. Each master is a listed row of its own group, and the Access Control sheet's
    // groups go on naming them as `masterKey` only, which is not membership.
    id: "dashboard-access", label: "Dashboard", masterKey: "dashboard.view",
    permissions: ["dashboard.view", "dashboard.all_staff"]
  },
  {
    id: "report-access", label: "Report", masterKey: "reports.view",
    permissions: ["reports.view"]
  },
  {
    id: "cash-drawer", label: "Cash Drawer", masterKey: null,
    permissions: ["cash_drawer.manage", "cash_drawer.delete_records"]
  },
  {
    id: "retail", label: "Retail", masterKey: null,
    permissions: ["retail.sale_create", "settings.retail"]
  },
  {
    id: "package", label: "Package", masterKey: null,
    permissions: ["settings.packages", "packages.sell"]
  },
  {
    id: "gift-card", label: "Gift Card", masterKey: null,
    permissions: ["settings.gift_cards", "gift_cards.sell"]
  },
  {
    id: "clock", label: "Clock in/out", masterKey: null,
    permissions: ["settings.clock_in_out", "clock_in_out.all_staff"]
  },
  {
    id: "messaging", label: "Message/Call", masterKey: null,
    permissions: ["messages.view", "messages.call_records", "messages.voicemail"]
  },

  // -------------------------------------------------------------------------------------------
  // THE ACCESS CONTROL SHEET, unchanged.
  //
  // These three carry the report and dashboard projection children shipped with the reporting
  // taxonomy. Their ids are the ones `ROLE_ACCESS_GROUP_IDS` names in the web app, which is what
  // puts them on the second sheet; every other id falls through to the Permissions sheet. Neither
  // their membership nor their enforcement is revisited here.
  // -------------------------------------------------------------------------------------------
  {
    id: "dashboard", label: "Dashboard", masterKey: "dashboard.view",
    permissions: [
      "dashboard.revenue", "dashboard.revenue_by_staff", "dashboard.commission_by_staff",
      "dashboard.tips_by_staff", "dashboard.sales_items", "dashboard.payment_status",
      "dashboard.sales_by_method", "dashboard.summary"
    ]
  },
  {
    id: "payroll", label: "Payroll", masterKey: "reports.view",
    permissions: [
      "payroll.report", "payroll.commission_by_staff", "payroll.staff_commission_detail",
      "payroll.clock_in_out_by_staff", "payroll.clock_in_out_detail", "payroll.tips_by_staff",
      "payroll.tips_collected_detail", "payroll.clock_in_out_by_day",
      "payroll.special_service_rates"
    ]
  },
  {
    id: "sales", label: "Sales", masterKey: "reports.view",
    permissions: [
      "sales.all", "sales.by_payment_method", "sales.by_service", "sales.by_product",
      "sales.by_staff", "sales.by_client"
    ]
  }
];

/**
 * The permission a status transition requires, derived from the *target* status.
 *
 * The server derives it this way in the transition handler, so a client that guesses from the
 * current status instead will hide an action the caller is allowed to take, or offer one the
 * server will refuse. Cancel and no-show share `appointments.cancel`.
 *
 * This is for deciding what to render. The server checks it again, and that check is the one
 * that authorizes anything.
 */
export function permissionForTransition(status: AppointmentStatus): Permission {
  if (status === "checked_in") return "operations.check_in";
  if (status === "in_service") return "operations.perform_service";
  if (status === "completed") return "operations.complete";
  return "appointments.cancel";
}
