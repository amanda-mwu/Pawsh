import { z } from "zod";
import { passwordSchema } from "../security/passwords.js";
import { rabiesVerificationMethods, rabiesVerificationStatuses } from "@pawsh/domain";
import { petHealthIssues } from "@pawsh/domain";
import { permissions, type Permission } from "@pawsh/domain";
import {pricingClasses,weightTiers} from "@pawsh/domain";
import {cardProcessorProviders,paymentMethods} from "@pawsh/domain";
import {groomerPaletteSize} from "@pawsh/domain";
import {isSupportedCurrency,supportedCurrencies} from "@pawsh/domain";
import {appointmentLockModes,businessTypes,couponStackingModes,dateFormats,hourFormats,weightUnits,upcomingAppointmentCountMax} from "@pawsh/domain";

export const idParams = z.object({ id: z.string().uuid() });
export const locationParams = z.object({ locationId: z.string().uuid() });

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

/**
 * Inviting somebody to the workspace.
 *
 * An invitation names a ROLE. What the person arrives holding is the role as it stands on the day
 * they ACCEPT, not a snapshot taken when the invitation was written - so tightening a role also
 * tightens every invitation still outstanding against it, which is the only behaviour that cannot
 * quietly hand somebody the looser set they were offered last week.
 *
 * The old `{ email, permissions }` shape is gone along with the column it wrote to. There is no
 * transitional arm left: `membership_invitations.permissions` no longer exists, so an invitation
 * that named a permission list would have nowhere to put it and the membership it created would
 * resolve to the empty set.
 */
export const invitationSchema = z.object({
  email: z.string().email().max(320),
  roleId: z.string().uuid()
}).strict();

/**
 * Approving a workspace access request.
 *
 * `roleId` is REQUIRED, and that is the point of the endpoint changing at all. It used to grant
 * the Groomer preset silently - a decision nobody made, taken on behalf of an owner who was only
 * told they were approving somebody. Naming the role makes the grant visible at the moment it is
 * made, which is what roles exist for.
 */
export const workspaceAccessApprovalSchema = z.object({
  roleId: z.string().uuid()
}).strict();

export const invitationAcceptSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(1).max(1024)
});

/**
 * Transferring ownership.
 *
 * `outgoingOwnerRoleId` IS REQUIRED, AND THERE IS DELIBERATELY NO DEFAULT.
 *
 * Ownership transfer is the one action that turns an owner into a non-owner, and a non-owner's
 * only grant is their role. So the transfer has to say what the founder keeps. Every alternative
 * is worse: falling through to no role would resolve to the EMPTY SET and lock them out of the
 * workspace they built, by an action that never mentioned permissions; auto-minting a "Former
 * owner" role would invent an access level nobody chose; and silently copying the full permission
 * tuple would hand a demoted owner everything except the name, which is the opposite of demoting
 * them. The person performing the transfer states what the outgoing owner keeps, and if they will
 * not state it the transfer does not happen.
 *
 * The role is validated against the caller's own business and applied in the SAME TRANSACTION that
 * clears `is_owner`, so there is no instant at which the outgoing owner resolves to nothing.
 */
export const ownershipTransferSchema = z.object({
  membershipId: z.string().uuid(),
  outgoingOwnerRoleId: z.string().uuid()
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

/**
 * Creating a role.
 *
 * A new role starts with NO permissions unless it is copied from an existing one. That is the
 * safe default in both directions: an owner who creates "Front desk" and walks away has granted
 * nobody anything, and an owner who meant to copy said so. `copyFromRoleId` is resolved
 * server-side against the caller's own business, so it can never seed a role from another
 * tenant's - the lookup carries the business predicate, not the client.
 */
export const roleCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.preprocess(blankToNull, z.string().trim().max(500).nullish()),
  copyFromRoleId: z.string().uuid().nullish()
}).strict();

