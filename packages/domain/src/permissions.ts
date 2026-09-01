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
  "sales.by_client"
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
  "sales.by_client"
]);

/**
 * The permission catalog, grouped for presentation.
 *
 * EVERY PERMISSION IN THE TUPLE MUST APPEAR IN EXACTLY ONE GROUP. A permission missing from here
 * is one an owner can never grant through the UI, and one appearing twice is a checkbox that
 * disagrees with itself. `tests/domain/permission-catalog.test.ts` enforces both.
 */
export const permissionGroups: readonly PermissionGroup[] = [
  {
    id: "calendar", label: "Calendar & appointments", masterKey: null,
    permissions: [
      "calendar.view", "appointments.view", "appointments.create", "appointments.edit",
      "appointments.cancel", "appointments.override_conflict"
    ]
  },
  {
    id: "clients", label: "Clients & pets", masterKey: null,
    permissions: ["customers.view", "customers.edit", "pets.view", "pets.edit",
      "pets.care.view", "pets.care.edit"]
  },
  {
    id: "operations", label: "Operations", masterKey: null,
    permissions: ["operations.check_in", "operations.perform_service", "operations.complete"]
  },
  {
    id: "money", label: "Money", masterKey: null,
    permissions: ["checkout.perform", "payments.view", "discounts.apply"]
  },
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
  },
  {
    id: "reporting", label: "Reporting", masterKey: null,
    permissions: ["reports.view", "dashboard.view"]
  },
  {
    id: "administration", label: "Administration", masterKey: null,
    permissions: ["services.manage", "team.manage", "settings.manage"]
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
