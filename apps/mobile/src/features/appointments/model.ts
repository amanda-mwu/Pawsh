import {
  formatMinor,
  groomerSlotIndex,
  rabiesAppointmentStatusLabels,
  rabiesNeedsAttention,
  resolveAppointmentBadge,
  splitAppointmentServices,
  type AppointmentBadge,
  type AppointmentServiceSplit,
  type AppointmentStatus,
  type CalendarAppointment,
  type RabiesAppointmentStatus,
  type ServiceCategory
} from "@pawsh/domain";
import type { ServiceSummary } from "../../api/endpoints";
import { formatDateValue, formatLongDate, formatRange, parseLocalDateTime } from "./time";

/**
 * How the app talks about care information it did not receive.
 *
 * An empty region means three different things — this dog is fine, the notes failed to load, and
 * you are not allowed to see this — and a groomer deciding whether to reach for a muzzle cannot
 * be asked to tell them apart from blank space. Every surface that shows care information states
 * which of these it is.
 */
export type CareVisibility = "visible" | "withheld";

export interface AppointmentView {
  id: string;
  status: AppointmentStatus;
  version: number;
  badge: AppointmentBadge | null;
  /** `YYYY-MM-DD` in the location's own wall clock. */
  localDate: string;
  timeRange: string;
  dateLabel: string;
  durationMinutes: number;
  petId: string;
  petName: string;
  breed: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  /** The primary assignee, and everyone assigned, so a "mine" filter needs no second lookup. */
  employeeId: string;
  groomerIds: string[];
  groomerName: string;
  groomerSlot: number | null;
  services: AppointmentServiceSplit;
  serviceNames: string[];
  totalPriceLabel: string | null;
  conflictOverridden: boolean;
  care: CareVisibility;
  safetyAlerts: string | null;
  behaviorNotes: string | null;
  medicalNotes: string | null;
  groomingPreferences: string | null;
  coatNotes: string | null;
  appointmentNotes: string | null;
  operationalNotes: string | null;
  rabiesStatus: RabiesAppointmentStatus | null;
  rabiesLabel: string | null;
  rabiesNeeded: boolean;
  vaccinationExpires: string | null;
  startedAt: string;
}

function text(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length ? trimmed : null;
}

function clientName(appointment: CalendarAppointment): string {
  return [appointment.firstName, appointment.lastName].filter(Boolean).join(" ").trim();
}

/**
 * Builds everything a screen needs from one appointment row.
 *
 * `careVisibility` is passed in rather than inferred from the data, because care fields are
 * redacted to `null` rather than omitted: a pet with no safety alert and a groomer without
 * `pets.care.view` produce byte-identical rows.
 */
export function toAppointmentView(
  appointment: CalendarAppointment,
  options: {
    careVisibility: CareVisibility;
    /** The service catalog, for deciding which line is the groom and which are add-ons. */
    categoryOf?: ((serviceId: string) => ServiceCategory | null | undefined) | undefined;
    currency?: string | undefined;
  }
): AppointmentView {
  const start = parseLocalDateTime(appointment.scheduledLocalStart);
  const durationMinutes = Math.max(
    1,
    Math.round(
      (new Date(appointment.endAt).getTime() - new Date(appointment.startAt).getTime()) / 60_000
    )
  );
  const localDate = start?.date ?? String(appointment.scheduledLocalStart ?? "").slice(0, 10);
  const services = splitAppointmentServices(
    appointment.services ?? [],
    options.categoryOf ?? (() => null)
  );
  const priceMinor = (appointment.services ?? []).reduce(
    (sum, service) => (service.priceMinor === null ? sum : sum + Number(service.priceMinor)),
    0
  );
  const hasPrices =
    (appointment.services ?? []).length > 0 &&
    (appointment.services ?? []).every((service) => service.priceMinor !== null);
  const rabiesStatus = appointment.rabiesAppointmentStatus;

  return {
    id: appointment.id,
    status: appointment.status,
    version: appointment.version,
    badge: resolveAppointmentBadge(appointment),
    localDate,
    timeRange: start ? formatRange(start, durationMinutes) : "",
    dateLabel: localDate ? formatLongDate(localDate) : "",
    durationMinutes,
    petId: appointment.petId,
    petName: text(appointment.petName) ?? "Unnamed pet",
    breed: text(appointment.breed) ?? "",
    customerId: appointment.customerId,
    customerName: clientName(appointment) || "Unnamed client",
    customerPhone: text(appointment.customerPhone),
    employeeId: appointment.employeeId,
    groomerIds: (appointment.groomers ?? []).map((groomer) => groomer.id),
    groomerName: appointment.groomers?.[0]?.displayName ?? appointment.employeeName ?? "",
    groomerSlot: groomerSlotIndex(appointment.employeeId),
    services,
    serviceNames: (appointment.services ?? []).map((service) => service.name),
    totalPriceLabel: hasPrices ? formatMinor(priceMinor, options.currency ?? "USD") : null,
    conflictOverridden: Boolean(appointment.conflictOverridden),
    care: options.careVisibility,
    safetyAlerts: text(appointment.safetyAlerts),
    behaviorNotes: text(appointment.behaviorNotes),
    medicalNotes: text(appointment.medicalNotes),
    groomingPreferences: text(appointment.groomingPreferences),
    coatNotes: text(appointment.coatNotes),
    appointmentNotes: text(appointment.notes),
    operationalNotes: text(appointment.operationalNotes),
    rabiesStatus,
    rabiesLabel: rabiesStatus ? rabiesAppointmentStatusLabels[rabiesStatus] : null,
    rabiesNeeded: Boolean(rabiesStatus && rabiesNeedsAttention.includes(rabiesStatus)),
    vaccinationExpires: formatDateValue(appointment.vaccinationExpiresOn),
    startedAt: appointment.startAt
  };
}

export function categoryLookup(
  services: readonly ServiceSummary[] | undefined
): (serviceId: string) => ServiceCategory | null {
  const byId = new Map((services ?? []).map((service) => [service.id, service.category]));
  return (serviceId: string) => byId.get(serviceId) ?? null;
}

/** Whether a groomer is the person this appointment is assigned to. */
export function isAssignedTo(view: AppointmentView, employeeId: string): boolean {
  return view.employeeId === employeeId || view.groomerIds.includes(employeeId);
}

/**
 * The order Today shows appointments in.
 *
 * Terminal appointments earlier than now are not deleted — a groomer needs to know a slot is dead
 * — but they stop competing for the top of the list.
 */
export const terminalStatuses: readonly AppointmentStatus[] = ["completed", "cancelled", "no_show"];

export function isTerminal(status: AppointmentStatus): boolean {
  return terminalStatuses.includes(status);
}

export function sortByStart(first: AppointmentView, second: AppointmentView): number {
  return first.startedAt.localeCompare(second.startedAt);
}

/**
 * The one appointment promoted to the top of Today: whatever is on the table, or the next thing
 * that is not.
 *
 * Deliberately not keyed to the wall clock. A salon runs late, and an appointment whose slot
 * started an hour ago is still the one the groomer has to deal with next — dropping it because
 * its start time has passed would promote the wrong dog and leave the right one buried.
 */
export function findNowAppointment(views: readonly AppointmentView[]): AppointmentView | null {
  const inService = views.find((view) => view.status === "in_service");
  if (inService) return inService;
  return views.find((view) => !isTerminal(view.status)) ?? null;
}
