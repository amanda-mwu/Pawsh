import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z, type ZodType } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { DocumentStorageError, sha256, type DocumentStorage } from "../storage/documents.js";
import { canTransition, type AppointmentStatus } from "../domain/appointments.js";
import { calculateInvoice } from "../domain/money.js";
import { canonicalHash } from "../domain/canonical.js";
import { safePdfFilename } from "../domain/filenames.js";
import { localDateBounds, localDateForInstant, resolveWallTime, validateTimeZone } from "../domain/time.js";
import { permissionPresets, permissions } from "../domain/permissions.js";
import { auth, authentication, issueToken, platformAuthentication, requirePermission, tokenHash } from "./context.js";
import {
  appointmentSchema, checkoutSchema, customerSchema, employeeSchema, idParams, loginSchema,
  normalizeEmail, normalizePhone, paymentSchema, petSchema, serviceSchema, signupSchema,
  transitionSchema, businessSettingsSchema, workingHoursSchema, blockedTimeSchema,
  operationalUpdateSchema, voidPaymentSchema, appointmentMoveSchema, appointmentServicesSchema,
  passwordResetRequestSchema, passwordResetConfirmSchema, invitationSchema,
  invitationAcceptSchema, ownershipTransferSchema, petProfileUpdateSchema, petCareUpdateSchema,
  servicePricingSchema,breedCatalogCreateSchema,breedCatalogUpdateSchema,priceResolutionSchema,
  ownProfileUpdateSchema,passwordChangeSchema,workspaceAccessRequestSchema,workspaceSelectionSchema
} from "./schemas.js";
import { sealSecret } from "../security/secrets.js";
import { hashPassword, validateNewPassword, verifyPassword } from "../security/passwords.js";
import { AuthAbuseProtector } from "../security/auth-abuse.js";
import {
  changedPetCareFields,
  writablePetCareFields,
  redactPetCare,
  suppliedPetCareFields,
  type PetCareRecord
} from "../domain/pet-care.js";
import { catalogBreedName, normalizeBreedSearch } from "../domain/pets/dog-breeds.js";
import {provisionBusinessCatalog} from "../domain/catalog-seed.js";
import {resolveServicePrices} from "../domain/service-pricing.js";

type Transaction = postgres.TransactionSql;

const calendarQuerySchema=z.object({
  localDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days:z.coerce.number().int().min(1).max(31).optional(),
  mode:z.enum(["start","overlap"]).optional()
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
  days:z.coerce.number().int().min(1).max(366).optional()
}).strict();

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

