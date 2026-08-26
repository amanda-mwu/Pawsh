/**
 * Presentation rules — the decisions about *what* a client shows, not how it looks.
 *
 * Each rule here already existed in `public/app.js` and had to be re-derived by any second
 * client. Which badge an appointment carries, which of its services leads the line, and which
 * colour slot a groomer owns are not styling choices: two clients that answer them differently
 * are showing the same appointment as two different things. Layout, colour values, and copy
 * belong to the client; the rules belong here.
 *
 * Nothing in this module reads a catalog or a clock. Callers pass in what they know.
 */
import { appointmentStatuses, type AppointmentStatus } from "./appointments.js";
import type { InvoiceStatus, ServiceCategory } from "./enums.js";
import { appointmentStatusBadges, type StatusBadge } from "./labels.js";
import type { Permission } from "./permissions.js";

/**
 * The two payment badges, which replace the lifecycle badge once an invoice exists.
 *
 * Only `paid` is paid; every other invoice status — `open`, `partially_paid`, `draft`, `void` —
 * reads as unpaid, because the question a salon acts on is whether money is still owed.
 */
export const paymentBadges: Record<"paid" | "unpaid", StatusBadge> = {
  paid: { code: "PAI", label: "Paid" },
  unpaid: { code: "UNP", label: "Unpaid" }
};

export interface AppointmentBadge extends StatusBadge {
  /** `payment` when an invoice exists and took precedence, `lifecycle` otherwise. */
  kind: "lifecycle" | "payment";
  /** The value the badge was derived from, for a client that keys a colour off it. */
  variant: AppointmentStatus | "paid" | "unpaid";
}

/**
 * The badge for one appointment, or `null` when the status is not one the API can back.
 *
 * A `null` means render no badge at all. A grey "Unknown" chip would assert a state the data
 * does not support, and there is no confirmed/unconfirmed flag on the appointment model for one
 * to fall back to.
 */
export function resolveAppointmentBadge(appointment: {
  status?: string | null;
  invoiceStatus?: InvoiceStatus | null;
}): AppointmentBadge | null {
  const invoiceStatus = appointment.invoiceStatus;
  if (invoiceStatus) {
    const variant = invoiceStatus === "paid" ? "paid" : "unpaid";
    return { ...paymentBadges[variant], kind: "payment", variant };
  }
  const status = appointment.status;
  if (!status || !isAppointmentStatus(status)) return null;
  return { ...appointmentStatusBadges[status], kind: "lifecycle", variant: status };
}

export function isAppointmentStatus(value: string): value is AppointmentStatus {
  return (appointmentStatuses as readonly string[]).includes(value);
}

/**
 * The one action that advances an appointment from a given status, with the permission the
 * server derives from the target status.
 *
 * `completed` is the exception: checkout opens a screen rather than posting a transition, so it
 * carries no target status.
 */
export interface AppointmentPrimaryAction {
  label: string;
  permission: Permission;
  target: AppointmentStatus | null;
}

export const appointmentPrimaryActions: Partial<Record<AppointmentStatus, AppointmentPrimaryAction>> = {
  scheduled: { label: "Check in", permission: "operations.check_in", target: "checked_in" },
  checked_in: { label: "Start service", permission: "operations.perform_service", target: "in_service" },
  in_service: { label: "Complete", permission: "operations.complete", target: "completed" },
  completed: { label: "Checkout", permission: "checkout.perform", target: null }
};

/** The destructive transitions, which never sit next to the advancing action. */
export const appointmentTerminalActions: { status: AppointmentStatus; label: string }[] = [
  { status: "cancelled", label: "Cancel appointment" },
  { status: "no_show", label: "No show" }
];

/**
 * The catalog families that are add-ons rather than a groom in their own right.
 *
 * Everything else is a base service, which is why the fallback below leads with the longest.
 */
export const addOnServiceCategories: readonly ServiceCategory[] = ["DOG_ADDON", "A_LA_CARTE"];

export interface AppointmentServiceLike {
  serviceId: string;
  name: string;
  durationMinutes: number;
}

export interface AppointmentServiceSplit {
  primary: string;
  addOns: string[];
}

/**
 * One base service and its add-ons, so a booking reads as "what is being done" plus "what was
 * added".
 *
 * An appointment stores only a service id per line, so the category has to be resolved against
 * the loaded catalog. When it cannot be — an unknown id, or a client that has not loaded the
 * catalog — the longest service leads, which is the same fallback the web app uses.
 */
export function splitAppointmentServices(
  services: readonly AppointmentServiceLike[],
  categoryOf: (serviceId: string) => ServiceCategory | null | undefined
): AppointmentServiceSplit {
  const entries = services.map((service, index) => ({
    index,
    name: service.name,
    duration: Number(service.durationMinutes) || 0,
    addOn: addOnServiceCategories.includes(categoryOf(service.serviceId) ?? ("" as ServiceCategory))
  }));
  const [primary] = [...entries].sort(
    (first, second) =>
      Number(first.addOn) - Number(second.addOn) ||
      second.duration - first.duration ||
      first.index - second.index
  );
  if (!primary) return { primary: "", addOns: [] };
  return {
    primary: primary.name,
    addOns: entries.filter((entry) => entry !== primary).map((entry) => entry.name)
  };
}

/** How many identity slots a client cycles groomers through. */
export const groomerSlotCount = 5;

/**
 * The identity slot a groomer occupies, from a stable hash of the employee id.
 *
 * The hash is reproduced exactly rather than replaced with something tidier: a groomer who is
 * purple on the web calendar and orange on a phone is two people to anyone reading both.
 */
export function groomerSlotIndex(id: string | null | undefined): number | null {
  if (!id) return null;
  const key = String(id);
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash % groomerSlotCount;
}
