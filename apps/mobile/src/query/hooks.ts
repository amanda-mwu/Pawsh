import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  CalendarAppointment,
  CustomerHistoryResponse,
  LocationSummary,
  MeResponse,
  Pet,
  PetNote
} from "@pawsh/domain";
import {
  api,
  type CustomerDirectoryEntry,
  type EmployeeSummary,
  type ServiceSummary
} from "../api/endpoints";
import { queryKeys } from "./keys";

export function useMe(enabled: boolean): UseQueryResult<MeResponse> {
  return useQuery({ queryKey: queryKeys.me, queryFn: api.me, enabled });
}

/**
 * The service catalog, which only exists here to tell a groom from an add-on.
 *
 * It changes when an owner edits it at a desk, not during a shift, so it is fetched once and left
 * alone. A missing catalog is not an error: `splitAppointmentServices` falls back to leading with
 * the longest service, exactly as the web app does for an unknown id.
 */
export function useServices(enabled: boolean): UseQueryResult<ServiceSummary[]> {
  return useQuery({
    queryKey: queryKeys.services,
    queryFn: api.services,
    enabled,
    staleTime: 60 * 60 * 1000
  });
}

/**
 * The employee roster, used only to resolve the signed-in membership to a groomer so Today can
 * offer a "Mine" scope. A user with no employee record — an owner who does not groom — simply
 * has no "Mine" to filter to, and the segment is not shown.
 */
export function useEmployees(enabled: boolean): UseQueryResult<EmployeeSummary[]> {
  return useQuery({
    queryKey: queryKeys.employees,
    queryFn: api.employees,
    enabled,
    staleTime: 60 * 60 * 1000
  });
}

export function resolveMyEmployeeId(
  employees: readonly EmployeeSummary[] | undefined,
  membershipId: string | null | undefined
): string | null {
  if (!employees || !membershipId) return null;
  return employees.find((employee) => employee.membershipId === membershipId)?.id ?? null;
}

export function useLocations(enabled: boolean): UseQueryResult<LocationSummary[]> {
  return useQuery({ queryKey: queryKeys.locations, queryFn: api.locations, enabled });
}

/**
 * One day of appointments.
 *
 * `localDate` is omitted for Today so the server resolves the active location's own current date
 * — it knows the location's timezone and the device does not. An explicit date is sent only when
 * the groomer navigated to one.
 */
export function useDayAppointments(
  localDate: string | null,
  enabled: boolean
): UseQueryResult<CalendarAppointment[]> {
  return useQuery({
    queryKey: queryKeys.appointmentDay(localDate),
    queryFn: () => api.appointments({ localDate: localDate ?? undefined, days: 1 }),
    enabled
  });
}

export function useAppointment(id: string, enabled: boolean): UseQueryResult<CalendarAppointment> {
  return useQuery({
    queryKey: queryKeys.appointmentDetail(id),
    queryFn: () => api.appointment(id),
    enabled
  });
}

export function usePet(id: string, enabled: boolean): UseQueryResult<Pet> {
  return useQuery({ queryKey: queryKeys.pet(id), queryFn: () => api.pet(id), enabled });
}

export function usePetNotes(id: string, enabled: boolean): UseQueryResult<PetNote[]> {
  return useQuery({ queryKey: queryKeys.petNotes(id), queryFn: () => api.petNotes(id), enabled });
}

export function useCustomerHistory(
  id: string,
  enabled: boolean
): UseQueryResult<CustomerHistoryResponse> {
  return useQuery({
    queryKey: queryKeys.customerHistory(id),
    queryFn: () => api.customerHistory(id),
    enabled
  });
}

export function useCustomerSearch(
  term: string,
  enabled: boolean
): UseQueryResult<CustomerDirectoryEntry[]> {
  return useQuery({
    queryKey: queryKeys.customerSearch(term),
    queryFn: () => api.searchCustomers(term),
    enabled
  });
}

export function usePetSearch(term: string, enabled: boolean): UseQueryResult<Pet[]> {
  return useQuery({
    queryKey: queryKeys.petSearch(term),
    queryFn: () => api.searchPets(term),
    enabled
  });
}
