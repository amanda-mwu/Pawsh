import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z, type ZodType } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { DocumentStorageError, sha256, type DocumentStorage } from "../storage/documents.js";
import { canTransition, type AppointmentStatus } from "@pawsh/domain";
import { calculateInvoice } from "@pawsh/domain";
import { canonicalHash } from "../domain/canonical.js";
import { safePdfFilename } from "../domain/filenames.js";
import { maxPhotoBytes, readPhotoShape, safePhotoFilename } from "../domain/images.js";
import { localDateBounds, localDateForInstant, resolveWallTime, validateTimeZone } from "../domain/time.js";
import { permissionPresets, permissions } from "@pawsh/domain";
import { auth, authentication, issueToken, platformAuthentication, requirePermission, sessionToken, tokenHash } from "./context.js";
import {
  appointmentSchema, checkoutSchema, customerSchema, employeeSchema, idParams, loginSchema,
  normalizeEmail, normalizePhone, paymentSchema, petSchema, serviceSchema, signupSchema,
  transitionSchema, businessSettingsSchema, workingHoursSchema, blockedTimeSchema,
  operationalUpdateSchema, voidPaymentSchema, appointmentMoveSchema, appointmentServicesSchema,
  passwordResetRequestSchema, passwordResetConfirmSchema, invitationSchema,
  invitationAcceptSchema, ownershipTransferSchema, petProfileUpdateSchema, petCareUpdateSchema,
  servicePricingSchema,petTypeParams,breedParams,breedSettingsSchema,priceResolutionSchema,
  breedCreateSchema,breedRenameSchema,
  ownProfileUpdateSchema,passwordChangeSchema,workspaceAccessRequestSchema,workspaceSelectionSchema,
  locationSelectionSchema,customerNoteParams,customerNoteCreateSchema,customerNoteUpdateSchema,
  customerNoteQuerySchema,customerPreferencesSchema,
  agreementTemplateCreateSchema,agreementTemplateUpdateSchema,agreementTemplateQuerySchema,
  agreementSignatureSchema,agreementSendSchema,customerAgreementParams,vaccinationReminderSchema,
  reportCardCreateSchema,reportCardUpdateSchema,reportCardSendSchema,
  petNoteParams,petPhotoUploadMetadataSchema,petAvatarSchema,
  customerChildParams,customerAddressCreateSchema,customerAddressUpdateSchema,
  customerContactCreateSchema,customerContactUpdateSchema,
  petVaccinationCreateSchema,petVaccinationUpdateSchema,petDeceasedSchema,
  locationParams,closureDayQuerySchema,closureDaysSchema
} from "./schemas.js";
import { availabilityRefusalCodes } from "../domain/availability.js";
import { sealSecret } from "../security/secrets.js";
import { hashPassword, validateNewPassword, verifyPassword } from "../security/passwords.js";
import { AuthAbuseProtector } from "../security/auth-abuse.js";
import {
  changedPetCareFields,
  writablePetCareFields,
  redactPetCare,
  suppliedPetCareFields,
  type PetCareRecord
} from "@pawsh/domain";
import { normalizeBreedSearch } from "@pawsh/domain";
import {provisionBusinessCatalog} from "../domain/catalog-seed.js";
import {resolveServicePrices} from "../domain/service-pricing.js";

type Transaction = postgres.TransactionSql;

const employeeFilterSchema=z.preprocess(
  value=>value===undefined||value===""?undefined
    :(Array.isArray(value)?value:String(value).split(",")).map(entry=>String(entry).trim()).filter(Boolean),
  z.array(z.string().uuid()).min(1).max(50).optional()
);
const calendarQuerySchema=z.object({
  localDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days:z.coerce.number().int().min(1).max(31).optional(),
  mode:z.enum(["start","overlap"]).optional(),
  employeeIds:employeeFilterSchema
}).strict();
const customerDirectoryQuerySchema=z.object({
  q:z.string().trim().max(200).optional(),
  search:z.string().trim().max(200).optional(),
  page:z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize:z.coerce.number().int().min(10).max(50).default(25),
  status:z.enum(["active","inactive","all"]).default("active"),
  upcoming:z.enum(["any","yes","no"]).default("any"),
  sort:z.enum(["name","lastVisit","nextAppointment"]).default("name"),
  direction:z.enum(["asc","desc"]).default("asc"),
  paged:z.coerce.boolean().default(false)
}).strict();
const reportRangeSchema=z.object({
  localDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days:z.coerce.number().int().min(1).max(366).optional(),
  employeeIds:employeeFilterSchema
}).strict();
const appointmentHistoryQuerySchema=z.object({
  page:z.coerce.number().int().min(1).max(1000).default(1),
  // The client profile pages history two or three rows at a time, so the floor is a single row
  // rather than the ten a full-page listing needs.
  pageSize:z.coerce.number().int().min(1).max(100).default(25),
  direction:z.enum(["upcoming","past"]).optional()
}).strict();
// Client and pet profiles read a bounded first page; the paginated history routes serve the tail.
const profileHistoryLimit=100;
// Upcoming is a short list by nature — the next few visits, not a log — and the profile shows
// it in full rather than paging it.
const profileUpcomingLimit=25;
// History opens as a preview rather than a log. A few rows beyond what the profile shows first
// means growing the visible window costs no round trip, while a client with years of visits
// never ships years of rows to render two of them.
const profileHistoryPreviewLimit=5;
const preferredGroomerSchema=z.object({employeeId:z.string().uuid().nullable()}).strict();
const reminderQuerySchema=z.object({type:z.enum(["appointment_reminder","secondary_reminder","same_day_reminder","rebook_reminder","vaccination_reminder","birthday_reminder"])}).strict();

interface CustomerPreferences {
  id: string;
  bookingFrequencyWeeks: number | null;
  blockMessages: boolean;
  blockOnlineBooking: boolean;
  marketingSmsAllowed: boolean;
  emailAllowed: boolean;
}

interface SchedulingConflict {
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
}

function mayViewPetCare(context: { isOwner: boolean; permissions: readonly string[] }): boolean {
  return context.isOwner || context.permissions.includes("pets.care.view");
}

const documentUploadMetadataSchema = z.object({
  uploadRequestId: z.string().uuid(),
  expectedCurrentDocumentId: z.string().uuid().nullable(),
  expectedCurrentDocumentVersion: z.number().int().positive().optional(),
  documentDate: z.string().date().nullish(),
  expiration: z.object({ intent: z.literal("preserve") }),
  claimedDigest: z.string().regex(/^[0-9a-f]{64}$/).optional()
}).superRefine((value, context) => {
  if (value.expectedCurrentDocumentId && !value.expectedCurrentDocumentVersion) {
    context.addIssue({ code: "custom", path: ["expectedCurrentDocumentVersion"], message: "Current document version is required" });
  }
  if (!value.expectedCurrentDocumentId && value.expectedCurrentDocumentVersion !== undefined) {
    context.addIssue({ code: "custom", path: ["expectedCurrentDocumentVersion"], message: "Version is invalid without a current document" });
  }
});

type DocumentUploadMetadata = z.infer<typeof documentUploadMetadataSchema>;

const photoUploadMetadataSchema = z.object({
  petId: z.string().uuid(),
  phase: z.enum(["before", "after"]),
  uploadRequestId: z.string().uuid(),
  claimedDigest: z.string().regex(/^[0-9a-f]{64}$/).optional()
}).strict();

// A groomer photographing one dog produces a handful of shots per phase, not an album. The cap
// exists so a stuck retry loop cannot fill the bucket, and it is reported rather than silently
// dropping the extra.
const maxPhotosPerPhase = 12;
// A pet gallery is a handful of portraits over the years, not an album.
const maxPetPhotos = 24;

/**
 * Escape a value for interpolation into the report card preview page.
 *
 * That page is the only HTML this server composes, and every value in it comes from tenant data
 * that a person typed. Quotes are escaped along with the angle brackets so the same function is
 * safe in an attribute as well as in text.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[character] ?? character));
}

// The storage key and digest stay server-side: neither tells the interface anything, and the key
// is the one field that would let a caller reason about the object layout of the bucket.
interface PhotoApiRow {
  id: string; petId: string; phase: string; width: number | null; height: number | null;
  sizeBytes: string | null; originalFilename: string; contentType: string; createdAt: Date;
}

function documentRequestFingerprint(input: DocumentUploadMetadata): string {
  return sha256(new TextEncoder().encode(JSON.stringify({
    documentType: "rabies_vaccination",
    expectedCurrentDocumentId: input.expectedCurrentDocumentId,
    expectedCurrentDocumentVersion: input.expectedCurrentDocumentVersion ?? null,
    documentDate: input.documentDate ?? null,
    expiration: input.expiration,
    claimedDigest: input.claimedDigest ?? null
  })));
}

function validPdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) return false;
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") return false;
  const tail = new TextDecoder("ascii").decode(bytes.slice(Math.max(0, bytes.byteLength - 4096)));
  return tail.includes("%%EOF");
}

interface DocumentApiRow {
  id: string; documentType: string; state: string; documentVersion: number;
  safeDownloadFilename: string; sizeBytes: number; documentDate: string | Date | null;
  expiresOn: string | Date | null; createdAt: string;
}

function dateOnly(value: string | Date | null): string | null {
  if (!value) return null;
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

function publicDocument(row: DocumentApiRow) {
  return {
    id: row.id, documentType: row.documentType, state: row.state,
    version: row.documentVersion, filename: row.safeDownloadFilename,
    sizeBytes: row.sizeBytes, documentDate: dateOnly(row.documentDate), expiresOn: dateOnly(row.expiresOn),
    uploadedAt: row.createdAt
  };
}

interface DocumentActivityRow {
  requestId: string; operation: "upload" | "replace"; requestState: string;
  resultCode: string | null; lastScanError: string | null; filename: string; createdAt: string; updatedAt: string;
}

function publicDocumentActivity(row: DocumentActivityRow) {
  const status = row.requestState === "in_progress" ? "pending" : "unavailable";
  return {
    requestId: row.requestId,
    documentType: "rabies_vaccination",
    operation: row.operation,
    filename: row.filename,
    status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canUpload: row.requestState !== "in_progress"
  };
}

export interface SchedulingHooks {
  afterLocationLock?: (input:{operation:"create"|"reschedule";businessId:string;timezone:string;version:number})=>Promise<void>;
  beforeLock?: (input: {
    operation: "create" | "reschedule";
    businessId: string;
    employeeIds: readonly string[];
  }) => Promise<void>;
  afterOverrideAudit?: (input: {
    operation: "create" | "reschedule";
    appointmentId: string;
  }) => Promise<void>;
  afterCommit?: (input:{operation:"create"|"reschedule";appointmentId:string})=>Promise<void>;
}

export interface LifecycleHooks {
  beforeRowLock?: (input: {
    businessId: string;
    appointmentId: string;
    targetStatus: AppointmentStatus;
  }) => Promise<void>;
}

export interface DocumentHooks {
  beforeDocumentAudit?: (input: { businessId: string; petId: string; documentId: string }) => Promise<void>;
}

export interface FinancialHooks {
  beforeFinancialAudit?: (operation: FinancialOperation) => Promise<void>;
  afterFinancialCommit?: (operation: FinancialOperation) => Promise<void>;
}

type FinancialOperation = "checkout.create-invoice" | "payment.record" | "payment.void";
type SchedulingOperation = "appointment.create" | "appointment.reschedule";
type SchedulingCanonicalVersion = "appointment.create:v2" | "appointment.reschedule:v2";
type SchedulingResultVersion = "appointment.create.result:v1" | "appointment.reschedule.result:v1";

class FinancialRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "FinancialRequestError";
  }
}

class SchedulingRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "SchedulingRequestError";
  }
}

function schedulingIdempotencyKey(request: { headers: Record<string, unknown> }): string {
  const value=request.headers["idempotency-key"];
  if(typeof value!=="string"||value.length<16||value.length>128||!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SchedulingRequestError(400,"IDEMPOTENCY_KEY_REQUIRED","A valid Idempotency-Key header is required");
  }
  return value;
}

function schedulingCanonicalHash(
  operation: SchedulingOperation,
  version: SchedulingCanonicalVersion,
  fields: readonly unknown[]
): string {
  return canonicalHash([operation,version,...fields]);
}

interface SchedulingReplayResult {
  resultSchemaVersion: SchedulingResultVersion;
  appointmentId: string;
  appointmentVersion: number;
  startAt: Date;
  endAt: Date;
  schedulingTimezone: string;
  scheduledLocalStart: string;
  disambiguation: "earlier"|"later"|null;
  utcOffsetMinutes: number;
  employeeId: string;
  locationId: string;
  conflictDetected:boolean;
  conflictOverrideRequested:boolean;
  conflictOverrideAuthorized:boolean;
  conflictOverrideApplied: boolean;
  availabilityOverrideApplied: boolean;
}

interface SchedulingClaim {
  id: string;
  replay: SchedulingReplayResult|null;
}

async function claimSchedulingRequest(tx:Transaction,input:{
  businessId:string;actorId:string;operation:SchedulingOperation;key:string;hash:string;
  canonicalizationVersion:SchedulingCanonicalVersion;
}):Promise<SchedulingClaim>{
  const [created]=await tx<{id:string}[]>`
    insert into scheduling_request_replays
      (business_id,operation,idempotency_key,canonical_payload_hash,canonicalization_version,initiating_actor_id)
    values (${input.businessId},${input.operation},${input.key},${input.hash},${input.canonicalizationVersion},${input.actorId})
    on conflict (business_id,operation,idempotency_key) do nothing
    returning id
  `;
  if(created)return {id:created.id,replay:null};
  const [existing]=await tx<({id:string;canonicalPayloadHash:string;canonicalizationVersion:string;completedAt:Date|null}&SchedulingReplayResult)[]>`
    select id,canonical_payload_hash,canonicalization_version,completed_at,
      result_schema_version, resulting_appointment_id as appointment_id,
      resulting_appointment_version as appointment_version,result_start_at as start_at,result_end_at as end_at,
      result_scheduling_timezone as scheduling_timezone,
      to_char(result_scheduled_local_start,'YYYY-MM-DD"T"HH24:MI') as scheduled_local_start,
      result_disambiguation as disambiguation,result_utc_offset_minutes as utc_offset_minutes,
      result_employee_id as employee_id,result_location_id as location_id,
      result_conflict_detected as conflict_detected,
      result_conflict_override_requested as conflict_override_requested,
      result_conflict_override_authorized as conflict_override_authorized,
      result_conflict_override_applied as conflict_override_applied,
      result_availability_override_applied as availability_override_applied
    from scheduling_request_replays
    where business_id=${input.businessId} and operation=${input.operation} and idempotency_key=${input.key}
  `;
  if(!existing?.completedAt)throw new SchedulingRequestError(409,"IDEMPOTENCY_IN_PROGRESS","The scheduling request is still being processed");
  if(existing.canonicalizationVersion!==input.canonicalizationVersion||existing.canonicalPayloadHash!==input.hash){
    throw new SchedulingRequestError(409,"IDEMPOTENCY_KEY_REUSED","The idempotency key was already used for a different request");
  }
  if(!["appointment.create.result:v1","appointment.reschedule.result:v1"].includes(existing.resultSchemaVersion)){
    throw new SchedulingRequestError(409,"IDEMPOTENCY_RESULT_UNAVAILABLE","The stored scheduling result cannot be replayed safely");
  }
  return {id:existing.id,replay:existing};
}

async function completeSchedulingRequest(tx:Transaction,id:string,result:SchedulingReplayResult):Promise<void>{
  await tx`
    update scheduling_request_replays set
      result_schema_version=${result.resultSchemaVersion},resulting_appointment_id=${result.appointmentId},
      resulting_appointment_version=${result.appointmentVersion},result_start_at=${result.startAt},result_end_at=${result.endAt},
      result_scheduling_timezone=${result.schedulingTimezone},
      result_scheduled_local_start=${result.scheduledLocalStart}::text::timestamp without time zone,
      result_disambiguation=${result.disambiguation},result_utc_offset_minutes=${result.utcOffsetMinutes},
      result_employee_id=${result.employeeId},result_location_id=${result.locationId},
      result_conflict_detected=${result.conflictDetected},
      result_conflict_override_requested=${result.conflictOverrideRequested},
      result_conflict_override_authorized=${result.conflictOverrideAuthorized},
      result_conflict_override_applied=${result.conflictOverrideApplied},
      result_availability_override_applied=${result.availabilityOverrideApplied},completed_at=now()
    where id=${id} and completed_at is null
  `;
}

function schedulingReplayResponse(result:SchedulingReplayResult){
  return {
    id:result.appointmentId,version:result.appointmentVersion,startAt:result.startAt,endAt:result.endAt,
    schedulingTimezone:result.schedulingTimezone,scheduledLocalStart:result.scheduledLocalStart,
    scheduledDisambiguation:result.disambiguation,scheduledUtcOffsetMinutes:result.utcOffsetMinutes,
    employeeId:result.employeeId,locationId:result.locationId,
    availabilityOverridden:result.availabilityOverrideApplied,conflictOverridden:result.conflictOverrideApplied,
    scheduling:{conflictDetected:result.conflictDetected,overrideRequested:result.conflictOverrideRequested,
      overrideAuthorized:result.conflictOverrideAuthorized,overrideApplied:result.conflictOverrideApplied}
  };
}

async function authorizeSchedulingReplay(tx:Transaction,context:{businessId:string;membershipId:string},result:SchedulingReplayResult):Promise<void>{
  if(!await hasCurrentPermission(tx,{businessId:context.businessId,membershipId:context.membershipId,permission:"appointments.view"})){
    throw new SchedulingRequestError(403,"PERMISSION_DENIED","The scheduling result is not available");
  }
  if(result.conflictOverrideApplied&&!await hasCurrentPermission(tx,{businessId:context.businessId,membershipId:context.membershipId,permission:"appointments.override_conflict"})){
    throw new SchedulingRequestError(403,"PERMISSION_DENIED","The scheduling result is not available");
  }
  if(result.availabilityOverrideApplied&&!await hasCurrentPermission(tx,{businessId:context.businessId,membershipId:context.membershipId,permission:"appointments.edit"})){
    throw new SchedulingRequestError(403,"PERMISSION_DENIED","The scheduling result is not available");
  }
}

function idempotencyKey(request: { headers: Record<string, unknown> }): string {
  const value = request.headers["idempotency-key"];
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new FinancialRequestError(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
  return parsed.data;
}

interface FinancialClaim {
  id: string;
  existingResult: unknown | null;
}

async function claimFinancialRequest(
  tx: Transaction,
  input: { businessId: string; actorId: string; operation: FinancialOperation; key: string; hash: string }
): Promise<FinancialClaim> {
  const [created] = await tx<{ id: string }[]>`
    insert into financial_idempotency_requests
      (business_id,operation,idempotency_key,initiating_actor_id,canonical_payload_hash,state)
    values (${input.businessId},${input.operation},${input.key},${input.actorId},${input.hash},'in_progress')
    on conflict (business_id,operation,idempotency_key) do nothing
    returning id
  `;
  if (created) return { id: created.id, existingResult: null };
  const [existing] = await tx<{ id: string; canonicalPayloadHash: string; state: string; resultMetadata: unknown }[]>`
    select id,canonical_payload_hash,state,result_metadata
    from financial_idempotency_requests
    where business_id=${input.businessId} and operation=${input.operation} and idempotency_key=${input.key}
  `;
  if (!existing) throw new FinancialRequestError(409, "IDEMPOTENCY_IN_PROGRESS", "The financial request is still being processed");
  if (existing.canonicalPayloadHash !== input.hash) {
    throw new FinancialRequestError(409, "IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used for a different request");
  }
  if (existing.state !== "completed") {
    throw new FinancialRequestError(409, "IDEMPOTENCY_IN_PROGRESS", "The financial request is still being processed");
  }
  return { id: existing.id, existingResult: existing.resultMetadata };
}

async function completeFinancialRequest(
  tx: Transaction,
  input: { id: string; resultType: string; resourceId: string; result: unknown }
): Promise<void> {
  await tx`
    update financial_idempotency_requests set state='completed',result_type=${input.resultType},
      result_resource_id=${input.resourceId},result_metadata=${tx.json(input.result as any)},completed_at=now()
    where id=${input.id} and state='in_progress'
  `;
}

function body<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

// Restricts an `appointments a` projection to appointments assigned to the requested groomers.
function assignedToEmployees(db: Database, employeeIds: readonly string[] | undefined) {
  if (!employeeIds?.length) return db`true`;
  return db`exists(
    select 1 from appointment_employees scoped_assignment
    where scoped_assignment.business_id=a.business_id and scoped_assignment.appointment_id=a.id
      and scoped_assignment.employee_id in ${db(employeeIds as string[])}
  )`;
}

type SqlFragment = ReturnType<typeof assignedToEmployees>;

/**
 * The calendar row shape, in one place.
 *
 * The list endpoint and the single-appointment endpoint must agree field for field, because a
 * mobile detail screen refetches one appointment and re-renders the same record the list handed
 * it. Two hand-written queries would drift the first time a column is added to one of them, so
 * both callers pass only a `where` fragment and share this projection. The fragment carries the
 * tenant predicate.
 */
function appointmentCalendarRows(db: Database, scope: SqlFragment) {
  return db`
    select a.*, c.first_name, c.last_name, c.phone as customer_phone, p.name as pet_name, p.breed, p.safety_alerts,
      p.behavior_notes, p.medical_notes, p.grooming_preferences, p.coat_notes,
      p.vaccination_expires_on,p.rabies_verification_status,p.rabies_verification_method,
      case
        when p.vaccination_expires_on is null then 'not_provided'
        when p.vaccination_expires_on < a.scheduled_local_start::date then 'expires_before_appointment'
        else 'valid_for_appointment'
      end as rabies_appointment_status,
      coalesce((select ni.status from notification_intents ni
        where ni.business_id=a.business_id and ni.appointment_id=a.id
          and ni.notification_type='rabies_expiration_customer'
        order by ni.created_at desc limit 1),'not_required') as rabies_customer_notification_status,
      e.display_name as employee_name,
      coalesce((select json_agg(json_build_object('id',staff.id,'displayName',staff.display_name) order by staff.display_name)
        from appointment_employees assignment join employees staff on staff.id=assignment.employee_id
        where assignment.business_id=a.business_id and assignment.appointment_id=a.id),
        json_build_array(json_build_object('id',e.id,'displayName',e.display_name))) as groomers,
      coalesce(json_agg(json_build_object(
        'id', aps.id, 'name', aps.service_name_snapshot, 'durationMinutes',
        aps.duration_minutes_snapshot, 'priceMinor', aps.price_minor_snapshot,
        'serviceId', aps.service_id
      )) filter (where aps.id is not null), '[]') as services,
      inv.status as invoice_status, inv.balance_minor as invoice_balance_minor
    from appointments a
    join customers c on c.id=a.customer_id
    join pets p on p.id=a.pet_id
    join locations l on l.business_id=a.business_id and l.id=a.location_id
    join employees e on e.id=a.employee_id
    left join appointment_services aps on aps.appointment_id=a.id
    left join invoices inv on inv.business_id=a.business_id and inv.appointment_id=a.id and inv.status<>'void'
    where ${scope}
    group by a.id,c.id,p.id,e.id,l.id,inv.id order by a.start_at,a.employee_id,a.id
  `;
}

// Bounded appointment history projection carrying the service snapshots the profile views render,
// so the client never has to fan out one request per appointment.
/**
 * One page of a client's or pet's appointments.
 *
 * `direction` splits the same list the way the profile reads it. "upcoming" is work still
 * ahead — a future start that has not reached a terminal state — and reads forwards, because
 * the next visit is the one being looked for. "past" is everything else, including a cancelled
 * or no-show appointment whose date has not arrived yet: it is settled, so it belongs in
 * history rather than in a list of what is still going to happen. Omitting `direction` keeps
 * the undivided newest-first list the pet profile uses.
 */
async function appointmentHistoryPage(
  db: Database,
  input: {
    businessId: string; scope: "customer" | "pet"; id: string; limit: number; offset: number;
    direction?: "upcoming" | "past";
  }
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const scope = input.scope === "customer" ? db`a.customer_id=${input.id}` : db`a.pet_id=${input.id}`;
  const pending = db`a.start_at >= now() and a.status not in ('completed','cancelled','no_show')`;
  const window = input.direction === "upcoming" ? pending
    : input.direction === "past" ? db`not (${pending})`
    : db`true`;
  const ordering = input.direction === "upcoming"
    ? db`order by a.start_at asc,a.id asc`
    : db`order by a.start_at desc,a.id desc`;
  const [items, totals] = await Promise.all([
    db<Record<string, unknown>[]>`
      select a.*, p.name as pet_name, e.display_name as employee_name,
        coalesce((select json_agg(json_build_object(
          'id',aps.id,'serviceId',aps.service_id,'name',aps.service_name_snapshot,
          'durationMinutes',aps.duration_minutes_snapshot,'priceMinor',aps.price_minor_snapshot
        ) order by aps.id) from appointment_services aps
          where aps.business_id=a.business_id and aps.appointment_id=a.id),'[]') as services,
        coalesce((select json_agg(json_build_object('id',staff.id,'displayName',staff.display_name)
          order by staff.display_name)
          from appointment_employees assignment
          join employees staff on staff.business_id=assignment.business_id and staff.id=assignment.employee_id
          where assignment.business_id=a.business_id and assignment.appointment_id=a.id),
          json_build_array(json_build_object('id',e.id,'displayName',e.display_name))) as groomers
      from appointments a
      join pets p on p.business_id=a.business_id and p.id=a.pet_id
      join employees e on e.business_id=a.business_id and e.id=a.employee_id
      where a.business_id=${input.businessId} and ${scope} and ${window}
      ${ordering} limit ${input.limit} offset ${input.offset}
    `,
    db<{ count: number }[]>`
      select count(*)::int count from appointments a
      where a.business_id=${input.businessId} and ${scope} and ${window}
    `
  ]);
  return { items, total: totals[0]?.count ?? 0 };
}

/**
 * The figures the client profile leads with.
 *
 * Money is counted from invoices rather than appointments, because an appointment carries a
 * quoted price and an invoice carries what was actually charged. `unclosed` is the honest gap
 * between the two: a completed appointment with no invoice has been worked but never billed,
 * and it is neither revenue nor outstanding until somebody closes it out.
 *
 * Pawsh sells no retail, so no retail figure is reported. Rendering a zero there would read as
 * "no retail sold to this client" rather than "Pawsh does not do retail".
 */
async function customerSalesSummary(
  db: Database,
  input: { businessId: string; customerId: string }
): Promise<Record<string, unknown>> {
  const [[money], statuses, [unclosed]] = await Promise.all([
    db<{ invoicedMinor: number; outstandingMinor: number; paidMinor: number; invoiceCount: number }[]>`
      select coalesce(sum(total_minor),0)::int invoiced_minor,
        coalesce(sum(balance_minor),0)::int outstanding_minor,
        coalesce(sum(total_minor-balance_minor),0)::int paid_minor,
        count(*)::int invoice_count
      from invoices
      where business_id=${input.businessId} and customer_id=${input.customerId} and status<>'void'
    `,
    db<{ status: string; count: number }[]>`
      select status,count(*)::int count from appointments
      where business_id=${input.businessId} and customer_id=${input.customerId}
      group by status
    `,
    db<{ count: number }[]>`
      select count(*)::int count from appointments appointment
      where appointment.business_id=${input.businessId} and appointment.customer_id=${input.customerId}
        and appointment.status='completed'
        and not exists (
          select 1 from invoices invoice
          where invoice.business_id=appointment.business_id
            and invoice.appointment_id=appointment.id and invoice.status<>'void'
        )
    `
  ]);
  const counts = Object.fromEntries(statuses.map((row) => [row.status, row.count]));
  const appointmentTotal = statuses.reduce((sum, row) => sum + row.count, 0);
  return {
    invoicedMinor: money?.invoicedMinor ?? 0,
    paidMinor: money?.paidMinor ?? 0,
    outstandingMinor: money?.outstandingMinor ?? 0,
    invoiceCount: money?.invoiceCount ?? 0,
    appointmentTotal,
    statusCounts: {
      scheduled: counts.scheduled ?? 0,
      checkedIn: counts.checked_in ?? 0,
      inService: counts.in_service ?? 0,
      completed: counts.completed ?? 0,
      cancelled: counts.cancelled ?? 0,
      noShow: counts.no_show ?? 0
    },
    unclosedTotal: unclosed?.count ?? 0
  };
}

async function setTenant(tx: Transaction, businessId: string): Promise<void> {
  await tx`select set_config('app.business_id', ${businessId}, true)`;
}

// Client note thread projection. `authorName` always resolves to something renderable: the
// business-scoped employee name when the author still has one, otherwise their account display
// name, and never a bare user id. Pinned ("popup") notes float to the top of the thread.
async function customerNoteRows(
  db: Database,
  input: { businessId: string; customerId: string; noteId?: string; limit: number; offset: number }
): Promise<Record<string, unknown>[]> {
  const scope = input.noteId ? db`note.id=${input.noteId}` : db`true`;
  return db<Record<string, unknown>[]>`
    select note.id,note.customer_id,note.body,note.pinned,note.created_by,
      note.created_at,note.updated_at,
      coalesce(author_employee.display_name,author_user.display_name,'Unknown') as author_name
    from customer_notes note
    left join users author_user on author_user.id=note.created_by
    left join business_memberships author_membership
      on author_membership.business_id=note.business_id and author_membership.user_id=note.created_by
    left join employees author_employee
      on author_employee.business_id=note.business_id
      and author_employee.membership_id=author_membership.id
    where note.business_id=${input.businessId} and note.customer_id=${input.customerId} and ${scope}
    order by note.pinned desc,note.created_at desc,note.id desc
    limit ${input.limit} offset ${input.offset}
  `;
}

/**
 * Bridges the legacy single-field `customers.notes` write path onto the note thread, which is now
 * the source of truth (a database trigger mirrors the newest note back onto the column, so the
 * legacy response key can never disagree with the thread).
 *
 * An absent value leaves the thread untouched, an explicit empty value removes the note the legacy
 * field represents, and any other value edits that note in place — matching what editing a single
 * free-text field always meant. Returns whether the thread changed.
 */
async function applyLegacyCustomerNote(
  tx: Transaction,
  input: { businessId: string; customerId: string; actorId: string; value: string | null | undefined }
): Promise<boolean> {
  if (input.value === undefined) return false;
  const body = (input.value ?? "").trim();
  const [latest] = await tx<{ id: string; body: string }[]>`
    select id,body from customer_notes
    where business_id=${input.businessId} and customer_id=${input.customerId}
    order by created_at desc,id desc limit 1
  `;
  if (!body) {
    if (!latest) return false;
    await tx`delete from customer_notes where business_id=${input.businessId} and id=${latest.id}`;
    return true;
  }
  if (!latest) {
    await tx`
      insert into customer_notes (business_id, customer_id, body, created_by)
      values (${input.businessId}, ${input.customerId}, ${body}, ${input.actorId})
    `;
    return true;
  }
  if (latest.body === body) return false;
  await tx`
    update customer_notes set body=${body},updated_at=now()
    where business_id=${input.businessId} and id=${latest.id}
  `;
  return true;
}

// ---------------------------------------------------------------------------
// Client agreements
// ---------------------------------------------------------------------------

type AgreementEmailReason = "ok" | "no_email_address" | "email_declined" | "messages_blocked";

interface AgreementRecipient {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  emailAllowed: boolean;
  blockMessages: boolean;
}

const agreementEmailDetail: Record<AgreementEmailReason, string | null> = {
  ok: null,
  no_email_address: "This client has no email address on file.",
  email_declined: "This client has opted out of email.",
  messages_blocked: "This client's profile blocks messages."
};

function agreementEmailReason(customer: AgreementRecipient): AgreementEmailReason {
  if (!customer.email) return "no_email_address";
  if (customer.blockMessages) return "messages_blocked";
  if (!customer.emailAllowed) return "email_declined";
  return "ok";
}

/**
 * Describes, per channel, whether an agreement can actually be delivered to this client.
 *
 * "sms" is reported and permanently unavailable. `notification_intents.channel` is
 * `check (channel in ('email'))` and Pawsh has no SMS transport, credentials, or cost
 * model, so the honest answer is a named channel with a reason rather than an option
 * the UI could present as if it might work.
 */
function agreementDelivery(customer: AgreementRecipient) {
  const reason = agreementEmailReason(customer);
  return {
    supportedChannels: ["email"],
    channels: [
      {
        channel: "email",
        available: reason === "ok",
        reason,
        detail: agreementEmailDetail[reason],
        destination: reason === "ok" ? customer.email : null
      },
      {
        channel: "sms",
        available: false,
        reason: "channel_unsupported",
        detail: "Pawsh has no SMS delivery. Agreements can only be sent by email.",
        destination: null
      }
    ]
  };
}

interface CustomerAgreementItem {
  agreementId: string | null;
  templateId: string;
  name: string;
  body: string;
  required: boolean;
  active: boolean;
  templateVersion: number;
  status: "not_sent" | "sent" | "signed";
  sentAt: Date | null;
  sendCount: number;
  lastSentChannel: string | null;
  signedAt: Date | null;
  signedName: string | null;
  signatureMethod: string | null;
  signatureNote: string | null;
  signedTemplateVersion: number | null;
  recordedByName: string | null;
  lastSend: Record<string, unknown> | null;
}

/**
 * Resolved per-customer agreement state. Every live template appears, whether or not the
 * client has a row for it, so "not sent" is a state the panel can render rather than a
 * gap; an archived template appears only when this client already has state against it,
 * so history is never lost when a salon retires a document.
 */
async function customerAgreementRows(
  db: Database,
  input: { businessId: string; customerId: string; templateId?: string }
): Promise<CustomerAgreementItem[]> {
  const scope = input.templateId ? db`template.id=${input.templateId}` : db`true`;
  return db<CustomerAgreementItem[]>`
    select template.id as template_id, template.name, template.body, template.required,
      template.active, template.version as template_version,
      state.id as agreement_id,
      coalesce(state.status,'not_sent') as status,
      state.sent_at, coalesce(state.send_count,0)::int as send_count,
      state.last_sent_channel, state.signed_at, state.signed_name,
      state.signature_method, state.signature_note, state.signed_template_version,
      coalesce(signer_employee.display_name,signer_user.display_name) as recorded_by_name,
      case when last_send.id is null then null else json_build_object(
        'channel',last_send.channel,'deliveryStatus',last_send.status,
        'queuedAt',last_send.created_at,'updatedAt',last_send.updated_at) end as last_send
    from agreement_templates template
    left join customer_agreements state
      on state.business_id=template.business_id
      and state.agreement_template_id=template.id
      and state.customer_id=${input.customerId}
    left join business_memberships signer_membership
      on signer_membership.business_id=state.business_id
      and signer_membership.id=state.signed_by_membership_id
    left join users signer_user on signer_user.id=signer_membership.user_id
    left join employees signer_employee
      on signer_employee.business_id=signer_membership.business_id
      and signer_employee.membership_id=signer_membership.id
    left join lateral (
      select intent.id,intent.channel,intent.status,intent.created_at,intent.updated_at
      from notification_intents intent
      where intent.business_id=template.business_id and intent.customer_id=${input.customerId}
        and intent.agreement_template_id=template.id
      order by intent.created_at desc,intent.id desc limit 1
    ) last_send on true
    where template.business_id=${input.businessId}
      and (template.active or state.id is not null) and ${scope}
    order by template.required desc,lower(btrim(template.name)),template.id
  `;
}

/**
 * The warning banner's condition: at least one live required document this client has
 * not signed. Archived templates never raise the banner even when state exists for them.
 */
function agreementSummary(items: readonly CustomerAgreementItem[]) {
  const live = items.filter((item) => item.active);
  const required = live.filter((item) => item.required);
  const unsignedRequired = required.filter((item) => item.status !== "signed");
  return {
    total: live.length,
    requiredTotal: required.length,
    signedTotal: live.filter((item) => item.status === "signed").length,
    unsignedRequiredTotal: unsignedRequired.length,
    unsignedRequiredTemplateIds: unsignedRequired.map((item) => item.templateId),
    needsAttention: unsignedRequired.length > 0
  };
}

/**
 * The message a client actually receives. Pawsh has no client-facing signing surface, so
 * the email carries the document text and asks the client to confirm with the salon; the
 * signature is then recorded by staff. It is sealed like every other composed notification
 * body so the outbox worker decrypts it instead of regenerating it.
 */
function agreementMessage(input: {
  businessName: string;
  businessPhone: string | null;
  businessEmail: string | null;
  templateName: string;
  templateBody: string;
}): string {
  const contact = input.businessPhone ?? input.businessEmail ?? input.businessName;
  return [
    `${input.businessName} asks you to review and agree to "${input.templateName}".`,
    input.templateBody,
    `Reply to this message or contact ${contact} to confirm your agreement. Your confirmation is then recorded on your client record.`
  ].join("\n\n");
}

async function lockSchedulingResources(
  tx: Transaction,
  businessId: string,
  employeeIds: readonly string[]
): Promise<void> {
  for (const employeeId of [...new Set(employeeIds)].sort()) {
    await tx`
      select pg_advisory_xact_lock(
        hashtextextended(${`${businessId}:${employeeId}`}, 0)
      )
    `;
  }
}

async function hasCurrentPermission(
  tx: Transaction,
  input: { businessId: string; membershipId: string; permission: string }
): Promise<boolean> {
  const [row] = await tx<{ allowed: boolean }[]>`
    select (membership.is_owner or ${input.permission}=any(membership.permissions)) as allowed
    from business_memberships membership
    join users account on account.id=membership.user_id and account.disabled_at is null
    join businesses business on business.id=membership.business_id and business.status='active'
    where membership.business_id=${input.businessId}
      and membership.id=${input.membershipId}
      and membership.status='active'
  `;
  return row?.allowed ?? false;
}

