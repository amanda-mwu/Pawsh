import type {
  CalendarAppointment,
  CustomerHistoryResponse,
  CustomerSummary,
  LocationSummary,
  LoginResponse,
  MeResponse,
  Pet,
  PetNote,
  ServiceCategory,
  TransitionRequest
} from "@pawsh/domain";
import { request } from "./client";

/**
 * The endpoint adapter.
 *
 * The API has no response envelope: bare arrays, bare database rows, `{items,total,page,pageSize}`
 * pages and bespoke composites all coexist. That variety is absorbed here, once, so no screen has
 * to know which shape its data arrived in. Nothing in this file decides a domain rule — no
 * permission check, no status label, no money formatting.
 */

/** A service catalog row. Only what the app reads is typed; the row carries far more. */
export interface ServiceSummary {
  id: string;
  name: string;
  category: ServiceCategory | null;
  durationMinutes: number;
  active: boolean;
}

/**
 * An employee row. `membershipId` is what resolves the signed-in user to a groomer, which is the
 * only way the Today screen can offer a "Mine" scope: `/api/me` knows the membership, and the
 * calendar is keyed by employee.
 */
export interface EmployeeSummary {
  id: string;
  displayName: string;
  membershipId: string | null;
  active: boolean;
}

/** `GET /api/customers` without `paged` — a bare array, with the customer's pets inlined. */
export interface CustomerDirectoryEntry extends CustomerSummary {
  pets?: { id: string; name: string | null; breed: string | null; safetyAlerts: string | null }[];
}

export interface LocationSelection {
  locationId: string;
  locationName: string;
  timezone: string;
  locationVersion: number;
}

export interface CalendarQuery {
  /** Omit to let the server resolve the active location's own current date. */
  localDate?: string | undefined;
  days?: number | undefined;
  mode?: "start" | "overlap" | undefined;
  /** Sent as a comma-separated list, which is the only form the server's filter accepts. */
  employeeIds?: readonly string[] | undefined;
}

export const api = {
  login(input: { email: string; password: string }): Promise<LoginResponse> {
    return request<LoginResponse>("/api/auth/login", { method: "POST", body: input });
  },

  logout(): Promise<void> {
    return request<void>("/api/auth/logout", { method: "POST" });
  },

  me(): Promise<MeResponse> {
    return request<MeResponse>("/api/me");
  },

  locations(): Promise<LocationSummary[]> {
    return request<LocationSummary[]>("/api/locations");
  },

  selectLocation(locationId: string): Promise<LocationSelection> {
    return request<LocationSelection>("/api/me/location", {
      method: "POST",
      body: { locationId }
    });
  },

  employees(): Promise<EmployeeSummary[]> {
    return request<EmployeeSummary[]>("/api/employees");
  },

  services(): Promise<ServiceSummary[]> {
    return request<ServiceSummary[]>("/api/services");
  },

  /** Scoped to the session's active location, not to any parameter. */
  appointments(query: CalendarQuery = {}): Promise<CalendarAppointment[]> {
    return request<CalendarAppointment[]>("/api/appointments", {
      query: {
        localDate: query.localDate,
        days: query.days,
        mode: query.mode,
        employeeIds: query.employeeIds?.length ? query.employeeIds.join(",") : undefined
      }
    });
  },

  appointment(id: string): Promise<CalendarAppointment> {
    return request<CalendarAppointment>(`/api/appointments/${id}`);
  },

  /**
   * Advances the lifecycle. Send `version` so a stale view is answered with 409 rather than
   * quietly overwriting somebody else's action.
   *
   * The response is the bare `appointments` row, **not** the calendar projection — it carries no
   * pet, customer or service columns — so it must never be written into a detail cache. Callers
   * invalidate instead.
   */
  transition(id: string, input: TransitionRequest): Promise<unknown> {
    return request<unknown>(`/api/appointments/${id}/transition`, {
      method: "POST",
      body: input
    });
  },

  /** Valid only while the appointment is `checked_in` or `in_service`. */
  updateOperationalNotes(
    id: string,
    input: { operationalNotes: string | null; version?: number | undefined }
  ): Promise<unknown> {
    return request<unknown>(`/api/appointments/${id}/operations`, {
      method: "PATCH",
      body: input
    });
  },

  pet(id: string): Promise<Pet> {
    return request<Pet>(`/api/pets/${id}`);
  },

  async petNotes(id: string): Promise<PetNote[]> {
    const page = await request<{ items: PetNote[] }>(`/api/pets/${id}/notes`);
    return page.items ?? [];
  },

  customerHistory(id: string): Promise<CustomerHistoryResponse> {
    return request<CustomerHistoryResponse>(`/api/customers/${id}/history`);
  },

  searchCustomers(term: string): Promise<CustomerDirectoryEntry[]> {
    return request<CustomerDirectoryEntry[]>("/api/customers", { query: { q: term } });
  },

  searchPets(term: string): Promise<Pet[]> {
    return request<Pet[]>("/api/pets", { query: { q: term } });
  }
};
