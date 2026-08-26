import type { CalendarAppointment, MeResponse, Permission, Pet } from "@pawsh/domain";

export const groomerPermissions: Permission[] = [
  "calendar.view",
  "appointments.view",
  "pets.view",
  "pets.care.view",
  "customers.view",
  "operations.check_in",
  "operations.perform_service",
  "operations.complete"
];

export function makeMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    userId: "user-1",
    businessId: "business-1",
    membershipId: "membership-1",
    isOwner: false,
    permissions: groomerPermissions,
    locationId: "location-1",
    account: { email: "maya@salon.test", displayName: "Maya R." },
    business: {
      id: "business-1",
      name: "Riverside Grooming",
      currency: "USD",
      taxRateBasisPoints: 0,
      reminderLeadMinutes: 60,
      status: "active",
      locationId: "location-1",
      locationName: "Riverside",
      timezone: "America/Los_Angeles",
      locationVersion: 3,
      locationCount: 1
    },
    ...overrides
  };
}

export function makeAppointment(
  overrides: Partial<CalendarAppointment> = {}
): CalendarAppointment {
  return {
    id: "appointment-1",
    businessId: "business-1",
    locationId: "location-1",
    customerId: "customer-1",
    petId: "pet-1",
    employeeId: "employee-1",
    startAt: "2026-08-26T16:00:00.000Z",
    endAt: "2026-08-26T17:30:00.000Z",
    status: "scheduled",
    notes: null,
    operationalNotes: null,
    availabilityOverridden: false,
    conflictOverridden: false,
    version: 4,
    schedulingTimezone: "America/Los_Angeles",
    scheduledLocalStart: "2026-08-26T09:00",
    scheduledUtcOffsetMinutes: -420,
    firstName: "Sarah",
    lastName: "Chen",
    customerPhone: "5035550140",
    petName: "Biscuit",
    breed: "Standard Poodle",
    safetyAlerts: null,
    behaviorNotes: null,
    medicalNotes: null,
    groomingPreferences: null,
    coatNotes: null,
    vaccinationExpiresOn: null,
    rabiesVerificationStatus: null,
    rabiesAppointmentStatus: "valid_for_appointment",
    employeeName: "Maya R.",
    groomers: [{ id: "employee-1", displayName: "Maya R." }],
    services: [
      { id: "line-1", serviceId: "service-1", name: "Full Groom", durationMinutes: 90, priceMinor: 8500 }
    ],
    invoiceStatus: null,
    invoiceBalanceMinor: null,
    ...overrides
  };
}

export function makePet(overrides: Partial<Pet> = {}): Pet {
  return {
    id: "pet-1",
    businessId: "business-1",
    customerId: "customer-1",
    name: "Biscuit",
    species: "Dog",
    breed: "Standard Poodle",
    dateOfBirth: null,
    weightOunces: 672,
    sex: "female",
    fixedStatus: "spayed",
    hairLength: null,
    coatColor: null,
    coatNotes: null,
    groomingPreferences: null,
    behaviorNotes: null,
    medicalNotes: null,
    safetyAlerts: null,
    healthIssues: null,
    preferredShampoo: null,
    vaccinationExpiresOn: "2027-01-01",
    rabiesVerificationStatus: null,
    archivedAt: null,
    deceasedAt: null,
    version: 2,
    customerName: "Sarah Chen",
    customerPhone: "5035550140",
    ...overrides
  };
}
