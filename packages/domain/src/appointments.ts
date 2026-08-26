export const appointmentStatuses = [
  "scheduled", "checked_in", "in_service", "completed", "cancelled", "no_show"
] as const;

export type AppointmentStatus = (typeof appointmentStatuses)[number];

const transitions: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  scheduled: ["checked_in", "cancelled", "no_show"],
  checked_in: ["in_service"],
  in_service: ["completed"],
  completed: [],
  cancelled: [],
  no_show: []
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return transitions[from].includes(to);
}

export function overlaps(
  first: { startAt: Date; endAt: Date },
  second: { startAt: Date; endAt: Date }
): boolean {
  return first.startAt < second.endAt && second.startAt < first.endAt;
}
