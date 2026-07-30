export const protectedPetSafetyFields = [
  "safetyAlerts",
  "medicalNotes",
  "behaviorNotes",
  "emergencyContact",
  "veterinarian",
  "vaccinationNotes",
  "vaccinationExpiresOn"
] as const;

export type ProtectedPetSafetyField = (typeof protectedPetSafetyFields)[number];
export type PetSafetyRecord = Partial<Record<ProtectedPetSafetyField, unknown>>;

export function redactPetSafety<T extends PetSafetyRecord>(record: T): T {
  return {
    ...record,
    ...Object.fromEntries(protectedPetSafetyFields.map((field) => [field, null]))
  } as T;
}

export function suppliedPetSafetyFields(record: PetSafetyRecord): ProtectedPetSafetyField[] {
  return protectedPetSafetyFields.filter((field) =>
    Object.prototype.hasOwnProperty.call(record, field)
  );
}

export function changedPetSafetyFields(
  before: PetSafetyRecord,
  after: PetSafetyRecord
): ProtectedPetSafetyField[] {
  return protectedPetSafetyFields.filter((field) =>
    comparable(before[field]) !== comparable(after[field])
  );
}

function comparable(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}
