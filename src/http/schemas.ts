import { z } from "zod";
import { passwordSchema } from "../security/passwords.js";
import { rabiesVerificationMethods, rabiesVerificationStatuses } from "../domain/rabies.js";
import {pricingClasses,weightTiers} from "../domain/pricing.js";

export const idParams = z.object({ id: z.string().uuid() });

export const signupSchema = z.object({
  email: z.string().email().max(320),
  password: passwordSchema,
  businessName: z.string().trim().min(2).max(120),
  timezone: z.string().trim().min(1).max(80).default("America/Los_Angeles")
});

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024)
});

export const passwordResetRequestSchema = z.object({
  email: z.string().email().max(320)
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema
});

export const invitationSchema = z.object({
  email: z.string().email().max(320),
  permissions: z.array(z.enum([
    "calendar.view", "appointments.view", "appointments.create", "appointments.edit",
    "appointments.cancel", "appointments.override_conflict",
    "customers.view", "customers.edit", "pets.view", "pets.edit",
    "pets.care.view", "pets.care.edit", "operations.check_in",
    "operations.perform_service", "operations.complete", "checkout.perform",
    "payments.view", "discounts.apply", "services.manage", "team.manage",
    "reports.view", "settings.manage"
  ])).default([])
});

export const invitationAcceptSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(1).max(1024)
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

const petBaseSchema = z.object({
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
  rabiesVaccinationDate: z.string().date().nullish(),
  rabiesCertificateReference: z.string().trim().max(200).nullish(),
  rabiesVerificationStatus: z.enum(rabiesVerificationStatuses).optional(),
  rabiesVerificationMethod: z.enum(rabiesVerificationMethods).nullish(),
  rabiesVerificationDate: z.string().date().nullish(),
  photoPermission: z.boolean().nullish()
});

function validateRabiesDates(value: {
  rabiesVaccinationDate?:string|null|undefined;vaccinationExpiresOn?:string|null|undefined;
  rabiesVerificationStatus?:"not_provided"|"unverified"|"staff_verified"|undefined;
  rabiesVerificationMethod?:(typeof rabiesVerificationMethods)[number]|null|undefined;
}, context:z.RefinementCtx) {
  if (value.rabiesVaccinationDate && value.vaccinationExpiresOn
      && value.vaccinationExpiresOn < value.rabiesVaccinationDate) {
    context.addIssue({code:"custom",path:["vaccinationExpiresOn"],message:"Expiration cannot precede vaccination"});
  }
}

export const petSchema = petBaseSchema.superRefine(validateRabiesDates);

export const petProfileUpdateSchema = petBaseSchema.omit({
  safetyAlerts: true,
  medicalNotes: true,
  behaviorNotes: true,
  emergencyContact: true,
  veterinarian: true,
  vaccinationNotes: true,
  vaccinationExpiresOn: true
}).extend({
  version: z.number().int().positive()
});

export const petCareUpdateSchema = petBaseSchema.pick({
  safetyAlerts: true,
  medicalNotes: true,
  behaviorNotes: true,
  emergencyContact: true,
  veterinarian: true,
  vaccinationNotes: true,
  vaccinationExpiresOn: true,
  rabiesVaccinationDate: true,
  rabiesCertificateReference: true,
  rabiesVerificationStatus: true,
  rabiesVerificationMethod: true,
  rabiesVerificationDate: true
}).partial().extend({
  version: z.number().int().positive()
}).strict().superRefine(validateRabiesDates).refine(
  (value) => Object.keys(value).some((key) => key !== "version"),
  { message: "At least one protected safety field is required" }
);

export const serviceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullish(),
  baseDurationMinutes: z.number().int().positive().max(1440),
  basePriceMinor: z.number().int().nonnegative().max(100_000_000),
  category:z.enum(["GENERAL","DOG_BASE","DOG_ADDON","A_LA_CARTE","CAT"]).default("GENERAL"),
  pricingMode:z.enum(["FIXED","TIERED","WEIGHT_TIER","SERVICE_TYPE_FIXED","QUOTE_REQUIRED","RANGE"]).default("FIXED"),
  rangeMaxMinor:z.number().int().nonnegative().max(100_000_000).nullish(),
  priceConfirmationRequired:z.boolean().default(false),
  active:z.boolean().default(true)
});

export const servicePricingSchema=z.object({prices:z.array(z.object({
  pricingClass:z.enum(pricingClasses),weightTierCode:z.enum(weightTiers.map(tier=>tier.code) as ["TIER_1","TIER_2","TIER_3","TIER_4","TIER_5","TIER_6"]),
  priceMinor:z.number().int().nonnegative().max(100_000_000)
})).min(1).max(18)}).strict();

export const breedCatalogCreateSchema=z.object({name:z.string().trim().min(1).max(100),defaultPricingClass:z.enum(pricingClasses).default("STANDARD")}).strict();
export const breedCatalogUpdateSchema=z.object({name:z.string().trim().min(1).max(100).optional(),defaultPricingClass:z.enum(pricingClasses).optional(),active:z.boolean().optional()}).strict().refine(value=>Object.keys(value).length>0,{message:"At least one change is required"});
export const priceResolutionSchema=z.object({petId:z.string().uuid(),serviceIds:z.array(z.string().uuid()).min(1).max(30)}).strict();

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
  localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  disambiguation: z.enum(["earlier", "later"]).optional(),
  expectedLocationVersion: z.number().int().positive(),
  serviceIds: z.array(z.string().uuid()).min(1),
  notes: z.string().max(5000).nullish(),
  availabilityOverride: z.boolean().default(false),
  overrideConflict: z.boolean().default(false),
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
  expectedBalanceMinor: z.number().int().nonnegative(),
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
  reminderLeadMinutes: z.number().int().min(0).max(60 * 24 * 30),
  locationVersion: z.number().int().positive()
});

export const workingHoursSchema = z.object({
  hours: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  }).refine((period)=>period.startTime<period.endTime,{
    message:"Working hours must start before they end"
  })).max(7)
});

export const blockedTimeSchema = z.object({
  employeeId: z.string().uuid(),
  locationId: z.string().uuid(),
  localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  localEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  startDisambiguation: z.enum(["earlier", "later"]).optional(),
  endDisambiguation: z.enum(["earlier", "later"]).optional(),
  expectedLocationVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500)
});

export const operationalUpdateSchema = z.object({
  operationalNotes: z.string().max(10_000).nullish(),
  version: z.number().int().positive().optional()
});

export const appointmentMoveSchema = z.object({
  employeeId: z.string().uuid(),
  localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  disambiguation: z.enum(["earlier", "later"]).optional(),
  expectedLocationVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  availabilityOverride: z.boolean().default(false),
  overrideConflict: z.boolean().default(false),
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
