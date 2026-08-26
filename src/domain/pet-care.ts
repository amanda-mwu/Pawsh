/**
 * The health issues a salon records against a pet.
 *
 * Rabies is deliberately absent. Pawsh records rabies status authoritatively on the pet and in
 * its documents, where the expiry drives appointment eligibility and customer notifications. A
 * tick box saying "Rabies Shot" would be a second, unverified answer to the same question, and
 * an ambiguous compliance record is worse than none.
 *
 * Storage distinguishes two absences: null means nobody has been asked, an empty list means
 * somebody was asked and there is nothing to report.
 */
export const petHealthIssues = [
  "diabetes_mellitus", "epilepsy", "heart_condition", "arthritis", "obesity",
  "distemper", "fleas_ticks_mites", "cancer", "blind", "deaf"
] as const;

export type PetHealthIssue = (typeof petHealthIssues)[number];

export const protectedPetCareFields = [
  "safetyAlerts",
  "medicalNotes",
  // Structured medical and vet information joins the existing free-text fields behind the same
  // permission. Who the pet's vet is, and what it is being treated for, is exactly the kind of
  // detail `pets.care.view` exists to gate.
  "healthIssues",
  "vetName",
  "vetPhone",
  "vetContactName",
  "vetContactPhone",
  "vetAddress",
  "behaviorNotes",
  "emergencyContact",
  "veterinarian",
  "vaccinationNotes",
  "vaccinationExpiresOn",
  "rabiesVaccinationDate",
  "rabiesCertificateReference",
  "rabiesVerificationStatus",
  "rabiesVerificationMethod",
  "rabiesVerificationDate",
  "rabiesVerifiedByMembershipId",
  "rabiesVerifiedByName",
  "rabiesAppointmentStatus",
  "rabiesCustomerNotificationStatus"
] as const;

export const writablePetCareFields = [
  "safetyAlerts","medicalNotes","behaviorNotes","emergencyContact","veterinarian",
  "healthIssues","vetName","vetPhone","vetContactName","vetContactPhone","vetAddress",
  "vaccinationNotes","vaccinationExpiresOn","rabiesVaccinationDate",
  "rabiesCertificateReference","rabiesVerificationStatus","rabiesVerificationMethod",
  "rabiesVerificationDate"
] as const;

export type ProtectedPetCareField = (typeof protectedPetCareFields)[number];
export type WritablePetCareField = (typeof writablePetCareFields)[number];
export type PetCareRecord = Partial<Record<ProtectedPetCareField, unknown>>;

export function redactPetCare<T extends PetCareRecord>(record: T): T {
  return {
    ...record,
    ...Object.fromEntries(protectedPetCareFields.map((field) => [field, null]))
  } as T;
}

export function suppliedPetCareFields(record: PetCareRecord): WritablePetCareField[] {
  return writablePetCareFields.filter((field) =>
    Object.prototype.hasOwnProperty.call(record, field)
  );
}

export function changedPetCareFields(
  before: PetCareRecord,
  after: PetCareRecord
): WritablePetCareField[] {
  return writablePetCareFields.filter((field) =>
    comparable(before[field]) !== comparable(after[field])
  );
}

function comparable(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  // Health issues are a set. Order is not meaningful, so a re-tick that produces the same set in
  // a different order is not a change and must not be audited as one.
  if (Array.isArray(value)) return value.length ? [...value].map(String).sort().join(",") : "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}
