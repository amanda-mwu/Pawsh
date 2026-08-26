/**
 * Query keys, in one place so an invalidation cannot miss a screen.
 *
 * Everything appointment-shaped lives under a single `appointments` root: a status transition
 * changes the day list, the detail, the activity log and the client's history at once, and a
 * broad invalidation on a handful of small queries is cheaper than a subtle one that leaves a
 * groomer looking at a status that already moved.
 */
export const queryKeys = {
  me: ["me"] as const,
  locations: ["locations"] as const,
  services: ["services"] as const,
  employees: ["employees"] as const,
  appointments: ["appointments"] as const,
  appointmentDay: (localDate: string | null) => ["appointments", "day", localDate] as const,
  appointmentDetail: (id: string) => ["appointments", "detail", id] as const,
  pets: ["pets"] as const,
  pet: (id: string) => ["pets", "detail", id] as const,
  petNotes: (id: string) => ["pets", "notes", id] as const,
  petSearch: (term: string) => ["pets", "search", term] as const,
  customers: ["customers"] as const,
  customerHistory: (id: string) => ["customers", "history", id] as const,
  customerSearch: (term: string) => ["customers", "search", term] as const
};
