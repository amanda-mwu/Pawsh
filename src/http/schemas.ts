import { z } from "zod";

export const idParams = z.object({ id: z.string().uuid() });

export const signupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(200),
  businessName: z.string().trim().min(2).max(120),
  timezone: z.string().trim().min(1).max(80).default("America/Los_Angeles")
});

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200)
});

export const passwordResetRequestSchema = z.object({
  email: z.string().email().max(320)
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(200)
});

export const invitationSchema = z.object({
  email: z.string().email().max(320),
  permissions: z.array(z.enum([
    "calendar.view", "appointments.view", "appointments.create", "appointments.edit",
    "appointments.cancel", "customers.view", "customers.edit", "pets.view", "pets.edit",
    "pets.safety.view", "pets.safety.edit", "operations.check_in",
    "operations.perform_service", "operations.complete", "checkout.perform",
    "payments.view", "discounts.apply", "services.manage", "team.manage",
    "reports.view", "settings.manage"
  ])).default([])
});

export const invitationAcceptSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(200)
});

export const ownershipTransferSchema = z.object({
  membershipId: z.string().uuid()
});

export const customerSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(40).nullish(),
  email: z.string().email().max(320).nullish(),
  address: z.string().trim().max(500).nullish(),
  preferredContactMethod: z.enum(["email", "phone", "none"]).default("email"),
  emailAllowed: z.boolean().default(true),
  notes: z.string().max(5000).nullish()
});

export const petSchema = z.object({
  customerId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  species: z.string().trim().min(1).max(60).default("dog"),
  breed: z.string().trim().max(100).nullish(),
  dateOfBirth: z.string().date().nullish(),
  approximateAge: z.string().trim().max(50).nullish(),
  weightOunces: z.number().int().nonnegative().nullish(),
  sex: z.string().trim().max(30).nullish(),
  coatNotes: z.string().max(5000).nullish(),
  groomingPreferences: z.string().max(5000).nullish(),
  behaviorNotes: z.string().max(5000).nullish(),
  medicalNotes: z.string().max(5000).nullish(),
  safetyAlerts: z.string().max(5000).nullish(),
  emergencyContact: z.string().max(500).nullish(),
  veterinarian: z.string().max(500).nullish(),
  vaccinationNotes: z.string().max(2000).nullish(),
  vaccinationExpiresOn: z.string().date().nullish(),
  photoPermission: z.boolean().nullish()
});

export const serviceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullish(),
  baseDurationMinutes: z.number().int().positive().max(1440),
  basePriceMinor: z.number().int().nonnegative().max(100_000_000)
});

export const employeeSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  membershipId: z.string().uuid().nullish(),
  serviceIds: z.array(z.string().uuid()).default([])
});

export const appointmentSchema = z.object({
  locationId: z.string().uuid(),
  customerId: z.string().uuid(),
  petId: z.string().uuid(),
  employeeId: z.string().uuid(),
  startAt: z.string().datetime({ offset: true }),
  serviceIds: z.array(z.string().uuid()).min(1),
  notes: z.string().max(5000).nullish(),
  availabilityOverride: z.boolean().default(false),
  overrideReason: z.string().trim().min(3).max(500).nullish()
}).superRefine((value, context) => {
  if (value.availabilityOverride && !value.overrideReason) {
    context.addIssue({ code: "custom", path: ["overrideReason"], message: "Override reason is required" });
  }
});

export const transitionSchema = z.object({
  status: z.enum(["checked_in", "in_service", "completed", "cancelled", "no_show"]),
  reason: z.string().trim().max(500).nullish(),
  version: z.number().int().positive().optional()
});

export const checkoutSchema = z.object({
  discountMinor: z.number().int().nonnegative().default(0),
  discountType: z.string().trim().max(80).nullish(),
  tipMinor: z.number().int().nonnegative().default(0)
});

export const paymentSchema = z.object({
  amountMinor: z.number().int().positive(),
  method: z.enum(["cash", "external_card", "check", "other"]),
  externalReference: z.string().trim().max(200).nullish()
});

export const businessSettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(40).nullish(),
  email: z.string().email().max(320).nullish(),
  timezone: z.string().trim().min(1).max(80),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  taxRateBasisPoints: z.number().int().min(0).max(10_000),
  reminderLeadMinutes: z.number().int().min(0).max(60 * 24 * 30)
});

export const workingHoursSchema = z.object({
  hours: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    startTime: z.string().regex(/^\d\d:\d\d$/),
    endTime: z.string().regex(/^\d\d:\d\d$/)
  })).max(7)
});

export const blockedTimeSchema = z.object({
  employeeId: z.string().uuid(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500)
}).refine((value) => new Date(value.startAt) < new Date(value.endAt), {
  message: "Blocked time must end after it starts"
});

export const operationalUpdateSchema = z.object({
  operationalNotes: z.string().max(10_000).nullish(),
  version: z.number().int().positive().optional()
});

export const appointmentMoveSchema = z.object({
  employeeId: z.string().uuid(),
  startAt: z.string().datetime({ offset: true }),
  version: z.number().int().positive(),
  availabilityOverride: z.boolean().default(false),
  overrideReason: z.string().trim().min(3).max(500).nullish()
}).superRefine((value, context) => {
  if (value.availabilityOverride && !value.overrideReason) {
    context.addIssue({ code: "custom", path: ["overrideReason"], message: "Override reason is required" });
  }
});

export const appointmentServicesSchema = z.object({
  serviceIds: z.array(z.string().uuid()).min(1),
  version: z.number().int().positive().optional()
});

export const voidPaymentSchema = z.object({
  reason: z.string().trim().min(3).max(500)
});

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizePhone(value?: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\D/g, "");
  return normalized || null;
}
