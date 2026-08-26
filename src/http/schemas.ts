import { z } from "zod";
import { passwordSchema } from "../security/passwords.js";
import { rabiesVerificationMethods, rabiesVerificationStatuses } from "@pawsh/domain";
import { petHealthIssues } from "@pawsh/domain";
import { permissions } from "@pawsh/domain";
import {pricingClasses,weightTiers} from "@pawsh/domain";

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
}).strict();

export const ownProfileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120)
}).strict();

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordSchema
}).strict();

export const invitationSchema = z.object({
  email: z.string().email().max(320),
  // Read from the domain tuple rather than restated here, so a new permission cannot be grantable
  // by the authorization layer while silently rejected at the invitation boundary.
  permissions: z.array(z.enum(permissions)).default([])
});

export const invitationAcceptSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(1).max(1024)
});

export const ownershipTransferSchema = z.object({
  membershipId: z.string().uuid()
});

export const workspaceAccessRequestSchema=z.object({
  requesterName:z.string().trim().min(1).max(120),
  requesterEmail:z.string().email().max(320),
  workspaceName:z.string().trim().min(2).max(120),
  workspaceAdminEmail:z.string().email().max(320),
  message:z.string().trim().max(1000).nullish()
}).strict();

export const workspaceSelectionSchema=z.object({businessId:z.string().uuid()}).strict();
export const locationSelectionSchema=z.object({locationId:z.string().uuid()}).strict();

/**
 * A client record, which may be only partly known.
 *
 * Somebody who rings to enquire and does not book can be written down with whatever they gave —
 * often just a phone number. Names are therefore optional, and a blank one is normalised to
 * absent so the database never has to distinguish "" from unknown.
 *
 * What is required is one way to identify or reach them. A record with no name, no phone, and
 * no email cannot be found again, so saving it helps nobody.
 */
const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

export const customerSchema = z.object({
  firstName: z.preprocess(blankToNull, z.string().trim().min(1).max(80).nullish()),
  lastName: z.preprocess(blankToNull, z.string().trim().min(1).max(80).nullish()),
  phone: z.preprocess(blankToNull, z.string().trim().max(40).nullish()),
  email: z.preprocess(blankToNull, z.string().email().max(320).nullish()),
  address: z.string().trim().max(500).nullish(),
  preferredContactMethod: z.enum(["email", "phone", "none"]).default("email"),
  emailAllowed: z.boolean().default(true),
  notes: z.string().max(5000).nullish()
}).superRefine((value, context) => {
  if (!value.firstName && !value.lastName && !value.phone && !value.email) {
    context.addIssue({
      code: "custom",
      path: ["firstName"],
      message: "Enter at least a name, a phone number, or an email address"
    });
  }
});

export const customerNoteParams = z.object({
  id: z.string().uuid(),
  noteId: z.string().uuid()
});

// The thread is the source of truth for client notes; `pinned` is the stored name for the
// note flag the reference profile renders as a "popup" note.
export const customerNoteCreateSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  pinned: z.boolean().default(false)
}).strict();

export const customerNoteUpdateSchema = z.object({
  body: z.string().trim().min(1).max(5000).optional(),
  pinned: z.boolean().optional()
}).strict().refine(
  (value) => value.body !== undefined || value.pinned !== undefined,
  { message: "At least one note change is required" }
);

export const customerNoteQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50)
}).strict();

// Partial by design: the client profile toggles switches one at a time, and a full-object
// PUT would let a caller that does not know about a switch silently reset it.
// `emailAllowed` is the existing marketing-email column surfaced here, not a new one.
export const customerPreferencesSchema = z.object({
  bookingFrequencyWeeks: z.number().int().min(1).max(104).nullable().optional(),
  blockMessages: z.boolean().optional(),
  blockOnlineBooking: z.boolean().optional(),
  marketingSmsAllowed: z.boolean().optional(),
  emailAllowed: z.boolean().optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one preference is required" }
);

// ---------------------------------------------------------------------------
// Client addresses and contacts
//
// Both lists carry exactly one primary. A record that says it is primary makes the one that
// was primary step down, done in the same transaction rather than left to the caller.
// ---------------------------------------------------------------------------

export const customerChildParams = z.object({
  id: z.string().uuid(),
  childId: z.string().uuid()
});

export const customerAddressCreateSchema = z.object({
  address: z.string().trim().min(1).max(500),
  label: z.preprocess(blankToNull, z.string().trim().min(1).max(60).nullish()),
  isPrimary: z.boolean().default(false)
}).strict();

export const customerAddressUpdateSchema = customerAddressCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one address change is required" }
);

