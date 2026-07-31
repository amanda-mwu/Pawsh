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