/**
 * Editing a role, field by field, under optimistic concurrency.
 *
 * `version` is REQUIRED and every other field is optional, which is the same shape location
 * settings use (`locationVersion`). Two owners editing one role in two tabs must not silently
 * overwrite each other, and permissions are the last place in the product where a lost update is
 * acceptable: the loser's tab would report success while having quietly restored whatever the
 * winner just removed.
 *
 * ABSENCE IS DISTINCT FROM AN EXPLICIT VALUE. Omitting `permissions` leaves them alone; sending
 * `[]` revokes everything the role grants. `description` accepts null to clear it. `permissions`
 * is validated against the domain tuple rather than a list restated here, so a permission cannot
 * be grantable through this endpoint while unknown to the authorization layer.
 */
/**
 * ONE PERMISSION KEY, checked against the domain tuple.
 *
 * The membership test is `z.enum(permissions)`'s, and the reason this is not written that way is
 * the failure body. Zod's `invalid_value` issue carries the full `values` array, and
 * `app.setErrorHandler` sends the ZodError as `details` - so one misspelt permission answered
 * with roughly 4KB enumerating all 101 valid keys, most of a response spent restating a catalog
 * the client can already fetch from `GET /api/permissions`. Naming a custom error keeps the
 * message short but not the issue: `values` is on the issue object regardless. So the check is
 * expressed as set membership, which fails in about 170 bytes and says the same thing.
 *
 * The set is DERIVED from the tuple, never restated, so a permission cannot become grantable
 * through this endpoint while being unknown to the authorization layer.
 */
const permissionKeys = new Set<string>(permissions);
const permissionKey = z.custom<Permission>(
  (value) => typeof value === "string" && permissionKeys.has(value),
  { error: "Unknown permission" }
);

export const roleUpdateSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.preprocess(blankToNull, z.string().trim().max(500).nullable()).optional(),
  enabled: z.boolean().optional(),
  permissions: z.array(permissionKey).optional()
}).strict();

/**
 * Assigning a member to a role.
 *
 * `roleId` is required and may not be null. "No role" is not an access level a person can be put
 * on: it is the transitional state migration 0041 emptied, and it resolves to the membership's
 * own legacy column - which stops existing. An owner who wants a member to have nothing assigns
 * them a role that grants nothing, which is a decision written down rather than an absence.
 */
export const memberRoleSchema = z.object({
  roleId: z.string().uuid()
}).strict();

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
  // Canonical taxonomy. `petTypeId`/`breedId` are the authority; `breed` stays for legacy
  // callers and as the display mirror, and `breedOther` records a deliberate "Other" so a
  // typo can never be mistaken for one.
  petTypeId: z.string().uuid().nullish(),
  breedId: z.string().uuid().nullish(),
  breedOther: z.string().trim().min(1).max(120).nullish(),
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

export const petTypeParams=z.object({petTypeId:z.string().uuid()});
export const breedParams=z.object({breedId:z.string().uuid()});

// What one salon thinks about a canonical breed.
//
// Absent and null mean different things on purpose. An ABSENT field is left exactly as stored;
// an explicit NULL clears that override and returns the field to the Pawsh default. Without the
// distinction a caller editing only the pricing class would have to resend `active`, and
// resending it at its current effective value would silently pin a field that was previously
// just following the shared taxonomy - so the breed would stop tracking Pawsh without anyone
// choosing that.
export const breedSettingsSchema=z.object({
  pricingClass:z.enum(pricingClasses).nullable().optional(),
  active:z.boolean().nullable().optional()
}).strict().refine(
  (value)=>value.pricingClass!==undefined||value.active!==undefined,
  { message:"At least one breed setting is required" }
);
// A breed this business adds for itself. `pricingClass` is optional because the overwhelmingly
// common case is a breed that prices like everything else; omitting it stores STANDARD, which
// is what a pet with no resolvable breed already resolves to, so adding a breed can never move
// a price on its own.
export const breedCreateSchema=z.object({
  // 120 matches `pets.breed_other`, the other place a human types a breed name.
  name:z.string().trim().min(1).max(120),
  pricingClass:z.enum(pricingClasses).optional()
}).strict();