export const customerContactCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(1).max(40),
  title: z.preprocess(blankToNull, z.string().trim().min(1).max(80).nullish()),
  // Recorded now so the salon is not asked again once something reads it. Nothing does today.
  receivesAutomatedMessages: z.boolean().default(true),
  isPrimary: z.boolean().default(false)
}).strict();

export const customerContactUpdateSchema = customerContactCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one contact change is required" }
);

// ---------------------------------------------------------------------------
// Client agreements
// ---------------------------------------------------------------------------

export const customerAgreementParams = z.object({
  id: z.string().uuid(),
  templateId: z.string().uuid()
});

export const agreementTemplateCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20_000),
  required: z.boolean().default(false),
  active: z.boolean().default(true)
}).strict();

// Partial by design, like the other settings-owned records: a caller that does
// not know about `required` must not be able to silently clear it.
export const agreementTemplateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(20_000).optional(),
  required: z.boolean().optional(),
  active: z.boolean().optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one template change is required" }
);

export const agreementTemplateQuerySchema = z.object({
  status: z.enum(["active", "inactive", "all"]).default("active")
}).strict();

/**
 * A staff-recorded signature, not an e-signature: the name the client gave, when
 * they gave it, and an optional note about how it was collected. `signedAt` may
 * be backdated (paper form signed at the counter yesterday) but never postdated.
 */
export const agreementSignatureSchema = z.object({
  signedName: z.string().trim().min(1).max(120),
  signedAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(500).nullish()
}).strict().superRefine((value, context) => {
  if (!value.signedAt) return;
  const signed = Date.parse(value.signedAt);
  if (signed > Date.now() + 60_000) {
    context.addIssue({ code: "custom", path: ["signedAt"], message: "A signature cannot be recorded in the future" });
  }
  if (signed < Date.parse("2000-01-01T00:00:00.000Z")) {
    context.addIssue({ code: "custom", path: ["signedAt"], message: "Signature date is out of range" });
  }
});

/**
 * `channel` accepts "sms" so the API can answer the question honestly instead of
 * failing schema validation with a generic message. Pawsh has no SMS transport,
 * so the handler refuses it with an explicit reason and the supported channel list.
 */
export const agreementSendSchema = z.object({
  templateIds: z.array(z.string().uuid()).min(1).max(25),
  channel: z.enum(["email", "sms"]).default("email")
}).strict();

/**
 * Sending a vaccination reminder before the appointment exists.
 *
 * The booking flow can tell a client their rabies record will have lapsed by the date
 * being booked, and that warning is worth sending before the appointment is committed.
 * There is no appointment row to hang the reminder on at that point, so the caller
 * supplies the date it is warning about. `channel` accepts "sms" for the same reason
 * the agreement send does: the handler answers with a named, explained refusal rather
 * than a generic schema failure.
 */
export const vaccinationReminderSchema = z.object({
  appointmentLocalDate: z.string().date(),
  channel: z.enum(["email", "sms"]).default("email")
}).strict();

/**
 * Report cards.
 *
 * A card stores only the note somebody wrote; the visit, services, groomer, and photographs are
 * read from the appointment when the card is rendered. `version` is required on update for the
 * same reason it is on appointments and pets: two people with the card open must not silently
 * overwrite each other.
 */
export const reportCardCreateSchema = z.object({
  petId: z.string().uuid(),
  note: z.string().trim().max(4000).nullish()
}).strict();

export const reportCardUpdateSchema = z.object({
  note: z.string().trim().max(4000).nullish(),
  version: z.number().int().positive()
}).strict();

// "sms" is accepted so the handler can refuse it by name with a reason, exactly as the agreement
// send does, instead of failing schema validation with something generic.
export const reportCardSendSchema = z.object({
  channel: z.enum(["email", "sms"]).default("email")
}).strict();

