import { useMemo } from "react";
import type { CalendarAppointment } from "@pawsh/domain";
import type { UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthProvider";
import { useDayAppointments, useServices } from "../../query/hooks";
import { categoryLookup, sortByStart, toAppointmentView, type AppointmentView, type CareVisibility } from "./model";

export interface DayView {
  views: AppointmentView[];
  query: UseQueryResult<CalendarAppointment[]>;
  careVisibility: CareVisibility;
  /** When the shown data was last successfully fetched, for the offline banner. */
  lastSyncedAt: number | null;
}

/**
 * One day, assembled.
 *
 * Care visibility is decided from the session's permissions rather than from the data, because
 * pet care fields are redacted to `null` rather than omitted: a pet with nothing to report and a
 * groomer who may not look produce identical rows.
 */
export function useDayView(localDate: string | null, enabled: boolean): DayView {
  const { me, allowed } = useAuth();
  const query = useDayAppointments(localDate, enabled);
  const services = useServices(enabled);

  const careVisibility: CareVisibility = allowed("pets.care.view") ? "visible" : "withheld";
  const currency = me?.business?.currency ?? "USD";
  const categoryOf = useMemo(() => categoryLookup(services.data), [services.data]);

  const views = useMemo(() => {
    const rows = query.data ?? [];
    return rows
      .map((row) => toAppointmentView(row, { careVisibility, categoryOf, currency }))
      .sort(sortByStart);
  }, [query.data, careVisibility, categoryOf, currency]);

  return {
    views,
    query,
    careVisibility,
    lastSyncedAt: query.dataUpdatedAt || null
  };
}