// Renaming is the ONLY field a business may change on the breed row itself, and only on a breed it
// owns. Pricing class and availability continue to go through `breedSettingsSchema` for every
// breed alike, so there is exactly one write path per field and no way for two of them to
// disagree about which value wins.
export const breedRenameSchema=z.object({
  name:z.string().trim().min(1).max(120)
}).strict();

export const priceResolutionSchema=z.object({petId:z.string().uuid(),serviceIds:z.array(z.string().uuid()).min(1).max(30)}).strict();

/**
 * The calendar identity colour a groomer is assigned, or null for "use the hash".
 *
 * The database check is the durable outer bound (0-15). THIS is where the palette's real size is
 * enforced, against the same `groomerPaletteSize` the web and mobile clients render from, so
 * adding a colour is a one-line change in `packages/domain` and never a migration. Null is not a
 * missing value: it means "keep the hash-derived slot", which is what every existing employee has.
 *
 * The bound is the PALETTE, deliberately not `groomerHashSlotCount`. The hash may only ever deal
 * the first five colours, because widening its modulus recolours everyone who has not been
 * assigned one; the other five are reachable only by an operator choosing them here.
 */
const colorSlotField = z.number().int().min(0).max(groomerPaletteSize - 1);

/**
 * A staff phone number, for the record only. Nothing dials or texts it - Pawsh has no SMS channel.
 *
 * Validated exactly like `customerSchema.phone` so the codebase has one phone convention: a blank
 * string is a cleared field rather than a validation error, and the stored text is capped at the
 * same 40 characters the column allows. The digits-only form is derived server-side by
 * `normalizePhone`, never accepted from the client.
 */
const staffPhoneField = z.preprocess(blankToNull, z.string().trim().max(40).nullish());

/**
 * Creating a team member.
 *
 * `serviceIds` defaults to the empty set because the overwhelmingly common case is a groomer who
 * does everything the salon offers; an empty set is "no restriction", not "restricted to nothing".
 *
 * `membershipId` LINKS an existing workspace account; it never grants one. Membership and
 * permissions are created in Settings -> Permissions and nowhere else.
 */
export const employeeSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  membershipId: z.string().uuid().nullish(),
  serviceIds: z.array(z.string().uuid()).default([]),
  colorSlot: colorSlotField.nullish(),
  phone: staffPhoneField
});

/**
 * Editing a team member, field by field.
 *
 * THIS IS A MERGE, NOT A REPLACE, AND THE DIFFERENCE IS NOT COSMETIC. `employeeSchema` defaults
 * `serviceIds` to `[]` and treats an absent `membershipId` as null, so reusing it for PUT turned
 * every partial edit into a full overwrite: the web editor sends `{displayName}` alone, so
 * renaming a groomer cleared `employees.membership_id` and deleted every one of their
 * `employee_services` rows. `membership_id` is the join behind report-card author, agreement
 * signer, rabies verifier, photo uploader, note author, actor attribution and the mobile app's
 * "which groomer am I", so a rename silently detached a person from their own work history.
 *
 * Every field is therefore optional and ABSENCE IS DISTINCT FROM AN EXPLICIT VALUE:
 *
 *   membershipId omitted  -> the stored link is left exactly as it is
 *   membershipId: null    -> the operator is unlinking the account, on purpose
 *   serviceIds omitted    -> the stored restriction is left exactly as it is
 *   serviceIds: []        -> the operator is clearing the restriction, on purpose
 *   colorSlot omitted     -> the stored colour is left exactly as it is
 *   colorSlot: null       -> back to the hash-derived colour, on purpose
 *   phone omitted         -> the stored number is left exactly as it is
 *   phone: null or ""     -> the operator is clearing the number, on purpose
 *   active omitted        -> the employee stays as active or inactive as they were
 *   active: true / false  -> the operator moved the Active switch, on purpose
 *
 * `active` is here because `DELETE /api/employees/:id` soft-deactivates and nothing could undo
 * it: a deactivated groomer could not be brought back through the API at all. DELETE is left
 * exactly as it is - it is the deactivation path existing clients already call - so there are now
 * two ways to deactivate and one way to reactivate, which is the right trade against changing a
 * route other code depends on. It is NOT a second activation concept: both write the same
 * `employees.active` column, and availability remains the only owner of WHEN a groomer is
 * bookable.
 *
 * `.strict()` is deliberate: a client that misspells a field must be told, rather than have the
 * request silently succeed while changing nothing.
 */
