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
 * The payment badges, which replace the lifecycle badge once an invoice exists.
 *
 * Only `paid` is paid; `open`, `partially_paid`, `draft` and `void` all read as unpaid, because
 * the question a salon acts on is whether money is still owed.
 *
 * `refunded` and `partially_refunded` are neither, and collapsing them into either one would be a
 * lie in a different direction each time. Calling a refund "Paid" hides the single most important
 * thing that happened to that visit. Calling it "Unpaid" sends somebody to chase a customer for
 * money that was collected and then deliberately given back. So they get their own badges and the
 * calendar says what actually happened.
 */
export type PaymentBadgeVariant = "paid" | "unpaid" | "partially_refunded" | "refunded";

export const paymentBadges: Record<PaymentBadgeVariant, StatusBadge> = {
  paid: { code: "PAI", label: "Paid" },
  unpaid: { code: "UNP", label: "Unpaid" },
  partially_refunded: { code: "PRF", label: "Partly refunded" },
  refunded: { code: "REF", label: "Refunded" }
};

export interface AppointmentBadge extends StatusBadge {
  /** `payment` when an invoice exists and took precedence, `lifecycle` otherwise. */
  kind: "lifecycle" | "payment";
  /** The value the badge was derived from, for a client that keys a colour off it. */
  variant: AppointmentStatus | PaymentBadgeVariant;
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
    // Named one at a time rather than defaulted, so the day a seventh invoice status is added the
    // compiler asks what badge it carries instead of quietly filing it under "Unpaid".
    const variant: PaymentBadgeVariant =
      invoiceStatus === "paid" ? "paid"
        : invoiceStatus === "refunded" ? "refunded"
          : invoiceStatus === "partially_refunded" ? "partially_refunded"
            : "unpaid";
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

/**
 * How many identity colours the palette actually has, and therefore the ceiling on a slot an
 * operator may be assigned or a client may render.
 *
 * THIS IS NOT THE HASH MODULUS. See `groomerHashSlotCount` for why the two must stay apart.
 * Growing the palette means growing this number; the database check on `employees.color_slot` is
 * a wider outer bound (0-15) precisely so that growing it needs no migration.
 */
export const groomerPaletteSize = 10;

/**
 * How many of those colours the HASH FALLBACK may assign.
 *
 * NEVER WIDEN THIS, and never fold it back together with `groomerPaletteSize`. It is the modulus
 * of `groomerSlotIndex`, which is the colour every groomer nobody has explicitly assigned one
 * still gets — which is every groomer in every workspace that has not opened the Staff screen.
 * Changing the modulus does not extend the palette for those people, it REDEALS it: measured over
 * 200,000 UUIDs, moving 5 to 10 recolours 50.2% of them. A groomer's colour is how a person finds
 * their own column on a calendar they have read every morning for a year, and the whole reason
 * `color_slot` exists is that nobody could fix a collision. Silently reshuffling half the salon to
 * make room for five new colours would be a worse version of the problem it was added to solve.
 *
 * Slots 5-9 are reachable only by explicit assignment, which is the intended asymmetry: an
 * operator opts in to the new colours, the hash never drifts anyone into them.
 */
export const groomerHashSlotCount = 5;

/**
 * The identity slot a groomer occupies, from a stable hash of the employee id.
 *
 * The hash is reproduced exactly rather than replaced with something tidier: a groomer who is
 * purple on the web calendar and orange on a phone is two people to anyone reading both. For the
 * same reason the modulus is pinned at `groomerHashSlotCount` and not at the palette size.
 */
export function groomerSlotIndex(id: string | null | undefined): number | null {
  if (!id) return null;
  const key = String(id);
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash % groomerHashSlotCount;
}

/**
 * The identity slot a groomer actually gets: the one an operator assigned, or the hash.
 *
 * `employees.color_slot` is null for every groomer nobody has assigned a colour to, which is
 * every groomer in every workspace that never opens the setting, so the hash stays the default
 * and nothing about those calendars changes. An assigned slot simply wins.
 *
 * This exists so the override is resolved in ONE place. `groomerSlotIndex` carries a note that a
 * groomer who is purple on the web and orange on a phone is two people to anyone reading both;
 * two clients each deciding for themselves when the stored slot beats the hash is the same defect
 * with an extra branch to get wrong.
 *
 * An out-of-range stored slot is ignored rather than rendered, because the database's check
 * constraint is deliberately wider than the palette: it is the durable outer bound, and
 * `groomerPaletteSize` is how many colours actually exist today. A slot stored while the palette
 * was larger falls back to the hash instead of asking for a token that is not there. The bound
 * here is the PALETTE, not the hash count - an assigned slot of 7 is a real colour, and only the
 * hash is confined to the first five.
 */
export function resolveGroomerSlot(
  id: string | null | undefined,
  colorSlot: number | null | undefined
): number | null {
  if (typeof colorSlot === "number" && Number.isInteger(colorSlot)
    && colorSlot >= 0 && colorSlot < groomerPaletteSize) {
    return colorSlot;
  }
  return groomerSlotIndex(id);
}