async function findSchedulingConflicts(
  tx: Transaction,
  input: {
    businessId: string;
    employeeId: string;
    startAt: Date;
    endAt: Date;
    excludeAppointmentId?: string;
  }
): Promise<SchedulingConflict[]> {
  return tx<SchedulingConflict[]>`
    select appointment.id as appointment_id,appointment.start_at as starts_at,appointment.end_at as ends_at
    from appointments appointment join appointment_employees assignment
      on assignment.business_id=appointment.business_id and assignment.appointment_id=appointment.id
    where appointment.business_id=${input.businessId}
      and assignment.employee_id=${input.employeeId}
      and appointment.status in ('scheduled','checked_in','in_service')
      and appointment.id<>coalesce(${input.excludeAppointmentId ?? null}::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
      and tstzrange(appointment.start_at,appointment.end_at,'[)')
          && tstzrange(${input.startAt},${input.endAt},'[)')
    order by appointment.start_at,appointment.id
  `;
}

async function authorizeConflictOverride(
  tx: Transaction,
  context: { businessId: string; membershipId: string },
  overrideRequested: boolean
): Promise<boolean> {
  if (!overrideRequested) return false;
  return hasCurrentPermission(tx, {
    businessId: context.businessId,
    membershipId: context.membershipId,
    permission: "appointments.override_conflict"
  });
}

async function permitConflictOverride(
  tx: Transaction,
  appointmentId: string
): Promise<void> {
  await tx`
    select set_config(
      'app.scheduling_conflict_override_appointment_id',
      ${appointmentId},
      true
    )
  `;
}

async function ensureBookingResourcesAvailable(
  tx:Transaction,
  input:{businessId:string;employeeIds:readonly string[];serviceIds:readonly string[]}
):Promise<void>{
  const employees=await tx<{id:string;displayName:string;active:boolean}[]>`
    select id,display_name,active from employees
    where business_id=${input.businessId} and id in ${tx(input.employeeIds as string[])}
  `;
  if(employees.length!==new Set(input.employeeIds).size)throw new Error("One or more selected groomers are unavailable");
  const inactiveEmployee=employees.find(employee=>!employee.active);
  if(inactiveEmployee)throw new Error(`${inactiveEmployee.displayName} is inactive and cannot be booked.`);
  const services=await tx<{id:string;name:string;active:boolean}[]>`
    select service.id,service.name,service.active
    from services service where service.business_id=${input.businessId}
      and service.id in ${tx(input.serviceIds as string[])}
  `;
  if(services.length!==new Set(input.serviceIds).size)throw new Error("One or more selected services are unavailable");
  const inactive=services.find(service=>!service.active);
  if(inactive)throw new Error(`${inactive.name} is inactive and cannot be booked.`);
}

async function groomersAvailable(
  tx:Transaction,input:{businessId:string;locationId:string;employeeIds:readonly string[];startAt:Date;endAt:Date}
):Promise<boolean>{
  const [result]=await tx<{available:boolean}[]>`
    select bool_and(
      (not exists(select 1 from employee_working_hours wh where wh.business_id=${input.businessId} and wh.employee_id=employee.id)
       or exists(select 1 from employee_working_hours wh join locations location on location.id=${input.locationId}
         where wh.business_id=${input.businessId} and wh.employee_id=employee.id
           and wh.weekday=extract(dow from (${input.startAt}::timestamptz at time zone location.timezone))
           and (${input.startAt}::timestamptz at time zone location.timezone)::time>=wh.start_time
           and (${input.endAt}::timestamptz at time zone location.timezone)::time<=wh.end_time))
      and not exists(select 1 from blocked_times blocked where blocked.business_id=${input.businessId}
        and blocked.employee_id=employee.id and tstzrange(blocked.start_at,blocked.end_at,'[)') && tstzrange(${input.startAt},${input.endAt},'[)'))
    ) and (not exists(select 1 from business_hours where location_id=${input.locationId}) or exists(
      select 1 from business_hours hours join locations location on location.id=hours.location_id
      where hours.business_id=${input.businessId} and hours.location_id=${input.locationId}
        and hours.weekday=extract(dow from (${input.startAt}::timestamptz at time zone location.timezone))
        and (${input.startAt}::timestamptz at time zone location.timezone)::time>=hours.start_time
        and (${input.endAt}::timestamptz at time zone location.timezone)::time<=hours.end_time)) as available
    from employees employee where employee.business_id=${input.businessId} and employee.id in ${tx(input.employeeIds as string[])}
  `;
  return Boolean(result?.available);
}

/**
 * Refuses a booking on a day the shop is shut.
 *
 * This is step 1 of `resolveEffectiveAvailability` in `src/domain/availability.ts`, where the
 * precedence is written down and tested: a closure is TERMINAL. It outranks a per-date staff
 * override that says the groomer is working, and - unlike every other availability rule in this
 * file - it outranks `availabilityOverride` too. Someone with the override permission is saying
 * "book them anyway"; that is a judgement about a groomer's hours, and it cannot make an unstaffed
 * building open. Because the verdict is terminal the resolver reads nothing else, so this needs
 * only the one indexed lookup rather than the whole availability picture.
 *
 * The date is the local calendar date at the LOCATION. An appointment cannot cross local midnight
 * (enforced separately), so the start's local date is the only one a booking can land on, and
 * deriving it from the instant on the client would put a closure on the wrong day for anyone
 * browsing from another timezone.
 */
async function salonClosedOn(
  tx: Transaction,
  input: { businessId: string; locationId: string; localDate: string }
): Promise<{ localDate: string; reason: string | null } | null> {
  const [closure] = await tx<{ localDate: string; reason: string | null }[]>`
    select to_char(local_date,'YYYY-MM-DD') as local_date,reason
    from location_closure_days
    where business_id=${input.businessId} and location_id=${input.locationId}
      and local_date=${input.localDate}::date
  `;
  return closure ?? null;
}

/**
 * Canonical breeds for one pet type, with a tenant's sparse overrides folded in.
 *
 * `defaultPricingClass` and `active` come back as EFFECTIVE values so no caller has to
 * re-implement the precedence, and `customized` says whether this business has expressed an
 * opinion at all - which is what lets Settings show "following the Pawsh default" honestly
 * rather than implying the business chose today's value.
 *
 * `businessOwned` separates the two partitions of the taxonomy: false is a shared Pawsh breed,
 * which this business may configure but never rename or delete; true is a breed this business
 * created, which only it can see and only it can change. It is the single field the client
 * needs to decide whether a row gets rename and delete controls.
 *
 * Everything here is keyed on `businessId` alone - the customer account - so the same catalog
 * is served at every location that account operates. There is no location dimension by
 * design; see migrations/0033_business_owned_breeds.sql.
 */
function breedCatalogRows(
  db: Database,
  input: { businessId: string; petTypeId: string; includeInactive?: boolean; breedId?: string }
) {
  return db<{
    id: string; name: string; search: string;
    defaultPricingClass: string; active: boolean; customized: boolean; businessOwned: boolean;
  }[]>`
    select breed.id,breed.name,breed.normalized_name as search,
      coalesce(override.pricing_class,breed.default_pricing_class) as default_pricing_class,
      coalesce(override.active,breed.active) as active,
      (override.pricing_class is not null or override.active is not null) as customized,
      (breed.business_id is not null) as business_owned
    from breeds breed
    left join business_breed_settings override
      on override.business_id=${input.businessId} and override.breed_id=breed.id
    where breed.pet_type_id=${input.petTypeId}
      -- The shared taxonomy plus this account's own additions, and nothing belonging to
      -- another tenant. Every breed query in this file carries this predicate, and it is the
      -- primary boundary: the row-level policies on this table are inert while Pawsh connects
      -- as its owner, so this predicate is load-bearing rather than defense in depth.
      and (breed.business_id is null or breed.business_id=${input.businessId})
      and (${input.breedId ?? null}::uuid is null or breed.id=${input.breedId ?? null}::uuid)
      and (${input.includeInactive ?? false} or coalesce(override.active,breed.active))
    order by coalesce(override.active,breed.active) desc,breed.name
  `;
}

/**
 * Loads a breed this tenant is allowed to see, and says which partition it belongs to.
 *
 * Returning `undefined` and returning a shared breed are different answers and the callers act
 * on them differently: not visible is a 404, visible but shared is a refusal with its own code,
 * because "no such breed" and "that breed is not yours to change" are different things for
 * anyone reading the response.
 */
async function loadBreedForTenant(
  sql: Transaction | Database,
  input: { businessId: string; breedId: string }
): Promise<{ id: string; petTypeId: string; name: string; businessId: string | null } | undefined> {
  const [breed] = await sql<{ id: string; petTypeId: string; name: string; businessId: string | null }[]>`
    select id,pet_type_id,name,business_id from breeds
    where id=${input.breedId}
      and (business_id is null or business_id=${input.businessId})
  `;
  return breed;
}

/**
 * Refuses to mutate a shared Pawsh breed.
 *
 * A rename would change breed identity for every tenant at once, which is exactly the property
 * the canonical taxonomy exists to guarantee, and a delete would remove a row other tenants'
 * pets reference. The account's controls over a shared breed are pricing class and availability,
 * both of which are already served by `PUT /api/breeds/:breedId/settings` and neither of which
 * touches the shared row.
 */
function refuseSharedBreedMutation(name: string): SchedulingRequestError {
  return new SchedulingRequestError(
    409,
    "BREED_NOT_BUSINESS_OWNED",
    `"${name}" is a shared Pawsh breed. Set its pricing class or turn it off for your business instead.`
  );
}

/**
 * Refuses a business-created breed name that is already taken for this pet type.
 *
 * Three sources of collision, all reported with one code because the client's response to each
 * is the same - ask for a different name - and the message says which one it hit:
 *   * a shared Pawsh breed, so a custom "Poodle" cannot shadow the canonical Poodle
 *   * one of this account's own breeds
 *   * an alias, because a breed named "Yorkie" would make the pet write path's name
 *     resolution ambiguous between the new row and the Yorkshire Terrier the alias points at
 * Another BUSINESS holding the name is NOT a collision: the two rows are independent, which is
 * what lets two unrelated accounts each add "Cavapoochon".
 */
async function assertBreedNameAvailable(
  tx: Transaction,
  input: { businessId: string; petTypeId: string; normalizedName: string; name: string; excludeBreedId?: string }
): Promise<void> {
  // Ordered rather than left to the planner: a bare `union all ... limit 1` picks an arbitrary
  // branch, and which collision the caller is told about should not depend on the plan.
  const [taken] = await tx<{ owner: string }[]>`
    select owner from (
      select case when breed.business_id is null then 'shared' else 'business' end as owner,
        case when breed.business_id is null then 1 else 2 end as rank
      from breeds breed
      where breed.pet_type_id=${input.petTypeId}
        and breed.normalized_name=${input.normalizedName}
        and (breed.business_id is null or breed.business_id=${input.businessId})
        and breed.id is distinct from ${input.excludeBreedId ?? null}::uuid
      union all
      select 'alias' as owner,3 as rank from breed_aliases alias
      where alias.pet_type_id=${input.petTypeId} and alias.normalized_name=${input.normalizedName}
    ) collision order by rank limit 1
  `;
  if (!taken) return;
  const reason = taken.owner === "shared"
    ? `"${input.name}" is already a Pawsh breed for this pet type.`
    : taken.owner === "alias"
      ? `"${input.name}" is already used as another spelling of an existing breed.`
      : `You already have a breed called "${input.name}".`;
  throw new SchedulingRequestError(409, "BREED_NAME_TAKEN", reason);
}

interface PetBreedSelection { petTypeId: string | null; breedId: string | null; breed: string | null; breedOther: string | null }

/**
 * Resolves what a pet's breed fields should become, from whatever the caller supplied.
 *
 * Four ways in, in precedence order:
 *
 *   1. `breedId` - an explicit canonical selection. Must belong to the pet's own type and be
 *      active for this tenant, so a Cat can never be assigned a Golden Retriever and a salon
 *      cannot book a breed it has switched off.
 *   2. `breedOther` - a deliberate "Other". Stores free text with no canonical id.
 *   3. `breed` text - resolved against the canonical taxonomy, then SAFE_EXACT aliases only.
 *      A SEARCH_ALIAS ("GSD", "Yorkie") deliberately does NOT resolve here: it exists to help a
 *      human find a breed in a picker, and letting it rewrite stored data would be the silent
 *      name-based guessing this whole migration removes.
 *   4. Nothing - a pet with no breed recorded, which is valid.
 *
 * Unrecognised text is REFUSED rather than quietly stored, so a typo cannot invent a breed and
 * move a price. The one exception is the grandfather clause: text identical to what the pet
 * already has passes through untouched. That is what lets someone edit a legacy pet's weight
 * without being forced to resolve a historical breed value they may know nothing about.
 */
async function resolvePetBreedSelection(
  tx: Transaction,
  input: {
    businessId: string;
    supplied: {
      species: string;
      petTypeId?: string | null | undefined;
      breedId?: string | null | undefined;
      breed?: string | null | undefined;
      breedOther?: string | null | undefined;
    };
    current?: { breed: string | null; breedId: string | null; petTypeId: string | null } | null;
  }
): Promise<PetBreedSelection> {
  const { supplied, current } = input;
  const [petType] = supplied.petTypeId
    ? await tx<{ id: string }[]>`select id from pet_types where id=${supplied.petTypeId} and active`
    : await tx<{ id: string }[]>`select id from pet_types where normalized_name=${normalizeBreedSearch(supplied.species)} and active`;
  if (supplied.petTypeId && !petType) throw new SchedulingRequestError(400, "PET_TYPE_NOT_FOUND", "That pet type is unavailable.");
  const petTypeId = petType?.id ?? current?.petTypeId ?? null;

  const refuse = (message: string) => new SchedulingRequestError(400, "BREED_NOT_IN_CATALOG", message);

  if (supplied.breedId) {
    if (!petTypeId) throw refuse("Choose a pet type before choosing a breed.");
    const [breed] = await tx<{ id: string; name: string }[]>`
      select breed.id,breed.name from breeds breed
      left join business_breed_settings override
        on override.business_id=${input.businessId} and override.breed_id=breed.id
      where breed.id=${supplied.breedId} and breed.pet_type_id=${petTypeId}
        -- A business-owned breed is selectable only by the business that owns it. Without this, a
        -- caller who learned another tenant's breed id could attach it to their own pet.
        and (breed.business_id is null or breed.business_id=${input.businessId})
        and (
          coalesce(override.active,breed.active)
          -- A salon may deactivate a breed after pets are already on it. Keeping the pet's own
          -- existing selection acceptable means an unrelated edit — a weight, a note — does not
          -- force a reselection. A deactivated breed still cannot be chosen for a new pet,
          -- because that only reaches here when the id differs from the stored one.
          or breed.id=${current?.breedId ?? null}::uuid
        )
    `;
    if (!breed) throw refuse("That breed is not available for this pet type.");
    return { petTypeId, breedId: breed.id, breed: breed.name, breedOther: null };
  }

  const other = supplied.breedOther?.trim();
  if (other) return { petTypeId, breedId: null, breed: other, breedOther: other };

  const text = supplied.breed?.trim();
  if (!text) return { petTypeId, breedId: null, breed: null, breedOther: null };

  const normalized = normalizeBreedSearch(text);
  if (petTypeId) {
    const [match] = await tx<{ id: string; name: string }[]>`
      select breed.id,breed.name from breeds breed
      left join business_breed_settings override
        on override.business_id=${input.businessId} and override.breed_id=breed.id
      where breed.pet_type_id=${petTypeId} and coalesce(override.active,breed.active)
        and (breed.business_id is null or breed.business_id=${input.businessId})
        and breed.normalized_name=${normalized}
      union all
      select breed.id,breed.name from breed_aliases alias
      join breeds breed on breed.id=alias.breed_id
      left join business_breed_settings override
        on override.business_id=${input.businessId} and override.breed_id=breed.id
      where alias.pet_type_id=${petTypeId} and alias.alias_kind='SAFE_EXACT_ALIAS'
        and alias.normalized_name=${normalized} and coalesce(override.active,breed.active)
        and (breed.business_id is null or breed.business_id=${input.businessId})
      limit 1
    `;
    if (match) return { petTypeId, breedId: match.id, breed: match.name, breedOther: null };
  }

  // Grandfather clause: unchanged legacy text is preserved exactly. The stored id is only kept
  // when the pet type still matches it — `pets` carries a composite foreign key on
  // (pet_type_id, breed_id), so pairing a new type with the old breed's id would fail as a raw
  // integrity violation instead of anything a caller could act on. Changing the type releases the
  // canonical link and leaves the text to stand on its own.
  if (current && current.breed && normalizeBreedSearch(current.breed) === normalized) {
    const keepsType = current.petTypeId !== null && current.petTypeId === petTypeId;
    return {
      petTypeId, breedId: keepsType ? current.breedId : null, breed: current.breed, breedOther: null
    };
  }
  throw refuse(`"${text}" is not a breed in the catalog. Choose one from the list, or select Other.`);
}

/** Calendar arithmetic on a `YYYY-MM-DD` local date, with no timezone in play. */
function shiftLocalDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function salonClosedError(closure: { localDate: string; reason: string | null }): SchedulingRequestError {
  return new SchedulingRequestError(
    409,
    availabilityRefusalCodes.location_closed,
    closure.reason
      ? `The salon is closed on ${closure.localDate} (${closure.reason}).`
      : `The salon is closed on ${closure.localDate}.`,
    { localDate: closure.localDate, closureReason: closure.reason }
  );
}

async function record(
  tx: Transaction,
  input: {
    businessId: string;
    actorId?: string | undefined;
    action: string;
    resourceType: string;
    resourceId?: string | undefined;
    before?: unknown;
    after?: unknown;
    reason?: string | null | undefined;
    eventType?: string | undefined;
  }
): Promise<void> {
  const correlationId = randomUUID();
  await tx`
    insert into audit_events
      (business_id, actor_id, action, resource_type, resource_id, correlation_id, before_data, after_data, reason)
    values
      (${input.businessId}, ${input.actorId ?? null}, ${input.action}, ${input.resourceType},
       ${input.resourceId ?? null}, ${correlationId}, ${input.before ? tx.json(input.before as any) : null},
       ${input.after ? tx.json(input.after as any) : null}, ${input.reason ?? null})
  `;
  if (input.eventType) {
    await tx`
      insert into outbox_events
        (business_id, event_type, actor_id, resource_id, correlation_id, payload)
      values
        (${input.businessId}, ${input.eventType}, ${input.actorId ?? null}, ${input.resourceId ?? null},
         ${correlationId}, ${tx.json((input.after ?? {}) as any)})
    `;
    if ([
      "BusinessCreated", "CustomerCreated", "PetCreated", "AppointmentCreated",
      "AppointmentCompleted", "InvoiceCreated", "PaymentRecorded", "EmployeeCreated",
      "ServiceCreated"
    ].includes(input.eventType)) {
      await tx`
        insert into product_analytics_events
          (business_id,user_id,event_name,resource_id,properties)
        values (${input.businessId},${input.actorId ?? null},${input.eventType},${input.resourceId ?? null},
          ${tx.json((input.after ?? {}) as any)})
      `;
    }
  }
}

/** A client that holds the session token itself rather than relying on the browser cookie jar. */
function nativeClient(request: FastifyRequest): boolean {
  const declared = request.headers["x-pawsh-client"];
  return (typeof declared === "string" ? declared : declared?.[0] ?? "").trim().toLowerCase() === "native";
}

function sessionCookie(config: Config) {
  return {
    path: "/",
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24 * 14,
    signed: false
  };
}