export const employeeUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  membershipId: z.string().uuid().nullable().optional(),
  serviceIds: z.array(z.string().uuid()).optional(),
  colorSlot: colorSlotField.nullable().optional(),
  phone: z.preprocess(blankToNull, z.string().trim().max(40).nullable().optional()),
  active: z.boolean().optional()
}).strict().refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  { message: "At least one team member field is required" }
);

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

/**
 * A currency the workspace may be switched to.
 *
 * The list, and the reason it is a list rather than "any ISO 4217 code", live in
 * `@pawsh/domain`'s `currency.ts`: every Pawsh amount is minor units divided by exactly one
 * hundred, so a currency with any other exponent would put wrong numbers on invoices. The set is
 * DERIVED from the tuple, never restated, in the same way `permissionKey` derives from
 * `permissions` - a code cannot become settable here while being unrenderable everywhere else.
 */
const currencyCode = z.string().trim().length(3)
  .transform((value) => value.toUpperCase())
  .refine(isSupportedCurrency, {
    error: `Unsupported currency. Pawsh supports ${supportedCurrencies.join(", ")}.`
  });

/**
 * Settings -> Business, saved as a MERGE over the stored record.
 *
 * ABSENCE IS DISTINCT FROM AN EXPLICIT VALUE, and the distinction is not cosmetic. `phone` and
 * `email` were `nullish()` while the handler wrote `input.phone ?? null` unconditionally, so a
 * client that sent neither - which is every client that exists - cleared both columns on every
 * save. Renaming the salon silently erased its contact details. Those two columns are not
 * decoration: `businesses.email` is one of the two identities
 * `POST /api/workspace-access-requests` matches a workspace administrator on, and the pair is the
 * "contact us" line on rabies notices, agreement requests and report cards. See the note above
 * the handler.
 *
 *   phone omitted        -> the stored number is left exactly as it is
 *   phone: null or ""    -> the operator is clearing the number, on purpose
 *   email omitted        -> the stored address is left exactly as it is
 *   email: null or ""    -> the operator is clearing the address, on purpose
 *   address omitted      -> the stored address line is left exactly as it is
 *   address: null or ""  -> the operator is clearing the address line, on purpose
 *   currency omitted     -> the stored currency is left exactly as it is
 *
 * This mirrors `employeeUpdateSchema`, which carries the same treatment for the same reason after
 * the same class of defect. `name`, `timezone`, `taxRateBasisPoints`, `reminderLeadMinutes` and
 * `locationVersion` stay REQUIRED: every existing caller sends all five, `timezone` drives the
 * confirm the client raises before a change, and `locationVersion` is the optimistic-concurrency
 * token the handler refuses a stale save on.
 *
 * `currency` is optional rather than required so a workspace still holding a value from before
 * `currencyCode` existed is not locked out of editing its own name - only a caller that actually
 * operates the picker is held to the supported list.
 *
 * `address` is `locations.address`, a single free-text line, matching the convention
 * `customer_addresses` set in 0025. Pawsh has no structured address anywhere and no need of one:
 * nothing geocodes, routes, or validates a postcode.
 */
