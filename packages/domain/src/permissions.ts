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
