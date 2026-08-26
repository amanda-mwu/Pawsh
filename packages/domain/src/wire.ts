/**
 * Wire types for the endpoints the mobile app consumes.
 *
 * These describe what the API actually returns today, not what a tidier API would return. The
 * backend has no response envelope — bare arrays, bare database rows, `{items,total,page,pageSize}`
 * pages, and bespoke composites all coexist — so each type is written against its own endpoint.
 * Normalizing that surface would break the web client, so clients absorb it in an adapter instead.
 *
 * Two properties of the API are load-bearing here and must not be "cleaned up" in the types:
 *
 * - Pet care fields are **redacted, not omitted**. A caller without `pets.care.view` receives the
 *   same keys with `null` values, so every care field is nullable regardless of the reader's role.
 * - Money is always integer **minor units** in a `*Minor` field. Currency lives on the business.
 */
import type { AppointmentStatus } from "./appointments.js";
import type { InvoiceStatus } from "./enums.js";
import type { Permission } from "./permissions.js";
import type { RabiesAppointmentStatus, RabiesVerificationStatus } from "./rabies.js";

/** ISO 8601 instant, e.g. `2026-08-26T17:30:00.000Z`. */
export type IsoInstant = string;
/** Naive local timestamp with no zone, e.g. `2026-08-26T09:30`. */
export type LocalDateTime = string;
/** `YYYY-MM-DD`. */
export type LocalDate = string;

/**
 * The error body. Every failure is JSON carrying `error`; richer failures add a `code` and
 * endpoint-specific fields alongside it. Note the backend answers an unexpected server fault with
 * **400**, not 500, so status alone is not a reliable signal of who was at fault.
 */
export interface ApiErrorBody {
  error: string;
  code?: string;
  details?: unknown;
  [key: string]: unknown;
}

export interface AccountSummary { email: string; displayName: string }

export interface BusinessSummary {
  id: string;
  name: string;
  currency: string;
  taxRateBasisPoints: number;
  reminderLeadMinutes: number;
  status: string;
  locationId: string | null;
  locationName: string | null;
  timezone: string | null;
  /** Required by every scheduling mutation as an optimistic-concurrency check. */
  locationVersion: number;
  locationCount: number;
}

/** `GET /api/me` */
export interface MeResponse {
  userId: string;
  businessId: string;
  membershipId: string;
  isOwner: boolean;
  permissions: Permission[];
  locationId: string | null;
  account: AccountSummary;
  business?: BusinessSummary;
}

/** `GET /api/workspaces` — a bare array. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  isOwner: boolean;
  permissions: Permission[];
  current: boolean;
}

/** `GET /api/locations` — a bare array. */
export interface LocationSummary {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  version: number;
  current: boolean;
}

export interface AppointmentService {
  id: string;
  serviceId: string;
  name: string;
  durationMinutes: number;
  priceMinor: number;
}

export interface AppointmentGroomer { id: string; displayName: string }

/**
 * One element of `GET /api/appointments`, and the entire body of `GET /api/appointments/:id`.
 * The two are guaranteed to be the same shape — they are built by one shared query projection.
 */
export interface CalendarAppointment {
  id: string;
  businessId: string;
  locationId: string;
  customerId: string;
  petId: string;
  employeeId: string;
  startAt: IsoInstant;
  endAt: IsoInstant;
  status: AppointmentStatus;
  notes: string | null;
  operationalNotes: string | null;
  availabilityOverridden: boolean;
  conflictOverridden: boolean;
  /** Optimistic-concurrency token; send it back on transitions to detect a stale view. */
  version: number;
  schedulingTimezone: string;
  scheduledLocalStart: LocalDateTime;
  scheduledUtcOffsetMinutes: number;

  firstName: string | null;
  lastName: string | null;
  customerPhone: string | null;

  petName: string | null;
  breed: string | null;
  safetyAlerts: string | null;
  behaviorNotes: string | null;
  medicalNotes: string | null;
  groomingPreferences: string | null;
  coatNotes: string | null;
  vaccinationExpiresOn: LocalDate | null;
  rabiesVerificationStatus: RabiesVerificationStatus | null;
  rabiesAppointmentStatus: RabiesAppointmentStatus | null;

  employeeName: string;
  groomers: AppointmentGroomer[];
  services: AppointmentService[];
  invoiceStatus: InvoiceStatus | null;
  invoiceBalanceMinor: number | null;
}

/** `GET /api/appointments/:id/activity` */
export interface AppointmentActivityEntry {
  id: string;
  action: string;
  createdAt: IsoInstant;
  actorName: string | null;
  reason: string | null;
  fromStatus: string | number | null;
  toStatus: string | number | null;
  amountMinor: number | null;
  method: string | null;
  totalMinor: number | null;
}

export interface CustomerSummary {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  preferredContactMethod: "email" | "phone" | "none" | null;
  notes: string | null;
  archivedAt: IsoInstant | null;
  preferredEmployeeId: string | null;
  preferredEmployeeName?: string | null;
}

/** Every care field is nullable: absent data and withheld data look identical by design. */
export interface Pet {
  id: string;
  businessId: string;
  customerId: string;
  name: string | null;
  species: string;
  breed: string | null;
  dateOfBirth: LocalDate | null;
  weightOunces: number | null;
  sex: string | null;
  fixedStatus: "spayed" | "neutered" | "intact" | null;
  hairLength: string | null;
  coatColor: string | null;
  coatNotes: string | null;
  groomingPreferences: string | null;
  behaviorNotes: string | null;
  medicalNotes: string | null;
  safetyAlerts: string | null;
  healthIssues: string[] | null;
  preferredShampoo: string | null;
  vaccinationExpiresOn: LocalDate | null;
  rabiesVerificationStatus: RabiesVerificationStatus | null;
  archivedAt: IsoInstant | null;
  deceasedAt: IsoInstant | null;
  version: number;
  customerName?: string | null;
  customerPhone?: string | null;
}

/** `GET /api/pets/:id/notes` */
export interface PetNote {
  id: string;
  body: string;
  pinned: boolean;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
  authorName: string | null;
}

/** The offset-paged envelope used by the history and note endpoints. */
export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }

/** `GET /api/customers/:id/history` — `summary` is withheld (null), not zeroed, without `payments.view`. */
export interface CustomerHistoryResponse {
  customer: CustomerSummary;
  pets: Pet[];
  upcoming: { items: CalendarAppointment[]; total: number };
  history: { items: CalendarAppointment[]; total: number };
  appointmentTotal: number;
  appointmentsTruncated: boolean;
  summary: CustomerFinancialSummary | null;
  invoices: CustomerInvoiceSummary[];
}

export interface CustomerFinancialSummary {
  invoicedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  invoiceCount: number;
  appointmentTotal: number;
  unclosedTotal: number;
}

export interface CustomerInvoiceSummary {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  totalMinor: number;
  balanceMinor: number;
  createdAt: IsoInstant;
}

/** `POST /api/appointments/:id/transition` */
export interface TransitionRequest {
  status: AppointmentStatus;
  reason?: string | null;
  version?: number;
}

/** `PATCH /api/appointments/:id/operations` */
export interface OperationalNotesRequest {
  operationalNotes: string | null;
  version?: number;
}

/** `POST /api/auth/login`. `token` is returned only to a client declaring `x-pawsh-client: native`. */
export interface LoginRequest { email: string; password: string }
export interface LoginResponse { ok: true; token?: string }