/**
 * A link an operator typed, normalised and made safe to render.
 *
 * TWO THINGS HAPPEN HERE AND BOTH MATTER.
 *
 * The PROTOCOL IS RESTRICTED TO http AND https, which is a security bound rather than tidiness.
 * Zod's bare `z.url()` accepts `javascript:alert(1)` - it is a well-formed URL. These four fields
 * exist to be rendered as links, so an unrestricted one is stored XSS with the salon's own
 * settings screen as the injection point and every viewer of the workspace as the target. `data:`
 * and `vbscript:` fall to the same bound. No escaping downstream can save an `href` whose scheme
 * is the payload, so the refusal belongs here, where it can be a 400 rather than a rendered link.
 *
 * A BARE HOST IS PREFIXED with `https://`. Nobody types a scheme into a "Yelp page" box, and
 * rejecting `www.yelp.com/biz/pawsh` for the absence of eight characters is the kind of validation
 * that teaches operators the form is broken. The prefix is applied ONLY when no scheme is present
 * at all, so `javascript:alert(1)` is not quietly rescued into `https://javascript:alert(1)` - it
 * already has a scheme, keeps it, and is refused.
 *
 * 500 matches the column bound in 0047, which matches `locations.address` and
 * `customer_addresses.address`. Blank is null, the one way to say "not recorded", exactly as the
 * contact fields treat it.
 */
const withScheme = /^[a-z][a-z0-9+.-]*:/i;
const businessLink = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    return withScheme.test(trimmed) ? trimmed : `https://${trimmed}`;
  },
  z.url({ protocol: /^https?$/ }).max(500).nullable().optional()
);

/**
 * Settings -> Business: the business info card, the preferences card and the social links.
 *
 * WHY EVERY NEW FIELD IS OPTIONAL. Absence means "leave the stored value alone", which is the
 * merge contract the contact fields above already follow, and it is the only shape that does not
 * break the callers that exist today: nothing in the product sends `weightUnit` or `dateFormat`
 * yet, and a required field would turn every current save of this screen into a 400. `businessType`
 * is REQUIRED OF THE OPERATOR without being required of the request - the column is `not null`
 * with a default, so a value always exists, and the form presents a select with no empty option.
 * Requiredness that would 400 an existing client is not requiredness, it is an outage.
 *
 * WHICH FIELDS MAY BE CLEARED, AND WHICH MAY NOT. The six enum-valued preferences are `not null`
 * columns over closed sets: there is no "no weight unit". They accept a value or nothing, never
 * null. `website` and the three social links are nullable text and follow the contact-field rule -
 * omitted preserves, null or blank clears.
 *
 * `upcomingAppointmentCount` IS THE ONE FIELD WHERE NULL IS A VALUE RATHER THAN A CLEAR. Null
 * means "All", which is a real choice an operator makes and the product default besides. The
 * literal string "All" is accepted as an alias for it so a client can round-trip the value its
 * select element holds without translating; both land as null. Omission still preserves, so the
 * three cases stay distinct.
 *
 * `defaultServiceFrequencyWeeks` takes the same 1-104 bound as `customers.booking_frequency_weeks`
 * because it is the default that seeds that column on a new client. A business default outside the
 * range of the column it fills would be a setting that saves and then fails on use.
 *
 * `couponStacking` and `upcomingAppointmentCount` have NO CONSUMER TODAY and that is deliberate,
 * not an omission - see `preferences.ts`. `appointmentLock` likewise stores and returns with no
 * enforcement anywhere, pending a ruling on what it should actually refuse.
 */
export const businessSettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.preprocess(blankToNull, z.string().trim().max(40).nullable().optional()),
  email: z.preprocess(blankToNull, z.string().trim().email().max(320).nullable().optional()),
  address: z.preprocess(blankToNull, z.string().trim().min(1).max(500).nullable().optional()),
  website: businessLink,
  businessType: z.enum(businessTypes).optional(),
  timezone: z.string().trim().min(1).max(80),
  currency: currencyCode.optional(),
  taxRateBasisPoints: z.number().int().min(0).max(10_000),
  reminderLeadMinutes: z.number().int().min(0).max(60 * 24 * 30),
  dateFormat: z.enum(dateFormats).optional(),
  hourFormat: z.enum(hourFormats).optional(),
  weightUnit: z.enum(weightUnits).optional(),
  appointmentLock: z.enum(appointmentLockModes).optional(),
  couponStacking: z.enum(couponStackingModes).optional(),
  upcomingAppointmentCount: z.preprocess(
    (value) => (typeof value === "string" && value.trim().toLowerCase() === "all" ? null : value),
    z.number().int().min(1).max(upcomingAppointmentCountMax).nullable().optional()
  ),
  defaultServiceFrequencyWeeks: z.number().int().min(1).max(104).nullable().optional(),
  socialFacebook: businessLink,
  socialGoogle: businessLink,
  socialYelp: businessLink,
  locationVersion: z.number().int().positive()
});