async function setTenant(tx: Transaction, businessId: string): Promise<void> {
  await tx`select set_config('app.business_id', ${businessId}, true)`;
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
        insert into sessions (user_id, business_id, token_hash, expires_at)
        values (${user.id}, ${business.id}, ${tokenHash(token)}, now() + interval '14 days')
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
    return reply.setCookie("pawsh_session", token, sessionCookie(config)).send({ ok: true });
  });

  app.post("/api/auth/logout", { preHandler: authenticate }, async (request, reply) => {
    const token = request.cookies.pawsh_session;
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
    const [business] = await db`
      select b.*, l.id as location_id, l.name as location_name, l.timezone, l.version as location_version
      from businesses b join locations l on l.business_id = b.id and l.active
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
    await db`update sessions set business_id=${input.businessId}
      where token_hash=${tokenHash(request.cookies.pawsh_session??"")} and user_id=${context.userId}`;
    return {selected:true};
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
    const currentTokenHash = tokenHash(request.cookies.pawsh_session ?? "");
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
      const [activeLocation]=await tx<{id:string}[]>`select id from locations where business_id=${context.businessId} and active`;
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

  app.put("/api/employees/:id/working-hours", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(workingHoursSchema, request.body);
    const exists = await db`select id from employees where business_id=${context.businessId} and id=${id}`;
    if (!exists.length) return reply.code(404).send({ error: "Employee not found" });
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      await tx`delete from employee_working_hours where business_id=${context.businessId} and employee_id=${id}`;
      for (const period of input.hours) {
        await tx`
          insert into employee_working_hours (business_id,employee_id,weekday,start_time,end_time)
          values (${context.businessId},${id},${period.weekday},${period.startTime},${period.endTime})
        `;
      }
    });
    return reply.code(204).send();
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
        select id from locations where business_id=${context.businessId} and active
      `;
      if (!location) throw new Error("Active location not found");
      await tx`delete from business_hours where business_id=${context.businessId} and location_id=${location.id}`;
      for (const period of input.hours) {
        await tx`
          insert into business_hours(business_id,location_id,weekday,start_time,end_time)
          values (${context.businessId},${location.id},${period.weekday},${period.startTime},${period.endTime})
        `;
      }
    });
    return { saved: true };
  });

  app.get("/api/business/working-hours", {
    preHandler: [authenticate, requirePermission("calendar.view")]
  }, async (request) => {
    const context=auth(request);
    return db`select weekday,start_time,end_time from business_hours
      where business_id=${context.businessId} order by weekday,start_time`;
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
      const [created] = await tx<{ id: string }[]>`
        insert into customers
          (business_id, first_name, last_name, phone, normalized_phone, email, normalized_email,
           address, preferred_contact_method, email_allowed, notes, created_by, updated_by)
        values
          (${context.businessId}, ${input.firstName}, ${input.lastName}, ${input.phone ?? null},
           ${normalizePhone(input.phone)}, ${input.email ?? null},
           ${input.email ? normalizeEmail(input.email) : null}, ${input.address ?? null},
           ${input.preferredContactMethod}, ${input.emailAllowed}, ${input.notes ?? null},
           ${context.userId}, ${context.userId})
        returning *
      `;
      if (!created) throw new Error("Customer creation failed");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "customer.create",
        resourceType: "customer", resourceId: created.id, eventType: "CustomerCreated"
      });
      return created;
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
    const [updated] = await db`
      update customers set first_name=${input.firstName},last_name=${input.lastName},
        phone=${input.phone ?? null},normalized_phone=${normalizePhone(input.phone)},
        email=${input.email ?? null},normalized_email=${input.email ? normalizeEmail(input.email) : null},
        address=${input.address ?? null},preferred_contact_method=${input.preferredContactMethod},
        email_allowed=${input.emailAllowed},notes=${input.notes ?? null},
        updated_by=${context.userId},updated_at=now()
      where business_id=${context.businessId} and id=${id} and archived_at is null returning *
    `;
    if (!updated) return reply.code(404).send({ error: "Active customer not found" });
    return updated;
  });

  app.get("/api/customers/:id/history", {
    preHandler: [authenticate, requirePermission("customers.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [customer] = await db`select * from customers where business_id=${context.businessId} and id=${id}`;
    if (!customer) return reply.code(404).send({ error: "Customer not found" });
    const mayViewCare = mayViewPetCare(context);
    const mayViewPayments = context.isOwner || context.permissions.includes("payments.view");
    const [pets, appointments, invoices] = await Promise.all([
      db`select * from pets where business_id=${context.businessId} and customer_id=${id} order by name,id`,
      db`select a.*, p.name as pet_name, e.display_name as employee_name
         from appointments a join pets p on p.id=a.pet_id join employees e on e.id=a.employee_id
         where a.business_id=${context.businessId} and a.customer_id=${id}
         order by a.start_at desc,a.id desc`,
      mayViewPayments
        ? db`select id,invoice_number,status,subtotal_minor,discount_minor,tax_minor,tip_minor,
              total_minor,balance_minor,created_at
             from invoices where business_id=${context.businessId} and customer_id=${id}
             order by created_at desc,id desc`
        : Promise.resolve([])
    ]);
    return {
      customer,
      pets: mayViewCare ? pets : pets.map((pet) => redactPetCare(pet)),
      appointments,
      invoices
    };
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

  app.get("/api/dog-breeds", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async (request) => {
    const context=auth(request);
    const canManage=context.isOwner||context.permissions.includes("services.manage");
    return db`select id,breed_key,name,normalized_name as search,default_pricing_class,active from business_breeds where business_id=${context.businessId} and (${canManage} or active) order by active desc,name`;
  });

  app.post("/api/dog-breeds",{preHandler:[authenticate,requirePermission("services.manage")]},async(request,reply)=>{
    const context=auth(request);const input=body(breedCatalogCreateSchema,request.body);const normalized=normalizeBreedSearch(input.name);
    const [created]=await db`insert into business_breeds(business_id,breed_key,name,normalized_name,default_pricing_class) values (${context.businessId},${`custom-${randomUUID()}`},${input.name},${normalized},${input.defaultPricingClass}) on conflict(business_id,normalized_name) do nothing returning *`;
    if(!created){const [existing]=await db`select id,name,active from business_breeds where business_id=${context.businessId} and normalized_name=${normalized}`;return reply.code(409).send({code:"BREED_DUPLICATE",error:`Breed already exists: ${existing?.name??input.name}`,existing});}return reply.code(201).send(created);
  });

  app.patch("/api/dog-breeds/:id",{preHandler:[authenticate,requirePermission("services.manage")]},async(request,reply)=>{
    const context=auth(request);const {id}=idParams.parse(request.params);const input=body(breedCatalogUpdateSchema,request.body);
    try{
      const [updated]=await db`update business_breeds set name=coalesce(${input.name??null},name),normalized_name=coalesce(${input.name?normalizeBreedSearch(input.name):null},normalized_name),default_pricing_class=coalesce(${input.defaultPricingClass??null},default_pricing_class),active=coalesce(${input.active??null},active),updated_at=now() where business_id=${context.businessId} and id=${id} returning *`;
      if(!updated)return reply.code(404).send({error:"Breed not found"});return updated;
    }catch(error){
      if(error&&typeof error==="object"&&"code" in error&&error.code==="23505"&&input.name){const normalized=normalizeBreedSearch(input.name);const [existing]=await db`select id,name,active from business_breeds where business_id=${context.businessId} and normalized_name=${normalized}`;return reply.code(409).send({code:"BREED_DUPLICATE",error:`Breed already exists: ${existing?.name??input.name}`,existing});}
      throw error;
    }
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
      const [created] = await tx<{ id: string }[]>`
        insert into pets
          (business_id, customer_id, name, species, breed, date_of_birth, approximate_age,
           weight_ounces, sex, coat_notes, grooming_preferences, behavior_notes, medical_notes,
           safety_alerts, emergency_contact, veterinarian, vaccination_notes,
           vaccination_expires_on,rabies_vaccination_date,rabies_certificate_reference,
           rabies_verification_status,rabies_verification_method,rabies_verified_at,
           rabies_verified_by_membership_id,photo_permission, created_by, updated_by)
        values
          (${context.businessId}, ${input.customerId}, ${input.name}, ${input.species},
           ${input.breed ? catalogBreedName(input.breed) ?? input.breed : null}, ${input.dateOfBirth ?? null}, ${input.approximateAge ?? null},
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
      const [pet] = await tx`
        update pets set customer_id=${input.customerId},name=${input.name},species=${input.species},
          breed=${input.breed ? catalogBreedName(input.breed) ?? input.breed : null},date_of_birth=${input.dateOfBirth ?? null},
          approximate_age=${input.approximateAge ?? null},weight_ounces=${input.weightOunces ?? null},
          sex=${input.sex ?? null},coat_notes=${input.coatNotes ?? null},
          grooming_preferences=${input.groomingPreferences ?? null},
          photo_permission=${input.photoPermission ?? null},version=version+1,
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
        version: number;
      }[]>`
        select safety_alerts,medical_notes,behavior_notes,emergency_contact,veterinarian,
          vaccination_notes,vaccination_expires_on,rabies_vaccination_date,
          rabies_certificate_reference,rabies_verification_status,rabies_verification_method,
          rabies_verified_at as rabies_verification_date,
          rabies_verified_by_membership_id,version
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
      await documentStorage.put(storageKey, bytes);
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
      return reply
        .header("Content-Type", "application/pdf")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", `attachment; filename="rabies-vaccination.pdf"; filename*=UTF-8''${encoded}`)
        .header("Cache-Control", "private, no-store")
        .header("Content-Length", object.size)
        .code(200).send(Buffer.from(object.bytes));
    } catch (error) {
      request.log.warn({ documentId: id, errorName: (error as Error).name }, "pet document download unavailable");
      return reply.code(503).send({ error: "Document is temporarily unavailable" });
    }
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
      select id,timezone from locations where business_id=${context.businessId} and active
    `;
    if (!location) return reply.code(404).send({ error:"Active location not found" });
    const localDate=query.localDate ?? localDateForInstant(new Date(),location.timezone);
    const days=query.days ?? 8;
    const from=localDateBounds(localDate,location.timezone).from;
    const endLocal=new Date(Date.UTC(Number(localDate.slice(0,4)),Number(localDate.slice(5,7))-1,Number(localDate.slice(8,10))+days));
    const to=localDateBounds(endLocal.toISOString().slice(0,10),location.timezone).from;
    const overlap=query.mode === "overlap";
    const rows = await db`
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
        )) filter (where aps.id is not null), '[]') as services
      from appointments a
      join customers c on c.id=a.customer_id
      join pets p on p.id=a.pet_id
      join locations l on l.business_id=a.business_id and l.id=a.location_id
      join employees e on e.id=a.employee_id
      left join appointment_services aps on aps.appointment_id=a.id
      where a.business_id=${context.businessId} and a.location_id=${location.id}
        and ${overlap
          ? db`a.start_at < ${to} and a.end_at > ${from}`
          : db`a.start_at >= ${from} - interval '2 days' and a.start_at < ${to} + interval '2 days'
              and a.scheduled_local_start >= ${localDate}::date and a.scheduled_local_start < ${endLocal.toISOString().slice(0,10)}::date`}
      group by a.id,c.id,p.id,e.id,l.id order by a.start_at,a.employee_id,a.id
    `;
    if (mayViewPetCare(context)) return rows;
    return rows.map((appointment) => redactPetCare(appointment));
  });

  app.get("/api/pets/:id/booking-defaults",{preHandler:[authenticate,requirePermission("appointments.create")]},async(request,reply)=>{
    const context=auth(request);const {id}=idParams.parse(request.params);
    const [pet]=await db<{id:string}[]>`select id from pets where business_id=${context.businessId} and id=${id} and archived_at is null`;
    if(!pet)return reply.code(404).send({error:"Pet not found"});
    const [recent]=await db<{id:string}[]>`
      select id from appointments where business_id=${context.businessId} and pet_id=${id}
        and status<>'cancelled' order by start_at desc,id desc limit 1`;
    if(!recent)return {groomers:[],services:[]};
    const groomers=await db`
      select employee.id,employee.display_name from appointment_employees assignment
      join employees employee on employee.id=assignment.employee_id and employee.business_id=assignment.business_id
      where assignment.business_id=${context.businessId} and assignment.appointment_id=${recent.id} and employee.active
      order by employee.display_name`;
    const services=await db`
      select service.id,service.name,service.base_duration_minutes,service.base_price_minor
      from appointment_services history join services service on service.id=history.service_id and service.business_id=history.business_id
      where history.business_id=${context.businessId} and history.appointment_id=${recent.id} and service.active
      order by history.id`;
    return {groomers,services};
  });

  app.post("/api/appointments", {
    preHandler: [authenticate, requirePermission("appointments.create")]
  }, async (request, reply) => {
    const context = auth(request);
    const requestKey=schedulingIdempotencyKey(request);
    const input = body(appointmentSchema, request.body);
    const employeeIds=[...new Set(input.employeeIds??(input.employeeId?[input.employeeId]:[]))];
    const primaryEmployeeId=employeeIds[0]!;
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
    const employeeIds=[...new Set(input.employeeIds??(input.employeeId?[input.employeeId]:[]))];
    const primaryEmployeeId=employeeIds[0]!;
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
    const [location]=await db<{id:string;timezone:string}[]>`select id,timezone from locations where business_id=${context.businessId} and active`;
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
    const [location]=await db<{id:string;timezone:string}[]>`select id,timezone from locations where business_id=${context.businessId} and active`;
    if(!location)return reply.code(404).send({error:"Active location not found"});
    const today=localDateForInstant(new Date(),location.timezone);
    const defaultStart=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7))-1,Number(today.slice(8,10))-30)).toISOString().slice(0,10);
    const localDate=query.localDate??defaultStart;
    const days=query.days??31;
    const from=localDateBounds(localDate,location.timezone).from;
    const end=new Date(Date.UTC(Number(localDate.slice(0,4)),Number(localDate.slice(5,7))-1,Number(localDate.slice(8,10))+days)).toISOString().slice(0,10);
    const to=localDateBounds(end,location.timezone).from;
    const [revenue, employees, servicesPerformed] = await Promise.all([
      db`
        select (i.created_at at time zone l.timezone)::date as date,sum(i.total_minor-i.balance_minor)::bigint as revenue_minor
        from invoices i join appointments a on a.id=i.appointment_id join locations l on l.id=a.location_id
        where i.business_id=${context.businessId} and i.created_at>=${from} and i.created_at<${to}
        group by (i.created_at at time zone l.timezone)::date order by date
      `,
      db`
        select e.id,e.display_name,count(a.id)::integer as appointment_count
        from employees e left join appointment_employees assignment
          on assignment.business_id=e.business_id and assignment.employee_id=e.id
        left join appointments a on a.id=assignment.appointment_id
          and a.start_at>=${from} and a.start_at<${to} and a.status='completed'
        where e.business_id=${context.businessId}
        group by e.id order by appointment_count desc
      `,
      db`
        select aps.service_name_snapshot as service,count(*)::integer as performed
        from appointment_services aps join appointments a on a.id=aps.appointment_id
        where aps.business_id=${context.businessId} and a.status='completed'
          and a.start_at>=${from} and a.start_at<${to}
        group by aps.service_name_snapshot order by performed desc
      `
    ]);
    return { localDate, days, from, to, revenue, employees, services: servicesPerformed };
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