export function registerRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
  documentStorage: DocumentStorage,
  schedulingHooks: SchedulingHooks = {},
  lifecycleHooks: LifecycleHooks = {},
  financialHooks: FinancialHooks = {},
  documentHooks?: DocumentHooks
): void {
  const authenticate = authentication(db);
  const authenticatePlatform = platformAuthentication(db);
  const abuse = new AuthAbuseProtector({
    secret:config.SESSION_SECRET,
    record:(event)=>app.log.info({ securityEvent:event }, "security event")
  });
  const invalidCredentialHash = "$argon2id$v=19$m=19456,t=2,p=1$8VmlYo465D+kq/0mXGEr/g$e/k9prNJPiZXPIVCxUkGskxSHFskuBBO8gFFQcihWrY";

  app.post("/api/auth/signup", async (request, reply) => {
    const input = body(signupSchema, request.body);
    const timezone=validateTimeZone(input.timezone);
    const email = normalizeEmail(input.email);
    await validateNewPassword(input.password, { email });
    const passwordHash = await hashPassword(input.password);
    const result = await db.begin(async (tx) => {
      const [user] = await tx<{ id: string }[]>`
        insert into users (email, normalized_email, password_hash, display_name)
        values (${input.email.trim()}, ${email}, ${passwordHash}, ${input.email.split("@",1)[0] ?? "Pawsh user"})
        returning id
      `;
      if (!user) throw new Error("User creation failed");
      const [business] = await tx<{ id: string }[]>`
        insert into businesses (name, email) values (${input.businessName}, ${email}) returning id
      `;
      if (!business) throw new Error("Business creation failed");
      await setTenant(tx, business.id);
      const [membership] = await tx<{ id: string }[]>`
        insert into business_memberships (business_id, user_id, is_owner, permissions)
        values (${business.id}, ${user.id}, true, ${permissions as unknown as string[]})
        returning id
      `;
      const [location] = await tx<{ id: string }[]>`
        insert into locations (business_id, name, timezone)
        values (${business.id}, ${input.businessName}, ${timezone})
        returning id
      `;
      await provisionBusinessCatalog(tx,business.id);
      const token = issueToken();
      await tx`
        insert into sessions (user_id, business_id, location_id, token_hash, expires_at)
        values (${user.id}, ${business.id}, ${location?.id ?? null}, ${tokenHash(token)}, now() + interval '14 days')
      `;
      await record(tx, {
        businessId: business.id, actorId: user.id, action: "business.create",
        resourceType: "business", resourceId: business.id,
        after: { name: input.businessName }, eventType: "BusinessCreated"
      });
      return { userId: user.id, businessId: business.id, membershipId: membership?.id, locationId: location?.id, token };
    });
    return reply
      .setCookie("pawsh_session", result.token, sessionCookie(config))
      .code(201)
      .send({ ...result, token: undefined });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = body(loginSchema, request.body);
    const email = normalizeEmail(input.email);
    const retryAfter = abuse.retryAfter(email, request.ip);
    if (retryAfter > 0) {
      abuse.event("auth.throttled", email, request.ip);
      return reply.header("retry-after", Math.max(1, Math.ceil(retryAfter / 1000)))
        .code(429).send({ error:"Too many authentication attempts; try again later" });
    }
    const [user] = await db<{ id: string; passwordHash: string }[]>`
      select id, password_hash from users
      where normalized_email = ${email} and disabled_at is null
    `;
    const valid = await verifyPassword(user?.passwordHash ?? invalidCredentialHash, input.password);
    if (!user || !valid) {
      abuse.failure(email, request.ip);
      abuse.event("login.failed", email, request.ip);
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    abuse.success(email);
    abuse.event("login.succeeded", email, request.ip);
    const [membership]=await db<{businessId:string}[]>`
      select business_id from business_memberships
      where user_id=${user.id} and status='active' order by created_at limit 1
    `;
    if(!membership)return reply.code(401).send({error:"Workspace access is unavailable"});
    const token = issueToken();
    await db`
      insert into sessions (user_id, business_id, token_hash, expires_at)
      values (${user.id}, ${membership.businessId}, ${tokenHash(token)}, now() + interval '14 days')
    `;
    // One transport per client. A browser gets the httpOnly cookie and never sees the token;
    // a native client declares itself and gets the token, with no cookie to be replayed. The
    // token is disclosed only to a client that asked for it at the moment it authenticated,
    // so there is no way to trade an existing cookie for a bearer credential.
    if (nativeClient(request)) return reply.send({ ok: true, token });
    return reply.setCookie("pawsh_session", token, sessionCookie(config)).send({ ok: true });
  });

  app.post("/api/auth/logout", { preHandler: authenticate }, async (request, reply) => {
    // Read through the shared accessor: a bearer client sends no cookie, and revoking nothing
    // while answering 204 would leave a live credential behind a "logged out" client.
    const token = sessionToken(request);
    if (token) await db`update sessions set revoked_at = now() where token_hash = ${tokenHash(token)}`;
    return reply.clearCookie("pawsh_session", { path: "/" }).code(204).send();
  });

  app.post("/api/workspace-access-requests", async (request, reply) => {
    const input=body(workspaceAccessRequestSchema,request.body);
    const normalizedEmail=normalizeEmail(input.requesterEmail);
    const throttleKey=`${normalizedEmail}:${input.workspaceName.toLocaleLowerCase("en-US")}`;
    const retryAfter=abuse.retryAfter(throttleKey,request.ip,"workspace-access");
    const generic={accepted:true,message:"If the request can be processed, the workspace administrator will be notified."};
    if(retryAfter>0)return reply.header("retry-after",Math.max(1,Math.ceil(retryAfter/1000))).code(202).send(generic);
    abuse.failure(throttleKey,request.ip,"workspace-access");
    abuse.event("workspace_access.requested",normalizedEmail,request.ip);
    const [business]=await db<{id:string;name:string}[]>`
      select distinct business.id,business.name from businesses business
      join business_memberships membership on membership.business_id=business.id
        and membership.is_owner and membership.status='active'
      join users owner_account on owner_account.id=membership.user_id and owner_account.disabled_at is null
      where business.status='active'
        and lower(btrim(business.name))=lower(btrim(${input.workspaceName}))
        and (owner_account.normalized_email=${normalizeEmail(input.workspaceAdminEmail)}
          or lower(btrim(coalesce(business.email,'')))=${normalizeEmail(input.workspaceAdminEmail)})
      limit 1
    `;
    if(!business)return reply.code(202).send(generic);
    await db.begin(async tx=>{
      await setTenant(tx,business.id);
      const [member]=await tx`
        select membership.id from business_memberships membership
        join users account on account.id=membership.user_id
        where membership.business_id=${business.id} and account.normalized_email=${normalizedEmail}
          and membership.status='active'
      `;
      if(member)return;
      const [created]=await tx<{id:string}[]>`
        insert into workspace_access_requests
          (business_id,requester_name,requester_email,normalized_email,message)
        values (${business.id},${input.requesterName},${input.requesterEmail.trim()},${normalizedEmail},${input.message??null})
        on conflict (business_id,normalized_email) where status='pending' do nothing returning id
      `;
      if(!created)return;
      await record(tx,{businessId:business.id,action:"workspace_access.request",resourceType:"workspace_access_request",resourceId:created.id,after:{requesterEmail:normalizedEmail},eventType:"WorkspaceAccessRequested"});
      const reviewers=await tx<{email:string}[]>`
        select distinct account.email from business_memberships membership
        join users account on account.id=membership.user_id and account.disabled_at is null
        where membership.business_id=${business.id} and membership.status='active'
          and (membership.is_owner or 'team.manage'=any(membership.permissions))
      `;
      const reviewBody=`${input.requesterName} (${input.requesterEmail.trim()}) requested access to ${business.name}.${input.message?` Message: ${input.message}`:""} Sign in to Pawsh and open Salon setup to review the request.`;
      for(const reviewer of reviewers)await tx`
        insert into notification_intents
          (business_id,notification_type,scheduled_occurrence,channel,destination,encrypted_body)
        values (${business.id},'workspace_access_request',now(),'email',${reviewer.email},${sealSecret(reviewBody,config.SESSION_SECRET)})
      `;
    });
    return reply.code(202).send(generic);
  });

  app.post("/api/auth/password-reset/request", async (request, reply) => {
    const input = body(passwordResetRequestSchema, request.body);
    const email = normalizeEmail(input.email);
    const retryAfter = abuse.retryAfter(email, request.ip, "reset");
    if (retryAfter > 0) {
      abuse.event("auth.throttled", email, request.ip);
      return reply.header("retry-after", Math.max(1, Math.ceil(retryAfter / 1000)))
        .code(429).send({ error:"Too many requests; try again later" });
    }
    abuse.failure(email, request.ip, "reset");
    abuse.event("password_reset.requested", email, request.ip);
    const [user] = await db<{ id: string; businessId: string | null }[]>`
      select user_account.id,
        (
          select membership.business_id from business_memberships membership
          where membership.user_id=user_account.id and membership.status='active'
          order by membership.created_at limit 1
        ) as business_id
      from users user_account
      where user_account.normalized_email=${email}
        and user_account.disabled_at is null
    `;
    let developmentToken: string | undefined;
    if (user) {
      const token = issueToken();
      await db.begin(async (tx) => {
        await tx`update password_reset_tokens set used_at=now() where user_id=${user.id} and used_at is null`;
        await tx`
          insert into password_reset_tokens(user_id,token_hash,expires_at)
          values (${user.id},${tokenHash(token)},now()+interval '30 minutes')
        `;
        if (user.businessId) {
          const resetMessage = [
            "A Pawsh password reset was requested for this email address.",
            `Open ${config.APP_ORIGIN}/?reset=${encodeURIComponent(token)} to choose a new password.`,
            "This link expires in 30 minutes. If you did not request it, you can ignore this message."
          ].join("\n\n");
          await tx`select set_config('app.business_id',${user.businessId},true)`;
          await tx`
            insert into notification_intents
              (business_id,customer_id,notification_type,scheduled_occurrence,channel,destination,encrypted_body)
            values (${user.businessId},null,'password_reset',now(),'email',${email},
              ${sealSecret(resetMessage,config.SESSION_SECRET)})
          `;
        }
      });
      if (config.NODE_ENV === "test") developmentToken = token;
    }
    return { accepted: true, ...(developmentToken ? { developmentToken } : {}) };
  });

  app.post("/api/auth/password-reset/confirm", async (request, reply) => {
    const input = body(passwordResetConfirmSchema, request.body);
    await validateNewPassword(input.password);
    const passwordHash = await hashPassword(input.password);
    const changed = await db.begin(async (tx) => {
      const [reset] = await tx<{ id: string; userId: string }[]>`
        select id,user_id from password_reset_tokens
        where token_hash=${tokenHash(input.token)} and used_at is null and expires_at>now() for update
      `;
      if (!reset) return false;
      await tx`update users set password_hash=${passwordHash},updated_at=now() where id=${reset.userId}`;
      await tx`update password_reset_tokens set used_at=now() where user_id=${reset.userId} and used_at is null`;
      await tx`update sessions set revoked_at=now() where user_id=${reset.userId} and revoked_at is null`;
      return true;
    });
    if (!changed) return reply.code(400).send({ error: "Reset token is invalid or expired" });
    return { changed: true };
  });

  app.post("/api/auth/invitations/accept", async (request, reply) => {
    const input = body(invitationAcceptSchema, request.body);
    const result = await db.begin(async (tx) => {
      const [invitation] = await tx<{
        id: string; businessId: string; email: string; normalizedEmail: string; permissions: string[];
      }[]>`
        select id,business_id,email,normalized_email,permissions from membership_invitations
        where token_hash=${tokenHash(input.token)} and accepted_at is null and revoked_at is null
          and expires_at>now() for update
      `;
      if (!invitation) return null;
      let [user] = await tx<{ id: string; passwordHash: string }[]>`
        select id,password_hash from users where normalized_email=${invitation.normalizedEmail}
      `;
      if (!user) {
        await validateNewPassword(input.password, { email:invitation.normalizedEmail });
        const passwordHash = await hashPassword(input.password);
        [user] = await tx<{ id: string; passwordHash: string }[]>`
          insert into users(email,normalized_email,password_hash,display_name)
          values (${invitation.email},${invitation.normalizedEmail},${passwordHash},${invitation.email.split("@",1)[0] ?? "Pawsh user"})
          returning id,password_hash
        `;
      } else {
        if (!(await verifyPassword(user.passwordHash, input.password))) {
          throw new Error("Existing Pawsh users must enter their current password");
        }
        const existingMembership = await tx`
          select id from business_memberships
          where business_id=${invitation.businessId} and user_id=${user.id}
        `;
        if (existingMembership.length) throw new Error("This user already belongs to the business");
      }
      if (!user) throw new Error("Invitation user creation failed");
      const [membership] = await tx<{ id: string }[]>`
        insert into business_memberships(business_id,user_id,permissions,status)
        values (${invitation.businessId},${user.id},${invitation.permissions},'active') returning id
      `;
      await tx`update membership_invitations set accepted_at=now() where id=${invitation.id}`;
      const token = issueToken();
      await tx`
        insert into sessions(user_id,business_id,token_hash,expires_at)
        values (${user.id},${invitation.businessId},${tokenHash(token)},now()+interval '14 days')
      `;
      await setTenant(tx, invitation.businessId);
      await record(tx, {
        businessId: invitation.businessId, actorId: user.id, action: "membership.accept",
        resourceType: "membership", resourceId: membership?.id
      });
      return { token, businessId: invitation.businessId };
    });
    if (!result) return reply.code(400).send({ error: "Invitation is invalid or expired" });
    return reply.setCookie("pawsh_session", result.token, sessionCookie(config)).send({ businessId: result.businessId });
  });

  app.get("/api/me", { preHandler: authenticate }, async (request) => {
    const context = auth(request);
    const [account] = await db<{ email: string; displayName: string }[]>`
      select email,display_name from users where id=${context.userId}
    `;
    // Joined on the session's already-resolved location id, so a multi-location
    // business returns exactly one deterministic row instead of an arbitrary one.
    const [business] = await db`
      select b.*, l.id as location_id, l.name as location_name, l.timezone, l.version as location_version,
        (select count(*)::int from locations c where c.business_id = b.id and c.active) as location_count
      from businesses b
      left join locations l
        on l.business_id = b.id and l.active and l.id = ${context.locationId}::uuid
      where b.id = ${context.businessId}
    `;
    return { ...context, account, business };
  });

  app.get("/api/workspaces",{preHandler:authenticate},async request=>{
    const context=auth(request);
    return db`
      select business.id,business.name,membership.is_owner,membership.permissions,
        (business.id=${context.businessId}) as current
      from business_memberships membership join businesses business on business.id=membership.business_id
      where membership.user_id=${context.userId} and membership.status='active' and business.status='active'
      order by current desc,business.name
    `;
  });

  app.post("/api/workspaces/select",{preHandler:authenticate},async(request,reply)=>{
    const context=auth(request);const input=body(workspaceSelectionSchema,request.body);
    const [membership]=await db<{id:string}[]>`
      select id from business_memberships where user_id=${context.userId}
        and business_id=${input.businessId} and status='active'
    `;
    if(!membership)return reply.code(404).send({error:"Workspace access is unavailable"});
    // Switching workspace must drop the previous workspace's location, otherwise the
    // session would reference a location owned by a different business.
    await db`update sessions set business_id=${input.businessId},location_id=null
      where token_hash=${tokenHash(sessionToken(request)??"")} and user_id=${context.userId}`;
    return {selected:true};
  });

  app.get("/api/locations",{preHandler:authenticate},async request=>{
    const context=auth(request);
    return db`
      select id,name,address,timezone,version,
        (id is not distinct from ${context.locationId}::uuid) as current
      from locations where business_id=${context.businessId} and active
      order by name,id
    `;
  });

  app.post("/api/me/location",{preHandler:authenticate},async(request,reply)=>{
    const context=auth(request);const input=body(locationSelectionSchema,request.body);
    const sessionTokenHash=tokenHash(sessionToken(request)??"");
    const selected=await db.begin(async tx=>{
      await setTenant(tx,context.businessId);
      // Scoped to the caller's business, so an id from another tenant is simply absent.
      const [location]=await tx<{id:string;name:string;timezone:string;version:number}[]>`
        select id,name,timezone,version from locations
        where business_id=${context.businessId} and id=${input.locationId} and active
      `;
      if(!location)return null;
      await tx`update sessions set location_id=${location.id}
        where token_hash=${sessionTokenHash} and user_id=${context.userId}`;
      return location;
    });
    if(!selected)return reply.code(404).send({error:"Location is unavailable"});
    return {locationId:selected.id,locationName:selected.name,timezone:selected.timezone,locationVersion:selected.version};
  });

  app.patch("/api/me", { preHandler: authenticate }, async (request) => {
    const context = auth(request);
    const input = body(ownProfileUpdateSchema, request.body);
    const [account] = await db.begin(async (tx) => {
      const [before] = await tx<{ displayName: string }[]>`
        select display_name from users where id=${context.userId} for update
      `;
      const rows = await tx<{ email: string; displayName: string }[]>`
        update users set display_name=${input.displayName},updated_at=now()
        where id=${context.userId}
        returning email,display_name
      `;
      await setTenant(tx, context.businessId);
      await record(tx, {
        businessId:context.businessId,actorId:context.userId,action:"account.profile.update",
        resourceType:"user",resourceId:context.userId,
        before:{ displayName:before?.displayName },after:{ displayName:input.displayName }
      });
      return rows;
    });
    return { account };
  });

  app.post("/api/me/password", { preHandler: authenticate }, async (request, reply) => {
    const context = auth(request);
    const input = body(passwordChangeSchema, request.body);
    const [account] = await db<{ email: string; passwordHash: string }[]>`
      select email,password_hash from users where id=${context.userId}
    `;
    const retryAfter=abuse.retryAfter(account?.email??context.userId,request.ip,"password-change");
    if(retryAfter>0){
      abuse.event("auth.throttled",account?.email??context.userId,request.ip);
      return reply.header("retry-after",Math.max(1,Math.ceil(retryAfter/1000))).code(429)
        .send({error:"Too many attempts; try again later"});
    }
    if (!account || !(await verifyPassword(account.passwordHash,input.currentPassword))) {
      abuse.failure(account?.email??context.userId,request.ip,"password-change");
      return reply.code(400).send({ error:"Current password is incorrect" });
    }
    abuse.success(account.email,"password-change");
    await validateNewPassword(input.newPassword,{ email:account.email });
    const passwordHash = await hashPassword(input.newPassword);
    // The caller's own session is the one exempted from the revocation sweep below, so it has
    // to be resolved from whichever transport the caller actually used.
    const currentTokenHash = tokenHash(sessionToken(request) ?? "");
    await db.begin(async (tx) => {
      await tx`update users set password_hash=${passwordHash},updated_at=now() where id=${context.userId}`;
      await tx`
        update sessions set revoked_at=now()
        where user_id=${context.userId} and revoked_at is null and token_hash<>${currentTokenHash}
      `;
      await setTenant(tx,context.businessId);
      await record(tx,{
        businessId:context.businessId,actorId:context.userId,action:"account.password.change",
        resourceType:"user",resourceId:context.userId
      });
    });
    return { changed:true };
  });

  app.get("/api/permissions", { preHandler: authenticate }, async () => ({
    permissions, presets: permissionPresets
  }));

  app.put("/api/business/settings", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(businessSettingsSchema, request.body);
    const timezone = validateTimeZone(input.timezone);
    return db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [activeLocation]=await tx<{id:string}[]>`select id from locations where business_id=${context.businessId} and id=${context.locationId}::uuid and active`;
      if(!activeLocation)return reply.code(404).send({error:"Active location not found"});
      await tx`select pg_advisory_xact_lock(hashtextextended(${'location-settings:' + activeLocation.id},0))`;
      const [location] = await tx<{ id:string; timezone:string; version:number }[]>`
        select id,timezone,version from locations
        where id=${activeLocation.id} and version=${input.locationVersion} for update
      `;
      if (!location) return reply.code(409).send({ code:"STALE_LOCATION_SETTINGS", error:"Location settings changed. Refresh and try again." });
      const [updated] = await tx`
        update businesses set name=${input.name}, phone=${input.phone ?? null}, email=${input.email ?? null},
          currency=${input.currency}, tax_rate_basis_points=${input.taxRateBasisPoints},
          reminder_lead_minutes=${input.reminderLeadMinutes}, updated_at=now()
        where id=${context.businessId} returning *
      `;
      await tx`
        update locations set name=${input.name}, timezone=${timezone}, version=version+1, updated_at=now()
        where id=${location.id}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "business.settings.update",
        resourceType: "business", resourceId: context.businessId,
        before:{ timezone:location.timezone }, after:{ timezone }
      });
      return updated;
    });
  });

  app.get("/api/members", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request) => {
    const context = auth(request);
    return db`
      select m.id, u.email, m.is_owner, m.permissions, m.status, m.created_at
      from business_memberships m join users u on u.id = m.user_id
      where m.business_id = ${context.businessId}
      order by m.is_owner desc, u.email
    `;
  });

  app.get("/api/workspace-access-requests",{
    preHandler:[authenticate,requirePermission("team.manage")]
  },async request=>{
    const context=auth(request);
    return db`
      select id,requester_name,requester_email,message,status,created_at,reviewed_at
      from workspace_access_requests where business_id=${context.businessId}
      order by (status='pending') desc,created_at desc limit 100
    `;
  });

  app.post("/api/workspace-access-requests/:id/approve",{
    preHandler:[authenticate,requirePermission("team.manage")]
  },async(request,reply)=>{
    const context=auth(request);const {id}=idParams.parse(request.params);
    const invitationToken=issueToken();
    const result=await db.begin(async tx=>{
      await setTenant(tx,context.businessId);
      const [accessRequest]=await tx<{id:string;requesterName:string;requesterEmail:string;normalizedEmail:string;status:string}[]>`
        select id,requester_name,requester_email,normalized_email,status
        from workspace_access_requests where business_id=${context.businessId} and id=${id} for update
      `;
      if(!accessRequest||accessRequest.status!=="pending")return null;
      const [user]=await tx<{id:string}[]>`select id from users where normalized_email=${accessRequest.normalizedEmail} and disabled_at is null`;
      let membershipId:string|null=null,invitationId:string|null=null,acceptancePath:string|null=null;
      if(user){
        const [existing]=await tx<{id:string;isOwner:boolean;status:string}[]>`
          select id,is_owner,status from business_memberships where business_id=${context.businessId} and user_id=${user.id}
        `;
        if(existing){
          membershipId=existing.id;
          await tx`update business_memberships set status='active',
              permissions=case when is_owner then permissions else ${permissionPresets.groomer as unknown as string[]} end,
              updated_at=now()
            where business_id=${context.businessId} and id=${existing.id}`;
        }else{
          const [created]=await tx<{id:string}[]>`
            insert into business_memberships(business_id,user_id,permissions,status)
            values (${context.businessId},${user.id},${permissionPresets.groomer as unknown as string[]},'active') returning id
          `;
          membershipId=created?.id??null;
        }
      }else{
        const [invitation]=await tx<{id:string}[]>`
          insert into membership_invitations
            (business_id,email,normalized_email,token_hash,permissions,invited_by,expires_at)
          values (${context.businessId},${accessRequest.requesterEmail},${accessRequest.normalizedEmail},${tokenHash(invitationToken)},
            ${permissionPresets.groomer as unknown as string[]},${context.userId},now()+interval '7 days')
          on conflict (business_id,normalized_email) do update set email=excluded.email,
            token_hash=excluded.token_hash,permissions=excluded.permissions,invited_by=excluded.invited_by,
            expires_at=excluded.expires_at,accepted_at=null,revoked_at=null,created_at=now()
          returning id
        `;
        invitationId=invitation?.id??null;
        acceptancePath=`/?invite=${encodeURIComponent(invitationToken)}`;
      }
      await tx`
        update workspace_access_requests set status='approved',reviewed_at=now(),reviewed_by=${context.userId},
          membership_id=${membershipId},invitation_id=${invitationId},updated_at=now()
        where business_id=${context.businessId} and id=${id}
      `;
      const [business]=await tx<{name:string}[]>`select name from businesses where id=${context.businessId}`;
      const message=acceptancePath
        ? `Your request to join ${business?.name??"the Pawsh workspace"} was approved. Complete account setup at ${config.APP_ORIGIN}${acceptancePath}`
        : `Your request to join ${business?.name??"the Pawsh workspace"} was approved. Sign in to Pawsh and select the workspace from Profile & Account.`;
      await tx`insert into notification_intents
        (business_id,notification_type,scheduled_occurrence,channel,destination,encrypted_body)
        values (${context.businessId},'workspace_access_approved',now(),'email',${accessRequest.requesterEmail},${sealSecret(message,config.SESSION_SECRET)})`;
      await record(tx,{businessId:context.businessId,actorId:context.userId,action:"workspace_access.approve",resourceType:"workspace_access_request",resourceId:id,after:{membershipId,invitationId},eventType:"WorkspaceAccessApproved"});
      return {approved:true,membershipCreated:Boolean(membershipId),invitationCreated:Boolean(invitationId),acceptancePath};
    });
    if(!result)return reply.code(404).send({error:"Pending access request not found"});
    return result;
  });

  app.post("/api/workspace-access-requests/:id/reject",{
    preHandler:[authenticate,requirePermission("team.manage")]
  },async(request,reply)=>{
    const context=auth(request);const {id}=idParams.parse(request.params);
    const result=await db.begin(async tx=>{
      await setTenant(tx,context.businessId);
      const [rejected]=await tx<{id:string;requesterEmail:string}[]>`
        update workspace_access_requests set status='rejected',reviewed_at=now(),reviewed_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id} and status='pending'
        returning id,requester_email
      `;
      if(!rejected)return false;
      await record(tx,{businessId:context.businessId,actorId:context.userId,action:"workspace_access.reject",resourceType:"workspace_access_request",resourceId:id,eventType:"WorkspaceAccessRejected"});
      return true;
    });
    if(!result)return reply.code(404).send({error:"Pending access request not found"});
    return {rejected:true};
  });

  app.post("/api/members/invitations", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    if (!context.isOwner) return reply.code(403).send({ error: "Only an Owner can invite members" });
    const input = body(invitationSchema, request.body);
    const invitationToken = issueToken();
    const normalized = normalizeEmail(input.email);
    const invitation = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [created] = await tx<{ id: string; email: string; permissions: string[]; expiresAt: Date }[]>`
        insert into membership_invitations
          (business_id,email,normalized_email,token_hash,permissions,invited_by,expires_at)
        values (${context.businessId},${input.email.trim()},${normalized},${tokenHash(invitationToken)},
          ${input.permissions},${context.userId},now()+interval '7 days')
        on conflict (business_id,normalized_email) do update set
          email=excluded.email,token_hash=excluded.token_hash,permissions=excluded.permissions,
          invited_by=excluded.invited_by,expires_at=excluded.expires_at,accepted_at=null,revoked_at=null,
          created_at=now()
        returning id,email,permissions,expires_at
      `;
      if (!created) throw new Error("Invitation creation failed");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "membership.invite",
        resourceType: "membership_invitation", resourceId: created.id,
        after: { email: created.email }, eventType: "MemberInvited"
      });
      return created;
    });
    return reply.code(201).send({
      ...invitation,
      acceptancePath: `/?invite=${encodeURIComponent(invitationToken)}`
    });
  });

  app.patch("/api/members/:id/permissions", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    if (!context.isOwner) return reply.code(403).send({ error: "Only an Owner can change member access" });
    const { id } = idParams.parse(request.params);
    const input = body(
      (await import("zod")).z.object({ permissions: (await import("zod")).z.array((await import("zod")).z.enum(permissions)) }),
      request.body
    );
    const member = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [before] = await tx<{ permissions: string[] }[]>`
        select permissions from business_memberships
        where id=${id} and business_id=${context.businessId} and not is_owner for update
      `;
      if (!before) return null;
      const [updated] = await tx`
        update business_memberships set permissions=${input.permissions},updated_at=now()
        where id=${id} and business_id=${context.businessId} and not is_owner
        returning id,permissions
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "membership.permissions.update",
        resourceType: "membership", resourceId: id,
        before: { permissions: before.permissions }, after: { permissions: input.permissions }
      });
      return updated;
    });
    if (!member) return reply.code(404).send({ error: "Editable member not found" });
    return member;
  });

  app.delete("/api/members/:id", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    if (!context.isOwner) return reply.code(403).send({ error: "Only an Owner can remove members" });
    const { id } = idParams.parse(request.params);
    const removed = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [membership] = await tx<{ userId: string; isOwner: boolean }[]>`
        select user_id,is_owner from business_memberships
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!membership) return false;
      if (membership.isOwner) throw new Error("Transfer ownership before removing an Owner");
      await tx`
        update business_memberships set status='disabled',updated_at=now()
        where business_id=${context.businessId} and id=${id}
      `;
      await tx`update sessions set revoked_at=now() where user_id=${membership.userId} and revoked_at is null`;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "membership.remove",
        resourceType: "membership", resourceId: id
      });
      return true;
    });
    if (!removed) return reply.code(404).send({ error: "Membership not found" });
    return reply.code(204).send();
  });

  app.post("/api/business/transfer-ownership", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    if (!context.isOwner) return reply.code(403).send({ error: "Only an Owner can transfer ownership" });
    const input = body(ownershipTransferSchema, request.body);
    if (input.membershipId === context.membershipId) {
      return reply.code(400).send({ error: "Select another active member" });
    }
    const transferred = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [target] = await tx<{ id: string }[]>`
        select id from business_memberships
        where business_id=${context.businessId} and id=${input.membershipId} and status='active' for update
      `;
      if (!target) return false;
      await tx`
        update business_memberships set is_owner=true,permissions=${permissions as unknown as string[]},
          updated_at=now() where id=${target.id}
      `;
      await tx`
        update business_memberships set is_owner=false,updated_at=now()
        where id=${context.membershipId}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "ownership.transfer",
        resourceType: "membership", resourceId: target.id,
        after: { previousOwnerMembershipId: context.membershipId }
      });
      return true;
    });
    if (!transferred) return reply.code(404).send({ error: "Active target member not found" });
    return { transferred: true };
  });

  app.get("/api/services", { preHandler: authenticate }, async (request) => {
    const context = auth(request);
    const canManage=context.isOwner||context.permissions.includes("services.manage");
    const services=await db<Record<string,unknown>[]>`select * from services where business_id = ${context.businessId} and (${canManage} or active) order by active desc, category, name`;
    const tiers=await db<{serviceId:string;pricingClass:string;weightTierCode:string;priceMinor:number}[]>`select service_id,pricing_class,weight_tier_code,price_minor from service_price_tiers where business_id=${context.businessId} and active order by pricing_class,weight_tier_code`;
    return services.map(service=>({...service,priceTiers:tiers.filter(tier=>tier.serviceId===service.id)}));
  });

  app.post("/api/services", {
    preHandler: [authenticate, requirePermission("services.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(serviceSchema, request.body);
    const service = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [created] = await tx<{ id: string }[]>`
        insert into services (business_id,name,description,base_duration_minutes,base_price_minor,category,pricing_mode,range_max_minor,price_confirmation_required,active)
        values (${context.businessId},${input.name},${input.description ?? null},
          ${input.baseDurationMinutes},${input.basePriceMinor},${input.category},${input.pricingMode},${input.rangeMaxMinor??null},${input.priceConfirmationRequired},${input.active}) returning *
      `;
      if (!created) throw new Error("Service creation failed");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "service.create",
        resourceType: "service", resourceId: created.id, eventType: "ServiceCreated"
      });
      return created;
    });
    return reply.code(201).send(service);
  });

  app.put("/api/services/:id", {
    preHandler: [authenticate, requirePermission("services.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(serviceSchema, request.body);
    const [service] = await db`
      update services set name=${input.name},description=${input.description ?? null},
        base_duration_minutes=${input.baseDurationMinutes},base_price_minor=${input.basePriceMinor},
        category=${input.category},pricing_mode=${input.pricingMode},range_max_minor=${input.rangeMaxMinor??null},
        price_confirmation_required=${input.priceConfirmationRequired},active=${input.active},
        updated_at=now()
      where business_id=${context.businessId} and id=${id} returning *
    `;
    if (!service) return reply.code(404).send({ error: "Service not found" });
    return service;
  });

  app.put("/api/services/:id/pricing",{preHandler:[authenticate,requirePermission("services.manage")]},async(request,reply)=>{
    const context=auth(request);const {id}=idParams.parse(request.params);const input=body(servicePricingSchema,request.body);
    const result=await db.begin(async tx=>{await setTenant(tx,context.businessId);const [service]=await tx<{id:string}[]>`select id from services where business_id=${context.businessId} and id=${id} for update`;if(!service)return false;
      for(const price of input.prices)await tx`insert into service_price_tiers(business_id,service_id,pricing_class,weight_tier_code,price_minor) values (${context.businessId},${id},${price.pricingClass},${price.weightTierCode},${price.priceMinor}) on conflict(service_id,pricing_class,weight_tier_code) do update set price_minor=excluded.price_minor,active=true,updated_at=now()`;
      await record(tx,{businessId:context.businessId,actorId:context.userId,action:"service.pricing.update",resourceType:"service",resourceId:id,after:{cells:input.prices.length}});return true;});
    if(!result)return reply.code(404).send({error:"Service not found"});return {updated:true};
  });

  app.delete("/api/services/:id", {
    preHandler: [authenticate, requirePermission("services.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [service] = await db`
      update services set active=false,updated_at=now()
      where business_id=${context.businessId} and id=${id} and active returning id
    `;
    if (!service) return reply.code(404).send({ error: "Active service not found" });
    return reply.code(204).send();
  });

  app.get("/api/employees", { preHandler: authenticate }, async (request) => {
    const context = auth(request);
    return db`
      select e.*,
        coalesce(array_agg(es.service_id) filter (where es.service_id is not null),'{}') as service_ids
      from employees e left join employee_services es on es.employee_id=e.id
      where e.business_id=${context.businessId}
      group by e.id order by e.active desc,e.display_name
    `;
  });

  app.post("/api/employees", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(employeeSchema, request.body);
    const employee = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [created] = await tx<{ id: string; displayName: string }[]>`
        insert into employees (business_id, membership_id, display_name)
        values (${context.businessId}, ${input.membershipId ?? null}, ${input.displayName})
        returning id, display_name
      `;
      if (!created) throw new Error("Employee creation failed");
      for (const serviceId of input.serviceIds) {
        await tx`
          insert into employee_services (business_id, employee_id, service_id)
          values (${context.businessId}, ${created.id}, ${serviceId})
        `;
      }
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "employee.create",
        resourceType: "employee", resourceId: created.id, eventType: "EmployeeCreated"
      });
      return created;
    });
    return reply.code(201).send(employee);
  });

  app.put("/api/employees/:id", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(employeeSchema, request.body);
    const employee = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [updated] = await tx<{ id: string }[]>`
        update employees set display_name=${input.displayName},membership_id=${input.membershipId ?? null},
          updated_at=now() where business_id=${context.businessId} and id=${id} returning *
      `;
      if (!updated) return null;
      await tx`delete from employee_services where business_id=${context.businessId} and employee_id=${id}`;
      for (const serviceId of input.serviceIds) {
        await tx`
          insert into employee_services(business_id,employee_id,service_id)
          values (${context.businessId},${id},${serviceId})
        `;
      }
      return updated;
    });
    if (!employee) return reply.code(404).send({ error: "Employee not found" });
    return employee;
  });

  app.delete("/api/employees/:id", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [employee] = await db`
      update employees set active=false,updated_at=now()
      where business_id=${context.businessId} and id=${id} and active returning id
    `;
    if (!employee) return reply.code(404).send({ error: "Active employee not found" });
    return reply.code(204).send();
  });

  app.get("/api/employees/:id/working-hours", {
    preHandler: [authenticate, requirePermission("calendar.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [employee] = await db<{ id: string }[]>`
      select id from employees where business_id=${context.businessId} and id=${id}
    `;
    if (!employee) return reply.code(404).send({ error: "Employee not found" });
    // HH:MM matches workingHoursSchema exactly, so the editor can feed this response straight
    // back into PUT without reformatting. Days with no stored period are simply absent (closed).
    return db`select weekday,to_char(start_time,'HH24:MI') as start_time,to_char(end_time,'HH24:MI') as end_time
      from employee_working_hours
      where business_id=${context.businessId} and employee_id=${id} order by weekday,start_time`;
  });

  app.put("/api/employees/:id/working-hours", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(workingHoursSchema, request.body);
    // Concurrency is enforced at one by database triggers (0002, 0015) and the
    // `one_groomer_per_appointment` index (0017), not by anything this handler could decide.
    // Accepting a higher number here would store a promise the database refuses to keep, so the
    // refusal is explicit and carries its own code rather than silently clamping to 1.
    if (input.hours.some((period) => period.appointmentLimit !== 1)) {
      return reply.code(400).send({
        code: "LIMIT_NOT_CONFIGURABLE",
        error: "Concurrent appointments per groomer are fixed at 1 and cannot be changed yet."
      });
    }
    const exists = await db`select id from employees where business_id=${context.businessId} and id=${id}`;
    if (!exists.length) return reply.code(404).send({ error: "Employee not found" });
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      await tx`delete from employee_working_hours where business_id=${context.businessId} and employee_id=${id}`;
      for (const period of input.hours) {
        await tx`
          insert into employee_working_hours (business_id,employee_id,weekday,start_time,end_time,appointment_limit)
          values (${context.businessId},${id},${period.weekday},${period.startTime},${period.endTime},${period.appointmentLimit})
        `;
      }
    });
    return reply.code(204).send();
  });

  /**
   * The whole availability grid in one response: every groomer, active or not, with the weekday
   * rows they actually have.
   *
   * The settings screen renders one row per groomer against a seven-day header. Fanning that out
   * to one request per groomer would make the page's cost scale with the size of the team and
   * would let it paint a half-loaded grid; this is a single indexed read either way.
   *
   * `days` is absent-means-closed, exactly as the per-employee endpoint is, and a groomer with no
   * rows at all comes back with an empty array. That empty array is not "closed all week" - the
   * booking path treats an unconfigured groomer as unrestricted, and the interface must say so.
   */
  app.get("/api/availability/working-hours", {
    preHandler: [authenticate, requirePermission("calendar.view")]
  }, async (request) => {
    const context = auth(request);
    const rows = await db<{
      id: string; displayName: string; active: boolean;
      weekday: number | null; startTime: string | null; endTime: string | null; appointmentLimit: number | null;
    }[]>`
      select employee.id,employee.display_name,employee.active,
        hours.weekday,
        to_char(hours.start_time,'HH24:MI') as start_time,
        to_char(hours.end_time,'HH24:MI') as end_time,
        hours.appointment_limit
      from employees employee
      left join employee_working_hours hours
        on hours.business_id=employee.business_id and hours.employee_id=employee.id
      where employee.business_id=${context.businessId}
      order by employee.active desc,employee.display_name,employee.id,hours.weekday,hours.start_time
    `;
    const employees: {
      id: string; displayName: string; active: boolean;
      days: { weekday: number; startTime: string; endTime: string; appointmentLimit: number }[];
    }[] = [];
    for (const row of rows) {
      let employee = employees.at(-1);
      if (employee?.id !== row.id) {
        employee = { id: row.id, displayName: row.displayName, active: row.active, days: [] };
        employees.push(employee);
      }
      if (row.weekday === null) continue;
      employee.days.push({
        weekday: row.weekday,
        startTime: row.startTime!,
        endTime: row.endTime!,
        appointmentLimit: row.appointmentLimit ?? 1
      });
    }
    return { employees };
  });

  /**
   * How many bookings were made outside each groomer's stated hours, per weekday.
   *
   * The hours grid marks the cells this lands on, so an operator editing availability can see
   * that bookings are routinely being routed around what they are about to change. One aggregate
   * for the whole grid, for the same reason the grid itself is one read.
   *
   * The weekday is the appointment's wall-clock weekday at the salon, derived from the instant
   * and the appointment's own recorded `scheduling_timezone`. A 22:30 booking in a Pacific salon
   * is a Tuesday evening, not a Wednesday morning, and grouping on the UTC instant would file it
   * under the wrong column of the grid.
   *
   * Deliberately not read from `scheduled_local_start`. That column is written by handing the
   * driver a bare local string, which the driver converts through the API host's timezone, so
   * outside a UTC host it holds the UTC instant rather than the local one - the exact error this
   * grouping has to avoid. `start_at at time zone scheduling_timezone` is right on every host.
   *
   * Cancelled and no-show appointments are excluded: the marker reads as live bookings sitting
   * outside the stated hours, and a cancelled one no longer sits anywhere. The window starts 60
   * days back and is unbounded ahead, so the marker reflects the recent past and everything
   * still to come rather than the whole history of the salon.
   */
  app.get("/api/availability/override-counts", {
    preHandler: [authenticate, requirePermission("calendar.view")]
  }, async (request) => {
    const context = auth(request);
    return db<{ employeeId: string; weekday: number; count: number }[]>`
      select appointment.employee_id,
        extract(dow from (appointment.start_at at time zone appointment.scheduling_timezone))::int as weekday,
        count(*)::int as count
      from appointments appointment
      where appointment.business_id=${context.businessId}
        and appointment.availability_overridden
        and appointment.status not in ('cancelled','no_show')
        and appointment.start_at >= now() - interval '60 days'
      group by 1,2
      order by 1,2
    `;
  });

  app.post("/api/blocked-times", {
    preHandler: [authenticate, requirePermission("appointments.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(blockedTimeSchema, request.body);
    const [location] = await db<{ timezone:string; version:number }[]>`
      select timezone,version from locations where business_id=${context.businessId} and id=${input.locationId} and active
    `;
    if (!location) return reply.code(404).send({ error:"Location not found" });
    if (location.version !== input.expectedLocationVersion) return reply.code(409).send({ code:"STALE_LOCATION_SETTINGS", error:"Location settings changed. Refresh and try again." });
    const start=resolveWallTime(input.localStart,location.timezone,input.startDisambiguation);
    const end=resolveWallTime(input.localEnd,location.timezone,input.endDisambiguation);
    if (start.instant >= end.instant) return reply.code(400).send({ error:"Blocked time must end after it starts" });
    const [created] = await db`
      insert into blocked_times (business_id,employee_id,location_id,start_at,end_at,scheduling_timezone,
        scheduled_local_start,scheduled_local_end,reason,created_by)
      values (${context.businessId},${input.employeeId},${input.locationId},${start.instant},${end.instant},${start.timeZone},
        ${input.localStart},${input.localEnd},${input.reason},${context.userId}) returning *
    `;
    return reply.code(201).send(created);
  });

  app.put("/api/business/working-hours", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request) => {
    const context = auth(request);
    const input = body(workingHoursSchema, request.body);
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [location] = await tx<{ id: string }[]>`
        select id from locations where business_id=${context.businessId} and id=${context.locationId}::uuid and active
      `;
      if (!location) throw new Error("Active location not found");
      await tx`delete from business_hours where business_id=${context.businessId} and location_id=${location.id}`;
      for (const period of input.hours) {
        await tx`
          insert into business_hours(business_id,location_id,weekday,start_time,end_time)
          values (${context.businessId},${location.id},${period.weekday},${period.startTime},${period.endTime})
        `;
      }
      // Salon hours are one of the inputs the booking path checks, and booking detects a stale
      // client through `expectedLocationVersion`. Rewriting the hours without moving the version
      // left a client that had cached the old grid booking against hours that no longer exist,
      // with nothing to tell it otherwise. The bump is in the same transaction as the rewrite so
      // the two can never be observed apart.
      await tx`
        update locations set version=version+1,updated_at=now()
        where business_id=${context.businessId} and id=${location.id}
      `;
    });
    return { saved: true };
  });

  app.get("/api/business/working-hours", {
    preHandler: [authenticate, requirePermission("calendar.view")]
  }, async (request) => {
    const context=auth(request);
    return db`select weekday,to_char(start_time,'HH24:MI') as start_time,to_char(end_time,'HH24:MI') as end_time
      from business_hours
      where business_id=${context.businessId} and location_id=${context.locationId}::uuid
      order by weekday,start_time`;
  });

  /**
   * Closure days for one shop over a bounded range.
   *
   * Scoped to the location on purpose: one shop closing for a flood is not both shops closing,
   * and a business-wide answer could not express the difference. `from`/`to` are both required so
   * a salon with years of recorded holidays cannot be made to return all of them at once.
   */
  app.get("/api/locations/:locationId/closure-days", {
    preHandler: [authenticate, requirePermission("calendar.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { locationId } = locationParams.parse(request.params);
    const range = body(closureDayQuerySchema, request.query);
    // Scoped to the caller's business, so a location id from another tenant is simply absent.
    const [location] = await db<{ id: string; timezone: string }[]>`
      select id,timezone from locations where business_id=${context.businessId} and id=${locationId}
    `;
    if (!location) return reply.code(404).send({ error: "Location not found" });
    // A date appears when it is closed, when it carries live appointments, or both. The booked
    // count is what lets the confirmation state a real number before someone shuts a day:
    // closing a day with bookings on it is allowed, but it must never happen silently, because
    // those appointments are not cancelled by the closure and would otherwise be stranded.
    //
    // The day an appointment belongs to is its wall-clock day at the salon, derived here from the
    // instant and the appointment's OWN recorded `scheduling_timezone`. Near local midnight that
    // disagrees with the UTC instant, and the salon's answer is the one an operator means.
    //
    // Not read from `scheduled_local_start`, despite the name: that column is written by handing
    // the driver a bare local string, which converts it through the API host's timezone, so its
    // contents are the UTC instant on any server not running in UTC. Deriving from `start_at`
    // gives the same answer on every host. See the note in the completion report.
    //
    // The instant window is widened a day at each end so an appointment whose own timezone
    // differs from the location's current one cannot fall outside it; the derived date, not the
    // window, decides what is counted. Bounding on `start_at` keeps `appointment_calendar` usable.
    const window = {
      from: localDateBounds(shiftLocalDate(range.from, -1), location.timezone).from,
      to: localDateBounds(shiftLocalDate(range.to, 1), location.timezone).to
    };
    const days = await db<{
      localDate: string; closed: boolean; reason: string | null; bookedAppointments: number;
    }[]>`
      with closure as (
        select local_date,reason from location_closure_days
        where business_id=${context.businessId} and location_id=${locationId}
          and local_date between ${range.from}::date and ${range.to}::date
      ), booked as (
        select (appointment.start_at at time zone appointment.scheduling_timezone)::date as local_date,
          count(*)::int as bookings
        from appointments appointment
        where appointment.business_id=${context.businessId} and appointment.location_id=${locationId}
          and appointment.status not in ('cancelled','no_show')
          and appointment.start_at >= ${window.from} and appointment.start_at < ${window.to}
        group by 1
        having (appointment.start_at at time zone appointment.scheduling_timezone)::date
          between ${range.from}::date and ${range.to}::date
      )
      select to_char(coalesce(closure.local_date,booked.local_date),'YYYY-MM-DD') as local_date,
        closure.local_date is not null as closed,
        closure.reason,
        coalesce(booked.bookings,0)::int as booked_appointments
      from closure full outer join booked on booked.local_date=closure.local_date
      order by 1
    `;
    return { locationId, from: range.from, to: range.to, days };
  });

  /**
   * Replaces one month's closure days for one shop.
   *
   * The month, not the submitted list, defines what may be deleted: a save publishes a single
   * month's answer and must leave every other month alone. Repeating the same save changes
   * nothing, so a retried request from a flaky connection is safe.
   *
   * The location version moves with the write, in the same transaction. Closure days are a
   * booking input, and booking detects a stale client through `expectedLocationVersion`; without
   * the bump a client holding yesterday's calendar would keep offering a day the salon just shut.
   */
  app.put("/api/locations/:locationId/closure-days", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { locationId } = locationParams.parse(request.params);
    const input = body(closureDaysSchema, request.body);
    const closedDates = [...new Set(input.closedDates)].sort();
    const monthStart = `${input.month}-01`;
    const saved = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      // Locked for the same reason the settings writer locks: two concurrent saves must not both
      // read the same version and both write version+1.
      const [location] = await tx<{ id: string; version: number }[]>`
        select id,version from locations
        where business_id=${context.businessId} and id=${locationId} for update
      `;
      if (!location) return null;
      await tx`
        delete from location_closure_days
        where business_id=${context.businessId} and location_id=${locationId}
          and local_date >= ${monthStart}::date
          and local_date < (${monthStart}::date + interval '1 month')
          and not (to_char(local_date,'YYYY-MM-DD') = any(${closedDates}::text[]))
      `;
      for (const localDate of closedDates) {
        // A date that is already closed keeps the reason it was recorded with, so re-saving a
        // month does not blank out an explanation somebody typed.
        await tx`
          insert into location_closure_days (business_id,location_id,local_date,reason,created_by)
          values (${context.businessId},${locationId},${localDate}::date,${input.reason ?? null},${context.userId})
          on conflict (location_id,local_date) do nothing
        `;
      }
      const [updated] = await tx<{ version: number }[]>`
        update locations set version=version+1,updated_at=now()
        where business_id=${context.businessId} and id=${locationId}
        returning version
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "location.closure_days.save",
        resourceType: "location", resourceId: locationId,
        after: { month: input.month, closedDates }
      });
      return { locationVersion: updated!.version };
    });
    if (!saved) return reply.code(404).send({ error: "Location not found" });
    return { locationId, month: input.month, closedDates, locationVersion: saved.locationVersion };
  });

  app.get("/api/customers", {
    preHandler: [authenticate, requirePermission("customers.view")]
  }, async (request) => {
    const context = auth(request);
    const query=body(customerDirectoryQuerySchema,request.query);
    const search=query.q??query.search??"";
    const normalizedSearchPhone=normalizePhone(search)??search;
    if(!query.paged)return db`
      select * from customers
      where business_id=${context.businessId} and archived_at is null
        and (${search}='' or concat_ws(' ',first_name,last_name) ilike ${`%${search}%`}
          or normalized_phone like ${`%${normalizedSearchPhone}%`}
          or normalized_email ilike ${`%${search.toLowerCase()}%`})
      order by last_name,first_name,id limit 100`;
    const offset=(query.page-1)*query.pageSize;
    const statusCondition=query.status==="all"?db`true`:query.status==="active"?db`customer.archived_at is null`:db`customer.archived_at is not null`;
    const upcomingCondition=query.upcoming==="any"?db`true`:query.upcoming==="yes"?db`summary.next_appointment is not null`:db`summary.next_appointment is null`;
    const searchCondition=db`(${search}='' or concat_ws(' ',customer.first_name,customer.last_name) ilike ${`%${search}%`}
      or customer.normalized_phone like ${`%${normalizedSearchPhone}%`}
      or customer.normalized_email ilike ${`%${search.toLowerCase()}%`}
      or exists(select 1 from pets search_pet where search_pet.business_id=customer.business_id
        and search_pet.customer_id=customer.id and search_pet.archived_at is null
        and (search_pet.name ilike ${`%${search}%`} or search_pet.breed ilike ${`%${search}%`})))`;
    const order=query.sort==="lastVisit"
      ? query.direction==="desc"?db`summary.last_visit desc nulls last,customer.id`:db`summary.last_visit asc nulls last,customer.id`
      : query.sort==="nextAppointment"
        ? query.direction==="desc"?db`summary.next_appointment desc nulls last,customer.id`:db`summary.next_appointment asc nulls last,customer.id`
        : query.direction==="desc"?db`customer.last_name desc,customer.first_name desc,customer.id`:db`customer.last_name,customer.first_name,customer.id`;
    const base=db`
      from customers customer
      left join employees preferred_employee
        on preferred_employee.business_id=customer.business_id
        and preferred_employee.id=customer.preferred_employee_id
      left join lateral (
        select
          max(appointment.start_at) filter(where appointment.start_at<now() and appointment.status='completed') last_visit,
          min(appointment.start_at) filter(where appointment.start_at>=now() and appointment.status='scheduled') next_appointment
        from appointments appointment where appointment.business_id=customer.business_id and appointment.customer_id=customer.id
      ) summary on true
      where customer.business_id=${context.businessId} and ${statusCondition} and ${searchCondition} and ${upcomingCondition}`;
    const [rows,totalRows]=await Promise.all([
      db`select customer.id,customer.first_name,customer.last_name,customer.phone,customer.email,
        customer.archived_at,summary.last_visit,summary.next_appointment,
        customer.preferred_employee_id,preferred_employee.display_name preferred_employee_name,
        coalesce((select json_agg(json_build_object('id',pet.id,'name',pet.name,'breed',pet.breed,'safetyAlerts',pet.safety_alerts)
          order by pet.name,pet.id) from pets pet where pet.business_id=customer.business_id
          and pet.customer_id=customer.id and pet.archived_at is null),'[]') pets
        ${base} order by ${order} limit ${query.pageSize} offset ${offset}`,
      db<{count:number}[]>`select count(*)::int count ${base}`
    ]);
    return {items:rows,total:totalRows[0]?.count??0,page:query.page,pageSize:query.pageSize};
  });

  app.post("/api/customers", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(customerSchema, request.body);
    const customer = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [created] = await tx<(Record<string, unknown> & { id: string })[]>`
        insert into customers
          (business_id, first_name, last_name, phone, normalized_phone, email, normalized_email,
           address, preferred_contact_method, email_allowed, created_by, updated_by)
        values
          (${context.businessId}, ${input.firstName ?? null}, ${input.lastName ?? null}, ${input.phone ?? null},
           ${normalizePhone(input.phone)}, ${input.email ?? null},
           ${input.email ? normalizeEmail(input.email) : null}, ${input.address ?? null},
           ${input.preferredContactMethod}, ${input.emailAllowed},
           ${context.userId}, ${context.userId})
        returning *
      `;
      if (!created) throw new Error("Customer creation failed");
      // `notes` is written through the thread; the mirror trigger fills the column back in.
      const noteWritten = await applyLegacyCustomerNote(tx, {
        businessId: context.businessId, customerId: created.id,
        actorId: context.userId, value: input.notes
      });
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "customer.create",
        resourceType: "customer", resourceId: created.id, eventType: "CustomerCreated"
      });
      if (!noteWritten) return created;
      const [stored] = await tx<(Record<string, unknown> & { id: string })[]>`
        select * from customers where business_id=${context.businessId} and id=${created.id}
      `;
      return stored ?? created;
    });
    return reply.code(201).send(customer);
  });

  app.get("/api/customers/archived", {
    preHandler: [authenticate, requirePermission("customers.view"), requirePermission("pets.care.view")]
  }, async (request) => {
    const context = auth(request);
    return db`
      select customer.id as customer_id,customer.first_name,customer.last_name,
        pet.id as pet_id,pet.name as pet_name,pet.archived_at as pet_archived_at
      from customers customer
      join pets pet on pet.business_id=customer.business_id and pet.customer_id=customer.id
      where customer.business_id=${context.businessId} and customer.archived_at is not null
      order by customer.last_name,customer.first_name,customer.id,pet.name,pet.id
      limit 500
    `;
  });

  app.put("/api/customers/:id", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(customerSchema, request.body);
    // Transactional because the legacy `notes` field now writes through the note thread: the
    // thread edit and the customer edit must land (or fail) together, and the thread edit runs
    // first so the mirror trigger has already refreshed `notes` by the time this returns it.
    const updated = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [existing] = await tx<{ id: string }[]>`
        select id from customers
        where business_id=${context.businessId} and id=${id} and archived_at is null for update
      `;
      if (!existing) return null;
      await applyLegacyCustomerNote(tx, {
        businessId: context.businessId, customerId: id,
        actorId: context.userId, value: input.notes
      });
      const [row] = await tx<(Record<string, unknown> & { id: string })[]>`
        update customers set first_name=${input.firstName ?? null},last_name=${input.lastName ?? null},
          phone=${input.phone ?? null},normalized_phone=${normalizePhone(input.phone)},
          email=${input.email ?? null},normalized_email=${input.email ? normalizeEmail(input.email) : null},
          address=${input.address ?? null},preferred_contact_method=${input.preferredContactMethod},
          email_allowed=${input.emailAllowed},
          updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id} and archived_at is null returning *
      `;
      return row ?? null;
    });
    if (!updated) return reply.code(404).send({ error: "Active customer not found" });
    return updated;
  });

  app.patch("/api/customers/:id/preferred-groomer", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context=auth(request),{id}=idParams.parse(request.params),input=body(preferredGroomerSchema,request.body);
    if(input.employeeId){
      const [employee]=await db`select id from employees where business_id=${context.businessId} and id=${input.employeeId} and active`;
      if(!employee)return reply.code(400).send({error:"Choose an active groomer"});
    }
    const [customer]=await db`
      update customers set preferred_employee_id=${input.employeeId},updated_by=${context.userId},updated_at=now()
      where business_id=${context.businessId} and id=${id} and archived_at is null returning id,preferred_employee_id
    `;
    if(!customer)return reply.code(404).send({error:"Active customer not found"});
    return customer;
  });

  // ---------------------------------------------------------------------------
  // Client addresses and contacts
  //
  // A client is rarely one address and one phone number. Both lists carry exactly one primary,
  // and promoting a record demotes the incumbent inside the same transaction — the partial
  // unique index would otherwise reject the second primary and leave the caller to work out why.
  // ---------------------------------------------------------------------------
  async function customerAddressRows(database: Database, businessId: string, customerId: string) {
    return database`
      select id,address,label,is_primary,created_at,updated_at from customer_addresses
      where business_id=${businessId} and customer_id=${customerId}
      order by is_primary desc,created_at,id
    `;
  }

  async function customerContactRows(database: Database, businessId: string, customerId: string) {
    return database`
      select id,name,phone,title,receives_automated_messages,is_primary,created_at,updated_at
      from customer_contacts
      where business_id=${businessId} and customer_id=${customerId}
      order by is_primary desc,created_at,id
    `;
  }

  async function activeCustomer(businessId: string, customerId: string) {
    const [customer] = await db<{ id: string }[]>`
      select id from customers
      where business_id=${businessId} and id=${customerId} and archived_at is null
    `;
    return customer ?? null;
  }

  /** Step the current primary down so the partial unique index has room for the new one. */
  async function demotePrimary(
    tx: Transaction, table: "customer_addresses" | "customer_contacts",
    businessId: string, customerId: string, keepId: string | null
  ) {
    const scope = table === "customer_addresses"
      ? tx`update customer_addresses set is_primary=false,updated_at=now()
           where business_id=${businessId} and customer_id=${customerId} and is_primary
             and (${keepId}::uuid is null or id<>${keepId}::uuid)`
      : tx`update customer_contacts set is_primary=false,updated_at=now()
           where business_id=${businessId} and customer_id=${customerId} and is_primary
             and (${keepId}::uuid is null or id<>${keepId}::uuid)`;
    await scope;
  }

  app.get("/api/customers/:id/addresses", {
    preHandler: [authenticate, requirePermission("customers.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    if (!await activeCustomer(context.businessId, id)) {
      return reply.code(404).send({ error: "Customer not found" });
    }
    return { items: await customerAddressRows(db, context.businessId, id) };
  });

  app.post("/api/customers/:id/addresses", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(customerAddressCreateSchema, request.body);
    if (!await activeCustomer(context.businessId, id)) {
      return reply.code(404).send({ error: "Customer not found" });
    }
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [existing] = await tx<{ count: number }[]>`
        select count(*)::int count from customer_addresses
        where business_id=${context.businessId} and customer_id=${id}
      `;
      // The first address is the primary whether or not anybody said so: a list of one with no
      // primary would leave the mirrored column empty for no reason.
      const primary = input.isPrimary || (existing?.count ?? 0) === 0;
      if (primary) await demotePrimary(tx, "customer_addresses", context.businessId, id, null);
      await tx`
        insert into customer_addresses (business_id,customer_id,address,label,is_primary,created_by)
        values (${context.businessId},${id},${input.address},${input.label ?? null},${primary},${context.userId})
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "customer.address.create", resourceType: "customer", resourceId: id
      });
    });
    return reply.code(201).send({ items: await customerAddressRows(db, context.businessId, id) });
  });

  app.patch("/api/customers/:id/addresses/:childId", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id, childId } = customerChildParams.parse(request.params);
    const input = body(customerAddressUpdateSchema, request.body);
    const updated = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [current] = await tx<{ id: string; address: string; label: string | null; isPrimary: boolean }[]>`
        select id,address,label,is_primary from customer_addresses
        where business_id=${context.businessId} and customer_id=${id} and id=${childId} for update
      `;
      if (!current) return null;
      if (input.isPrimary) await demotePrimary(tx, "customer_addresses", context.businessId, id, childId);
      await tx`
        update customer_addresses set
          address=${input.address ?? current.address},
          label=${input.label === undefined ? current.label : input.label},
          is_primary=${input.isPrimary ?? current.isPrimary},updated_at=now()
        where business_id=${context.businessId} and id=${childId}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "customer.address.edit", resourceType: "customer", resourceId: id
      });
      return current;
    });
    if (!updated) return reply.code(404).send({ error: "Address not found" });
    return { items: await customerAddressRows(db, context.businessId, id) };
  });

  app.delete("/api/customers/:id/addresses/:childId", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id, childId } = customerChildParams.parse(request.params);
    const removed = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [row] = await tx<{ id: string; isPrimary: boolean }[]>`
        delete from customer_addresses
        where business_id=${context.businessId} and customer_id=${id} and id=${childId}
        returning id,is_primary
      `;
      if (!row) return null;
      // Deleting the primary promotes the next one rather than leaving the client with several
      // addresses and no answer to "where do we go?".
      if (row.isPrimary) {
        await tx`
          update customer_addresses set is_primary=true,updated_at=now()
          where business_id=${context.businessId} and id=(
            select id from customer_addresses
            where business_id=${context.businessId} and customer_id=${id}
            order by created_at,id limit 1
          )
        `;
      }
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "customer.address.delete", resourceType: "customer", resourceId: id
      });
      return row;
    });
    if (!removed) return reply.code(404).send({ error: "Address not found" });
    return { items: await customerAddressRows(db, context.businessId, id) };
  });

  app.get("/api/customers/:id/contacts", {
    preHandler: [authenticate, requirePermission("customers.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    if (!await activeCustomer(context.businessId, id)) {
      return reply.code(404).send({ error: "Customer not found" });
    }
    return {
      items: await customerContactRows(db, context.businessId, id),
      // Said in the payload as well as the interface: a caller reading this list must not take
      // the flag to mean anything is being sent.
      automatedMessagesSupported: false
    };
  });

  app.post("/api/customers/:id/contacts", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(customerContactCreateSchema, request.body);
    if (!await activeCustomer(context.businessId, id)) {
      return reply.code(404).send({ error: "Customer not found" });
    }
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [existing] = await tx<{ count: number }[]>`
        select count(*)::int count from customer_contacts
        where business_id=${context.businessId} and customer_id=${id}
      `;
      const primary = input.isPrimary || (existing?.count ?? 0) === 0;
      if (primary) await demotePrimary(tx, "customer_contacts", context.businessId, id, null);
      await tx`
        insert into customer_contacts
          (business_id,customer_id,name,phone,normalized_phone,title,
           receives_automated_messages,is_primary,created_by)
        values (${context.businessId},${id},${input.name},${input.phone},
          ${normalizePhone(input.phone)},${input.title ?? null},
          ${input.receivesAutomatedMessages},${primary},${context.userId})
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "customer.contact.create", resourceType: "customer", resourceId: id
      });
    });
    return reply.code(201).send({ items: await customerContactRows(db, context.businessId, id) });
  });

  app.patch("/api/customers/:id/contacts/:childId", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id, childId } = customerChildParams.parse(request.params);
    const input = body(customerContactUpdateSchema, request.body);
    const updated = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [current] = await tx<{
        id: string; name: string; phone: string; title: string | null;
        receivesAutomatedMessages: boolean; isPrimary: boolean;
      }[]>`
        select id,name,phone,title,receives_automated_messages,is_primary from customer_contacts
        where business_id=${context.businessId} and customer_id=${id} and id=${childId} for update
      `;
      if (!current) return null;
      if (input.isPrimary) await demotePrimary(tx, "customer_contacts", context.businessId, id, childId);
      const phone = input.phone ?? current.phone;
      await tx`
        update customer_contacts set
          name=${input.name ?? current.name},
          phone=${phone},normalized_phone=${normalizePhone(phone)},
          title=${input.title === undefined ? current.title : input.title},
          receives_automated_messages=${input.receivesAutomatedMessages ?? current.receivesAutomatedMessages},
          is_primary=${input.isPrimary ?? current.isPrimary},updated_at=now()
        where business_id=${context.businessId} and id=${childId}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "customer.contact.edit", resourceType: "customer", resourceId: id
      });
      return current;
    });
    if (!updated) return reply.code(404).send({ error: "Contact not found" });
    return { items: await customerContactRows(db, context.businessId, id) };
  });

  app.delete("/api/customers/:id/contacts/:childId", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id, childId } = customerChildParams.parse(request.params);
    const removed = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [row] = await tx<{ id: string; isPrimary: boolean }[]>`
        delete from customer_contacts
        where business_id=${context.businessId} and customer_id=${id} and id=${childId}
        returning id,is_primary
      `;
      if (!row) return null;
      if (row.isPrimary) {
        await tx`
          update customer_contacts set is_primary=true,updated_at=now()
          where business_id=${context.businessId} and id=(
            select id from customer_contacts
            where business_id=${context.businessId} and customer_id=${id}
            order by created_at,id limit 1
          )
        `;
      }
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "customer.contact.delete", resourceType: "customer", resourceId: id
      });
      return row;
    });
    if (!removed) return reply.code(404).send({ error: "Contact not found" });
    return { items: await customerContactRows(db, context.businessId, id) };
  });

  app.get("/api/customers/:id/notes", {
    preHandler: [authenticate, requirePermission("customers.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const query = body(customerNoteQuerySchema, request.query);
    const [customer] = await db<{ id: string }[]>`
      select id from customers where business_id=${context.businessId} and id=${id}
    `;
    if (!customer) return reply.code(404).send({ error: "Customer not found" });
    const [items, totals] = await Promise.all([
      customerNoteRows(db, {
        businessId: context.businessId, customerId: id,
        limit: query.pageSize, offset: (query.page - 1) * query.pageSize
      }),
      db<{ count: number }[]>`
        select count(*)::int count from customer_notes
        where business_id=${context.businessId} and customer_id=${id}
      `
    ]);
    return { items, total: totals[0]?.count ?? 0, page: query.page, pageSize: query.pageSize };
  });

  app.post("/api/customers/:id/notes", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(customerNoteCreateSchema, request.body);
    const created = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [customer] = await tx<{ id: string }[]>`
        select id from customers
        where business_id=${context.businessId} and id=${id} and archived_at is null
      `;
      if (!customer) return null;
      const [note] = await tx<{ id: string }[]>`
        insert into customer_notes (business_id, customer_id, body, pinned, created_by)
        values (${context.businessId}, ${id}, ${input.body}, ${input.pinned}, ${context.userId})
        returning id
      `;
      if (!note) throw new Error("Client note creation failed");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "customer.note.create",
        resourceType: "customer_note", resourceId: note.id,
        after: { customerId: id, pinned: input.pinned }
      });
      return note;
    });
    if (!created) return reply.code(404).send({ error: "Active customer not found" });
    const [note] = await customerNoteRows(db, {
      businessId: context.businessId, customerId: id, noteId: created.id, limit: 1, offset: 0
    });
    return reply.code(201).send(note);
  });

  app.patch("/api/customers/:id/notes/:noteId", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id, noteId } = customerNoteParams.parse(request.params);
    const input = body(customerNoteUpdateSchema, request.body);
    const changed = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [note] = await tx<{ id: string; pinned: boolean }[]>`
        update customer_notes note
        set body=coalesce(${input.body ?? null}::text,note.body),
          pinned=coalesce(${input.pinned ?? null}::boolean,note.pinned),
          updated_at=now()
        where note.business_id=${context.businessId} and note.id=${noteId} and note.customer_id=${id}
          and exists (select 1 from customers customer
            where customer.business_id=note.business_id and customer.id=note.customer_id
              and customer.archived_at is null)
        returning note.id,note.pinned
      `;
      if (!note) return null;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "customer.note.update",
        resourceType: "customer_note", resourceId: note.id,
        after: { customerId: id, pinned: note.pinned }
      });
      return note;
    });
    if (!changed) return reply.code(404).send({ error: "Client note not found" });
    const [note] = await customerNoteRows(db, {
      businessId: context.businessId, customerId: id, noteId: changed.id, limit: 1, offset: 0
    });
    return note;
  });

  app.delete("/api/customers/:id/notes/:noteId", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id, noteId } = customerNoteParams.parse(request.params);
    const removed = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [note] = await tx<{ id: string }[]>`
        delete from customer_notes note
        where note.business_id=${context.businessId} and note.id=${noteId} and note.customer_id=${id}
          and exists (select 1 from customers customer
            where customer.business_id=note.business_id and customer.id=note.customer_id
              and customer.archived_at is null)
        returning note.id
      `;
      if (!note) return null;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "customer.note.delete",
        resourceType: "customer_note", resourceId: note.id, before: { customerId: id }
      });
      return note;
    });
    if (!removed) return reply.code(404).send({ error: "Client note not found" });
    return reply.code(204).send();
  });

  // Preferences live on the customer row and are already returned by every customer read
  // (`select *`). Only the write side needs its own endpoint, and it is a partial PATCH so a
  // caller that does not know about a switch can never reset it, which a full-object PUT would.
  app.patch("/api/customers/:id/preferences", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(customerPreferencesSchema, request.body);
    const clearFrequency = "bookingFrequencyWeeks" in input && input.bookingFrequencyWeeks === null;
    const updated = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [before] = await tx<CustomerPreferences[]>`
        select id,booking_frequency_weeks,block_messages,block_online_booking,
          marketing_sms_allowed,email_allowed
        from customers
        where business_id=${context.businessId} and id=${id} and archived_at is null for update
      `;
      if (!before) return null;
      const [after] = await tx<CustomerPreferences[]>`
        update customers set
          booking_frequency_weeks=case when ${clearFrequency} then null
            else coalesce(${input.bookingFrequencyWeeks ?? null}::int,booking_frequency_weeks) end,
          block_messages=coalesce(${input.blockMessages ?? null}::boolean,block_messages),
          block_online_booking=coalesce(${input.blockOnlineBooking ?? null}::boolean,block_online_booking),
          marketing_sms_allowed=coalesce(${input.marketingSmsAllowed ?? null}::boolean,marketing_sms_allowed),
          email_allowed=coalesce(${input.emailAllowed ?? null}::boolean,email_allowed),
          updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id} and archived_at is null
        returning id,booking_frequency_weeks,block_messages,block_online_booking,
          marketing_sms_allowed,email_allowed
      `;
      if (!after) return null;
      // Contact-consent switches are auditable: record what actually changed.
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "customer.preferences.update", resourceType: "customer", resourceId: id,
        before, after
      });
      return after;
    });
    if (!updated) return reply.code(404).send({ error: "Active customer not found" });
    return updated;
  });

  // -------------------------------------------------------------------------
  // Client agreements
  //
  // Templates are salon-authored content: reading them needs client access (the
  // profile panel renders the document text), authoring them is a settings act.
  // -------------------------------------------------------------------------

  app.get("/api/agreement-templates", { preHandler: authenticate }, async (request, reply) => {
    const context = auth(request);
    const mayRead = context.isOwner
      || context.permissions.includes("customers.view")
      || context.permissions.includes("settings.manage");
    if (!mayRead) return reply.code(403).send({ error: "Missing permission: customers.view" });
    const query = body(agreementTemplateQuerySchema, request.query);
    const activeOnly = query.status === "all" ? null : query.status === "active";
    return db<Record<string, unknown>[]>`
      select template.id,template.name,template.body,template.required,template.active,
        template.version,template.created_by,template.created_at,template.updated_at,
        (select count(*)::int from customer_agreements state
          where state.business_id=template.business_id
            and state.agreement_template_id=template.id and state.status='signed') as signed_count
      from agreement_templates template
      where template.business_id=${context.businessId}
        and (${activeOnly}::boolean is null or template.active=${activeOnly}::boolean)
      order by template.active desc,template.required desc,lower(btrim(template.name)),template.id
    `;
  });

  app.post("/api/agreement-templates", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(agreementTemplateCreateSchema, request.body);
    const created = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      if (input.active) {
        const [clash] = await tx<{ id: string }[]>`
          select id from agreement_templates
          where business_id=${context.businessId} and active
            and lower(btrim(name))=lower(btrim(${input.name}))
        `;
        if (clash) return { clash };
      }
      const [template] = await tx<Record<string, unknown>[]>`
        insert into agreement_templates (business_id,name,body,required,active,created_by,updated_by)
        values (${context.businessId},${input.name},${input.body},${input.required},${input.active},
          ${context.userId},${context.userId})
        returning id,name,body,required,active,version,created_by,created_at,updated_at
      `;
      if (!template) throw new Error("Agreement template creation failed");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "agreement.template.create",
        resourceType: "agreement_template", resourceId: String(template.id),
        after: { name: input.name, required: input.required, active: input.active }
      });
      return { template };
    });
    if ("clash" in created) {
      return reply.code(409).send({
        code: "AGREEMENT_TEMPLATE_DUPLICATE",
        error: "An active agreement with this name already exists"
      });
    }
    return reply.code(201).send({ ...created.template, signedCount: 0 });
  });

  app.patch("/api/agreement-templates/:id", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(agreementTemplateUpdateSchema, request.body);
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [before] = await tx<{
        id: string; name: string; body: string; required: boolean; active: boolean; version: number;
      }[]>`
        select id,name,body,required,active,version from agreement_templates
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!before) return { missing: true } as const;
      const next = {
        name: input.name ?? before.name,
        body: input.body ?? before.body,
        required: input.required ?? before.required,
        active: input.active ?? before.active
      };
      if (next.active) {
        const [clash] = await tx<{ id: string }[]>`
          select id from agreement_templates
          where business_id=${context.businessId} and active and id<>${id}
            and lower(btrim(name))=lower(btrim(${next.name}))
        `;
        if (clash) return { clash: true } as const;
      }
      // Only a change to what the client is agreeing to is a new revision; archiving
      // or restoring a document leaves already-recorded signatures pointing at the
      // revision they were actually recorded against.
      const contentChanged = next.name !== before.name
        || next.body !== before.body
        || next.required !== before.required;
      const [template] = await tx<Record<string, unknown>[]>`
        update agreement_templates set name=${next.name},body=${next.body},
          required=${next.required},active=${next.active},
          version=${before.version + (contentChanged ? 1 : 0)},
          updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id}
        returning id,name,body,required,active,version,created_by,created_at,updated_at
      `;
      if (!template) throw new Error("Agreement template update failed");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "agreement.template.update",
        resourceType: "agreement_template", resourceId: id,
        before: { name: before.name, required: before.required, active: before.active, version: before.version },
        after: { name: next.name, required: next.required, active: next.active, version: template.version }
      });
      return { template } as const;
    });
    if ("missing" in result) return reply.code(404).send({ error: "Agreement template not found" });
    if ("clash" in result) {
      return reply.code(409).send({
        code: "AGREEMENT_TEMPLATE_DUPLICATE",
        error: "An active agreement with this name already exists"
      });
    }
    const [signed] = await db<{ count: number }[]>`
      select count(*)::int count from customer_agreements
      where business_id=${context.businessId} and agreement_template_id=${id} and status='signed'
    `;
    return { ...result.template, signedCount: signed?.count ?? 0 };
  });

  // Archive, never delete: recorded signatures have to stay explainable.
  app.delete("/api/agreement-templates/:id", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const archived = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [template] = await tx<{ id: string; name: string }[]>`
        update agreement_templates set active=false,updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id} and active
        returning id,name
      `;
      if (!template) return null;
      // A document nobody is being asked to sign any more should not keep nagging.
      await tx`
        update notification_intents set status='cancelled',resolved_at=now(),updated_at=now()
        where business_id=${context.businessId} and agreement_template_id=${id}
          and status in ('pending','failed')
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "agreement.template.archive",
        resourceType: "agreement_template", resourceId: id, before: { name: template.name, active: true }
      });
      return template;
    });
    if (!archived) return reply.code(404).send({ error: "Active agreement template not found" });
    return reply.code(204).send();
  });

  // Drives both the client profile Agreements panel and its warning banner.
  app.get("/api/customers/:id/agreements", {
    preHandler: [authenticate, requirePermission("customers.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [customer] = await db<(AgreementRecipient & { archivedAt: Date | null })[]>`
      select id,first_name,last_name,email,email_allowed,block_messages,archived_at
      from customers where business_id=${context.businessId} and id=${id}
    `;
    if (!customer) return reply.code(404).send({ error: "Customer not found" });
    const items = await customerAgreementRows(db, { businessId: context.businessId, customerId: id });
    return {
      customerId: id,
      items,
      summary: agreementSummary(items),
      delivery: agreementDelivery(customer),
      // An archived client is readable but nothing can be sent to or recorded against it.
      customerArchived: customer.archivedAt !== null
    };
  });

  app.post("/api/customers/:id/agreements/:templateId/signature", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id, templateId } = customerAgreementParams.parse(request.params);
    const input = body(agreementSignatureSchema, request.body);
    const signedAt = input.signedAt ? new Date(input.signedAt) : new Date();
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [customer] = await tx<{ id: string }[]>`
        select id from customers
        where business_id=${context.businessId} and id=${id} and archived_at is null
      `;
      if (!customer) return { missingCustomer: true } as const;
      const [template] = await tx<{ id: string; active: boolean; version: number; name: string }[]>`
        select id,active,version,name from agreement_templates
        where business_id=${context.businessId} and id=${templateId}
      `;
      if (!template) return { missingTemplate: true } as const;
      if (!template.active) return { archivedTemplate: true } as const;
      // The `where` on the conflict path makes "already signed" a lost update rather
      // than a race: two concurrent recordings cannot both overwrite provenance.
      const [agreement] = await tx<{ id: string }[]>`
        insert into customer_agreements
          (business_id,customer_id,agreement_template_id,status,signed_at,signed_name,
           signature_method,signature_note,signed_template_version,signed_by_membership_id)
        values (${context.businessId},${id},${templateId},'signed',${signedAt},${input.signedName},
          'staff_recorded',${input.note ?? null},${template.version},${context.membershipId})
        on conflict (business_id,customer_id,agreement_template_id) do update set
          status='signed',signed_at=excluded.signed_at,signed_name=excluded.signed_name,
          signature_method='staff_recorded',signature_note=excluded.signature_note,
          signed_template_version=excluded.signed_template_version,
          signed_by_membership_id=excluded.signed_by_membership_id,updated_at=now()
        where customer_agreements.status<>'signed'
        returning id
      `;
      if (!agreement) return { alreadySigned: true } as const;
      await tx`
        update notification_intents set status='cancelled',resolved_at=now(),updated_at=now()
        where business_id=${context.businessId} and customer_id=${id}
          and agreement_template_id=${templateId} and status in ('pending','failed')
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "customer.agreement.sign",
        resourceType: "customer_agreement", resourceId: agreement.id,
        after: {
          customerId: id, templateId, templateName: template.name,
          signedName: input.signedName, signatureMethod: "staff_recorded",
          signedTemplateVersion: template.version, signedAt: signedAt.toISOString()
        }
      });
      return { agreement } as const;
    });
    if ("missingCustomer" in result) return reply.code(404).send({ error: "Active customer not found" });
    if ("missingTemplate" in result) return reply.code(404).send({ error: "Agreement template not found" });
    if ("archivedTemplate" in result) {
      return reply.code(409).send({
        code: "AGREEMENT_TEMPLATE_ARCHIVED",
        error: "This agreement has been archived and cannot be signed"
      });
    }
    if ("alreadySigned" in result) {
      return reply.code(409).send({
        code: "AGREEMENT_ALREADY_SIGNED",
        error: "This agreement is already signed for this client"
      });
    }
    const [item] = await customerAgreementRows(db, {
      businessId: context.businessId, customerId: id, templateId
    });
    return item;
  });

  // Correction path for a signature recorded in error. The agreement falls back to
  // "sent" when it had been sent, otherwise to "not sent" (the row disappears).
  app.delete("/api/customers/:id/agreements/:templateId/signature", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id, templateId } = customerAgreementParams.parse(request.params);
    const cleared = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [before] = await tx<{
        id: string; sentAt: Date | null; signedName: string; signedTemplateVersion: number;
      }[]>`
        select agreement.id,agreement.sent_at,agreement.signed_name,agreement.signed_template_version
        from customer_agreements agreement
        join customers customer on customer.business_id=agreement.business_id
          and customer.id=agreement.customer_id and customer.archived_at is null
        where agreement.business_id=${context.businessId} and agreement.customer_id=${id}
          and agreement.agreement_template_id=${templateId} and agreement.status='signed'
        for update of agreement
      `;
      if (!before) return null;
      if (before.sentAt) {
        await tx`
          update customer_agreements set status='sent',signed_at=null,signed_name=null,
            signature_method=null,signature_note=null,signed_template_version=null,
            signed_by_membership_id=null,updated_at=now()
          where business_id=${context.businessId} and id=${before.id}
        `;
      } else {
        await tx`
          delete from customer_agreements
          where business_id=${context.businessId} and id=${before.id}
        `;
      }
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "customer.agreement.signature.clear",
        resourceType: "customer_agreement", resourceId: before.id,
        before: {
          customerId: id, templateId, signedName: before.signedName,
          signedTemplateVersion: before.signedTemplateVersion
        }
      });
      return before;
    });
    if (!cleared) return reply.code(404).send({ error: "Signed agreement not found" });
    return reply.code(204).send();
  });

  /**
   * Queues the selected agreements to the client by email.
   *
   * What this does: writes one `notification_intents` row per agreement onto the existing
   * outbox, with the document text as the sealed message body, and marks the agreement
   * "sent". The background worker delivers it through the configured email provider.
   *
   * What this does NOT do: there is no SMS channel (see `agreementDelivery`), and there is
   * no client-facing signing page — the email asks the client to confirm with the salon and
   * a staff member then records the signature.
   */
  app.post("/api/customers/:id/agreements/send", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(agreementSendSchema, request.body);
    if (input.channel !== "email") {
      return reply.code(409).send({
        code: "AGREEMENT_CHANNEL_UNSUPPORTED",
        error: "Pawsh has no SMS delivery. Agreements can only be sent by email.",
        channel: input.channel,
        supportedChannels: ["email"]
      });
    }
    const templateIds = [...new Set(input.templateIds)];
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [customer] = await tx<AgreementRecipient[]>`
        select id,first_name,last_name,email,email_allowed,block_messages
        from customers
        where business_id=${context.businessId} and id=${id} and archived_at is null
      `;
      if (!customer) return { missingCustomer: true } as const;
      const reason = agreementEmailReason(customer);
      if (reason !== "ok") return { undeliverable: reason, customer } as const;
      const [business] = await tx<{ name: string; phone: string | null; email: string | null }[]>`
        select name,phone,email from businesses where id=${context.businessId}
      `;
      const templates = await tx<{
        id: string; name: string; body: string; active: boolean;
      }[]>`
        select id,name,body,active from agreement_templates
        where business_id=${context.businessId} and id in ${tx(templateIds)}
      `;
      const results: { templateId: string; outcome: string }[] = [];
      for (const templateId of templateIds) {
        const template = templates.find((candidate) => candidate.id === templateId);
        if (!template) { results.push({ templateId, outcome: "not_found" }); continue; }
        if (!template.active) { results.push({ templateId, outcome: "skipped_archived" }); continue; }
        const [existing] = await tx<{ status: string }[]>`
          select status from customer_agreements
          where business_id=${context.businessId} and customer_id=${id}
            and agreement_template_id=${templateId} for update
        `;
        if (existing?.status === "signed") {
          results.push({ templateId, outcome: "skipped_signed" });
          continue;
        }
        const message = agreementMessage({
          businessName: business?.name ?? "Your salon",
          businessPhone: business?.phone ?? null,
          businessEmail: business?.email ?? null,
          templateName: template.name,
          templateBody: template.body
        });
        // `one_open_agreement_notification` makes this the idempotency point: while an
        // earlier request is still undelivered, a repeat send queues nothing new.
        const [intent] = await tx<{ id: string }[]>`
          insert into notification_intents
            (business_id,customer_id,agreement_template_id,notification_type,
             scheduled_occurrence,channel,destination,encrypted_body)
          values (${context.businessId},${id},${templateId},'agreement_signature_request',
            now(),'email',${customer.email},${sealSecret(message, config.SESSION_SECRET)})
          on conflict do nothing returning id
        `;
        if (!intent) { results.push({ templateId, outcome: "already_queued" }); continue; }
        await tx`
          insert into customer_agreements
            (business_id,customer_id,agreement_template_id,status,sent_at,send_count,
             last_sent_channel,last_sent_by_membership_id)
          values (${context.businessId},${id},${templateId},'sent',now(),1,'email',${context.membershipId})
          on conflict (business_id,customer_id,agreement_template_id) do update set
            status=case when customer_agreements.status='signed' then customer_agreements.status else 'sent' end,
            sent_at=now(),send_count=customer_agreements.send_count+1,
            last_sent_channel='email',last_sent_by_membership_id=${context.membershipId},
            updated_at=now()
        `;
        results.push({ templateId, outcome: "queued" });
      }
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "customer.agreement.send",
        resourceType: "customer", resourceId: id,
        after: { channel: "email", results }
      });
      return { results, customer } as const;
    });
    if ("missingCustomer" in result) return reply.code(404).send({ error: "Active customer not found" });
    if ("undeliverable" in result) {
      return reply.code(409).send({
        code: "AGREEMENT_UNDELIVERABLE",
        error: agreementEmailDetail[result.undeliverable] ?? "This client cannot be emailed",
        channel: "email",
        reason: result.undeliverable,
        supportedChannels: ["email"],
        delivery: agreementDelivery(result.customer)
      });
    }
    const items = await customerAgreementRows(db, { businessId: context.businessId, customerId: id });
    return {
      channel: "email",
      queued: result.results.filter((entry) => entry.outcome === "queued").length,
      results: result.results,
      items,
      summary: agreementSummary(items),
      delivery: agreementDelivery(result.customer)
    };
  });

  /**
   * Queue a rabies reminder for a pet whose record lapses before a date being booked.
   *
   * This runs while the appointment is still being composed, so there is no appointment row
   * to attach the intent to. The reminder therefore hangs off the customer and carries its own
   * sealed body: the worker's generated copy reads the appointment for the pet name and dates,
   * and would render empty here. `material_key` supplies idempotency through
   * `unique_notification_material_recipient`, so pressing Send Reminder twice for the same pet,
   * expiration, and target date queues one message rather than two.
   *
   * `reconcileRabiesNotifications` only ever touches intents scoped to an appointment id, so a
   * reminder queued here is never cancelled or superseded by the booking that follows it. If the
   * appointment is then created with the record still lapsed, reconciliation queues its own
   * appointment-scoped intent; that is a second, differently-worded message and is intended.
   */
  app.post("/api/pets/:id/vaccination-reminder", {
    preHandler: [authenticate, requirePermission("appointments.create")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(vaccinationReminderSchema, request.body);
    if (input.channel !== "email") {
      return reply.code(409).send({
        code: "VACCINATION_REMINDER_CHANNEL_UNSUPPORTED",
        error: "Pawsh has no SMS delivery. Vaccination reminders can only be sent by email.",
        channel: input.channel,
        supportedChannels: ["email"]
      });
    }
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [pet] = await tx<{
        id: string; name: string; expirationDate: string | null; customerId: string;
        firstName: string; lastName: string; email: string | null;
        emailAllowed: boolean; blockMessages: boolean;
      }[]>`
        select pet.id,pet.name,pet.vaccination_expires_on::text as expiration_date,
          customer.id as customer_id,customer.first_name,customer.last_name,
          customer.email,customer.email_allowed,customer.block_messages
        from pets pet
        join customers customer on customer.business_id=pet.business_id and customer.id=pet.customer_id
        where pet.business_id=${context.businessId} and pet.id=${id}
          and pet.archived_at is null and customer.archived_at is null
      `;
      if (!pet) return { missingPet: true } as const;
      // A pet whose record is already current for the date is not a reminder the client should
      // receive. Refusing is more useful than sending a message contradicted by the record.
      if (!pet.expirationDate || pet.expirationDate >= input.appointmentLocalDate) {
        return { notRequired: true, expirationDate: pet.expirationDate } as const;
      }
      const recipient = {
        id: pet.customerId, firstName: pet.firstName, lastName: pet.lastName,
        email: pet.email, emailAllowed: pet.emailAllowed, blockMessages: pet.blockMessages
      } satisfies AgreementRecipient;
      const reason = agreementEmailReason(recipient);
      if (reason !== "ok") return { undeliverable: reason, recipient } as const;
      const [business] = await tx<{ name: string; phone: string | null; email: string | null }[]>`
        select name,phone,email from businesses where id=${context.businessId}
      `;
      const contact = business?.phone ?? business?.email ?? business?.name ?? "the business";
      const message = [
        `${business?.name ?? "Your salon"} is booking ${pet.name} for ${input.appointmentLocalDate}.`,
        `The rabies vaccination information on file expires on ${pet.expirationDate}, so it will not be current for that visit.`,
        `Please send updated rabies information before the appointment, or contact ${contact}.`
      ].join("\n\n");
      const key = `rabies:${createHash("sha256").update(JSON.stringify([
        context.businessId, pet.customerId, pet.id, "rabies_expiration_customer",
        input.appointmentLocalDate, pet.expirationDate, "email", pet.email
      ])).digest("hex")}`;
      const [intent] = await tx<{ id: string }[]>`
        insert into notification_intents
          (business_id,customer_id,notification_type,scheduled_occurrence,channel,
           destination,status,recipient_kind,material_key,encrypted_body)
        values (${context.businessId},${pet.customerId},'rabies_expiration_customer',now(),'email',
          ${pet.email},'pending','customer',${key},${sealSecret(message, config.SESSION_SECRET)})
        on conflict do nothing returning id
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "pet.vaccination_reminder.send", resourceType: "pet", resourceId: id,
        after: {
          channel: "email", customerId: pet.customerId,
          appointmentLocalDate: input.appointmentLocalDate, expirationDate: pet.expirationDate,
          outcome: intent ? "queued" : "already_queued"
        }
      });
      return { queued: Boolean(intent), intentId: intent?.id ?? null, pet, recipient } as const;
    });
    if ("missingPet" in result) return reply.code(404).send({ error: "Active pet not found" });
    if ("notRequired" in result) {
      return reply.code(409).send({
        code: "VACCINATION_REMINDER_NOT_REQUIRED",
        error: result.expirationDate
          ? "The rabies record on file is current for this date, so no reminder was sent."
          : "No rabies expiration is on file for this pet, so there is nothing to remind about.",
        expirationDate: result.expirationDate ?? null
      });
    }
    if ("undeliverable" in result) {
      return reply.code(409).send({
        code: "VACCINATION_REMINDER_UNDELIVERABLE",
        error: agreementEmailDetail[result.undeliverable] ?? "This client cannot be emailed",
        channel: "email",
        reason: result.undeliverable,
        supportedChannels: ["email"]
      });
    }
    return reply.code(202).send({
      channel: "email",
      queued: result.queued,
      outcome: result.queued ? "queued" : "already_queued",
      intentId: result.intentId,
      destination: result.recipient.email
    });
  });

  app.get("/api/customers/:id/history", {
    preHandler: [authenticate, requirePermission("customers.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [customer] = await db`select customer.*,employee.display_name preferred_employee_name
      from customers customer left join employees employee
        on employee.business_id=customer.business_id and employee.id=customer.preferred_employee_id
      where customer.business_id=${context.businessId} and customer.id=${id}`;
    if (!customer) return reply.code(404).send({ error: "Customer not found" });
    const mayViewCare = mayViewPetCare(context);
    const mayViewPayments = context.isOwner || context.permissions.includes("payments.view");
    const [pets, upcoming, history, invoices, summary] = await Promise.all([
      db`select * from pets where business_id=${context.businessId} and customer_id=${id} order by name,id`,
      appointmentHistoryPage(db, {
        businessId: context.businessId, scope: "customer", id,
        limit: profileUpcomingLimit, offset: 0, direction: "upcoming"
      }),
      appointmentHistoryPage(db, {
        businessId: context.businessId, scope: "customer", id,
        limit: profileHistoryPreviewLimit, offset: 0, direction: "past"
      }),
      mayViewPayments
        ? db`select id,invoice_number,status,subtotal_minor,discount_minor,tax_minor,tip_minor,
              total_minor,balance_minor,created_at
             from invoices where business_id=${context.businessId} and customer_id=${id}
             order by created_at desc,id desc limit ${profileHistoryLimit}`
        : Promise.resolve([]),
      mayViewPayments
        ? customerSalesSummary(db, { businessId: context.businessId, customerId: id })
        : Promise.resolve(null)
    ]);
    const appointmentTotal = upcoming.total + history.total;
    return {
      customer,
      pets: mayViewCare ? pets : pets.map((pet) => redactPetCare(pet)),
      upcoming: { items: upcoming.items, total: upcoming.total },
      history: { items: history.items, total: history.total },
      appointmentTotal,
      appointmentsTruncated:
        upcoming.total > upcoming.items.length || history.total > history.items.length,
      // Money is withheld rather than zeroed for staff without `payments.view`, so an empty
      // summary is never mistaken for a client who has never spent anything.
      summary,
      invoices
    };
  });

  app.get("/api/customers/:id/appointments", {
    preHandler: [authenticate, requirePermission("customers.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const query = body(appointmentHistoryQuerySchema, request.query);
    const [customer] = await db<{ id: string }[]>`
      select id from customers where business_id=${context.businessId} and id=${id}
    `;
    if (!customer) return reply.code(404).send({ error: "Customer not found" });
    const { items, total } = await appointmentHistoryPage(db, {
      businessId: context.businessId, scope: "customer", id,
      limit: query.pageSize, offset: (query.page - 1) * query.pageSize,
      ...(query.direction ? { direction: query.direction } : {})
    });
    return { items, total, page: query.page, pageSize: query.pageSize };
  });

  app.get("/api/reminders", {
    preHandler: [authenticate, requirePermission("appointments.view")]
  }, async (request) => {
    const context=auth(request),query=body(reminderQuerySchema,request.query);
    const supported=query.type==="appointment_reminder"||query.type==="vaccination_reminder";
    if(!supported)return {supported:false,items:[]};
    const notificationTypes=query.type==="appointment_reminder"
      ? ["appointment_reminder"]
      : ["rabies_expiration_customer","rabies_expiration_staff"];
    const items=await db`
      select intent.id,intent.appointment_id,intent.notification_type,intent.status reminder_status,
        intent.scheduled_occurrence,intent.channel,intent.destination,intent.attempts,
        appointment.status appointment_status,appointment.start_at,customer.first_name,customer.last_name,
        coalesce((select json_agg(json_build_object(
          'attemptNumber',attempt.attempt_number,'outcome',attempt.outcome,'createdAt',attempt.created_at,
          'attemptKind',case when attempt.attempt_number=1 then 'initial' else 'retry' end,
          'safeFailureReason',case when attempt.outcome='failed' then 'Delivery failed' else null end
        ) order by attempt.attempt_number desc) from notification_delivery_attempts attempt
          where attempt.business_id=intent.business_id and attempt.notification_intent_id=intent.id),'[]') logs
      from notification_intents intent
      left join appointments appointment on appointment.business_id=intent.business_id and appointment.id=intent.appointment_id
      left join customers customer on customer.business_id=intent.business_id and customer.id=intent.customer_id
      where intent.business_id=${context.businessId} and intent.notification_type in ${db(notificationTypes)}
      order by intent.scheduled_occurrence desc,intent.id desc limit 200
    `;
    return {supported:true,items};
  });

  app.post("/api/reminders/:id/send", {
    preHandler: [authenticate, requirePermission("appointments.edit")]
  }, async (request,reply) => {
    const context=auth(request),{id}=idParams.parse(request.params);
    const [intent]=await db`
      update notification_intents set status='pending',scheduled_occurrence=least(scheduled_occurrence,now()),updated_at=now()
      where business_id=${context.businessId} and id=${id}
        and notification_type in ('appointment_reminder','rabies_expiration_customer','rabies_expiration_staff')
        and status in ('pending','failed') and attempts<5 returning id,status
    `;
    if(!intent)return reply.code(409).send({error:"Reminder cannot be sent or is already complete"});
    return reply.code(202).send({queued:true,id:intent.id});
  });

  app.get("/api/reminders/:id/logs", {
    preHandler: [authenticate, requirePermission("appointments.view")]
  }, async (request, reply) => {
    const context=auth(request),{id}=idParams.parse(request.params);
    const [intent]=await db<{id:string;channel:string;destination:string;status:string;attempts:number}[]>`
      select id,channel,destination,status,attempts from notification_intents
      where business_id=${context.businessId} and id=${id}
        and notification_type in ('appointment_reminder','rabies_expiration_customer','rabies_expiration_staff')
    `;
    if(!intent)return reply.code(404).send({error:"Reminder not found"});
    // `attemptKind` keeps the audit trail readable: a first send and a later retry of the same
    // reminder are otherwise indistinguishable rows. Provider errors stay server-side.
    const logs=await db`
      select attempt_number,outcome,created_at,
        case when attempt_number=1 then 'initial' else 'retry' end as attempt_kind,
        case when outcome='failed' then 'Delivery failed' else null end as safe_failure_reason
      from notification_delivery_attempts
      where business_id=${context.businessId} and notification_intent_id=${id}
      order by attempt_number desc limit 50
    `;
    return {id:intent.id,channel:intent.channel,destination:intent.destination,
      reminderStatus:intent.status,attempts:intent.attempts,logs};
  });

  app.post("/api/customers/:id/archive", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [customer] = await db`
      update customers set archived_at=now(), updated_by=${context.userId}, updated_at=now()
      where business_id=${context.businessId} and id=${id} and archived_at is null returning id
    `;
    if (!customer) return reply.code(404).send({ error: "Active customer not found" });
    return reply.code(204).send();
  });

  app.get("/api/pets", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async (request) => {
    const context = auth(request);
    const query = request.query as { q?: string; customerId?: string };
    const rows = await db`
      select p.*, concat_ws(' ', c.first_name, c.last_name) as customer_name,
        (select upcoming.scheduled_local_start from appointments upcoming
          where upcoming.business_id=p.business_id and upcoming.pet_id=p.id
            and upcoming.status='scheduled' and upcoming.start_at>now()
          order by upcoming.start_at,upcoming.id limit 1) as next_appointment_local_start,
        coalesce(verifier_employee.display_name,verifier_user.email) as rabies_verified_by_name
      from pets p
      join customers c on c.id=p.customer_id and c.business_id=p.business_id
        and c.archived_at is null
      left join business_memberships verifier on verifier.business_id=p.business_id
        and verifier.id=p.rabies_verified_by_membership_id
      left join users verifier_user on verifier_user.id=verifier.user_id
      left join employees verifier_employee on verifier_employee.business_id=p.business_id
        and verifier_employee.membership_id=verifier.id
      where p.business_id=${context.businessId} and p.archived_at is null
        and (${query.customerId ?? null}::uuid is null or p.customer_id=${query.customerId ?? null}::uuid)
        and (${query.q ?? ""}='' or p.name ilike ${`%${query.q ?? ""}%`} or p.breed ilike ${`%${query.q ?? ""}%`})
      order by p.name,p.id limit 100
    `;
    if (mayViewPetCare(context)) return rows;
    return rows.map((pet) => redactPetCare(pet));
  });

  /** The pet types breeds are organized under. Global taxonomy, readable by any tenant. */
  app.get("/api/pet-types", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async () => db`
    select id,name,normalized_name as search,sort_order from pet_types
    where active order by sort_order,name
  `);

  /**
   * The breeds a tenant may choose from, for one pet type, with that tenant's own configuration
   * folded in.
   *
   * `defaultPricingClass` and `active` are the EFFECTIVE values: the account's sparse override
   * where it has expressed one, the canonical Pawsh default otherwise. The caller never has to
   * know which of the two answered, and an account that has configured nothing simply sees the
   * shared taxonomy.
   *
   * Staff who cannot manage settings see only what is active for them, so the pet editor cannot
   * offer a breed the account has switched off.
   */
  app.get("/api/pet-types/:petTypeId/breeds", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async (request, reply) => {
    const context=auth(request);
    const {petTypeId}=petTypeParams.parse(request.params);
    const [petType]=await db<{id:string}[]>`select id from pet_types where id=${petTypeId} and active`;
    if(!petType)return reply.code(404).send({error:"Pet type not found"});
    return breedCatalogRows(db,{businessId:context.businessId,petTypeId,
      includeInactive:context.isOwner||context.permissions.includes("services.manage")});
  });

  /**
   * Kept at its original path so existing clients keep working, but it is no longer a
   * per-tenant catalog: it serves the canonical Dog taxonomy with this tenant's overrides
   * applied. `id` is now a canonical breed id, which is the value `pets.breedId` references.
   */
  app.get("/api/dog-breeds", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async (request) => {
    const context=auth(request);
    const [petType]=await db<{id:string}[]>`select id from pet_types where normalized_name='dog'`;
    if(!petType)return [];
    return breedCatalogRows(db,{businessId:context.businessId,petTypeId:petType.id,
      includeInactive:context.isOwner||context.permissions.includes("services.manage")});
  });

  /**
   * Records what THIS BUSINESS thinks about a canonical breed - its coat/pricing class, and whether
   * it offers the breed at all.
   *
   * It deliberately cannot rename a breed. Breed identity is canonical and shared: a business
   * renaming "German Shepherd" for everyone was never the intent, and under the old per-tenant
   * catalog a rename silently repriced that account's whole book because pets were joined to it by
   * name. Setting a field back to null restores the Pawsh default rather than freezing today's
   * value, so a breed follows the shared taxonomy again once the account stops disagreeing.
   * Renaming a breed the business owns is a separate call - PATCH /api/breeds/:breedId.
   *
   * This serves business-owned breeds too, through the same override table and the same
   * precedence. Keeping one write path for pricing class and availability means those two
   * fields have exactly one storage location per breed, so no two endpoints can disagree about
   * which value wins.
   */
  app.put("/api/breeds/:breedId/settings",{preHandler:[authenticate,requirePermission("services.manage")]},async(request,reply)=>{
    const context=auth(request);
    const {breedId}=breedParams.parse(request.params);
    const input=body(breedSettingsSchema,request.body);
    // Scoped, so another tenant's business-owned breed is a 404 rather than a settable row.
    const breed=await loadBreedForTenant(db,{businessId:context.businessId,breedId});
    if(!breed)return reply.code(404).send({error:"Breed not found"});
    await db.begin(async (tx)=>{
      await setTenant(tx,context.businessId);
      // Merge, never replace. A field the caller omitted keeps whatever is stored, so editing
      // the pricing class cannot silently pin `active` away from the shared taxonomy. Only an
      // explicit null clears an override.
      const [stored]=await tx<{pricingClass:string|null;active:boolean|null}[]>`
        select pricing_class,active from business_breed_settings
        where business_id=${context.businessId} and breed_id=${breedId} for update
      `;
      const pricingClass=input.pricingClass!==undefined?input.pricingClass:stored?.pricingClass??null;
      const active=input.active!==undefined?input.active:stored?.active??null;
      // A row that overrides nothing is deleted rather than stored: the table exists to hold
      // disagreements, and an empty one keeps the common lookup free of rows that say nothing.
      if(pricingClass===null&&active===null){
        await tx`delete from business_breed_settings
          where business_id=${context.businessId} and breed_id=${breedId}`;
        return;
      }
      await tx`
        insert into business_breed_settings (business_id,breed_id,pricing_class,active,created_by)
        values (${context.businessId},${breedId},${pricingClass},${active},${context.userId})
        on conflict (business_id,breed_id) do update
          set pricing_class=excluded.pricing_class,active=excluded.active,updated_at=now()
      `;
    });
    // Read back with inactive rows included. Deactivating a breed is a legitimate outcome of
    // this call, and the default catalog projection hides inactive rows - so without this the
    // write would succeed and then report 404 for the row it had just saved.
    const [row]=await breedCatalogRows(db,{businessId:context.businessId,petTypeId:breed.petTypeId,breedId,includeInactive:true});
    return row ?? reply.code(404).send({error:"Breed not found"});
  });

  /**
   * Creates a breed that belongs to THIS BUSINESS - the customer account, so it is available at
   * every location that account operates rather than at one salon.
   *
   * The row lives in `breeds` alongside the shared taxonomy, carrying this business_id, so its
   * id is an ordinary breed id: `pets.breedId` references it through the same composite foreign
   * key, the pricing resolver reads it through the same join, and the settings endpoint
   * configures it through the same override table. No second identity space, and no row is
   * created for any account that does not ask for one.
   *
   * `pricingClass` defaults to STANDARD, which is what an unresolved breed already prices at, so
   * adding a breed cannot move a price by itself. It is changed afterwards through the settings
   * endpoint like any other breed.
   */
  app.post("/api/pet-types/:petTypeId/breeds",{preHandler:[authenticate,requirePermission("services.manage")]},async(request,reply)=>{
    const context=auth(request);
    const {petTypeId}=petTypeParams.parse(request.params);
    const input=body(breedCreateSchema,request.body);
    const [petType]=await db<{id:string}[]>`select id from pet_types where id=${petTypeId} and active`;
    if(!petType)return reply.code(404).send({error:"Pet type not found"});
    const normalized=normalizeBreedSearch(input.name);
    if(!normalized)throw new SchedulingRequestError(400,"BREED_NAME_INVALID","Enter a breed name using letters or numbers.");
    const breedId=await db.begin(async (tx)=>{
      await setTenant(tx,context.businessId);
      await assertBreedNameAvailable(tx,{businessId:context.businessId,petTypeId,normalizedName:normalized,name:input.name});
      const [created]=await tx<{id:string}[]>`
        insert into breeds (business_id,pet_type_id,name,normalized_name,default_pricing_class)
        values (${context.businessId},${petTypeId},${input.name},${normalized},${input.pricingClass??"STANDARD"})
        returning id
      `;
      return created!.id;
    });
    const [row]=await breedCatalogRows(db,{businessId:context.businessId,petTypeId,breedId,includeInactive:true});
    return reply.code(201).send(row);
  });

  /**
   * Renames a breed this business owns.
   *
   * A SHARED breed is refused with BREED_NOT_BUSINESS_OWNED: renaming one would change breed
   * identity for every tenant at once, and stable identity across a display-name change is the
   * property the canonical taxonomy exists to provide.
   *
   * `pets.breed` is the denormalized display copy of the name, so it is rewritten for this
   * account's pets on this breed. That is a display correction and nothing more - `breed_id` does
   * not move, so no pet changes pricing class. Only this account's pets can reference the breed,
   * so the update is bounded to rows this tenant owns.
   */
  app.patch("/api/breeds/:breedId",{preHandler:[authenticate,requirePermission("services.manage")]},async(request,reply)=>{
    const context=auth(request);
    const {breedId}=breedParams.parse(request.params);
    const input=body(breedRenameSchema,request.body);
    const normalized=normalizeBreedSearch(input.name);
    if(!normalized)throw new SchedulingRequestError(400,"BREED_NAME_INVALID","Enter a breed name using letters or numbers.");
    const petTypeId=await db.begin(async (tx)=>{
      await setTenant(tx,context.businessId);
      const breed=await loadBreedForTenant(tx,{businessId:context.businessId,breedId});
      if(!breed)throw new SchedulingRequestError(404,"RESOURCE_NOT_FOUND","Breed not found");
      if(breed.businessId===null)throw refuseSharedBreedMutation(breed.name);
      await assertBreedNameAvailable(tx,{businessId:context.businessId,petTypeId:breed.petTypeId,
        normalizedName:normalized,name:input.name,excludeBreedId:breedId});
      await tx`
        update breeds set name=${input.name},normalized_name=${normalized},updated_at=now()
        where id=${breedId} and business_id=${context.businessId}
      `;
      await tx`
        update pets set breed=${input.name},updated_at=now()
        where business_id=${context.businessId} and breed_id=${breedId}
      `;
      return breed.petTypeId;
    });
    const [row]=await breedCatalogRows(db,{businessId:context.businessId,petTypeId,breedId,includeInactive:true});
    return row ?? reply.code(404).send({error:"Breed not found"});
  });

  /**
   * Deletes a breed this business owns.
   *
   * A SHARED breed is refused with BREED_NOT_BUSINESS_OWNED, for the same reason a rename is.
   *
   * A breed any pet still references is refused with BREED_IN_USE rather than deleted. The
   * alternative - clearing `pets.breed_id` and leaving the display text, the way legacy pets are
   * grandfathered - would drop every one of those pets to STANDARD, which is a price cut applied
   * without anyone choosing it. Refusing puts the decision where it belongs: move the pets, or
   * turn the breed off with the settings endpoint and keep them priced as they are.
   *
   * Archived pets count. They still hold the foreign key, and un-archiving one must not
   * resurrect a reference to a breed that no longer exists.
   */
  app.delete("/api/breeds/:breedId",{preHandler:[authenticate,requirePermission("services.manage")]},async(request,reply)=>{
    const context=auth(request);
    const {breedId}=breedParams.parse(request.params);
    await db.begin(async (tx)=>{
      await setTenant(tx,context.businessId);
      const breed=await loadBreedForTenant(tx,{businessId:context.businessId,breedId});
      if(!breed)throw new SchedulingRequestError(404,"RESOURCE_NOT_FOUND","Breed not found");
      if(breed.businessId===null)throw refuseSharedBreedMutation(breed.name);
      const [usage]=await tx<{petCount:number}[]>`
        select count(*)::int as pet_count from pets
        where business_id=${context.businessId} and breed_id=${breedId}
      `;
      const petCount=usage?.petCount??0;
      if(petCount>0){
        throw new SchedulingRequestError(409,"BREED_IN_USE",
          `${petCount} ${petCount===1?"pet is":"pets are"} still recorded as "${breed.name}". Change them to another breed first, or turn this one off instead.`,
          {petCount});
      }
      // The account's own override of its own breed goes with it, by cascade.
      await tx`delete from breeds where id=${breedId} and business_id=${context.businessId}`;
    });
    return reply.code(204).send();
  });

  app.post("/api/pricing/resolve",{preHandler:[authenticate,requirePermission("appointments.create")]},async(request)=>{
    const context=auth(request);const input=body(priceResolutionSchema,request.body);return resolveServicePrices(db,{businessId:context.businessId,...input});
  });

  app.post("/api/pets", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(petSchema, request.body);
    if (suppliedPetCareFields(request.body as PetCareRecord).length
      && !context.isOwner && !context.permissions.includes("pets.care.edit")) {
      return reply.code(403).send({ error: "Missing permission: pets.care.edit" });
    }
    const pet = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const verificationStatus=input.rabiesVerificationStatus === "staff_verified"
        ? "staff_verified" : input.vaccinationExpiresOn ? "unverified" : "not_provided";
      const verifiedAt=verificationStatus === "staff_verified"
        ? input.rabiesVerificationDate ? new Date(`${input.rabiesVerificationDate}T12:00:00.000Z`) : new Date()
        : null;
      const selection = await resolvePetBreedSelection(tx, {
        businessId: context.businessId,
        supplied: { species: input.species, petTypeId: input.petTypeId, breedId: input.breedId, breed: input.breed, breedOther: input.breedOther }
      });
      const [created] = await tx<{ id: string }[]>`
        insert into pets
          (business_id, customer_id, name, species, pet_type_id, breed_id, breed_other, breed, date_of_birth, approximate_age,
           weight_ounces, sex, coat_notes, grooming_preferences, behavior_notes, medical_notes,
           safety_alerts, emergency_contact, veterinarian, vaccination_notes,
           vaccination_expires_on,rabies_vaccination_date,rabies_certificate_reference,
           rabies_verification_status,rabies_verification_method,rabies_verified_at,
           rabies_verified_by_membership_id,photo_permission, created_by, updated_by)
        values
          (${context.businessId}, ${input.customerId}, ${input.name ?? null}, ${input.species},
           ${selection.petTypeId}, ${selection.breedId}, ${selection.breedOther}, ${selection.breed}, ${input.dateOfBirth ?? null}, ${input.approximateAge ?? null},
           ${input.weightOunces ?? null}, ${input.sex ?? null}, ${input.coatNotes ?? null},
           ${input.groomingPreferences ?? null}, ${input.behaviorNotes ?? null},
           ${input.medicalNotes ?? null}, ${input.safetyAlerts ?? null},
           ${input.emergencyContact ?? null}, ${input.veterinarian ?? null},
           ${input.vaccinationNotes ?? null}, ${input.vaccinationExpiresOn ?? null},
           ${input.rabiesVaccinationDate ?? null},${input.rabiesCertificateReference ?? null},
           ${verificationStatus},${verificationStatus === "staff_verified" ? input.rabiesVerificationMethod ?? null : null},
           ${verifiedAt},${verificationStatus === "staff_verified" ? context.membershipId : null},
           ${input.photoPermission ?? null}, ${context.userId}, ${context.userId})
        returning *
      `;
      if (!created) throw new Error("Pet creation failed");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "pet.create",
        resourceType: "pet", resourceId: created.id,
        after: {
          hasSafetyAlerts: Boolean(input.safetyAlerts),
          hasMedicalNotes: Boolean(input.medicalNotes),
          hasBehaviorNotes: Boolean(input.behaviorNotes)
        },
        eventType: "PetCreated"
      });
      return created;
    });
    return reply.code(201).send(mayViewPetCare(context) ? pet : redactPetCare(pet as PetCareRecord & {id:string}));
  });

  app.get("/api/pets/:id", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [pet] = await db`
      select p.*, concat_ws(' ', c.first_name, c.last_name) as customer_name,
        c.phone as customer_phone, c.email as customer_email, c.archived_at as customer_archived_at,
        (select upcoming.scheduled_local_start from appointments upcoming
          where upcoming.business_id=p.business_id and upcoming.pet_id=p.id
            and upcoming.status='scheduled' and upcoming.start_at>now()
          order by upcoming.start_at,upcoming.id limit 1) as next_appointment_local_start,
        coalesce(verifier_employee.display_name,verifier_user.email) as rabies_verified_by_name
      from pets p
      join customers c on c.business_id=p.business_id and c.id=p.customer_id
      left join business_memberships verifier on verifier.business_id=p.business_id
        and verifier.id=p.rabies_verified_by_membership_id
      left join users verifier_user on verifier_user.id=verifier.user_id
      left join employees verifier_employee on verifier_employee.business_id=p.business_id
        and verifier_employee.membership_id=verifier.id
      where p.business_id=${context.businessId} and p.id=${id}
    `;
    if (!pet) return reply.code(404).send({ error: "Pet not found" });
    return mayViewPetCare(context) ? pet : redactPetCare(pet);
  });

  app.get("/api/pets/:id/appointments", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const query = body(appointmentHistoryQuerySchema, request.query);
    const [pet] = await db<{ id: string }[]>`
      select id from pets where business_id=${context.businessId} and id=${id}
    `;
    if (!pet) return reply.code(404).send({ error: "Pet not found" });
    const { items, total } = await appointmentHistoryPage(db, {
      businessId: context.businessId, scope: "pet", id,
      limit: query.pageSize, offset: (query.page - 1) * query.pageSize
    });
    return { items, total, page: query.page, pageSize: query.pageSize };
  });

  app.put("/api/pets/:id", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const protectedFields = suppliedPetCareFields(request.body as PetCareRecord);
    if (protectedFields.length) {
      if (!context.isOwner && !context.permissions.includes("pets.care.edit")) {
        return reply.code(403).send({ error: "Missing permission: pets.care.edit" });
      }
      return reply.code(400).send({ error: "Protected safety fields must use the safety update operation" });
    }
    const input = body(petProfileUpdateSchema, request.body);
    const updated = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [customer] = await tx<{ available: boolean }[]>`
        select exists (
          select 1 from customers
          where business_id=${context.businessId} and id=${input.customerId} and archived_at is null
        ) as available
      `;
      if (!customer?.available) return { kind: "invalidCustomer" } as const;
      // The pet's stored breed is read first so unchanged legacy text can be grandfathered
      // through: editing a weight must never fail because a historical breed predates the
      // canonical taxonomy.
      const [existingPet] = await tx<{ breed: string | null; breedId: string | null; petTypeId: string | null }[]>`
        select breed,breed_id,pet_type_id from pets
        where business_id=${context.businessId} and id=${id} and archived_at is null
      `;
      const selection = await resolvePetBreedSelection(tx, {
        businessId: context.businessId,
        supplied: { species: input.species, petTypeId: input.petTypeId, breedId: input.breedId, breed: input.breed, breedOther: input.breedOther },
        current: existingPet ?? null
      });
      const [pet] = await tx`
        update pets set customer_id=${input.customerId},name=${input.name ?? null},species=${input.species},
          pet_type_id=${selection.petTypeId},breed_id=${selection.breedId},breed_other=${selection.breedOther},
          breed=${selection.breed},date_of_birth=${input.dateOfBirth ?? null},
          approximate_age=${input.approximateAge ?? null},weight_ounces=${input.weightOunces ?? null},
          sex=${input.sex ?? null},coat_notes=${input.coatNotes ?? null},
          grooming_preferences=${input.groomingPreferences ?? null},
          photo_permission=${input.photoPermission ?? null},
          mixed_breed=${input.mixedBreed ?? null},hair_length=${input.hairLength ?? null},
          coat_color=${input.coatColor ?? null},fixed_status=${input.fixedStatus ?? null},
          preferred_shampoo=${input.preferredShampoo ?? null},
          approximate_age_years=${input.approximateAgeYears ?? null},
          approximate_age_months=${input.approximateAgeMonths ?? null},version=version+1,
          updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id} and archived_at is null
          and version=${input.version}
        returning *
      `;
      if (pet) return { kind: "updated", pet } as const;
      const [existing] = await tx<{ exists: boolean }[]>`
        select exists (
          select 1 from pets where business_id=${context.businessId} and id=${id} and archived_at is null
        ) as exists
      `;
      return existing?.exists ? { kind: "stale" } as const : null;
    });
    if (!updated) return reply.code(404).send({ error: "Active pet not found" });
    if (updated.kind === "invalidCustomer") {
      return reply.code(400).send({ error: "The selected customer is unavailable" });
    }
    if (updated.kind === "stale") {
      return reply.code(409).send({ error: "Pet changed; refresh before continuing" });
    }
    return mayViewPetCare(context) ? updated.pet : redactPetCare(updated.pet);
  });

  app.put("/api/pets/:id/care", {
    preHandler: [
      authenticate,
      requirePermission("pets.edit"),
      requirePermission("pets.care.edit")
    ]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(petCareUpdateSchema, request.body);
    const supplied = new Set(suppliedPetCareFields(input));
    const updated = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [before] = await tx<{
        safetyAlerts: string | null;
        medicalNotes: string | null;
        behaviorNotes: string | null;
        emergencyContact: string | null;
        veterinarian: string | null;
        vaccinationNotes: string | null;
        vaccinationExpiresOn: string | null;
        rabiesVaccinationDate: string | null;
        rabiesCertificateReference: string | null;
        rabiesVerificationStatus: string;
        rabiesVerificationMethod: string | null;
        rabiesVerificationDate: string | null;
        rabiesVerifiedByMembershipId: string | null;
        healthIssues: string[] | null;
        vetName: string | null;
        vetPhone: string | null;
        vetContactName: string | null;
        vetContactPhone: string | null;
        vetAddress: string | null;
        version: number;
      }[]>`
        select safety_alerts,medical_notes,behavior_notes,emergency_contact,veterinarian,
          vaccination_notes,vaccination_expires_on,rabies_vaccination_date,
          rabies_certificate_reference,rabies_verification_status,rabies_verification_method,
          rabies_verified_at as rabies_verification_date,
          rabies_verified_by_membership_id,
          health_issues,vet_name,vet_phone,vet_contact_name,vet_contact_phone,vet_address,version
        from pets
        where business_id=${context.businessId} and id=${id} and archived_at is null
        for update
      `;
      if (!before) return null;
      if (before.version !== input.version) return { kind: "stale" } as const;
      const after: PetCareRecord = { ...before };
      for (const field of writablePetCareFields) {
        if (supplied.has(field)) after[field] = input[field];
      }
      const changedFields = changedPetCareFields(before, after);
      // Verification columns are historical metadata. Expiration-only edits must preserve them.
      const verificationStatus=before.rabiesVerificationStatus;
      const method=before.rabiesVerificationMethod;
      const verifiedAt=before.rabiesVerificationDate;
      const [pet] = await tx`
        update pets set
          safety_alerts=${supplied.has("safetyAlerts") ? input.safetyAlerts ?? null : before.safetyAlerts},
          medical_notes=${supplied.has("medicalNotes") ? input.medicalNotes ?? null : before.medicalNotes},
          behavior_notes=${supplied.has("behaviorNotes") ? input.behaviorNotes ?? null : before.behaviorNotes},
          emergency_contact=${supplied.has("emergencyContact") ? input.emergencyContact ?? null : before.emergencyContact},
          veterinarian=${supplied.has("veterinarian") ? input.veterinarian ?? null : before.veterinarian},
          vaccination_notes=${supplied.has("vaccinationNotes") ? input.vaccinationNotes ?? null : before.vaccinationNotes},
          vaccination_expires_on=${
            supplied.has("vaccinationExpiresOn") ? input.vaccinationExpiresOn ?? null : before.vaccinationExpiresOn
          },
          rabies_vaccination_date=${supplied.has("rabiesVaccinationDate") ? input.rabiesVaccinationDate ?? null : before.rabiesVaccinationDate},
          rabies_certificate_reference=${supplied.has("rabiesCertificateReference") ? input.rabiesCertificateReference ?? null : before.rabiesCertificateReference},
          rabies_verification_status=${verificationStatus},
          rabies_verification_method=${method},
          rabies_verified_at=${verifiedAt},
          rabies_verified_by_membership_id=${before.rabiesVerifiedByMembershipId},
          health_issues=${supplied.has("healthIssues") ? input.healthIssues ?? null : before.healthIssues},
          vet_name=${supplied.has("vetName") ? input.vetName ?? null : before.vetName},
          vet_phone=${supplied.has("vetPhone") ? input.vetPhone ?? null : before.vetPhone},
          vet_contact_name=${supplied.has("vetContactName") ? input.vetContactName ?? null : before.vetContactName},
          vet_contact_phone=${supplied.has("vetContactPhone") ? input.vetContactPhone ?? null : before.vetContactPhone},
          vet_address=${supplied.has("vetAddress") ? input.vetAddress ?? null : before.vetAddress},
          version=version+1,updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id} and version=${input.version}
        returning *
      `;
      if (!pet) return { kind: "stale" } as const;
      if (changedFields.length) {
        const rabiesChanged=changedFields.some((field)=>field.startsWith("rabies") || field === "vaccinationExpiresOn");
        if(rabiesChanged) {
          await tx`
            update notification_intents set status='cancelled',resolved_at=now(),updated_at=now()
            where business_id=${context.businessId}
              and appointment_id in (select id from appointments where business_id=${context.businessId} and pet_id=${id})
              and notification_type in ('rabies_expiration_customer','rabies_expiration_staff')
              and status in ('pending','failed','suppressed')
          `;
        }
        await record(tx, {
          businessId: context.businessId,
          actorId: context.userId,
          action: "pet.care.update",
          resourceType: "pet",
          resourceId: id,
          after: { changedFields },
          eventType: rabiesChanged ? "RabiesComplianceUpdated" : undefined
        });
      }
      return { kind: "updated", pet } as const;
    });
    if (!updated) return reply.code(404).send({ error: "Active pet not found" });
    if (updated.kind === "stale") {
      return reply.code(409).send({ error: "Pet changed; refresh before continuing" });
    }
    return mayViewPetCare(context) ? updated.pet : redactPetCare(updated.pet);
  });

  app.get("/api/pets/:id/documents", {
    preHandler: [authenticate, requirePermission("pets.care.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [pet] = await db<{ id: string }[]>`
      select id from pets where business_id=${context.businessId} and id=${id}
    `;
    if (!pet) return reply.code(404).send({ error: "Pet not found" });
    const rows = await db<DocumentApiRow[]>`
      select id,document_type,state,document_version,safe_download_filename,size_bytes,
        document_date,expires_on,created_at
      from pet_documents
      where business_id=${context.businessId} and pet_id=${id}
        and document_type='rabies_vaccination' and state in ('current','superseded')
      order by (state='current') desc,created_at desc,id desc
    `;
    const activity = await db<DocumentActivityRow[]>`
      select request.upload_request_id request_id,request.operation,request.state request_state,
        request.result_code,request.last_scan_error,document.safe_download_filename filename,request.created_at,request.updated_at
      from pet_document_requests request
      join pet_documents document on document.business_id=request.business_id and document.request_id=request.id
      where request.business_id=${context.businessId} and request.pet_id=${id}
        and request.created_at>=now()-interval '7 days'
        and request.state<>'completed'
      order by request.updated_at desc,request.id desc
      limit 5
    `;
    return {
      current: rows.find((row) => row.state === "current") ? publicDocument(rows.find((row) => row.state === "current")!) : null,
      previous: rows.filter((row) => row.state === "superseded").map(publicDocument),
      activity: activity.map(publicDocumentActivity)
    };
  });

  app.get("/api/pets/:id/document-requests/:requestId", {
    preHandler: [authenticate, requirePermission("pets.edit"), requirePermission("pets.care.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const params = z.object({ id: z.string().uuid(), requestId: z.string().uuid() }).parse(request.params);
    const query = z.object({ operation: z.enum(["upload","replace"]) }).parse(request.query);
    const [requestRow] = await db<{
      state: string; resultCode: string | null; resultDocumentId: string | null;
      createdAt: string; updatedAt: string;
    }[]>`
      select state,result_code,result_document_id,created_at,updated_at
      from pet_document_requests
      where business_id=${context.businessId} and pet_id=${params.id}
        and operation=${query.operation} and upload_request_id=${params.requestId}
    `;
    if (!requestRow) return reply.code(404).send({ error: "Upload request not found" });
    let result = null;
    if (requestRow.resultDocumentId) {
      const [document] = await db<DocumentApiRow[]>`
        select id,document_type,state,document_version,safe_download_filename,size_bytes,
          document_date,expires_on,created_at
        from pet_documents where business_id=${context.businessId} and id=${requestRow.resultDocumentId}
      `;
      if (document) result = publicDocument(document);
    }
    return { state: requestRow.state, code: requestRow.resultCode, result };
  });

  app.post("/api/pets/:id/documents/rabies", {
    preHandler: [authenticate, requirePermission("pets.edit"), requirePermission("pets.care.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id: petId } = idParams.parse(request.params);
    if (!request.isMultipart()) return reply.code(400).send({ error: "Multipart upload required" });
    const iterator = request.parts()[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || first.value.type !== "field" || first.value.fieldname !== "metadata") {
      return reply.code(400).send({ error: "Metadata must be the first multipart field" });
    }
    let metadataValue: unknown;
    try { metadataValue = JSON.parse(String(first.value.value)); }
    catch { return reply.code(400).send({ error: "Invalid upload metadata" }); }
    const metadata = documentUploadMetadataSchema.parse(metadataValue);
    const operation = metadata.expectedCurrentDocumentId ? "replace" : "upload";
    const fingerprint = documentRequestFingerprint(metadata);

    const [activePet] = await db<{ id: string }[]>`
      select pet.id from pets pet join customers customer
        on customer.business_id=pet.business_id and customer.id=pet.customer_id
      where pet.business_id=${context.businessId} and pet.id=${petId}
        and pet.archived_at is null and customer.archived_at is null
    `;
    if (!activePet) return reply.code(404).send({ error: "Active pet not found" });

    const [createdRequest] = await db<{ id: string }[]>`
      insert into pet_document_requests
        (business_id,pet_id,operation,upload_request_id,metadata_fingerprint,state,requested_by,membership_id,
         expected_current_document_id,expected_current_document_version,expected_pet_version,
         expiration_intent,expiration_value,document_date)
      values (${context.businessId},${petId},${operation},${metadata.uploadRequestId},${fingerprint},'in_progress',
        ${context.userId},${context.membershipId},${metadata.expectedCurrentDocumentId},
        ${metadata.expectedCurrentDocumentVersion ?? null},${null},
        'preserve',${null},
        ${metadata.documentDate ?? null})
      on conflict (business_id,pet_id,operation,upload_request_id) do nothing
      returning id
    `;
    if (!createdRequest) {
      const [existing] = await db<{
        state: string; metadataFingerprint: string; resultDocumentId: string | null; resultCode: string | null;
      }[]>`
        select state,metadata_fingerprint,result_document_id,result_code
        from pet_document_requests
        where business_id=${context.businessId} and pet_id=${petId}
          and operation=${operation} and upload_request_id=${metadata.uploadRequestId}
      `;
      if (!existing || existing.metadataFingerprint !== fingerprint) {
        return reply.code(409).send({ code: "UPLOAD_REQUEST_CONFLICT", error: "Upload request identity was already used" });
      }
      if (existing.state === "completed" && existing.resultDocumentId) {
        const [document] = await db<DocumentApiRow[]>`
          select id,document_type,state,document_version,safe_download_filename,size_bytes,
            document_date,expires_on,created_at
          from pet_documents where business_id=${context.businessId} and id=${existing.resultDocumentId}
        `;
        return document ? publicDocument(document) : reply.code(409).send({ error: "Completed upload result is unavailable" });
      }
      if (existing.state === "in_progress") {
        return reply.code(202).send({ state: "in_progress" });
      }
      return reply.code(409).send({ code: existing.resultCode ?? "UPLOAD_REQUEST_TERMINAL", error: "Use a new upload request identifier" });
    }

    const failRequest = async (state: "failed" | "conflict", code: string) => {
      await db`
        update pet_document_requests set state=${state},result_code=${code},updated_at=now(),completed_at=now()
        where id=${createdRequest.id} and state='in_progress'
      `;
    };

    const second = await iterator.next();
    if (second.done || second.value.type !== "file" || second.value.fieldname !== "file") {
      await failRequest("failed", "INVALID_MULTIPART");
      return reply.code(400).send({ error: "Exactly one PDF file is required" });
    }
    if (second.value.mimetype !== "application/pdf") {
      second.value.file.resume();
      await failRequest("failed", "INVALID_MIME");
      return reply.code(400).send({ error: "Only PDF files are supported" });
    }
    let bytes: Buffer;
    try { bytes = await second.value.toBuffer(); }
    catch {
      await failRequest("failed", "UPLOAD_TOO_LARGE");
      return reply.code(413).send({ error: "PDF must be 10 MB or smaller" });
    }
    const extra = await iterator.next();
    if (!extra.done) {
      if (extra.value.type === "file") extra.value.file.resume();
      await failRequest("failed", "INVALID_MULTIPART");
      return reply.code(400).send({ error: "Duplicate upload fields are not allowed" });
    }
    if (!validPdf(bytes)) {
      await failRequest("failed", "INVALID_PDF");
      return reply.code(400).send({ error: "The file did not pass PDF upload sanity validation" });
    }
    const digest = sha256(bytes);
    if (metadata.claimedDigest && metadata.claimedDigest !== digest) {
      await failRequest("failed", "DIGEST_MISMATCH");
      return reply.code(400).send({ error: "The uploaded file digest did not match" });
    }
    const documentId = randomUUID();
    const storageKey = `business/${context.businessId}/pets/${petId}/documents/${documentId}`;
    const filename = safePdfFilename(second.value.filename || "rabies-vaccination.pdf");
    await db`
      insert into pet_documents
        (id,business_id,pet_id,document_type,state,original_filename,safe_download_filename,
         storage_key,content_type,document_date,expires_on,uploaded_by,request_id)
      values (${documentId},${context.businessId},${petId},'rabies_vaccination','pending',
        ${filename.original},${filename.download},${storageKey},'application/pdf',
        ${metadata.documentDate ?? null},
        ${null},${context.userId},${createdRequest.id})
    `;
    let uploaded = false;
    try {
      await documentStorage.put(storageKey, bytes, "application/pdf");
      uploaded = true;
      await db`
        update pet_documents set size_bytes=${bytes.byteLength},sha256=${digest},
          object_uploaded_at=now(),updated_at=now()
        where business_id=${context.businessId} and id=${documentId} and state='pending'
      `;
      await db.begin(async (tx) => {
        const [requestRow] = await tx<{petId:string;requestedBy:string;expectedCurrentDocumentId:string|null;expectedCurrentDocumentVersion:number|null;expectedPetVersion:number|null;expirationIntent:string;expirationValue:string|null}[]>`
          select pet_id,requested_by,expected_current_document_id,expected_current_document_version,expected_pet_version,expiration_intent,expiration_value
          from pet_document_requests where id=${createdRequest.id} and state='in_progress' for update`;
        if (!requestRow) throw new Error("Upload request is no longer active");
        const [membership] = await tx<{isOwner:boolean;permissions:string[]}[]>`select is_owner,permissions from business_memberships where business_id=${context.businessId} and id=${context.membershipId} and user_id=${context.userId} and status='active' for update`;
        if (!membership || (!membership.isOwner && (!membership.permissions.includes('pets.edit') || !membership.permissions.includes('pets.care.edit')))) throw new Error("PERMISSION_REVOKED");
        const [pet] = await tx<{version:number;vaccinationExpiresOn:string|null}[]>`select version,vaccination_expires_on from pets where business_id=${context.businessId} and id=${requestRow.petId} for update`;
        const [current] = await tx<{id:string;documentVersion:number}[]>`select id,document_version from pet_documents where business_id=${context.businessId} and pet_id=${requestRow.petId} and document_type='rabies_vaccination' and state='current' for update`;
        if ((requestRow.expectedCurrentDocumentId === null && current) || (requestRow.expectedCurrentDocumentId && (!current || current.id !== requestRow.expectedCurrentDocumentId || current.documentVersion !== requestRow.expectedCurrentDocumentVersion))) throw new Error("DOCUMENT_STALE");
        if (current) await tx`update pet_documents set state='superseded',updated_at=now() where id=${current.id}`;
        const expiration: string | null = pet?.vaccinationExpiresOn ?? null;
        await tx`update pet_documents set state='current',expires_on=${expiration},updated_at=now() where id=${documentId} and state='pending'`;
        await documentHooks?.beforeDocumentAudit?.({ businessId: context.businessId, petId: requestRow.petId, documentId });
        await tx`update pet_document_requests set state='completed',result_document_id=${documentId},result_code='COMPLETED',completed_at=now(),updated_at=now() where id=${createdRequest.id}`;
        await tx`insert into audit_events(business_id,actor_id,action,resource_type,resource_id,correlation_id,after_data) values (${context.businessId},${context.userId},${current ? 'pet.document.replaced' : 'pet.document.uploaded'},'pet_document',${documentId},${randomUUID()},${tx.json({petId:requestRow.petId,documentType:'rabies_vaccination',supportingAttachment:true})})`;
      });
      const [document] = await db<DocumentApiRow[]>`select id,document_type,state,document_version,safe_download_filename,size_bytes,document_date,expires_on,created_at from pet_documents where business_id=${context.businessId} and id=${documentId}`;
      return reply.code(metadata.expectedCurrentDocumentId ? 200 : 201).send(publicDocument(document!));
    } catch (error) {
      const code = error instanceof Error ? error.message : "UPLOAD_FAILED";
      await failRequest("failed", error instanceof DocumentStorageError ? error.code.toUpperCase() : "UPLOAD_FAILED");
      if (uploaded) {
        await db`delete from pet_documents where business_id=${context.businessId} and id=${documentId} and state='pending'`;
        await documentStorage.delete(storageKey).catch(() => undefined);
      }
      if (code === "PERMISSION_REVOKED") return reply.code(403).send({ error: "Pet Care permission is required" });
      if (code === "DOCUMENT_STALE" || code === "PET_STALE") return reply.code(409).send({ error: "The pet or document changed; refresh and try again" });
      if (code === "Upload request is no longer active") return reply.code(409).send({ error: code });
      request.log.warn({ errorName: (error as Error).name }, "pet document upload failed");
      return reply.code(503).send({ error: "The document could not be stored" });
    }
  });

  app.get("/api/pet-documents/:id/download", {
    preHandler: [authenticate, requirePermission("pets.care.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [document] = await db<{
      storageKey: string; sizeBytes: number; safeDownloadFilename: string;
    }[]>`
      select storage_key,size_bytes,safe_download_filename
      from pet_documents
      where business_id=${context.businessId} and id=${id} and state in ('current','superseded')
    `;
    if (!document) return reply.code(404).send({ error: "Document not found" });
    try {
      const head = await documentStorage.head(document.storageKey);
      if (head.size !== Number(document.sizeBytes)) {
        request.log.error({ documentId: id }, "pet document storage size mismatch");
        return reply.code(503).send({ error: "Document is temporarily unavailable" });
      }
      const object = await documentStorage.get(document.storageKey);
      if (object.size !== head.size) return reply.code(503).send({ error: "Document is temporarily unavailable" });
      const encoded = encodeURIComponent(document.safeDownloadFilename).replace(/['()]/g, escape);
      // The pet profile links "View document", which should open the certificate rather than
      // download it. Inline is opt-in per request, so nothing that already downloads changes,
      // and the response keeps nosniff plus a policy that permits nothing at all.
      const inline = (request.query as { disposition?: string } | undefined)?.disposition === "inline";
      return reply
        .header("Content-Type", "application/pdf")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="rabies-vaccination.pdf"; filename*=UTF-8''${encoded}`)
        .header("Cache-Control", "private, no-store")
        .header("Content-Length", object.size)
        .code(200).send(Buffer.from(object.bytes));
    } catch (error) {
      request.log.warn({ documentId: id, errorName: (error as Error).name }, "pet document download unavailable");
      return reply.code(503).send({ error: "Document is temporarily unavailable" });
    }
  });

  // ---------------------------------------------------------------------------
  // Pet notes
  //
  // The same thread the client profile has, against a pet. Every entry records who wrote it and
  // when, because a grooming instruction nobody can be asked about is not much use later.
  // Gated on the ordinary pet permissions rather than pet care: "one inch reverse, round head"
  // is a grooming instruction, not medical information.
  // ---------------------------------------------------------------------------
  async function petNoteRows(database: Database, input: { businessId: string; petId: string }) {
    return database`
      select note.id,note.body,note.pinned,note.created_at,note.updated_at,
        coalesce(author_employee.display_name,author_user.display_name,author_user.email) as author_name
      from pet_notes note
      left join users author_user on author_user.id=note.created_by
      left join business_memberships author_membership
        on author_membership.business_id=note.business_id and author_membership.user_id=note.created_by
      left join employees author_employee
        on author_employee.business_id=author_membership.business_id
        and author_employee.membership_id=author_membership.id
      where note.business_id=${input.businessId} and note.pet_id=${input.petId}
      order by note.pinned desc,note.created_at desc,note.id desc
      limit 200
    `;
  }

  async function activePet(businessId: string, petId: string) {
    const [pet] = await db<{ id: string }[]>`
      select id from pets where business_id=${businessId} and id=${petId} and archived_at is null
    `;
    return pet ?? null;
  }

  /**
   * Coat colours already in use in this salon.
   *
   * A managed vocabulary with its own admin screen would be a heavier thing than this deserves;
   * suggesting what the salon has already typed gives the same "pick one or add a new one"
   * behaviour, and a colour becomes a suggestion the moment somebody first uses it.
   */
  app.get("/api/pets/coat-colors", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async (request) => {
    const context = auth(request);
    const rows = await db<{ coatColor: string }[]>`
      select distinct coat_color from pets
      where business_id=${context.businessId} and coat_color is not null and btrim(coat_color) <> ''
      order by coat_color limit 200
    `;
    return { items: rows.map((row) => row.coatColor) };
  });

  app.get("/api/pets/:id/notes", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    if (!await activePet(context.businessId, id)) return reply.code(404).send({ error: "Pet not found" });
    return { items: await petNoteRows(db, { businessId: context.businessId, petId: id }) };
  });

  app.post("/api/pets/:id/notes", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(customerNoteCreateSchema, request.body);
    if (!await activePet(context.businessId, id)) return reply.code(404).send({ error: "Pet not found" });
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      await tx`
        insert into pet_notes (business_id,pet_id,body,pinned,created_by)
        values (${context.businessId},${id},${input.body},${input.pinned},${context.userId})
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "pet.note.create", resourceType: "pet", resourceId: id
      });
    });
    return reply.code(201).send({ items: await petNoteRows(db, { businessId: context.businessId, petId: id }) });
  });

  app.patch("/api/pets/:id/notes/:noteId", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id, noteId } = petNoteParams.parse(request.params);
    const input = body(customerNoteUpdateSchema, request.body);
    const updated = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [current] = await tx<{ id: string; body: string; pinned: boolean }[]>`
        select id,body,pinned from pet_notes
        where business_id=${context.businessId} and pet_id=${id} and id=${noteId} for update
      `;
      if (!current) return null;
      await tx`
        update pet_notes set body=${input.body ?? current.body},
          pinned=${input.pinned ?? current.pinned},updated_at=now()
        where business_id=${context.businessId} and id=${noteId}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "pet.note.edit", resourceType: "pet", resourceId: id
      });
      return current;
    });
    if (!updated) return reply.code(404).send({ error: "Note not found" });
    return { items: await petNoteRows(db, { businessId: context.businessId, petId: id }) };
  });

  app.delete("/api/pets/:id/notes/:noteId", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id, noteId } = petNoteParams.parse(request.params);
    const removed = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [row] = await tx<{ id: string }[]>`
        delete from pet_notes where business_id=${context.businessId} and pet_id=${id} and id=${noteId}
        returning id
      `;
      if (!row) return null;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "pet.note.delete", resourceType: "pet", resourceId: id
      });
      return row;
    });
    if (!removed) return reply.code(404).send({ error: "Note not found" });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------
  // Pet photographs
  //
  // A gallery of the pet over time, any one of which can become the avatar. Same validation and
  // serving posture as appointment photographs: the bytes decide the type, a truncated upload is
  // refused, and delivery is inline under nosniff and a null content policy.
  // ---------------------------------------------------------------------------
  app.get("/api/pets/:id/photos", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [pet] = await db<{ id: string; avatarPhotoId: string | null }[]>`
      select id,avatar_photo_id from pets
      where business_id=${context.businessId} and id=${id} and archived_at is null
    `;
    if (!pet) return reply.code(404).send({ error: "Pet not found" });
    const items = await db`
      select id,width,height,size_bytes,original_filename,content_type,created_at
      from pet_photos
      where business_id=${context.businessId} and pet_id=${id} and state='stored'
      order by created_at desc,id desc
    `;
    return {
      items, avatarPhotoId: pet.avatarPhotoId,
      canEdit: context.isOwner || context.permissions.includes("pets.edit")
    };
  });

  app.post("/api/pets/:id/photos", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    if (!request.isMultipart()) return reply.code(400).send({ error: "Multipart upload required" });
    const iterator = request.parts()[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || first.value.type !== "field" || first.value.fieldname !== "metadata") {
      return reply.code(400).send({ error: "Metadata must be the first multipart field" });
    }
    let metadataValue: unknown;
    try { metadataValue = JSON.parse(String(first.value.value)); }
    catch { return reply.code(400).send({ error: "Invalid upload metadata" }); }
    const parsed = petPhotoUploadMetadataSchema.safeParse(metadataValue);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid upload metadata" });
    const metadata = parsed.data;
    if (!await activePet(context.businessId, id)) return reply.code(404).send({ error: "Pet not found" });

    const [duplicate] = await db<{ id: string; state: string }[]>`
      select id,state from pet_photos
      where business_id=${context.businessId} and pet_id=${id}
        and upload_request_id=${metadata.uploadRequestId}
    `;
    if (duplicate?.state === "stored") {
      const [existing] = await db`
        select id,width,height,size_bytes,original_filename,content_type,created_at
        from pet_photos where business_id=${context.businessId} and id=${duplicate.id}
      `;
      return reply.code(200).send(existing);
    }

    const second = await iterator.next();
    if (second.done || second.value.type !== "file") {
      return reply.code(400).send({ error: "Exactly one image file is required" });
    }
    let bytes: Buffer;
    try { bytes = await second.value.toBuffer(); }
    catch { return reply.code(413).send({ error: "Photos must be 8 MB or smaller" }); }
    const extra = await iterator.next();
    if (!extra.done) {
      if (extra.value.type === "file") extra.value.file.resume();
      return reply.code(400).send({ error: "Duplicate upload fields are not allowed" });
    }
    if (bytes.byteLength > maxPhotoBytes) {
      return reply.code(413).send({ error: "Photos must be 8 MB or smaller" });
    }
    const shape = readPhotoShape(bytes);
    if (!shape) {
      return reply.code(400).send({
        error: "That file is not a readable JPEG, PNG, or WebP image",
        supportedTypes: ["image/jpeg", "image/png", "image/webp"]
      });
    }
    const [count] = await db<{ count: number }[]>`
      select count(*)::int count from pet_photos
      where business_id=${context.businessId} and pet_id=${id} and state='stored'
    `;
    if ((count?.count ?? 0) >= maxPetPhotos) {
      return reply.code(409).send({
        code: "PHOTO_LIMIT_REACHED",
        error: `Up to ${maxPetPhotos} photos can be kept for one pet.`
      });
    }

    const photoId = randomUUID();
    const storageKey = `business/${context.businessId}/pets/${id}/photos/${photoId}`;
    const filename = safePhotoFilename(second.value.filename || "photo", shape.contentType);
    const [reserved] = await db<{ id: string }[]>`
      insert into pet_photos
        (id,business_id,pet_id,state,storage_key,content_type,width,height,
         original_filename,upload_request_id,uploaded_by)
      values (${photoId},${context.businessId},${id},'pending',${storageKey},${shape.contentType},
        ${shape.width},${shape.height},${filename},${metadata.uploadRequestId},${context.userId})
      on conflict (business_id,pet_id,upload_request_id) do nothing
      returning id
    `;
    if (!reserved) return reply.code(409).send({ error: "That upload is already in progress" });

    let uploaded = false;
    try {
      await documentStorage.put(storageKey, bytes, shape.contentType);
      uploaded = true;
      await db.begin(async (tx) => {
        await setTenant(tx, context.businessId);
        await tx`
          update pet_photos set state='stored',size_bytes=${bytes.byteLength},
            sha256=${sha256(bytes)},updated_at=now()
          where business_id=${context.businessId} and id=${photoId} and state='pending'
        `;
        // The first photograph of a pet becomes its avatar, because the alternative is a gallery
        // with a picture in it and a profile still showing an initial.
        if (metadata.useAsAvatar || (count?.count ?? 0) === 0) {
          await tx`
            update pets set avatar_photo_id=${photoId},updated_at=now()
            where business_id=${context.businessId} and id=${id}
          `;
        }
        await record(tx, {
          businessId: context.businessId, actorId: context.userId,
          action: "pet.photo.add", resourceType: "pet", resourceId: id, after: { photoId }
        });
      });
      const [stored] = await db`
        select id,width,height,size_bytes,original_filename,content_type,created_at
        from pet_photos where business_id=${context.businessId} and id=${photoId}
      `;
      return reply.code(201).send(stored);
    } catch (error) {
      await db`delete from pet_photos
        where business_id=${context.businessId} and id=${photoId} and state='pending'`;
      if (uploaded) await documentStorage.delete(storageKey).catch(() => undefined);
      request.log.warn({ petId: id, errorName: (error as Error).name }, "pet photo upload failed");
      return reply.code(503).send({ error: "The photo could not be stored" });
    }
  });

  app.get("/api/pet-photos/:id/content", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [photo] = await db<{
      storageKey: string; sizeBytes: string; contentType: string; originalFilename: string;
    }[]>`
      select storage_key,size_bytes,content_type,original_filename from pet_photos
      where business_id=${context.businessId} and id=${id} and state='stored'
    `;
    if (!photo) return reply.code(404).send({ error: "Photo not found" });
    try {
      const object = await documentStorage.get(photo.storageKey);
      if (object.size !== Number(photo.sizeBytes)) {
        request.log.error({ photoId: id }, "pet photo storage size mismatch");
        return reply.code(503).send({ error: "Photo is temporarily unavailable" });
      }
      const encoded = encodeURIComponent(photo.originalFilename).replace(/['()]/g, escape);
      return reply
        .header("Content-Type", photo.contentType)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Content-Disposition", `inline; filename*=UTF-8''${encoded}`)
        .header("Cache-Control", "private, max-age=300")
        .header("Content-Length", object.size)
        .code(200).send(Buffer.from(object.bytes));
    } catch (error) {
      request.log.warn({ photoId: id, errorName: (error as Error).name }, "pet photo unavailable");
      return reply.code(503).send({ error: "Photo is temporarily unavailable" });
    }
  });

  /** Choose which photograph represents the pet, or clear it back to an initial. */
  app.patch("/api/pets/:id/avatar", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(petAvatarSchema, request.body);
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      if (input.photoId) {
        const [photo] = await tx<{ id: string }[]>`
          select id from pet_photos
          where business_id=${context.businessId} and pet_id=${id} and id=${input.photoId}
            and state='stored'
        `;
        if (!photo) return { missingPhoto: true } as const;
      }
      const [pet] = await tx<{ id: string }[]>`
        update pets set avatar_photo_id=${input.photoId ?? null},updated_at=now()
        where business_id=${context.businessId} and id=${id} and archived_at is null
        returning id
      `;
      if (!pet) return { missingPet: true } as const;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "pet.avatar.set", resourceType: "pet", resourceId: id,
        after: { photoId: input.photoId ?? null }
      });
      return { avatarPhotoId: input.photoId ?? null };
    });
    if ("missingPet" in result) return reply.code(404).send({ error: "Pet not found" });
    if ("missingPhoto" in result) return reply.code(404).send({ error: "Photo not found" });
    return result;
  });

  app.delete("/api/pet-photos/:id", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const removed = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [photo] = await tx<{ id: string; storageKey: string; petId: string }[]>`
        select id,storage_key,pet_id from pet_photos
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!photo) return null;
      // Cleared here rather than by the foreign key: the reference is composite, so a cascade
      // would set every column in it, including the not-null business_id. A pet whose portrait
      // is deleted falls back to its initial.
      await tx`
        update pets set avatar_photo_id=null,updated_at=now()
        where business_id=${context.businessId} and avatar_photo_id=${id}
      `;
      await tx`delete from pet_photos where business_id=${context.businessId} and id=${id}`;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "pet.photo.remove", resourceType: "pet", resourceId: photo.petId,
        before: { photoId: id }
      });
      return photo;
    });
    if (!removed) return reply.code(404).send({ error: "Photo not found" });
    await documentStorage.delete(removed.storageKey).catch(() => undefined);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------
  // Vaccination records
  //
  // Rabies is not stored here; the schema refuses it. It already has an authoritative home on
  // the pet and in `pet_documents`, where the expiry drives appointment eligibility and customer
  // notification. The interface renders that record alongside these and sends edits to the place
  // that owns it, so there is never a second answer to "is this dog covered?".
  // ---------------------------------------------------------------------------
  app.get("/api/pets/:id/vaccinations", {
    preHandler: [authenticate, requirePermission("pets.care.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [pet] = await db<{
      id: string; vaccinationExpiresOn: string | null; rabiesVaccinationDate: string | null;
    }[]>`
      select id,vaccination_expires_on,rabies_vaccination_date from pets
      where business_id=${context.businessId} and id=${id} and archived_at is null
    `;
    if (!pet) return reply.code(404).send({ error: "Pet not found" });
    const [items, documents] = await Promise.all([
      db`
        select id,vaccine,expires_on,notes,version,created_at,updated_at,
          document_filename,document_content_type,
          (document_storage_key is not null) as has_document
        from pet_vaccinations
        where business_id=${context.businessId} and pet_id=${id}
        order by expires_on desc nulls last,id
      `,
      db`
        select id,safe_download_filename,document_type,created_at from pet_documents
        where business_id=${context.businessId} and pet_id=${id} and state='current'
      `
    ]);
    return {
      items,
      // Reported separately and marked as owned elsewhere, so the interface can show it in the
      // same table without implying it is editable in the same way.
      rabies: {
        expiresOn: pet.vaccinationExpiresOn,
        vaccinatedOn: pet.rabiesVaccinationDate,
        documentId: documents.find((document) => document.documentType === "rabies_vaccination")?.id ?? null,
        managedElsewhere: true
      },
      canEdit: context.isOwner || context.permissions.includes("pets.care.edit")
    };
  });

  app.post("/api/pets/:id/vaccinations", {
    preHandler: [authenticate, requirePermission("pets.care.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(petVaccinationCreateSchema, request.body);
    if (!await activePet(context.businessId, id)) return reply.code(404).send({ error: "Pet not found" });
    if (input.vaccine.trim().toLowerCase() === "rabies") {
      return reply.code(409).send({
        code: "RABIES_MANAGED_ELSEWHERE",
        error: "Rabies is recorded on the pet's care record and its document, not as a free record."
      });
    }
    const created = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [row] = await tx<{ id: string }[]>`
        insert into pet_vaccinations
          (business_id,pet_id,vaccine,expires_on,notes,created_by,updated_by)
        values (${context.businessId},${id},${input.vaccine},${input.expiresOn ?? null},
          ${input.notes ?? null},${context.userId},${context.userId})
        returning id
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "pet.vaccination.create", resourceType: "pet", resourceId: id,
        after: { vaccine: input.vaccine, expiresOn: input.expiresOn ?? null }
      });
      return row;
    });
    return reply.code(201).send({ id: created?.id });
  });

  /**
   * Attach the certificate a vaccination came from — a photo of the card, or a PDF.
   *
   * Both are accepted and both are checked structurally: an image has its header parsed the same
   * way a pet photograph does, and a PDF has to start and end like one. The declared mimetype is
   * ignored in favour of what the bytes are, because this file is served back to a browser.
   *
   * Replacing an attachment deletes the old object after the row points at the new one, so a
   * failure part-way through leaves a readable record rather than a broken link.
   */
  app.post("/api/pet-vaccinations/:id/document", {
    preHandler: [authenticate, requirePermission("pets.care.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    if (!request.isMultipart()) return reply.code(400).send({ error: "Multipart upload required" });
    const [current] = await db<{ id: string; petId: string; documentStorageKey: string | null }[]>`
      select id,pet_id,document_storage_key from pet_vaccinations
      where business_id=${context.businessId} and id=${id}
    `;
    if (!current) return reply.code(404).send({ error: "Vaccination record not found" });

    const iterator = request.parts()[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || first.value.type !== "file") {
      return reply.code(400).send({ error: "Exactly one file is required" });
    }
    let bytes: Buffer;
    try { bytes = await first.value.toBuffer(); }
    catch { return reply.code(413).send({ error: "Attachments must be 8 MB or smaller" }); }
    const extra = await iterator.next();
    if (!extra.done) {
      if (extra.value.type === "file") extra.value.file.resume();
      return reply.code(400).send({ error: "Only one file can be attached" });
    }
    if (bytes.byteLength > maxPhotoBytes) {
      return reply.code(413).send({ error: "Attachments must be 8 MB or smaller" });
    }
    const image = readPhotoShape(bytes);
    const contentType = image?.contentType ?? (validPdf(bytes) ? "application/pdf" : null);
    if (!contentType) {
      return reply.code(400).send({
        error: "Attach a readable PDF, JPEG, PNG, or WebP file",
        supportedTypes: ["application/pdf", "image/jpeg", "image/png", "image/webp"]
      });
    }
    const filename = contentType === "application/pdf"
      ? safePdfFilename(first.value.filename || "vaccination.pdf").download
      : safePhotoFilename(first.value.filename || "vaccination", image!.contentType);
    const storageKey = `business/${context.businessId}/pets/${current.petId}/vaccinations/${id}/${randomUUID()}`;
    try {
      await documentStorage.put(storageKey, bytes, contentType);
    } catch (error) {
      request.log.warn({ vaccinationId: id, errorName: (error as Error).name }, "vaccination attachment failed");
      return reply.code(503).send({ error: "The attachment could not be stored" });
    }
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      await tx`
        update pet_vaccinations set
          document_storage_key=${storageKey},document_content_type=${contentType},
          document_filename=${filename},document_size_bytes=${bytes.byteLength},
          document_sha256=${sha256(bytes)},document_uploaded_at=now(),
          version=version+1,updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "pet.vaccination.document", resourceType: "pet", resourceId: current.petId,
        after: { vaccinationId: id, contentType }
      });
    });
    // Only once the row points at the new object, so a failure leaves a readable record.
    if (current.documentStorageKey) {
      await documentStorage.delete(current.documentStorageKey).catch(() => undefined);
    }
    return reply.code(201).send({ filename, contentType });
  });

  app.get("/api/pet-vaccinations/:id/document", {
    preHandler: [authenticate, requirePermission("pets.care.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [row] = await db<{
      documentStorageKey: string | null; documentContentType: string | null;
      documentFilename: string | null; documentSizeBytes: string | null;
    }[]>`
      select document_storage_key,document_content_type,document_filename,document_size_bytes
      from pet_vaccinations where business_id=${context.businessId} and id=${id}
    `;
    if (!row?.documentStorageKey) return reply.code(404).send({ error: "No attachment on this record" });
    try {
      const object = await documentStorage.get(row.documentStorageKey);
      if (object.size !== Number(row.documentSizeBytes)) {
        request.log.error({ vaccinationId: id }, "vaccination attachment size mismatch");
        return reply.code(503).send({ error: "Attachment is temporarily unavailable" });
      }
      const encoded = encodeURIComponent(row.documentFilename ?? "vaccination").replace(/['()]/g, escape);
      return reply
        .header("Content-Type", row.documentContentType!)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Content-Disposition", `inline; filename*=UTF-8''${encoded}`)
        .header("Cache-Control", "private, no-store")
        .header("Content-Length", object.size)
        .code(200).send(Buffer.from(object.bytes));
    } catch (error) {
      request.log.warn({ vaccinationId: id, errorName: (error as Error).name }, "vaccination attachment unavailable");
      return reply.code(503).send({ error: "Attachment is temporarily unavailable" });
    }
  });

  app.patch("/api/pet-vaccinations/:id", {
    preHandler: [authenticate, requirePermission("pets.care.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(petVaccinationUpdateSchema, request.body);
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [current] = await tx<{
        id: string; petId: string; vaccine: string; expiresOn: string | null;
        notes: string | null; version: number;
      }[]>`
        select id,pet_id,vaccine,expires_on,notes,version from pet_vaccinations
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!current) return { missing: true } as const;
      if (current.version !== input.version) return { stale: true } as const;
      await tx`
        update pet_vaccinations set
          vaccine=${input.vaccine ?? current.vaccine},
          expires_on=${input.expiresOn === undefined ? current.expiresOn : input.expiresOn},
          notes=${input.notes === undefined ? current.notes : input.notes},
          version=version+1,updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "pet.vaccination.edit", resourceType: "pet", resourceId: current.petId,
        before: { vaccine: current.vaccine, expiresOn: current.expiresOn }
      });
      return { updated: true } as const;
    });
    if ("missing" in result) return reply.code(404).send({ error: "Vaccination record not found" });
    if ("stale" in result) {
      return reply.code(409).send({ error: "The record changed; refresh and try again" });
    }
    return { updated: true };
  });

  app.delete("/api/pet-vaccinations/:id", {
    preHandler: [authenticate, requirePermission("pets.care.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const removed = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [row] = await tx<{ id: string; petId: string; vaccine: string }[]>`
        delete from pet_vaccinations where business_id=${context.businessId} and id=${id}
        returning id,pet_id,vaccine
      `;
      if (!row) return null;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "pet.vaccination.delete", resourceType: "pet", resourceId: row.petId,
        before: { vaccine: row.vaccine }
      });
      return row;
    });
    if (!removed) return reply.code(404).send({ error: "Vaccination record not found" });
    return reply.code(204).send();
  });

  /**
   * Mark a pet as having died, or reverse that.
   *
   * The record stays: its history, invoices, and report cards all still have to be explainable,
   * and archiving it would hide the pet from the profile that explains them. What changes is that
   * the interface stops offering to book it and says why.
   */
  app.post("/api/pets/:id/deceased", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(petDeceasedSchema, request.body);
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [pet] = await tx<{ id: string; deceasedAt: Date | null }[]>`
        update pets set deceased_at=${input.deceased ? new Date() : null},
          version=version+1,updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id} and archived_at is null
        returning id,deceased_at
      `;
      if (!pet) return null;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: input.deceased ? "pet.deceased.mark" : "pet.deceased.clear",
        resourceType: "pet", resourceId: id
      });
      return pet;
    });
    if (!result) return reply.code(404).send({ error: "Pet not found" });
    return { deceasedAt: result.deceasedAt };
  });

  app.post("/api/pets/:id/archive", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [pet] = await db`
      update pets set archived_at=now(),updated_by=${context.userId},updated_at=now()
      where business_id=${context.businessId} and id=${id} and archived_at is null returning id
    `;
    if (!pet) return reply.code(404).send({ error: "Active pet not found" });
    return reply.code(204).send();
  });

  app.get("/api/appointments", {
    preHandler: [authenticate, requirePermission("appointments.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const query = body(calendarQuerySchema,request.query);
    const [location] = await db<{ id:string; timezone:string }[]>`
      select id,timezone from locations where business_id=${context.businessId} and id=${context.locationId}::uuid and active
    `;
    if (!location) return reply.code(404).send({ error:"Active location not found" });
    const localDate=query.localDate ?? localDateForInstant(new Date(),location.timezone);
    const days=query.days ?? 8;
    const from=localDateBounds(localDate,location.timezone).from;
    const endLocal=new Date(Date.UTC(Number(localDate.slice(0,4)),Number(localDate.slice(5,7))-1,Number(localDate.slice(8,10))+days));
    const to=localDateBounds(endLocal.toISOString().slice(0,10),location.timezone).from;
    const overlap=query.mode === "overlap";
    const rows = await appointmentCalendarRows(db, db`
      a.business_id=${context.businessId} and a.location_id=${location.id}
        and ${assignedToEmployees(db,query.employeeIds)}
        and ${overlap
          ? db`a.start_at < ${to} and a.end_at > ${from}`
          : db`a.start_at >= ${from} - interval '2 days' and a.start_at < ${to} + interval '2 days'
              and a.scheduled_local_start >= ${localDate}::date and a.scheduled_local_start < ${endLocal.toISOString().slice(0,10)}::date`}
    `);
    if (mayViewPetCare(context)) return rows;
    return rows.map((appointment) => redactPetCare(appointment));
  });

  /**
   * One appointment, in the calendar row shape.
   *
   * A detail view refetching a single visit should not have to pull a whole date window to find
   * it again, so this returns exactly one element of `GET /api/appointments` from the same
   * projection. Scoped to the business rather than the session's active location: the row is
   * addressed by id, and a multi-location salon can legitimately open a visit booked elsewhere.
   */
  app.get("/api/appointments/:id", {
    preHandler: [authenticate, requirePermission("appointments.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [appointment] = await appointmentCalendarRows(db, db`
      a.business_id=${context.businessId} and a.id=${id}
    `);
    if (!appointment) return reply.code(404).send({ error: "Appointment not found" });
    return mayViewPetCare(context) ? appointment : redactPetCare(appointment);
  });

  app.get("/api/pets/:id/booking-defaults",{preHandler:[authenticate,requirePermission("appointments.create")]},async(request,reply)=>{
    const context=auth(request);const {id}=idParams.parse(request.params);
    const [pet]=await db<{id:string;preferredEmployeeId:string|null}[]>`select pet.id,customer.preferred_employee_id
      from pets pet join customers customer on customer.business_id=pet.business_id and customer.id=pet.customer_id
      where pet.business_id=${context.businessId} and pet.id=${id} and pet.archived_at is null and customer.archived_at is null`;
    if(!pet)return reply.code(404).send({error:"Pet not found"});
    // The last groomer and the default services answer two different questions and so read
    // from two different visits. "Who saw this pet last" is the most recent visit that was not
    // cancelled. "What does this pet normally get" is the last visit the customer actually paid
    // for, because an unpaid or abandoned visit is not evidence of a settled service selection.
    const [recent]=await db<{id:string}[]>`
      select id from appointments where business_id=${context.businessId} and pet_id=${id}
        and status<>'cancelled' order by start_at desc,id desc limit 1`;
    const [lastPaid]=await db<{id:string;startAt:Date}[]>`
      select appointment.id,appointment.start_at from appointments appointment
      join invoices invoice on invoice.business_id=appointment.business_id
        and invoice.appointment_id=appointment.id and invoice.status='paid'
      where appointment.business_id=${context.businessId} and appointment.pet_id=${id}
        and appointment.status<>'cancelled'
      order by appointment.start_at desc,appointment.id desc limit 1`;
    const groomers=recent
      ? await db`
        select employee.id,employee.display_name from appointment_employees assignment
        join employees employee on employee.id=assignment.employee_id and employee.business_id=assignment.business_id
        where assignment.business_id=${context.businessId} and assignment.appointment_id=${recent.id} and employee.active
        order by employee.display_name`
      : pet.preferredEmployeeId
        ? await db`select id,display_name from employees
          where business_id=${context.businessId} and id=${pet.preferredEmployeeId} and active`
        : [];
    const services=lastPaid
      ? await db`
        select service.id,service.name,service.base_duration_minutes,service.base_price_minor
        from appointment_services history join services service on service.id=history.service_id and service.business_id=history.business_id
        where history.business_id=${context.businessId} and history.appointment_id=${lastPaid.id} and service.active
        order by history.id`
      : [];
    // The source is reported rather than inferred from an empty list, so the interface can say
    // "no paid visit yet" instead of silently presenting an empty selection as a considered default.
    return {
      groomers,
      services,
      serviceSource: !lastPaid ? "none" : services.length ? "last_paid_visit" : "last_paid_visit_unavailable",
      lastPaidVisitAt: lastPaid?.startAt ?? null,
      groomerSource: recent ? "last_visit" : pet.preferredEmployeeId ? "preferred_staff" : "none"
    };
  });

  /**
   * What has happened to one appointment, oldest last.
   *
   * The feed is read from `audit_events` rather than reconstructed from current state, so it
   * reports what was actually recorded and by whom. Money moves are audited against the invoice
   * and payment rather than the appointment, so those are pulled in through the appointment's
   * own invoices; without that the feed would show a visit being completed and never paid.
   *
   * Only whitelisted scalars leave the audit payload. `after_data` is free-form JSON written by
   * many call sites, and shipping it whole would make every future field an accidental
   * disclosure decision.
   */
  /**
   * Before-and-after photographs for one appointment, grouped the way the detail view reads them.
   *
   * Gated on `appointments.view` rather than pet care: a grooming photograph is a record of the
   * work, not medical or safety information, and every operational role that can see the
   * appointment can see what the pet looked like.
   */
  app.get("/api/appointments/:id/photos", {
    preHandler: [authenticate, requirePermission("appointments.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [appointment] = await db<{ id: string; petId: string; petName: string }[]>`
      select appointment.id,appointment.pet_id,pet.name as pet_name
      from appointments appointment
      join pets pet on pet.business_id=appointment.business_id and pet.id=appointment.pet_id
      where appointment.business_id=${context.businessId} and appointment.id=${id}
    `;
    if (!appointment) return reply.code(404).send({ error: "Appointment not found" });
    const photos = await db<{
      id: string; petId: string; phase: string; width: number | null; height: number | null;
      sizeBytes: string | null; originalFilename: string; contentType: string; createdAt: Date;
      uploadedByName: string | null;
    }[]>`
      select photo.id,photo.pet_id,photo.phase,photo.width,photo.height,photo.size_bytes,
        photo.original_filename,photo.content_type,photo.created_at,
        coalesce(uploader_employee.display_name,uploader.display_name,uploader.email) as uploaded_by_name
      from appointment_photos photo
      left join users uploader on uploader.id=photo.uploaded_by
      left join business_memberships uploader_membership
        on uploader_membership.business_id=photo.business_id and uploader_membership.user_id=photo.uploaded_by
      left join employees uploader_employee
        on uploader_employee.business_id=uploader_membership.business_id
        and uploader_employee.membership_id=uploader_membership.id
      where photo.business_id=${context.businessId} and photo.appointment_id=${id}
        and photo.state='stored'
      order by photo.created_at,photo.id
    `;
    // The pet is reported even with no photographs so the interface can offer somewhere to add
    // them rather than showing an empty panel with no affordance.
    return {
      appointmentId: id,
      // One pet per appointment today; the shape is a list so a multi-pet appointment would not
      // need every consumer rewritten.
      pets: [{
        petId: appointment.petId,
        petName: appointment.petName,
        before: photos.filter((photo) => photo.petId === appointment.petId && photo.phase === "before"),
        after: photos.filter((photo) => photo.petId === appointment.petId && photo.phase === "after")
      }],
      total: photos.length,
      maxPerPhase: maxPhotosPerPhase,
      canEdit: context.isOwner || context.permissions.includes("operations.perform_service")
    };
  });

  /**
   * Attach one photograph to an appointment.
   *
   * `operations.perform_service` is the gate: the person doing the groom is the person taking
   * the pictures. Reception can see them and cannot add them.
   *
   * The declared multipart mimetype is ignored. What is stored is what the bytes actually parse
   * as, because these are served back inline to a browser and a client-declared type is not a
   * fact. Nothing here is a malware scan and nothing claims to be.
   */
  app.post("/api/appointments/:id/photos", {
    preHandler: [authenticate, requirePermission("operations.perform_service")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    if (!request.isMultipart()) return reply.code(400).send({ error: "Multipart upload required" });
    const iterator = request.parts()[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || first.value.type !== "field" || first.value.fieldname !== "metadata") {
      return reply.code(400).send({ error: "Metadata must be the first multipart field" });
    }
    let metadataValue: unknown;
    try { metadataValue = JSON.parse(String(first.value.value)); }
    catch { return reply.code(400).send({ error: "Invalid upload metadata" }); }
    const parsed = photoUploadMetadataSchema.safeParse(metadataValue);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid upload metadata" });
    const metadata = parsed.data;

    const [appointment] = await db<{ id: string; petId: string }[]>`
      select id,pet_id from appointments
      where business_id=${context.businessId} and id=${id} and status<>'cancelled'
    `;
    if (!appointment) return reply.code(404).send({ error: "Appointment not found" });
    if (appointment.petId !== metadata.petId) {
      return reply.code(400).send({ error: "That pet is not on this appointment" });
    }

    // A retry of an upload that already landed returns the row it created rather than storing the
    // same photograph twice. Checked before reading the body so a repeat costs nothing.
    const [duplicate] = await db<{ id: string; state: string }[]>`
      select id,state from appointment_photos
      where business_id=${context.businessId} and appointment_id=${id}
        and upload_request_id=${metadata.uploadRequestId}
    `;
    if (duplicate?.state === "stored") {
      const [existing] = await db<PhotoApiRow[]>`
        select id,pet_id,phase,width,height,size_bytes,original_filename,content_type,created_at
        from appointment_photos where business_id=${context.businessId} and id=${duplicate.id}
      `;
      return reply.code(200).send(existing);
    }

    const second = await iterator.next();
    if (second.done || second.value.type !== "file") {
      return reply.code(400).send({ error: "Exactly one image file is required" });
    }
    let bytes: Buffer;
    try { bytes = await second.value.toBuffer(); }
    catch { return reply.code(413).send({ error: "Photos must be 8 MB or smaller" }); }
    const extra = await iterator.next();
    if (!extra.done) {
      if (extra.value.type === "file") extra.value.file.resume();
      return reply.code(400).send({ error: "Duplicate upload fields are not allowed" });
    }
    if (bytes.byteLength > maxPhotoBytes) {
      return reply.code(413).send({ error: "Photos must be 8 MB or smaller" });
    }
    const shape = readPhotoShape(bytes);
    if (!shape) {
      return reply.code(400).send({
        error: "That file is not a readable JPEG, PNG, or WebP image",
        supportedTypes: ["image/jpeg", "image/png", "image/webp"]
      });
    }
    const digest = sha256(bytes);
    if (metadata.claimedDigest && metadata.claimedDigest !== digest) {
      return reply.code(400).send({ error: "The uploaded file digest did not match" });
    }

    const [existingCount] = await db<{ count: number }[]>`
      select count(*)::int count from appointment_photos
      where business_id=${context.businessId} and appointment_id=${id}
        and pet_id=${metadata.petId} and phase=${metadata.phase} and state='stored'
    `;
    if ((existingCount?.count ?? 0) >= maxPhotosPerPhase) {
      return reply.code(409).send({
        code: "PHOTO_LIMIT_REACHED",
        error: `Up to ${maxPhotosPerPhase} ${metadata.phase} photos can be kept for one pet on one appointment.`
      });
    }

    const photoId = randomUUID();
    const storageKey = `business/${context.businessId}/appointments/${id}/photos/${photoId}`;
    const filename = safePhotoFilename(second.value.filename || "photo", shape.contentType);
    const [reserved] = await db<{ id: string }[]>`
      insert into appointment_photos
        (id,business_id,appointment_id,pet_id,phase,state,storage_key,content_type,
         width,height,original_filename,upload_request_id,uploaded_by)
      values (${photoId},${context.businessId},${id},${metadata.petId},${metadata.phase},'pending',
        ${storageKey},${shape.contentType},${shape.width},${shape.height},${filename},
        ${metadata.uploadRequestId},${context.userId})
      on conflict (business_id,appointment_id,upload_request_id) do nothing
      returning id
    `;
    // Another request for the same upload id won the race between the check above and this
    // insert. Losing that race is not an error; the winner's row is the answer.
    if (!reserved) return reply.code(409).send({ error: "That upload is already in progress" });

    let uploaded = false;
    try {
      await documentStorage.put(storageKey, bytes, shape.contentType);
      uploaded = true;
      await db.begin(async (tx) => {
        await setTenant(tx, context.businessId);
        await tx`
          update appointment_photos
          set state='stored',size_bytes=${bytes.byteLength},sha256=${digest},updated_at=now()
          where business_id=${context.businessId} and id=${photoId} and state='pending'
        `;
        await record(tx, {
          businessId: context.businessId, actorId: context.userId,
          action: "appointment.photo.add", resourceType: "appointment", resourceId: id,
          after: { photoId, petId: metadata.petId, phase: metadata.phase, contentType: shape.contentType }
        });
      });
      const [stored] = await db<PhotoApiRow[]>`
        select id,pet_id,phase,width,height,size_bytes,original_filename,content_type,created_at
        from appointment_photos where business_id=${context.businessId} and id=${photoId}
      `;
      return reply.code(201).send(stored);
    } catch (error) {
      // A reserved row with no object behind it is worse than no row: the list would show a
      // broken thumbnail forever. Both sides are unwound.
      await db`delete from appointment_photos
        where business_id=${context.businessId} and id=${photoId} and state='pending'`;
      if (uploaded) await documentStorage.delete(storageKey).catch(() => undefined);
      request.log.warn({ appointmentId: id, errorName: (error as Error).name }, "appointment photo upload failed");
      return reply.code(503).send({ error: "The photo could not be stored" });
    }
  });

  /**
   * Serve one photograph.
   *
   * Inline, because the point is to render it in the appointment detail. That makes the response
   * headers load-bearing: the stored content type is echoed from a column the schema constrains
   * to three image types, `nosniff` stops the browser reconsidering it, and a `default-src 'none'`
   * policy means even a response that somehow carried markup could not fetch or execute anything.
   */
  app.get("/api/appointment-photos/:id/content", {
    preHandler: [authenticate, requirePermission("appointments.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [photo] = await db<{
      storageKey: string; sizeBytes: string; contentType: string; originalFilename: string;
    }[]>`
      select storage_key,size_bytes,content_type,original_filename
      from appointment_photos
      where business_id=${context.businessId} and id=${id} and state='stored'
    `;
    if (!photo) return reply.code(404).send({ error: "Photo not found" });
    try {
      const object = await documentStorage.get(photo.storageKey);
      if (object.size !== Number(photo.sizeBytes)) {
        request.log.error({ photoId: id }, "appointment photo storage size mismatch");
        return reply.code(503).send({ error: "Photo is temporarily unavailable" });
      }
      const encoded = encodeURIComponent(photo.originalFilename).replace(/['()]/g, escape);
      return reply
        .header("Content-Type", photo.contentType)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Content-Disposition", `inline; filename*=UTF-8''${encoded}`)
        .header("Cache-Control", "private, max-age=300")
        .header("Content-Length", object.size)
        .code(200).send(Buffer.from(object.bytes));
    } catch (error) {
      request.log.warn({ photoId: id, errorName: (error as Error).name }, "appointment photo unavailable");
      return reply.code(503).send({ error: "Photo is temporarily unavailable" });
    }
  });

  /**
   * Remove a photograph.
   *
   * Unlike rabies evidence, a grooming photo carries no attestation, so a bad shot is deleted
   * rather than superseded. The row goes first and the object follows: a stored object with no
   * row is unreachable and reclaimable, whereas a row with no object is a permanent broken image.
   */
  app.delete("/api/appointment-photos/:id", {
    preHandler: [authenticate, requirePermission("operations.perform_service")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [photo] = await tx<{
        id: string; storageKey: string; appointmentId: string; petId: string; phase: string;
      }[]>`
        select id,storage_key,appointment_id,pet_id,phase from appointment_photos
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!photo) return null;
      await tx`delete from appointment_photos where business_id=${context.businessId} and id=${id}`;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "appointment.photo.remove", resourceType: "appointment",
        resourceId: photo.appointmentId,
        before: { photoId: id, petId: photo.petId, phase: photo.phase }
      });
      return photo;
    });
    if (!result) return reply.code(404).send({ error: "Photo not found" });
    await documentStorage.delete(result.storageKey).catch(() => undefined);
    return reply.code(204).send();
  });

  /**
   * Everything a report card renders, gathered from the appointment rather than copied into the
   * card when it was made. See the migration for why the card stores only what a person wrote.
   */
  async function reportCardView(cardId: string, businessId: string) {
    const [card] = await db<{
      id: string; appointmentId: string; petId: string; customerId: string; note: string | null;
      version: number; lastSentAt: Date | null; sendCount: number; createdAt: Date; updatedAt: Date;
      petName: string; breed: string | null; customerFirstName: string; customerLastName: string;
      customerEmail: string | null; customerEmailAllowed: boolean; customerBlockMessages: boolean;
      startAt: Date; schedulingTimezone: string; employeeName: string; businessName: string;
      businessPhone: string | null; businessEmail: string | null; authorName: string | null;
    }[]>`
      select card.id,card.appointment_id,card.pet_id,card.customer_id,card.note,card.version,
        card.last_sent_at,card.send_count,card.created_at,card.updated_at,
        pet.name as pet_name,pet.breed,
        customer.first_name as customer_first_name,customer.last_name as customer_last_name,
        customer.email as customer_email,customer.email_allowed as customer_email_allowed,
        customer.block_messages as customer_block_messages,
        appointment.start_at,appointment.scheduling_timezone,
        employee.display_name as employee_name,
        business.name as business_name,business.phone as business_phone,business.email as business_email,
        coalesce(author_employee.display_name,author_user.display_name,author_user.email) as author_name
      from appointment_report_cards card
      join appointments appointment
        on appointment.business_id=card.business_id and appointment.id=card.appointment_id
      join pets pet on pet.business_id=card.business_id and pet.id=card.pet_id
      join customers customer on customer.business_id=card.business_id and customer.id=card.customer_id
      join employees employee on employee.business_id=appointment.business_id and employee.id=appointment.employee_id
      join businesses business on business.id=card.business_id
      left join users author_user on author_user.id=card.updated_by
      left join business_memberships author_membership
        on author_membership.business_id=card.business_id and author_membership.user_id=card.updated_by
      left join employees author_employee
        on author_employee.business_id=author_membership.business_id
        and author_employee.membership_id=author_membership.id
      where card.business_id=${businessId} and card.id=${cardId}
    `;
    if (!card) return null;
    const [services, photos] = await Promise.all([
      db<{ name: string; durationMinutes: number; priceMinor: number }[]>`
        select service_name_snapshot as name,duration_minutes_snapshot as duration_minutes,
          price_minor_snapshot as price_minor
        from appointment_services
        where business_id=${businessId} and appointment_id=${card.appointmentId}
        order by id
      `,
      db<{ id: string; phase: string; width: number | null; height: number | null }[]>`
        select id,phase,width,height from appointment_photos
        where business_id=${businessId} and appointment_id=${card.appointmentId}
          and pet_id=${card.petId} and state='stored'
        order by created_at,id
      `
    ]);
    return { card, services, photos };
  }

  function reportCardRow(view: NonNullable<Awaited<ReturnType<typeof reportCardView>>>) {
    const { card } = view;
    return {
      id: card.id,
      appointmentId: card.appointmentId,
      petId: card.petId,
      petName: card.petName,
      customerName: `${card.customerFirstName} ${card.customerLastName}`.trim(),
      note: card.note,
      version: card.version,
      appointmentDate: card.startAt,
      lastEditedAt: card.updatedAt,
      lastEditedBy: card.authorName,
      lastSentAt: card.lastSentAt,
      sendCount: card.sendCount,
      photoCount: view.photos.length
    };
  }

  app.get("/api/appointments/:id/report-cards", {
    preHandler: [authenticate, requirePermission("appointments.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [appointment] = await db<{ id: string; petId: string; customerId: string }[]>`
      select id,pet_id,customer_id from appointments
      where business_id=${context.businessId} and id=${id}
    `;
    if (!appointment) return reply.code(404).send({ error: "Appointment not found" });
    const cards = await db<{ id: string }[]>`
      select id from appointment_report_cards
      where business_id=${context.businessId} and appointment_id=${id}
      order by created_at,id
    `;
    const views = await Promise.all(cards.map((row) => reportCardView(row.id, context.businessId)));
    return {
      items: views.filter(Boolean).map((view) => reportCardRow(view!)),
      // The interface offers "+ Add" only while a pet on this appointment has no card yet, so it
      // needs to know which pets are still available rather than inferring it from the list.
      availablePetIds: cards.length ? [] : [appointment.petId],
      canEdit: context.isOwner || context.permissions.includes("operations.perform_service"),
      canSend: context.isOwner || context.permissions.includes("customers.edit")
    };
  });

  app.post("/api/appointments/:id/report-cards", {
    preHandler: [authenticate, requirePermission("operations.perform_service")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(reportCardCreateSchema, request.body);
    const [appointment] = await db<{ id: string; petId: string; customerId: string }[]>`
      select id,pet_id,customer_id from appointments
      where business_id=${context.businessId} and id=${id} and status<>'cancelled'
    `;
    if (!appointment) return reply.code(404).send({ error: "Appointment not found" });
    if (appointment.petId !== input.petId) {
      return reply.code(400).send({ error: "That pet is not on this appointment" });
    }
    const created = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [row] = await tx<{ id: string }[]>`
        insert into appointment_report_cards
          (business_id,appointment_id,pet_id,customer_id,note,created_by,updated_by)
        values (${context.businessId},${id},${input.petId},${appointment.customerId},
          ${input.note ?? null},${context.userId},${context.userId})
        on conflict (business_id,appointment_id,pet_id) do nothing
        returning id
      `;
      if (!row) return null;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "appointment.report_card.create", resourceType: "appointment", resourceId: id,
        after: { reportCardId: row.id, petId: input.petId }
      });
      return row;
    });
    if (!created) {
      return reply.code(409).send({
        code: "REPORT_CARD_EXISTS",
        error: "This pet already has a report card for this appointment."
      });
    }
    const view = await reportCardView(created.id, context.businessId);
    return reply.code(201).send(reportCardRow(view!));
  });

  app.patch("/api/report-cards/:id", {
    preHandler: [authenticate, requirePermission("operations.perform_service")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(reportCardUpdateSchema, request.body);
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [current] = await tx<{ id: string; version: number; note: string | null; appointmentId: string }[]>`
        select id,version,note,appointment_id from appointment_report_cards
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!current) return { missing: true } as const;
      if (current.version !== input.version) return { stale: true } as const;
      await tx`
        update appointment_report_cards
        set note=${input.note ?? null},version=version+1,updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "appointment.report_card.edit", resourceType: "appointment",
        resourceId: current.appointmentId,
        before: { note: current.note }, after: { reportCardId: id, note: input.note ?? null }
      });
      return { updated: true } as const;
    });
    if ("missing" in result) return reply.code(404).send({ error: "Report card not found" });
    if ("stale" in result) {
      return reply.code(409).send({ error: "The report card changed; refresh and try again" });
    }
    const view = await reportCardView(id, context.businessId);
    return reportCardRow(view!);
  });

  app.delete("/api/report-cards/:id", {
    preHandler: [authenticate, requirePermission("operations.perform_service")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const removed = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [current] = await tx<{ id: string; appointmentId: string; petId: string; sendCount: number }[]>`
        select id,appointment_id,pet_id,send_count from appointment_report_cards
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!current) return null;
      await tx`delete from appointment_report_cards where business_id=${context.businessId} and id=${id}`;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "appointment.report_card.delete", resourceType: "appointment",
        resourceId: current.appointmentId,
        // Whether it had already reached the client is the part that matters afterwards.
        before: { reportCardId: id, petId: current.petId, sendCount: current.sendCount }
      });
      return current;
    });
    if (!removed) return reply.code(404).send({ error: "Report card not found" });
    return reply.code(204).send();
  });

  /**
   * The staff preview, as a standalone page.
   *
   * This is a page rather than JSON because it is opened in its own window: what the operator
   * checks before sending is the card as a card, not a form describing one. It is not a
   * client-facing surface — it needs the same session as the rest of the application, and there
   * is no token, no public URL, and nothing to hand a client.
   *
   * Every value is escaped, and the response carries a policy allowing nothing but same-origin
   * images and the inline stylesheet: no script can run here even if a stored value one day
   * arrived containing one.
   */
  app.get("/api/report-cards/:id/preview", {
    preHandler: [authenticate, requirePermission("appointments.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const view = await reportCardView(id, context.businessId);
    if (!view) return reply.code(404).send({ error: "Report card not found" });
    const { card, services, photos } = view;
    const when = new Intl.DateTimeFormat("en-US", {
      timeZone: card.schedulingTimezone, dateStyle: "full", timeStyle: "short"
    }).format(card.startAt);
    const strip = (phase: string) => {
      const set = photos.filter((photo) => photo.phase === phase);
      if (!set.length) return "";
      return `<p class="phase ${escapeHtml(phase)}">${phase === "before" ? "Before" : "After"}</p>`
        + `<div class="strip">${set.map((photo) =>
          `<img src="/api/appointment-photos/${encodeURIComponent(photo.id)}/content" alt="${escapeHtml(card.petName)} ${escapeHtml(phase)}"${
            photo.width ? ` width="${photo.width}"` : ""}${photo.height ? ` height="${photo.height}"` : ""}>`
        ).join("")}</div>`;
    };
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>${escapeHtml(card.petName)} · Report card</title><style>`
      + `body{margin:0;padding:28px 20px;background:#f1f3f1;color:#202522;`
      + `font:15px/1.6 Ubuntu,"Segoe UI",system-ui,-apple-system,sans-serif}`
      + `main{max-width:720px;margin:0 auto}`
      + `header{display:flex;align-items:center;gap:14px;margin-bottom:6px}`
      + `.avatar{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;`
      + `background:#202522;color:#fff;font-size:23px}`
      + `h1{margin:0;font-size:24px}h2{margin:0 0 10px;font-size:14px;letter-spacing:.6px;`
      + `text-transform:uppercase;color:#68706b}`
      + `.meta{margin:0 0 22px;color:#68706b;font-size:13px}`
      + `.phase{display:inline-block;margin:16px 0 8px;padding:3px 12px;border-radius:999px;`
      + `background:#202522;color:#fff;font-size:12px;font-weight:700}`
      + `.phase.after{background:#2f6f62}`
      + `.strip{display:flex;flex-wrap:wrap;gap:10px}`
      + `.strip img{width:190px;height:auto;border-radius:12px;background:#fff}`
      + `section{margin-top:22px;padding:18px;border-radius:14px;background:#fff}`
      + `ul{margin:0;padding-left:18px}li{margin-bottom:4px}`
      + `.note{white-space:pre-wrap;margin:0}`
      + `.stamp{margin:22px 0 0;color:#868f89;font-size:12px}`
      + `</style></head><body><main>`
      + `<header><span class="avatar" aria-hidden="true">${escapeHtml([...card.petName][0]?.toUpperCase() ?? "P")}</span>`
      + `<div><h1>${escapeHtml(card.petName)}</h1>`
      + `<p class="meta">${escapeHtml(card.breed || "")}${card.breed ? " · " : ""}`
      + `${escapeHtml(`${card.customerFirstName} ${card.customerLastName}`.trim())}</p></div></header>`
      + `<p class="meta">${escapeHtml(when)} · with ${escapeHtml(card.employeeName)}</p>`
      + strip("before") + strip("after")
      + (services.length
        ? `<section><h2>Services</h2><ul>${services.map((service) =>
          `<li>${escapeHtml(service.name)}</li>`).join("")}</ul></section>`
        : "")
      + (card.note
        ? `<section><h2>From your groomer</h2><p class="note">${escapeHtml(card.note)}</p></section>`
        : "")
      + `<p class="stamp">${escapeHtml(card.businessName)}`
      + `${card.businessPhone ? ` · ${escapeHtml(card.businessPhone)}` : ""}`
      + `${card.sendCount ? ` · sent to the client ${escapeHtml(card.lastSentAt!.toISOString().slice(0, 10))}` : " · not yet sent"}`
      + `</p></main></body></html>`;
    return reply
      .header("Content-Type", "text/html; charset=utf-8")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy",
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "private, no-store")
      .code(200).send(html);
  });

  /**
   * Email the report card to the client.
   *
   * The message carries the written card — the visit, the services, and the groomer's note. It
   * does not carry the photographs: the transport sends text, and Pawsh has no client-facing page
   * to link to. Rather than quietly sending a "report card" the client would find photoless and
   * confusing, the message says the photographs are held at the salon, and the interface says the
   * same thing before anyone presses send.
   */
  app.post("/api/report-cards/:id/send", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(reportCardSendSchema, request.body);
    if (input.channel !== "email") {
      return reply.code(409).send({
        code: "REPORT_CARD_CHANNEL_UNSUPPORTED",
        error: "Pawsh has no SMS delivery. Report cards can only be sent by email.",
        channel: input.channel,
        supportedChannels: ["email"]
      });
    }
    const view = await reportCardView(id, context.businessId);
    if (!view) return reply.code(404).send({ error: "Report card not found" });
    const { card, services, photos } = view;
    const recipient = {
      id: card.customerId, firstName: card.customerFirstName, lastName: card.customerLastName,
      email: card.customerEmail, emailAllowed: card.customerEmailAllowed,
      blockMessages: card.customerBlockMessages
    } satisfies AgreementRecipient;
    const reason = agreementEmailReason(recipient);
    if (reason !== "ok") {
      return reply.code(409).send({
        code: "REPORT_CARD_UNDELIVERABLE",
        error: agreementEmailDetail[reason] ?? "This client cannot be emailed",
        channel: "email", reason, supportedChannels: ["email"]
      });
    }
    const when = new Intl.DateTimeFormat("en-US", {
      timeZone: card.schedulingTimezone, dateStyle: "full", timeStyle: "short"
    }).format(card.startAt);
    const contact = card.businessPhone ?? card.businessEmail ?? card.businessName;
    const message = [
      `${card.petName}'s visit to ${card.businessName} on ${when}, with ${card.employeeName}.`,
      services.length ? `Services: ${services.map((service) => service.name).join(", ")}.` : null,
      card.note,
      photos.length
        ? `We took ${photos.length} photo${photos.length === 1 ? "" : "s"} of ${card.petName}. They are kept on your record at the salon — ask us and we will show you.`
        : null,
      `Questions? Contact ${contact}.`
    ].filter(Boolean).join("\n\n");
    const sent = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [intent] = await tx<{ id: string }[]>`
        insert into notification_intents
          (business_id,customer_id,appointment_id,notification_type,scheduled_occurrence,channel,
           destination,status,recipient_kind,encrypted_body)
        values (${context.businessId},${card.customerId},${card.appointmentId},'report_card',now(),'email',
          ${card.customerEmail},'pending','customer',${sealSecret(message, config.SESSION_SECRET)})
        returning id
      `;
      await tx`
        update appointment_report_cards
        set last_sent_at=now(),send_count=send_count+1,last_sent_channel='email',updated_at=now()
        where business_id=${context.businessId} and id=${id}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: "appointment.report_card.send", resourceType: "appointment",
        resourceId: card.appointmentId,
        after: { reportCardId: id, channel: "email", photosIncluded: false }
      });
      return intent;
    });
    const refreshed = await reportCardView(id, context.businessId);
    return reply.code(202).send({
      channel: "email",
      queued: true,
      intentId: sent?.id ?? null,
      destination: card.customerEmail,
      // Named explicitly so a caller cannot read a queued send as "the client got the photos".
      photosIncluded: false,
      card: reportCardRow(refreshed!)
    });
  });

  app.get("/api/appointments/:id/activity", {
    preHandler: [authenticate, requirePermission("appointments.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [appointment] = await db<{ id: string }[]>`
      select id from appointments where business_id=${context.businessId} and id=${id}
    `;
    if (!appointment) return reply.code(404).send({ error: "Appointment not found" });
    const mayViewPayments = context.isOwner || context.permissions.includes("payments.view");
    const rows = await db<{
      id: string; action: string; createdAt: Date; reason: string | null;
      actorName: string | null; beforeData: Record<string, unknown> | null;
      afterData: Record<string, unknown> | null;
    }[]>`
      select event.id,event.action,event.created_at,event.reason,
        event.before_data,event.after_data,
        coalesce(actor_employee.display_name,actor_user.display_name,actor_user.email) as actor_name
      from audit_events event
      left join users actor_user on actor_user.id=event.actor_id
      left join business_memberships actor_membership
        on actor_membership.business_id=event.business_id and actor_membership.user_id=event.actor_id
      left join employees actor_employee
        on actor_employee.business_id=actor_membership.business_id
        and actor_employee.membership_id=actor_membership.id
      where event.business_id=${context.businessId}
        and (
          (event.resource_type='appointment' and event.resource_id=${id})
          or (${mayViewPayments} and event.resource_type='invoice' and event.resource_id in (
            select invoice.id from invoices invoice
            where invoice.business_id=${context.businessId} and invoice.appointment_id=${id}
          ))
          or (${mayViewPayments} and event.resource_type='payment' and event.resource_id in (
            select payment.id from payments payment
            join invoices invoice on invoice.business_id=payment.business_id and invoice.id=payment.invoice_id
            where payment.business_id=${context.businessId} and invoice.appointment_id=${id}
          ))
        )
      order by event.created_at desc,event.id desc limit 200
    `;
    const scalar = (value: unknown): string | number | null =>
      typeof value === "string" || typeof value === "number" ? value : null;
    return {
      items: rows.map((row) => ({
        id: row.id,
        action: row.action,
        createdAt: row.createdAt,
        actorName: row.actorName,
        reason: row.reason,
        fromStatus: scalar(row.beforeData?.status),
        toStatus: scalar(row.afterData?.status),
        fromStartAt: scalar(row.beforeData?.startAt),
        toStartAt: scalar(row.afterData?.startAt),
        amountMinor: scalar(row.afterData?.amountMinor),
        method: scalar(row.afterData?.method),
        totalMinor: scalar(row.afterData?.totalMinor)
      }))
    };
  });

  app.post("/api/appointments", {
    preHandler: [authenticate, requirePermission("appointments.create")]
  }, async (request, reply) => {
    const context = auth(request);
    const requestKey=schedulingIdempotencyKey(request);
    const input = body(appointmentSchema, request.body);
    const primaryEmployeeId=input.employeeId;
    const employeeIds=[primaryEmployeeId];
    const canonicalizationVersion="appointment.create:v2" as const;
    const normalizedServiceIds=[...new Set(input.serviceIds)].sort();
    const requestHash=schedulingCanonicalHash("appointment.create",canonicalizationVersion,[
      input.locationId,input.customerId,input.petId,[...employeeIds].sort(),normalizedServiceIds,input.localStart,
      input.disambiguation??null,input.expectedLocationVersion,input.availabilityOverride,input.overrideConflict,
      input.overrideReason??null,input.notes??null
    ]);
    const appointmentId = randomUUID();
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const claim=await claimSchedulingRequest(tx,{businessId:context.businessId,actorId:context.userId,
        operation:"appointment.create",key:requestKey,hash:requestHash,canonicalizationVersion});
      if(claim.replay){
        await authorizeSchedulingReplay(tx,context,claim.replay);
        return {kind:"replay",result:claim.replay} as const;
      }
      const overrideAuthorized = await authorizeConflictOverride(tx, context, input.overrideConflict);
      if (input.overrideConflict && !overrideAuthorized) {
        throw new SchedulingRequestError(403,"PERMISSION_DENIED","Missing permission: appointments.override_conflict");
      }
      const [participants] = await tx<{ available: boolean }[]>`
        select exists (
          select 1 from customers customer
          join pets pet on pet.customer_id=customer.id and pet.business_id=customer.business_id
          where customer.business_id=${context.businessId} and customer.id=${input.customerId}
            and pet.id=${input.petId} and customer.archived_at is null and pet.archived_at is null
        ) as available
      `;
      if (!participants?.available) throw new Error("The selected customer or pet is unavailable");
      await tx`select pg_advisory_xact_lock_shared(hashtextextended(${'location-settings:' + input.locationId},0))`;
      const [location] = await tx<{ timezone:string; version:number }[]>`
        select timezone,version from locations
        where business_id=${context.businessId} and id=${input.locationId} and active
      `;
      if (!location) throw new SchedulingRequestError(404,"RESOURCE_NOT_FOUND","Location not found");
      if (location.version !== input.expectedLocationVersion) throw new SchedulingRequestError(409,"STALE_LOCATION_SETTINGS","Location settings changed. Refresh and try again.");
      const resolved=resolveWallTime(input.localStart,location.timezone,input.disambiguation);
      await schedulingHooks.afterLocationLock?.({operation:"create",businessId:context.businessId,timezone:location.timezone,version:location.version});
      await ensureBookingResourcesAvailable(tx,{businessId:context.businessId,employeeIds,serviceIds:input.serviceIds});
      const catalog=await resolveServicePrices(tx,{businessId:context.businessId,petId:input.petId,serviceIds:input.serviceIds});
      const unresolved=catalog.find(service=>service.status!=="resolved");
      if(unresolved)throw new Error(unresolved.status==="weight_required"?"Weight required to determine pricing.":unresolved.status==="quote_required"?`${unresolved.name} requires a quote before booking.`:`${unresolved.name} price requires admin confirmation.`);
      const totalMinutes = catalog.reduce((sum, service) => sum + service.durationMinutes, 0);
      const startAt = resolved.instant;
      const endAt = new Date(startAt.getTime() + totalMinutes * 60_000);
      if (localDateForInstant(endAt,location.timezone) !== input.localStart.slice(0,10)) {
        throw new Error("Appointments may not cross local midnight during the controlled pilot");
      }
      // Ahead of every staff-availability rule and ahead of the override branch below, because a
      // closure is terminal: see `salonClosedOn`.
      const closure=await salonClosedOn(tx,{businessId:context.businessId,locationId:input.locationId,
        localDate:localDateForInstant(startAt,location.timezone)});
      if (closure) throw salonClosedError(closure);
      await schedulingHooks.beforeLock?.({
        operation: "create",
        businessId: context.businessId,
        employeeIds
      });
      await lockSchedulingResources(tx, context.businessId, employeeIds);
      const conflicts=(await Promise.all(employeeIds.map(employeeId=>findSchedulingConflicts(tx,{businessId:context.businessId,employeeId,startAt,endAt})))).flat();
      if (conflicts.length && !input.overrideConflict) {
        const canOverride = await hasCurrentPermission(tx, {
          businessId: context.businessId,
          membershipId: context.membershipId,
          permission: "appointments.override_conflict"
        });
        throw new SchedulingRequestError(409,"SCHEDULING_CONFLICT","This employee already has an overlapping appointment during the selected time.",{conflicts,canOverride});
      }
      const overrideApplied = conflicts.length > 0 && input.overrideConflict && overrideAuthorized;
      if (overrideApplied) await permitConflictOverride(tx, appointmentId);
      const everyGroomerAvailable=await groomersAvailable(tx,{businessId:context.businessId,locationId:input.locationId,employeeIds,startAt,endAt});
      if (!everyGroomerAvailable && !input.availabilityOverride) {
        throw new Error("Requested time is outside employee availability; an explicit override is required");
      }
      if (input.availabilityOverride && !context.isOwner && !context.permissions.includes("appointments.edit")) {
        throw new Error("Availability override is not authorized");
      }
      const [appointment] = await tx<{ id: string;version:number }[]>`
        insert into appointments
          (id, business_id, location_id, customer_id, pet_id, employee_id, start_at, end_at,
           scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,scheduled_disambiguation,
           notes, availability_overridden, conflict_overridden, created_by, updated_by)
        values
          (${appointmentId}, ${context.businessId}, ${input.locationId}, ${input.customerId}, ${input.petId},
           ${primaryEmployeeId}, ${startAt}, ${endAt}, ${resolved.timeZone},${input.localStart},${resolved.offsetMinutes},${resolved.disambiguation},${input.notes ?? null},
           ${input.availabilityOverride}, ${overrideApplied}, ${context.userId}, ${context.userId})
        returning *
      `;
      if (!appointment) throw new Error("Appointment creation failed");
      for(const employeeId of employeeIds)await tx`
        insert into appointment_employees(business_id,appointment_id,employee_id)
        values (${context.businessId},${appointment.id},${employeeId})`;
      for (const service of catalog) {
        await tx`
          insert into appointment_services
            (business_id, appointment_id, service_id, service_name_snapshot,
             duration_minutes_snapshot, price_minor_snapshot,pricing_class_snapshot,weight_tier_snapshot,resolution_source_snapshot)
          values
            (${context.businessId}, ${appointment.id}, ${service.serviceId}, ${service.name},
             ${service.durationMinutes}, ${service.priceMinor!},${service.pricingClass},${service.weightTierCode},${service.resolutionSource})
        `;
      }
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "appointment.create",
        resourceType: "appointment", resourceId: appointment.id,
        after: { startAt, endAt, employeeIds },
        reason: input.overrideReason, eventType: "AppointmentCreated"
      });
      if (overrideApplied) {
        await record(tx, {
          businessId: context.businessId,
          actorId: context.userId,
          action: "appointment.conflict_override",
          resourceType: "appointment",
          resourceId: appointment.id,
          after: {
            operation: "create",
            employeeIds,
            startAt,
            endAt,
            conflictingAppointmentIds: conflicts.map((conflict) => conflict.appointmentId)
          }
        });
        await schedulingHooks.afterOverrideAudit?.({
          operation: "create",
          appointmentId: appointment.id
        });
      }
      const replayResult:SchedulingReplayResult={
        resultSchemaVersion:"appointment.create.result:v1",appointmentId:appointment.id,
        appointmentVersion:appointment.version,startAt,endAt,schedulingTimezone:resolved.timeZone,
        scheduledLocalStart:input.localStart,disambiguation:resolved.disambiguation,
        utcOffsetMinutes:resolved.offsetMinutes,employeeId:primaryEmployeeId,locationId:input.locationId,
        conflictDetected:conflicts.length>0,conflictOverrideRequested:input.overrideConflict,
        conflictOverrideAuthorized:overrideAuthorized,conflictOverrideApplied:overrideApplied,
        availabilityOverrideApplied:input.availabilityOverride
      };
      await completeSchedulingRequest(tx,claim.id,replayResult);
      return {
        kind: "created",
        result:replayResult
      } as const;
    });
    if(result.kind==="created")await schedulingHooks.afterCommit?.({operation:"create",appointmentId:result.result.appointmentId});
    return reply.code(result.kind==="created"?201:200).send(schedulingReplayResponse(result.result));
  });

  app.post("/api/appointments/:id/transition", {
    preHandler: authenticate
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(transitionSchema, request.body);
    const required = input.status === "checked_in" ? "operations.check_in"
      : input.status === "in_service" ? "operations.perform_service"
      : input.status === "completed" ? "operations.complete"
      : "appointments.cancel";
    if (!context.isOwner && !context.permissions.includes(required)) {
      return reply.code(403).send({ error: `Missing permission: ${required}` });
    }
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      await lifecycleHooks.beforeRowLock?.({
        businessId: context.businessId,
        appointmentId: id,
        targetStatus: input.status
      });
      const [current] = await tx<{ status: AppointmentStatus; version: number; employeeId: string }[]>`
        select status,version,employee_id from appointments
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!current) return null;
      const assignments=await tx<{employeeId:string}[]>`select employee_id from appointment_employees where business_id=${context.businessId} and appointment_id=${id}`;
      await lockSchedulingResources(tx, context.businessId, assignments.map(assignment=>assignment.employeeId));
      if (input.version && current.version !== input.version) {
        return { stale: true } as const;
      }
      if (!canTransition(current.status, input.status)) {
        throw new Error(`Invalid appointment transition: ${current.status} -> ${input.status}`);
      }
      const [updated] = await tx`
        update appointments set status=${input.status}, version=version+1,
          updated_by=${context.userId}, updated_at=now()
        where business_id=${context.businessId} and id=${id} returning *
      `;
      if(input.status === "cancelled" || input.status === "no_show") {
        await tx`
          update notification_intents set status='cancelled',resolved_at=now(),updated_at=now()
          where business_id=${context.businessId} and appointment_id=${id}
            and notification_type in ('rabies_expiration_customer','rabies_expiration_staff')
            and status in ('pending','failed','suppressed')
        `;
      }
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: `appointment.${input.status}`, resourceType: "appointment", resourceId: id,
        before: { status: current.status }, after: { status: input.status }, reason: input.reason,
        eventType: input.status === "checked_in" ? "AppointmentCheckedIn"
          : input.status === "in_service" ? "AppointmentStarted"
          : input.status === "completed" ? "AppointmentCompleted"
          : input.status === "cancelled" ? "AppointmentCancelled" : undefined
      });
      return updated;
    });
    if (!result) return reply.code(404).send({ error: "Appointment not found" });
    if ("stale" in result) return reply.code(409).send({ error: "Appointment changed; refresh before continuing" });
    return result;
  });

  app.patch("/api/appointments/:id/schedule", {
    preHandler: [authenticate, requirePermission("appointments.edit")]
  }, async (request) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const requestKey=schedulingIdempotencyKey(request);
    const input = body(appointmentMoveSchema, request.body);
    const primaryEmployeeId=input.employeeId;
    const employeeIds=[primaryEmployeeId];
    const canonicalizationVersion="appointment.reschedule:v2" as const;
    const requestHash=schedulingCanonicalHash("appointment.reschedule",canonicalizationVersion,[
      id,input.version,[...employeeIds].sort(),input.localStart,input.disambiguation??null,input.expectedLocationVersion,
      input.availabilityOverride,input.overrideConflict,input.overrideReason??null
    ]);
    const moved = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const claim=await claimSchedulingRequest(tx,{businessId:context.businessId,actorId:context.userId,
        operation:"appointment.reschedule",key:requestKey,hash:requestHash,canonicalizationVersion});
      if(claim.replay){
        await authorizeSchedulingReplay(tx,context,claim.replay);
        return {kind:"replay",result:claim.replay} as const;
      }
      const overrideAuthorized = await authorizeConflictOverride(tx, context, input.overrideConflict);
      if (input.overrideConflict && !overrideAuthorized) {
        throw new SchedulingRequestError(403,"PERMISSION_DENIED","Missing permission: appointments.override_conflict");
      }
      const [current] = await tx<{
        startAt: Date;
        endAt: Date;
        status: string;
        locationId: string;
        employeeId: string;
      }[]>`
        select start_at,end_at,status,location_id,employee_id from appointments
        where business_id=${context.businessId} and id=${id} and version=${input.version} for update
      `;
      if (!current) throw new SchedulingRequestError(409,"STALE_APPOINTMENT","Appointment changed or no longer exists");
      if (current.status !== "scheduled") throw new Error("Only scheduled appointments can be moved");
      const currentAssignments=await tx<{employeeId:string}[]>`select employee_id from appointment_employees where business_id=${context.businessId} and appointment_id=${id}`;
      await tx`select pg_advisory_xact_lock_shared(hashtextextended(${'location-settings:' + current.locationId},0))`;
      const [location] = await tx<{ timezone:string; version:number }[]>`
        select timezone,version from locations
        where business_id=${context.businessId} and id=${current.locationId} and active
      `;
      if (!location) throw new SchedulingRequestError(404,"RESOURCE_NOT_FOUND","Location not found");
      if (location.version !== input.expectedLocationVersion) throw new SchedulingRequestError(409,"STALE_LOCATION_SETTINGS","Location settings changed. Refresh and try again.");
      const resolved=resolveWallTime(input.localStart,location.timezone,input.disambiguation);
      await schedulingHooks.afterLocationLock?.({operation:"reschedule",businessId:context.businessId,timezone:location.timezone,version:location.version});
      await schedulingHooks.beforeLock?.({
        operation: "reschedule",
        businessId: context.businessId,
        employeeIds: [...currentAssignments.map(row=>row.employeeId),...employeeIds]
      });
      await lockSchedulingResources(tx, context.businessId, [...currentAssignments.map(row=>row.employeeId),...employeeIds]);
      const bookedServices=await tx<{serviceId:string}[]>`select service_id from appointment_services where business_id=${context.businessId} and appointment_id=${id}`;
      await ensureBookingResourcesAvailable(tx,{businessId:context.businessId,employeeIds,serviceIds:bookedServices.map(row=>row.serviceId)});
      const startAt = resolved.instant;
      const endAt = new Date(startAt.getTime() + (current.endAt.getTime() - current.startAt.getTime()));
      if (localDateForInstant(endAt,location.timezone) !== input.localStart.slice(0,10)) {
        throw new Error("Appointments may not cross local midnight during the controlled pilot");
      }
      // Same terminal closure rule as creation: an appointment cannot be moved onto a day the
      // shop is shut, override or not.
      const closure=await salonClosedOn(tx,{businessId:context.businessId,locationId:current.locationId,
        localDate:localDateForInstant(startAt,location.timezone)});
      if (closure) throw salonClosedError(closure);
      const conflicts=(await Promise.all(employeeIds.map(employeeId=>findSchedulingConflicts(tx,{businessId:context.businessId,employeeId,startAt,endAt,excludeAppointmentId:id})))).flat();
      if (conflicts.length && !input.overrideConflict) {
        const canOverride = await hasCurrentPermission(tx, {
          businessId: context.businessId,
          membershipId: context.membershipId,
          permission: "appointments.override_conflict"
        });
        throw new SchedulingRequestError(409,"SCHEDULING_CONFLICT","This employee already has an overlapping appointment during the selected time.",{conflicts,canOverride});
      }
      const overrideApplied = conflicts.length > 0 && input.overrideConflict && overrideAuthorized;
      if (overrideApplied) await permitConflictOverride(tx, id);
      const everyGroomerAvailable=await groomersAvailable(tx,{businessId:context.businessId,locationId:current.locationId,employeeIds,startAt,endAt});
      if (!everyGroomerAvailable && !input.availabilityOverride) {
        throw new Error("Requested time is outside employee availability; an explicit override is required");
      }
      await tx`delete from appointment_employees where business_id=${context.businessId} and appointment_id=${id}`;
      const [updated] = await tx<{id:string;version:number}[]>`
        update appointments set employee_id=${primaryEmployeeId},start_at=${startAt},end_at=${endAt},
          scheduling_timezone=${resolved.timeZone},scheduled_local_start=${input.localStart},
          scheduled_utc_offset_minutes=${resolved.offsetMinutes},scheduled_disambiguation=${resolved.disambiguation},
          availability_overridden=${input.availabilityOverride},
          conflict_overridden=${overrideApplied},version=version+1,
          updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id} and version=${input.version}
        returning *
      `;
      for(const employeeId of employeeIds)await tx`insert into appointment_employees(business_id,appointment_id,employee_id) values (${context.businessId},${id},${employeeId})`;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "appointment.move",
        resourceType: "appointment", resourceId: id,
        before: { startAt: current.startAt, endAt: current.endAt },
        after: { startAt, endAt, employeeIds },
        reason: input.overrideReason, eventType: "AppointmentUpdated"
      });
      await tx`
        update notification_intents set status='cancelled',resolved_at=now(),updated_at=now()
        where business_id=${context.businessId} and appointment_id=${id}
          and notification_type in ('rabies_expiration_customer','rabies_expiration_staff')
          and status in ('pending','failed','suppressed')
      `;
      if (overrideApplied) {
        await record(tx, {
          businessId: context.businessId,
          actorId: context.userId,
          action: "appointment.conflict_override",
          resourceType: "appointment",
          resourceId: id,
          after: {
            operation: "reschedule",
            employeeIds,
            startAt,
            endAt,
            conflictingAppointmentIds: conflicts.map((conflict) => conflict.appointmentId)
          }
        });
        await schedulingHooks.afterOverrideAudit?.({
          operation: "reschedule",
          appointmentId: id
        });
      }
      if(!updated)throw new SchedulingRequestError(409,"STALE_APPOINTMENT","Appointment changed or no longer exists");
      const replayResult:SchedulingReplayResult={
        resultSchemaVersion:"appointment.reschedule.result:v1",appointmentId:id,
        appointmentVersion:updated.version,startAt,endAt,schedulingTimezone:resolved.timeZone,
        scheduledLocalStart:input.localStart,disambiguation:resolved.disambiguation,
        utcOffsetMinutes:resolved.offsetMinutes,employeeId:primaryEmployeeId,locationId:current.locationId,
        conflictDetected:conflicts.length>0,conflictOverrideRequested:input.overrideConflict,
        conflictOverrideAuthorized:overrideAuthorized,conflictOverrideApplied:overrideApplied,
        availabilityOverrideApplied:input.availabilityOverride
      };
      await completeSchedulingRequest(tx,claim.id,replayResult);
      return {
        kind: "moved",
        result:replayResult
      } as const;
    });
    if(moved.kind==="moved")await schedulingHooks.afterCommit?.({operation:"reschedule",appointmentId:moved.result.appointmentId});
    return schedulingReplayResponse(moved.result);
  });

  app.patch("/api/appointments/:id/operations", {
    preHandler: [authenticate, requirePermission("operations.perform_service")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(operationalUpdateSchema, request.body);
    const [updated] = input.version
      ? await db`
          update appointments set operational_notes=${input.operationalNotes ?? null},
            version=version+1, updated_by=${context.userId}, updated_at=now()
          where business_id=${context.businessId} and id=${id} and version=${input.version}
            and status in ('checked_in','in_service') returning *
        `
      : await db`
          update appointments set operational_notes=${input.operationalNotes ?? null},
            version=version+1, updated_by=${context.userId}, updated_at=now()
          where business_id=${context.businessId} and id=${id}
            and status in ('checked_in','in_service') returning *
        `;
    if (!updated) return reply.code(404).send({ error: "Active service appointment not found" });
    return updated;
  });

  app.put("/api/appointments/:id/services", {
    preHandler: [authenticate, requirePermission("appointments.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(appointmentServicesSchema, request.body);
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [appointment] = await tx<{ startAt: Date; status: string; employeeId: string;petId:string; version: number; schedulingTimezone:string }[]>`
        select start_at,status,employee_id,pet_id,version,scheduling_timezone from appointments
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!appointment) return null;
      const assigned=await tx<{employeeId:string}[]>`select employee_id from appointment_employees where business_id=${context.businessId} and appointment_id=${id}`;
      await lockSchedulingResources(tx, context.businessId, assigned.map(row=>row.employeeId));
      if (input.version && appointment.version !== input.version) {
        return { stale: true } as const;
      }
      if (!["scheduled","checked_in","in_service"].includes(appointment.status)) {
        throw new Error("Services cannot be changed in the current appointment state");
      }
      const invoice = await tx`
        select id from invoices where business_id=${context.businessId} and appointment_id=${id} and status<>'void'
      `;
      if (invoice.length) throw new Error("Services cannot change after checkout begins");
      await ensureBookingResourcesAvailable(tx,{businessId:context.businessId,employeeIds:assigned.map(row=>row.employeeId),serviceIds:input.serviceIds});
      const catalog=await resolveServicePrices(tx,{businessId:context.businessId,petId:appointment.petId,serviceIds:input.serviceIds});
      const unresolved=catalog.find(service=>service.status!=="resolved");
      if(unresolved)throw new Error(unresolved.status==="weight_required"?"Weight required to determine pricing.":`${unresolved.name} price is unresolved.`);
      await tx`delete from appointment_services where business_id=${context.businessId} and appointment_id=${id}`;
      for (const service of catalog) {
        await tx`
          insert into appointment_services
            (business_id,appointment_id,service_id,service_name_snapshot,duration_minutes_snapshot,price_minor_snapshot,pricing_class_snapshot,weight_tier_snapshot,resolution_source_snapshot)
          values (${context.businessId},${id},${service.serviceId},${service.name},
            ${service.durationMinutes},${service.priceMinor!},${service.pricingClass},${service.weightTierCode},${service.resolutionSource})
        `;
      }
      const minutes = catalog.reduce((sum, service) => sum + service.durationMinutes, 0);
      const endAt = new Date(appointment.startAt.getTime() + minutes * 60_000);
      if (localDateForInstant(endAt,appointment.schedulingTimezone) !== localDateForInstant(appointment.startAt,appointment.schedulingTimezone)) {
        throw new Error("Appointments may not cross local midnight during the controlled pilot");
      }
      await tx`
        update appointments set end_at=${endAt},version=version+1,updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "appointment.services.update",
        resourceType: "appointment", resourceId: id,
        after: { serviceIds: input.serviceIds, endAt }, eventType: "AppointmentUpdated"
      });
      return { id, endAt };
    });
    if (!result) return reply.code(404).send({ error: "Appointment not found" });
    if ("stale" in result) return reply.code(409).send({ error: "Appointment changed; refresh before continuing" });
    return result;
  });

  app.post("/api/appointments/:id/checkout", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(checkoutSchema, request.body);
    const requestKey = idempotencyKey(request);
    if (input.discountMinor > 0 && !context.isOwner && !context.permissions.includes("discounts.apply")) {
      return reply.code(403).send({ error: "Missing permission: discounts.apply" });
    }
    const clientHash = canonicalHash({ version: 1, appointmentId: id, discountMinor: input.discountMinor,
      discountType: input.discountType?.trim() || null, tipMinor: input.tipMinor });
    const outcome = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [appointment] = await tx<{ customerId: string; status: string; taxRateBasisPoints: number }[]>`
        select a.customer_id, a.status, b.tax_rate_basis_points
        from appointments a join businesses b on b.id=a.business_id
        where a.business_id=${context.businessId} and a.id=${id} for update
      `;
      if (!appointment) return null;
      const claim = await claimFinancialRequest(tx, {
        businessId: context.businessId, actorId: context.userId,
        operation: "checkout.create-invoice", key: requestKey, hash: clientHash
      });
      if (claim.existingResult) return { result: claim.existingResult, created: false };
      if (appointment.status !== "completed") {
        throw new FinancialRequestError(409, "STALE_FINANCIAL_STATE", "Only completed appointments can be checked out");
      }
      const services = await tx<{ id: string; serviceNameSnapshot: string; priceMinorSnapshot: number }[]>`
        select id, service_name_snapshot, price_minor_snapshot from appointment_services
        where business_id=${context.businessId} and appointment_id=${id}
        order by id
      `;
      if (!services.length) throw new FinancialRequestError(409, "CHECKOUT_REQUIRES_SERVICE", "Checkout requires at least one service");
      const totals = calculateInvoice({
        lineAmounts: services.map((service) => service.priceMinorSnapshot),
        discount: input.discountMinor, taxRateBasisPoints: appointment.taxRateBasisPoints,
        tip: input.tipMinor
      });
      const intentFingerprint = canonicalHash({
        version: 1, appointmentId: id, customerId: appointment.customerId,
        services: services.map((service) => ({ id: service.id, name: service.serviceNameSnapshot, amountMinor: service.priceMinorSnapshot })),
        subtotalMinor: totals.subtotal, discountMinor: totals.discount,
        discountType: input.discountType?.trim() || null,
        taxRateBasisPoints: appointment.taxRateBasisPoints, taxMinor: totals.tax,
        tipMinor: totals.tip, totalMinor: totals.total
      });
      const [existing] = await tx<{ id: string; intentFingerprint: string | null }[]>`
        select id,intent_fingerprint from invoices
        where business_id=${context.businessId} and appointment_id=${id} and status<>'void'
      `;
      if (existing) {
        if (existing.intentFingerprint !== intentFingerprint) {
          const [authoritativeInvoice] = await tx`
            select * from invoices where business_id=${context.businessId} and id=${existing.id}
          `;
          throw new FinancialRequestError(409, "INVOICE_ALREADY_EXISTS",
            "An invoice already exists with different checkout totals", { invoice: authoritativeInvoice });
        }
        const [result] = await tx`select * from invoices where business_id=${context.businessId} and id=${existing.id}`;
        await completeFinancialRequest(tx, { id: claim.id, resultType: "invoice", resourceId: existing.id, result });
        return { result, created: false };
      }
      const [created] = await tx<{ id: string }[]>`
        insert into invoices
          (business_id, appointment_id, customer_id, status, subtotal_minor, discount_minor,
           tax_minor, tip_minor, total_minor, balance_minor, discount_type, discount_actor,
           intent_fingerprint,calculation_version,tax_rate_basis_points)
        values
          (${context.businessId}, ${id}, ${appointment.customerId}, ${totals.total === 0 ? "paid" : "open"},
           ${totals.subtotal}, ${totals.discount}, ${totals.tax}, ${totals.tip},
           ${totals.total}, ${totals.total}, ${input.discountType ?? null},
           ${input.discountMinor > 0 ? context.userId : null},${intentFingerprint},1,${appointment.taxRateBasisPoints})
        returning *
      `;
      if (!created) throw new Error("Invoice creation failed");
      for (const [index,service] of services.entries()) {
        await tx`
          insert into invoice_items
            (business_id, invoice_id, description, quantity, unit_price_minor, amount_minor,
             source_appointment_service_id,line_position)
          values
            (${context.businessId}, ${created.id}, ${service.serviceNameSnapshot}, 1,
             ${service.priceMinorSnapshot}, ${service.priceMinorSnapshot}, ${service.id},${index + 1})
        `;
      }
      await financialHooks.beforeFinancialAudit?.("checkout.create-invoice");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "invoice.create",
        resourceType: "invoice", resourceId: created.id, after: totals, eventType: "InvoiceCreated"
      });
      await completeFinancialRequest(tx, { id: claim.id, resultType: "invoice", resourceId: created.id, result: created });
      return { result: created, created: true };
    });
    if (!outcome) return reply.code(404).send({ error: "Appointment not found" });
    await financialHooks.afterFinancialCommit?.("checkout.create-invoice");
    return reply.code(outcome.created ? 201 : 200).send(outcome.result);
  });

  app.post("/api/invoices/:id/payments", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(paymentSchema, request.body);
    const requestKey = idempotencyKey(request);
    const requestHash = canonicalHash({ version: 1, invoiceId: id, amountMinor: input.amountMinor,
      expectedBalanceMinor: input.expectedBalanceMinor, method: input.method,
      externalReference: input.externalReference?.trim() || null });
    const outcome = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [invoice] = await tx<{ balanceMinor: number; status: string }[]>`
        select balance_minor, status from invoices
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!invoice) return null;
      const claim = await claimFinancialRequest(tx, { businessId: context.businessId, actorId: context.userId,
        operation: "payment.record", key: requestKey, hash: requestHash });
      if (claim.existingResult) return { result: claim.existingResult, created: false };
      if (!["open", "partially_paid"].includes(invoice.status)) {
        throw new FinancialRequestError(409, "STALE_FINANCIAL_STATE", "Invoice cannot accept payment");
      }
      if (input.amountMinor > invoice.balanceMinor) {
        const stale=input.expectedBalanceMinor!==invoice.balanceMinor;
        throw new FinancialRequestError(stale?409:400,stale?"STALE_FINANCIAL_STATE":"PAYMENT_EXCEEDS_CURRENT_BALANCE",
          stale?"The invoice balance changed; review the current balance":"Payment exceeds invoice balance");
      }
      const [created] = await tx<{ id: string }[]>`
        insert into payments
          (business_id, invoice_id, amount_minor, method, external_reference, recorded_by)
        values
          (${context.businessId}, ${id}, ${input.amountMinor}, ${input.method},
           ${input.externalReference ?? null}, ${context.userId})
        returning *
      `;
      const balance = invoice.balanceMinor - input.amountMinor;
      await tx`
        update invoices set balance_minor=${balance},
          status=${balance === 0 ? "paid" : "partially_paid"}, updated_at=now()
        where id=${id} and business_id=${context.businessId}
      `;
      await financialHooks.beforeFinancialAudit?.("payment.record");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "payment.record",
        resourceType: "payment", resourceId: created?.id,
        after: { invoiceId: id, amountMinor: input.amountMinor, method: input.method },
        eventType: "PaymentRecorded"
      });
      if (!created) throw new Error("Payment creation failed");
      const result = { ...created, balance };
      await completeFinancialRequest(tx, { id: claim.id, resultType: "payment", resourceId: created.id, result });
      return { result, created: true };
    });
    if (!outcome) return reply.code(404).send({ error: "Invoice not found" });
    await financialHooks.afterFinancialCommit?.("payment.record");
    return reply.code(outcome.created ? 201 : 200).send(outcome.result);
  });

  app.post("/api/payments/:id/void", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(voidPaymentSchema, request.body);
    const requestKey = idempotencyKey(request);
    const requestHash = canonicalHash({ version: 1, paymentId: id, reason: input.reason.trim() });
    const outcome = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [payment] = await tx<{ invoiceId: string; amountMinor: number; status: string }[]>`
        select invoice_id, amount_minor, status from payments
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!payment) return null;
      const claim = await claimFinancialRequest(tx, { businessId: context.businessId, actorId: context.userId,
        operation: "payment.void", key: requestKey, hash: requestHash });
      if (claim.existingResult) return { result: claim.existingResult, created: false };
      if (payment.status !== "recorded") {
        throw new FinancialRequestError(409, "PAYMENT_ALREADY_VOIDED", "Payment is already voided");
      }
      await tx`
        update payments set status='voided',voided_by=${context.userId},voided_at=now(),
          void_reason=${input.reason} where business_id=${context.businessId} and id=${id}
      `;
      const [invoice] = await tx<{ totalMinor: number }[]>`
        select total_minor from invoices where business_id=${context.businessId}
          and id=${payment.invoiceId} for update
      `;
      const [sum] = await tx<{ paid: number }[]>`
        select coalesce(sum(amount_minor),0)::integer as paid from payments
        where business_id=${context.businessId} and invoice_id=${payment.invoiceId} and status='recorded'
      `;
      const balance = (invoice?.totalMinor ?? 0) - (sum?.paid ?? 0);
      await tx`
        update invoices set balance_minor=${balance},
          status=${balance === (invoice?.totalMinor ?? 0) ? "open" : balance === 0 ? "paid" : "partially_paid"},
          updated_at=now()
        where business_id=${context.businessId} and id=${payment.invoiceId}
      `;
      await financialHooks.beforeFinancialAudit?.("payment.void");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "payment.void",
        resourceType: "payment", resourceId: id, reason: input.reason,
        before: { status: "recorded" }, after: { status: "voided" }
      });
      const result = { id, balance };
      await completeFinancialRequest(tx, { id: claim.id, resultType: "payment", resourceId: id, result });
      return { result, created: true };
    });
    if (!outcome) return reply.code(404).send({ error: "Payment not found" });
    await financialHooks.afterFinancialCommit?.("payment.void");
    return reply.code(200).send(outcome.result);
  });

  app.get("/api/invoices/:id/receipt", {
    preHandler: [authenticate, requirePermission("payments.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [invoice] = await db`
      select i.*, b.name as business_name, b.currency, c.first_name, c.last_name
      from invoices i join businesses b on b.id=i.business_id join customers c on c.id=i.customer_id
      where i.business_id=${context.businessId} and i.id=${id}
    `;
    if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
    const [items, payments] = await Promise.all([
      db`select * from invoice_items where business_id=${context.businessId} and invoice_id=${id} order by line_position,id`,
      db`select * from payments where business_id=${context.businessId} and invoice_id=${id} order by recorded_at,id`
    ]);
    return { invoice, items, payments };
  });

  app.get("/api/dashboard", {
    preHandler: [authenticate, requirePermission("reports.view")]
  }, async (request) => {
    const context = auth(request);
    const [location]=await db<{id:string;timezone:string}[]>`select id,timezone from locations where business_id=${context.businessId} and id=${context.locationId}::uuid and active`;
    if(!location)throw new Error("Active location not found");
    const today=localDateForInstant(new Date(),location.timezone);
    const bounds=localDateBounds(today,location.timezone);
    const [metrics] = await db`
      select
        count(*) filter (
          where a.start_at>=${bounds.from} and a.start_at<${bounds.to}
        ) as todays_appointments,
        count(*) filter (where a.start_at>=now() and a.status='scheduled') as upcoming_appointments,
        count(*) filter (
          where a.start_at>=${bounds.from} and a.start_at<${bounds.to}
            and a.status='completed'
        ) as completed_today
      from appointments a
      where a.business_id=${context.businessId} and a.location_id=${location.id}
    `;
    const [finance] = await db`
      select
        coalesce(sum(i.total_minor-i.balance_minor) filter (
          where i.created_at>=${bounds.from} and i.created_at<${bounds.to}
        ),0) as todays_sales_minor,
        coalesce(sum(i.balance_minor) filter (where i.status in ('open','partially_paid')),0) as outstanding_minor
      from invoices i
      join appointments a on a.id=i.appointment_id
      where i.business_id=${context.businessId} and a.location_id=${location.id}
    `;
    return { ...metrics, ...finance };
  });

  app.get("/api/reports", {
    preHandler: [authenticate, requirePermission("reports.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const query=body(reportRangeSchema,request.query);
    const [location]=await db<{id:string;timezone:string}[]>`select id,timezone from locations where business_id=${context.businessId} and id=${context.locationId}::uuid and active`;
    if(!location)return reply.code(404).send({error:"Active location not found"});
    const today=localDateForInstant(new Date(),location.timezone);
    const defaultStart=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7))-1,Number(today.slice(8,10))-30)).toISOString().slice(0,10);
    const localDate=query.localDate??defaultStart;
    const days=query.days??31;
    const from=localDateBounds(localDate,location.timezone).from;
    const end=new Date(Date.UTC(Number(localDate.slice(0,4)),Number(localDate.slice(5,7))-1,Number(localDate.slice(8,10))+days)).toISOString().slice(0,10);
    const to=localDateBounds(end,location.timezone).from;
    // One authoritative source for the Charts view, the Report table, and the analytics dashboard.
    //
    // SCOPE: every aggregate below is restricted to the session's resolved location, the requested
    // window, and the groomer filter. Reports must never blend locations the operator did not select.
    //
    // BUSINESS TOTALS (`totals`) count unique underlying business events. The groomer filter is an
    // `exists` predicate, never a join, so an appointment shared by groomers A and B is counted once
    // for `employeeIds=A`, once for `employeeIds=B`, and still once for `employeeIds=A,B`. Its invoice
    // is likewise counted once. Regression: "counts a shared multi-groomer appointment once in
    // business totals and once per groomer in attribution".
    //   paidRevenueMinor      sum(invoices.total_minor - invoices.balance_minor) for invoices created in
    //                         [from,to) whose appointment matches the filter. Cash collected, not billed.
    //   expectedRevenueMinor  sum(invoices.balance_minor) over the same invoices — billed and still owed.
    //                         `outstandingMinor` and `paymentStatus.outstandingMinor` are the same figure
    //                         under the names the dashboard panels use; they are aliases, not extra money.
    //   billedRevenueMinor    sum(invoices.total_minor) = paidRevenueMinor + expectedRevenueMinor.
    //   salesMinor            sum(subtotal_minor): gross line-item sales BEFORE discount.
    //   discountMinor         sum(discount_minor). salesMinor - discountMinor = netMinor.
    //   netMinor              sum(subtotal_minor - discount_minor): charged for work, before tax and tip.
    //                         billedRevenueMinor = netMinor + taxMinor + tipMinor, by invoice construction.
    //   completedAppointments count(appointments) with status='completed' and start_at in [from,to).
    //   totalPets             count(distinct pet) on exactly those completed appointments.
    //   servicesPerformed     count(appointment_services) rows on those completed appointments.
    //   commissionMinor       null. Pawsh has NO commission model: no rate, plan, or ledger exists in the
    //                         schema, so there is nothing to sum. Null (not zero) says "unknown", which is
    //                         the only honest answer; the dashboard renders an empty Commission panel.
    //
    // GROOMER ATTRIBUTION (`employees`) credits every assigned groomer with the whole appointment and its
    // whole invoice, because Pawsh has no allocation model and inventing one (splits, percentages) would
    // fabricate data. Migration 0017 currently enforces one groomer per appointment, so the rows do not
    // overlap today — but that is a property of the data, not a guarantee of this endpoint. If shared
    // appointments return, these rows double-count: read `totals` for business figures.
    //   unattributedRevenueMinor / unattributedTipMinor
    //                         the remainder that belongs to NO groomer, because the appointment carries no
    //                         `appointment_employees` row (legacy and directly-seeded rows exist in real
    //                         data). Without it the "Revenue by Staff" bars silently fail to add up to
    //                         `paidRevenueMinor`; with it the dashboard can show an honest Unassigned bar.
    //                         Zero when every appointment in the window is assigned.
    //
    // DATE SEMANTICS: money buckets by invoice `created_at`; operational metrics bucket by appointment
    // `start_at`. The two windows can legitimately disagree and that is not a bug.
    const appointmentScope=assignedToEmployees(db,query.employeeIds);
    const employeeScope=query.employeeIds?.length?db`e.id in ${db(query.employeeIds)}`:db`true`;
    // Reusable predicates so every panel provably shares one definition of "in this report".
    // Both assume the enclosing query aliases `invoices i` / `appointments a`.
    const reportedInvoices=db`i.business_id=${context.businessId} and a.location_id=${location.id}::uuid
      and i.status<>'void' and i.created_at>=${from} and i.created_at<${to} and ${appointmentScope}`;
    const completedAppointmentsScope=db`a.business_id=${context.businessId} and a.location_id=${location.id}::uuid
      and a.status='completed' and a.start_at>=${from} and a.start_at<${to} and ${appointmentScope}`;
    const [revenue, employees, servicesPerformed, operations, money, attribution, paymentMethodRows] = await Promise.all([
      db<{date:string;revenueMinor:string|number}[]>`
        select (i.created_at at time zone l.timezone)::date as date,sum(i.total_minor-i.balance_minor)::bigint as revenue_minor
        from invoices i join appointments a on a.id=i.appointment_id join locations l on l.id=a.location_id
        where ${reportedInvoices}
        group by (i.created_at at time zone l.timezone)::date order by date
      `,
      db<{id:string;displayName:string;appointmentCount:number}[]>`
        select e.id,e.display_name,count(a.id)::integer as appointment_count
        from employees e left join appointment_employees assignment
          on assignment.business_id=e.business_id and assignment.employee_id=e.id
        left join appointments a on a.id=assignment.appointment_id
          and a.start_at>=${from} and a.start_at<${to} and a.status='completed'
          and a.location_id=${location.id}::uuid
        where e.business_id=${context.businessId} and ${employeeScope}
        group by e.id order by appointment_count desc
      `,
      db<{service:string;performed:number}[]>`
        select aps.service_name_snapshot as service,count(*)::integer as performed
        from appointment_services aps join appointments a on a.id=aps.appointment_id
        where aps.business_id=${context.businessId} and ${completedAppointmentsScope}
        group by aps.service_name_snapshot order by performed desc
      `,
      db<{completedAppointments:number;totalPets:number}[]>`
        select count(*)::int completed_appointments,count(distinct a.pet_id)::int total_pets
        from appointments a where ${completedAppointmentsScope}
      `,
      db<{salesMinor:string;discountMinor:string;netMinor:string;taxMinor:string;tipMinor:string;
        billedRevenueMinor:string;outstandingMinor:string}[]>`
        select
          coalesce(sum(i.subtotal_minor),0)::bigint as sales_minor,
          coalesce(sum(i.discount_minor),0)::bigint as discount_minor,
          coalesce(sum(i.subtotal_minor-i.discount_minor),0)::bigint as net_minor,
          coalesce(sum(i.tax_minor),0)::bigint as tax_minor,
          coalesce(sum(i.tip_minor),0)::bigint as tip_minor,
          coalesce(sum(i.total_minor),0)::bigint as billed_revenue_minor,
          coalesce(sum(i.balance_minor),0)::bigint as outstanding_minor
        from invoices i join appointments a on a.id=i.appointment_id
        where ${reportedInvoices}
      `,
      db<{id:string;revenueMinor:string;tipMinor:string}[]>`
        select assignment.employee_id as id,
          coalesce(sum(i.total_minor-i.balance_minor),0)::bigint as revenue_minor,
          coalesce(sum(i.tip_minor),0)::bigint as tip_minor
        from invoices i join appointments a on a.id=i.appointment_id
        join appointment_employees assignment
          on assignment.business_id=i.business_id and assignment.appointment_id=a.id
        where ${reportedInvoices}
        group by assignment.employee_id
      `,
      // Voided payments never collected money, and `balance_minor` already excludes them, so the same
      // filter here keeps sum(paymentMethods[].amountMinor) === totals.paidRevenueMinor.
      db<{method:string;amountMinor:string;paymentCount:number}[]>`
        select p.method,coalesce(sum(p.amount_minor),0)::bigint as amount_minor,count(*)::int as payment_count
        from payments p join invoices i on i.id=p.invoice_id join appointments a on a.id=i.appointment_id
        where p.business_id=${context.businessId} and p.status='recorded' and ${reportedInvoices}
        group by p.method order by amount_minor desc,p.method
      `
    ]);
    // bigint sums arrive as strings from postgres.js; the wire contract is integer minor units.
    const minor=(value:string|number|null|undefined):number=>Number(value??0);
    const financials=money[0];
    const paidRevenueMinor=revenue.reduce((sum,row)=>sum+minor(row.revenueMinor),0);
    const outstandingMinor=minor(financials?.outstandingMinor);
    const taxMinor=minor(financials?.taxMinor);
    const tipMinor=minor(financials?.tipMinor);
    const netMinor=minor(financials?.netMinor);
    const byEmployee=new Map(attribution.map((row)=>[row.id,row]));
    const attributedRevenueMinor=attribution.reduce((sum,row)=>sum+minor(row.revenueMinor),0);
    const attributedTipMinor=attribution.reduce((sum,row)=>sum+minor(row.tipMinor),0);
    const totals={
      paidRevenueMinor,
      completedAppointments:operations[0]?.completedAppointments??0,
      servicesPerformed:servicesPerformed.reduce((sum,row)=>sum+Number(row.performed),0),
      totalPets:operations[0]?.totalPets??0,
      expectedRevenueMinor:outstandingMinor,
      outstandingMinor,
      billedRevenueMinor:minor(financials?.billedRevenueMinor),
      salesMinor:minor(financials?.salesMinor),
      discountMinor:minor(financials?.discountMinor),
      netMinor, taxMinor, tipMinor,
      unattributedRevenueMinor:paidRevenueMinor-attributedRevenueMinor,
      unattributedTipMinor:tipMinor-attributedTipMinor,
      // No commission model exists in this schema; see the comment above.
      commissionMinor:null
    };
    return {
      localDate, days, from, to,
      employeeIds: query.employeeIds ?? null,
      totals, revenue,
      employees: employees.map((row)=>({
        ...row,
        revenueMinor:minor(byEmployee.get(row.id)?.revenueMinor),
        tipMinor:minor(byEmployee.get(row.id)?.tipMinor),
        commissionMinor:null
      })),
      services: servicesPerformed,
      paymentMethods: paymentMethodRows.map((row)=>({
        method:row.method, amountMinor:minor(row.amountMinor), count:Number(row.paymentCount)
      })),
      // `productsMinor` is a structural zero, not a measurement: Pawsh has no product or retail model,
      // and every invoice line is created from an appointment service at checkout. `servicesMinor` is
      // net of discount so the four buckets sum to `totals.billedRevenueMinor`.
      salesItems: { servicesMinor: netMinor, productsMinor: 0, taxMinor, tipMinor },
      paymentStatus: { paidMinor: paidRevenueMinor, outstandingMinor }
    };
  });

  app.get("/api/audit", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request) => {
    const context = auth(request);
    return db`
      select id, actor_id, action, resource_type, resource_id, reason, created_at
      from audit_events where business_id=${context.businessId}
      order by created_at desc limit 100
    `;
  });

  app.get("/api/admin/businesses/:id", {
    preHandler: authenticatePlatform
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [business] = await db`
      select id,name,status,created_at,updated_at from businesses where id=${id}
    `;
    if (!business) return reply.code(404).send({ error: "Business not found" });
    await db`
      insert into audit_events
        (business_id,actor_id,action,resource_type,resource_id,correlation_id,reason)
      values (${id},${context.userId},'platform.metadata.view','business',${id},${randomUUID()},
        'Exact-id internal support lookup')
    `;
    return business;
  });

  app.get("/api/admin/users/:id", {
    preHandler: authenticatePlatform
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [user] = await db`
      select id,email,email_verified_at,disabled_at,created_at,updated_at
      from users where id=${id}
    `;
    if (!user) return reply.code(404).send({ error: "User not found" });
    await db`
      insert into audit_events(actor_id,action,resource_type,resource_id,correlation_id,reason)
      values (${context.userId},'platform.user_metadata.view','user',${id},${randomUUID()},
        'Exact-id internal support lookup')
    `;
    return user;
  });

  app.post("/api/admin/users/:id/disable", {
    preHandler: authenticatePlatform
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body((await import("zod")).z.object({
      reason: (await import("zod")).z.string().trim().min(5).max(500)
    }), request.body);
    const disabled = await db.begin(async (tx) => {
      const [user] = await tx<{ id: string }[]>`
        update users set disabled_at=now(),updated_at=now()
        where id=${id} and disabled_at is null returning id
      `;
      if (!user) return false;
      await tx`update sessions set revoked_at=now() where user_id=${id} and revoked_at is null`;
      await tx`
        insert into audit_events(actor_id,action,resource_type,resource_id,correlation_id,reason)
        values (${context.userId},'platform.user.disable','user',${id},${randomUUID()},${input.reason})
      `;
      return true;
    });
    if (!disabled) return reply.code(404).send({ error: "Active user not found" });
    return { disabled: true };
  });
}
