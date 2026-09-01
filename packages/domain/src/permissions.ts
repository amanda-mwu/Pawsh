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
  "settings.manage"
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
export const unenforcedPermissions: ReadonlySet<Permission> = new Set<Permission>([]);

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
    id: "reporting", label: "Reporting", masterKey: null,
    permissions: ["reports.view"]
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