const petBaseSchema = z.object({
  customerId: z.string().uuid(),
  // Optional for the same reason a client's name is: an enquiry often gives the breed and not
  // the pet's name, and a record saying "a Goldendoodle" is more use than one saying "?".
  name: z.preprocess(blankToNull, z.string().trim().min(1).max(80).nullish()),
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
  photoPermission: z.boolean().nullish(),

  // Unknown and "not a mix" are different answers, so this stays nullable.
  mixedBreed: z.boolean().nullish(),
  hairLength: z.string().trim().max(60).nullish(),
  coatColor: z.string().trim().max(60).nullish(),
  // Spayed and neutered also say which sex the pet is; a boolean would lose that.
  fixedStatus: z.enum(["spayed", "neutered", "intact"]).nullish(),
  preferredShampoo: z.string().trim().max(120).nullish(),
  // An estimate the salon was told, kept beside `dateOfBirth` rather than collapsed into a
  // fabricated birthday that would be indistinguishable from one the owner actually stated.
  approximateAgeYears: z.number().int().min(0).max(60).nullish(),
  approximateAgeMonths: z.number().int().min(0).max(11).nullish(),

  // Absent means nobody has been asked; an empty list means somebody was asked and there is
  // nothing to report. Rabies is deliberately not in the vocabulary — it has an authoritative
  // home already, and a second unverified answer is the one thing compliance cannot afford.
  healthIssues: z.array(z.enum(petHealthIssues)).max(petHealthIssues.length).nullish(),
  vetName: z.string().trim().max(120).nullish(),
  vetPhone: z.string().trim().max(40).nullish(),
  vetContactName: z.string().trim().max(120).nullish(),
  vetContactPhone: z.string().trim().max(40).nullish(),
  vetAddress: z.string().trim().max(500).nullish()
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
  healthIssues: true,
  vetName: true,
  vetPhone: true,
  vetContactName: true,
  vetContactPhone: true,
  vetAddress: true,
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

export const petNoteParams = z.object({
  id: z.string().uuid(),
  noteId: z.string().uuid()
});

export const petPhotoUploadMetadataSchema = z.object({
  uploadRequestId: z.string().uuid(),
  // A photograph taken specifically to be the portrait says so; otherwise only the first one
  // promotes itself, so a gallery never quietly changes the face on the profile.
  useAsAvatar: z.boolean().default(false)
}).strict();

export const petAvatarSchema = z.object({
  photoId: z.string().uuid().nullable()
}).strict();

/**
 * Vaccinations other than rabies.
 *
 * Rabies is refused by both this schema's handler and a database constraint. It is recorded on
 * the pet and in its documents, where the expiry drives appointment eligibility; a second record
 * claiming a different date would make the compliance answer ambiguous.
 */
export const petVaccinationCreateSchema = z.object({
  vaccine: z.string().trim().min(1).max(80),
  expiresOn: z.string().date().nullish(),
  notes: z.string().trim().max(2000).nullish()
}).strict();

export const petVaccinationUpdateSchema = z.object({
  vaccine: z.string().trim().min(1).max(80).optional(),
  expiresOn: z.string().date().nullish(),
  notes: z.string().trim().max(2000).nullish(),
  version: z.number().int().positive()
}).strict();

export const petDeceasedSchema = z.object({
  deceased: z.boolean()
}).strict();

export const petCareUpdateSchema = petBaseSchema.pick({
  healthIssues: true,
  vetName: true,
  vetPhone: true,
  vetContactName: true,
  vetContactPhone: true,
  vetAddress: true,
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
  employeeIds: z.array(z.string().uuid()).min(1).max(20).optional(),
  localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  disambiguation: z.enum(["earlier", "later"]).optional(),
  expectedLocationVersion: z.number().int().positive(),
  serviceIds: z.array(z.string().uuid()).min(1),
  notes: z.string().max(5000).nullish(),
  availabilityOverride: z.boolean().default(false),
  overrideConflict: z.boolean().default(false),
  overrideReason: z.string().trim().min(3).max(500).nullish()
}).superRefine((value, context) => {
  if (value.employeeIds) context.addIssue({code:"custom",path:["employeeIds"],message:"An appointment can only be assigned to one groomer."});
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
  employeeIds: z.array(z.string().uuid()).min(1).max(20).optional(),
  localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  disambiguation: z.enum(["earlier", "later"]).optional(),
  expectedLocationVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  availabilityOverride: z.boolean().default(false),
  overrideConflict: z.boolean().default(false),
  overrideReason: z.string().trim().min(3).max(500).nullish()
}).superRefine((value, context) => {
  if (value.employeeIds) context.addIssue({code:"custom",path:["employeeIds"],message:"An appointment can only be assigned to one groomer."});
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
