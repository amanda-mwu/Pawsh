export const rabiesVerificationStatuses = ["not_provided", "unverified", "staff_verified"] as const;
export const rabiesVerificationMethods = [
  "document_review", "veterinarian_confirmation", "verbal_confirmation", "customer_provided", "other"
] as const;

export type RabiesVerificationStatus = typeof rabiesVerificationStatuses[number];
export type RabiesAppointmentStatus =
  | "valid_for_appointment"
  | "expires_before_appointment"
  | "expired"
  | "not_provided";

export type RabiesProfileStatus = "current" | "expired" | "not_provided";

export function evaluateRabiesProfile(expirationDate: string | null, currentBusinessDate: string): RabiesProfileStatus {
  if (!expirationDate) return "not_provided";
  return expirationDate < currentBusinessDate ? "expired" : "current";
}

export function evaluateRabiesForAppointment(input: {
  verificationStatus?: RabiesVerificationStatus;
  expirationDate: string | null;
  appointmentLocalDate: string;
  currentBusinessDate: string;
}): RabiesAppointmentStatus {
  // Legacy verification metadata is retained for audit/history but is not authoritative for MVP eligibility.
  if (!input.expirationDate) return "not_provided";
  return input.expirationDate < input.appointmentLocalDate
    ? "expires_before_appointment"
    : "valid_for_appointment";
}
