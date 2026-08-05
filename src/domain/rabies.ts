export const rabiesVerificationStatuses = ["not_provided", "unverified", "staff_verified"] as const;
export const rabiesVerificationMethods = [
  "document_review", "veterinarian_confirmation", "verbal_confirmation", "customer_provided", "other"
] as const;

export type RabiesVerificationStatus = typeof rabiesVerificationStatuses[number];
export type RabiesAppointmentStatus =
  | "valid_for_appointment"
  | "expires_before_appointment"
  | "expired"
  | "unverified"
  | "not_provided";

export function evaluateRabiesForAppointment(input: {
  verificationStatus: RabiesVerificationStatus;
  expirationDate: string | null;
  appointmentLocalDate: string;
  currentBusinessDate: string;
}): RabiesAppointmentStatus {
  if (!input.expirationDate || input.verificationStatus === "not_provided") return "not_provided";
  if (input.verificationStatus !== "staff_verified") return "unverified";
  if (input.expirationDate < input.currentBusinessDate) return "expired";
  return input.expirationDate < input.appointmentLocalDate
    ? "expires_before_appointment"
    : "valid_for_appointment";
}