/**
 * A weekly grid of open periods, used by both the salon's hours and a groomer's.
 *
 * The two facts a grid can get wrong - a day that ends before it starts, and the same weekday
 * listed twice - are checked by `refuseInvalidWorkingHours` in the handlers rather than here, for
 * the reason already written below about `appointmentLimit`: a schema error reads like a typo,
 * and these are not typos. Somebody dragged an end time past midnight, or ticked Tuesday twice.
 * Both are answered with their own code so a modal can say which day and why.
 *
 * The database is the durable backstop for both - `check (start_time < end_time)` and
 * `unique (location_id, weekday)` / `unique (employee_id, weekday)` in 0001 - but reaching those
 * produces a constraint violation the error handler can only render as "violates a data integrity
 * rule", or, for the ordering check, a bare 400 carrying a Postgres message. That is the wrong
 * answer to give a salon owner setting their opening times.
 */
export const workingHoursSchema = z.object({
  hours: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    // Accepted so the editor can round-trip what it read, and stored so the setting has a home.
    // The value is constrained to 1 by the handler rather than here, because a caller who asked
    // for 2 deserves a specific refusal (`LIMIT_NOT_CONFIGURABLE`) rather than a schema error
    // that reads like a typo. Concurrency above one is enforced-against by four database objects
    // and is not a setting Pawsh can currently honour - see migration 0027.
    appointmentLimit: z.number().int().min(1).max(10).default(1)
  })).max(7)
});

/** `YYYY-MM-DD`, a calendar date in the location's own timezone. */
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export const closureDayQuerySchema = z.object({
  // Both ends are required: an unbounded closure listing would grow without limit as a salon
  // records years of holidays, and no caller needs one.
  from: z.string().regex(localDatePattern),
  to: z.string().regex(localDatePattern)
}).refine((range) => range.from <= range.to, { message: "Range must end on or after it starts" });

export const closureDaysSchema = z.object({
  // The month scopes the replacement. A save publishes one month's answer and must not disturb
  // any other month, so the window it may delete within is stated by the caller rather than
  // inferred from whichever dates happen to be in the list.
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  closedDates: z.array(z.string().regex(localDatePattern)).max(31),
  reason: z.string().trim().min(1).max(500).nullish()
}).strict().refine(
  (input) => input.closedDates.every((date) => date.startsWith(`${input.month}-`)),
  { message: "Every closed date must fall inside the month being saved", path: ["closedDates"] }
);

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

/**
 * Asking for a refund.
 *
 * There is no payment id, no provider, no Square refund id and no tip field. The payment is named
 * by the path, the provider identity is read out of the payment row server side, and the split
 * between the service amount and the tip is Pawsh's decision rather than the caller's - a request
 * body that could name the tip portion would let a client refund a groomer's gratuity while
 * leaving the disputed service unrefunded.
 *
 * `expectedRefundableMinor` mirrors `expectedBalanceMinor` on a payment: it is what the screen
 * believed was still refundable, so the server can tell "this operator asked for too much" from
 * "somebody else refunded part of this while the dialog was open" and say the right sentence for
 * each. `reason` is optional and capped at Square's own 192 characters, because it is forwarded.
 */
export const paymentRefundSchema = z.object({
  amountMinor: z.number().int().positive(),
  expectedRefundableMinor: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(192).nullish()
});

