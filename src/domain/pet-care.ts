export const protectedPetCareFields = [
  "safetyAlerts",
  "medicalNotes",
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
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}