// ---------------------------------------------------------------------------
// Tax and payment configuration
//
// Three things a salon configures - the tax it charges, the payment methods it offers, and the
// card processors it uses - and one it cannot: connecting a processor. Nothing here accepts a
// credential, a token or a pairing code, because Pawsh has nowhere to put one.
//
// Every bound below matches the check constraint on the column it writes, so a value the schema
// accepts is a value the database accepts, and neither is the only place the rule is stated.
// ---------------------------------------------------------------------------

export const cardProcessorFeeParams = z.object({
  id: z.string().uuid(),
  feeId: z.string().uuid()
});

export const cardProcessorTerminalParams = z.object({
  id: z.string().uuid(),
  terminalId: z.string().uuid()
});

// A configured method is a label over one of the four settlement types the ledger can tell
// apart, so `settlementType` reuses the payment enum rather than restating it.
export const paymentMethodCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  settlementType: z.enum(paymentMethods),
  enabled: z.boolean().default(true),
  processorLabel: z.preprocess(blankToNull, z.string().trim().min(1).max(60).nullish())
}).strict();

// Partial by design, like the other settings-owned records. `sortOrder` is deliberately absent:
// position is set by the reorder endpoint, which is the only caller that can see the whole list
// and therefore the only one that can leave it without gaps or ties.
export const paymentMethodUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  settlementType: z.enum(paymentMethods).optional(),
  enabled: z.boolean().optional(),
  processorLabel: z.preprocess(blankToNull, z.string().trim().min(1).max(60).nullish()).optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one payment method change is required" }
);

// The whole list, in the order it should appear. A partial order is refused rather than applied,
// because moving one row without knowing the others is how two methods end up sharing a position.
export const paymentMethodOrderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200)
}).strict();

export const taxRateCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  // Basis points, matching `businesses.tax_rate_basis_points` - the column every invoice
  // snapshots at creation, which the default rate is mirrored onto.
  rateBasisPoints: z.number().int().min(0).max(10_000),
  isDefault: z.boolean().default(false)
}).strict();

export const taxRateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  rateBasisPoints: z.number().int().min(0).max(10_000).optional(),
  isDefault: z.boolean().optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one tax rate change is required" }
);

// `provider` is the processor's identity here - it is unique per business and cannot be edited,
// because editing it would silently repoint the fees and terminals recorded underneath it.
export const cardProcessorCreateSchema = z.object({
  provider: z.enum(cardProcessorProviders),
  isDefault: z.boolean().default(false),
  locationLabel: z.preprocess(blankToNull, z.string().trim().min(1).max(80).nullish()),
  // Three tip presets, whole percents, always given together: they are one control on the
  // checkout screen rather than three independent numbers.
  tipPercents: z.array(z.number().int().min(0).max(100)).length(3).optional()
}).strict();

export const cardProcessorUpdateSchema = z.object({
  isDefault: z.boolean().optional(),
  locationLabel: z.preprocess(blankToNull, z.string().trim().min(1).max(80).nullish()).optional(),
  tipPercents: z.array(z.number().int().min(0).max(100)).length(3).optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one card processor change is required" }
);

// A processing fee is a percentage plus a flat amount: "2.6% + 10c" is one fee, not two.
export const cardProcessorFeeSchema = z.object({
  name: z.string().trim().min(1).max(60),
  rateBasisPoints: z.number().int().min(0).max(10_000),
  centAmountMinor: z.number().int().min(0).max(100_000).default(0)
}).strict();

// An inventory record of a device on the counter. `deviceCode` is recorded so staff can tell two
// machines apart; nothing sends it anywhere, because there is nowhere to send it.
export const cardProcessorTerminalSchema = z.object({
  name: z.string().trim().min(1).max(60),
  locationLabel: z.preprocess(blankToNull, z.string().trim().min(1).max(80).nullish()),
  deviceCode: z.preprocess(blankToNull, z.string().trim().min(1).max(40).nullish())
}).strict();

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizePhone(value?: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\D/g, "");
  return normalized || null;
}
