import type { Database } from "../db/client.js";
import { hasEffectivePermission } from "../db/effective-permissions.js";
import nodemailer from "nodemailer";
import type { Config } from "../config.js";
import { createHash } from "node:crypto";
import {
  dateTimePreferences, formatPreferredDateTime, formatPreferredLocalDate
} from "../domain/date-format.js";

const RABIES_CUSTOMER="rabies_expiration_customer";
const RABIES_STAFF="rabies_expiration_staff";

function dateOnly(value:string|Date|null):string|null {
  if(value===null)return null;
  return value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10);
}

function materialKey(parts: readonly (string|null)[]): string {
  return `rabies:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

export async function reconcileRabiesNotifications(
  db: Database,
  input: {businessId:string;appointmentId?:string;petId?:string}
): Promise<number> {
  const appointments=await db<{
    id:string;customerId:string;petId:string;employeeIds:string[];localDate:string|Date;
    expirationDate:string|Date|null;requiresNotification:boolean;
    email:string|null;emailAllowed:boolean;
  }[]>`
    select a.id,a.customer_id,a.pet_id,
      array(select employee_id from appointment_employees where appointment_id=a.id order by employee_id) as employee_ids,
      a.scheduled_local_start::date::text as local_date,
      p.vaccination_expires_on::text as expiration_date,
      (p.vaccination_expires_on is not null
        and p.vaccination_expires_on < a.scheduled_local_start::date) as requires_notification,
      c.email,c.email_allowed
    from appointments a
    join pets p on p.business_id=a.business_id and p.id=a.pet_id
    join customers c on c.business_id=a.business_id and c.id=a.customer_id
    join locations l on l.business_id=a.business_id and l.id=a.location_id
    where a.business_id=${input.businessId} and a.status='scheduled'
      and (${input.appointmentId??null}::uuid is null or a.id=${input.appointmentId??null}::uuid)
      and (${input.petId??null}::uuid is null or a.pet_id=${input.petId??null}::uuid)
      and a.start_at>now()
    order by a.start_at,a.id limit 200
  `;
  const availableStaff=await db<{membershipId:string;email:string;employeeId:string|null;defaultRecipient:boolean}[]>`
    select distinct m.id as membership_id,u.email,e.id as employee_id,
      ${hasEffectivePermission(db,"m","settings.manage")} as default_recipient
    from business_memberships m join users u on u.id=m.user_id
    left join employees e on e.business_id=m.business_id and e.membership_id=m.id and e.active
    where m.business_id=${input.businessId} and m.status='active'
      and (${hasEffectivePermission(db,"m","settings.manage")} or e.id is not null)
    order by m.id,e.id limit 100`;
  let created=0;
  for(const appointment of appointments) {
    const localDate=dateOnly(appointment.localDate)!;
    const expirationDate=dateOnly(appointment.expirationDate);
    const invalid=appointment.requiresNotification;
    if(!invalid) {
      await db`update notification_intents set status='cancelled',resolved_at=now(),updated_at=now()
        where business_id=${input.businessId} and appointment_id=${appointment.id}
          and notification_type in (${RABIES_CUSTOMER},${RABIES_STAFF})
          and status in ('pending','failed','suppressed')`;
      continue;
    }
    const customerKey=materialKey([input.businessId,appointment.id,appointment.customerId,
      RABIES_CUSTOMER,localDate,expirationDate,"email",appointment.email]);
    await db`update notification_intents set status='cancelled',resolved_at=now(),updated_at=now()
      where business_id=${input.businessId} and appointment_id=${appointment.id}
        and notification_type=${RABIES_CUSTOMER} and material_key<>${customerKey}
        and status in ('pending','failed','suppressed')`;
    const customerStatus=appointment.email && appointment.emailAllowed ? "pending" : "suppressed";
    const customerRows=await db`
      insert into notification_intents
        (business_id,appointment_id,customer_id,notification_type,scheduled_occurrence,channel,
         destination,status,recipient_kind,material_key)
      values (${input.businessId},${appointment.id},${appointment.customerId},${RABIES_CUSTOMER},now(),'email',
        ${customerStatus === "pending" ? appointment.email : null},${customerStatus},'customer',${customerKey})
      on conflict do nothing returning id`;
    created+=customerRows.length;

    const recipients=[...new Map(availableStaff
      .filter((recipient)=>recipient.defaultRecipient || (recipient.employeeId!==null&&appointment.employeeIds.includes(recipient.employeeId)))
      .map((recipient)=>[recipient.membershipId,recipient])).values()].slice(0,25);
    for(const recipient of recipients) {
      const staffKey=materialKey([input.businessId,appointment.id,recipient.membershipId,
        RABIES_STAFF,localDate,expirationDate,"email"]);
      await db`update notification_intents set status='cancelled',resolved_at=now(),updated_at=now()
        where business_id=${input.businessId} and appointment_id=${appointment.id}
          and notification_type=${RABIES_STAFF} and recipient_membership_id=${recipient.membershipId}
          and material_key<>${staffKey} and status in ('pending','failed')`;
      const staffRows=await db`
        insert into notification_intents
          (business_id,appointment_id,customer_id,notification_type,scheduled_occurrence,channel,
           destination,status,recipient_kind,recipient_membership_id,material_key)
        values (${input.businessId},${appointment.id},${appointment.customerId},${RABIES_STAFF},now(),'email',
          ${recipient.email},'pending','staff',${recipient.membershipId},${staffKey})
        on conflict do nothing returning id`;
      created+=staffRows.length;
    }
  }
  return created;
}

export interface EmailMessage {
  idempotencyKey: string;
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<{ providerReference: string }>;
}

export class LogEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<{ providerReference: string }> {
    // Development adapter intentionally excludes message content from logs.
    console.info(JSON.stringify({ event: "email.accepted", idempotencyKey: message.idempotencyKey }));
    return { providerReference: `log:${message.idempotencyKey}` };
  }
}

export class SmtpEmailProvider implements EmailProvider {
  private readonly transport;
  constructor(private readonly config: Config) {
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined
    });
  }
  async send(message: EmailMessage): Promise<{ providerReference: string }> {
    if (!this.config.EMAIL_FROM) throw new Error("EMAIL_FROM is required");
    const result = await this.transport.sendMail({
      from: this.config.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      headers: { "X-Pawsh-Idempotency-Key": message.idempotencyKey }
    });
    return { providerReference: result.messageId };
  }
}

export async function processOutbox(db: Database): Promise<number> {
  const events = await db<{
    id: string;
    businessId: string;
    eventType: string;
    resourceId: string | null;
    occurredAt: Date;
  }[]>`
    with claim as (
      select id from outbox_events
      where processed_at is null and next_attempt_at<=now()
      order by occurred_at for update skip locked limit 25
    )
    update outbox_events event set
      attempts=event.attempts+1,
      next_attempt_at=now()+interval '10 minutes'
    from claim where event.id=claim.id
    returning event.id,event.business_id,event.event_type,event.resource_id,event.occurred_at
  `;
  for (const event of events) {
    try {
      if (["AppointmentCreated", "AppointmentUpdated", "AppointmentCancelled"].includes(event.eventType) && event.resourceId) {
        const [target] = await db<{
          customerId: string;
          email: string | null;
          emailAllowed: boolean;
          startAt: Date;
          reminderLeadMinutes: number;
        }[]>`
          select a.customer_id, c.email, c.email_allowed, a.start_at, b.reminder_lead_minutes
          from appointments a
          join customers c on c.id=a.customer_id
          join businesses b on b.id=a.business_id
          where a.business_id=${event.businessId} and a.id=${event.resourceId}
        `;
        if (target?.email && target.emailAllowed) {
          if (event.eventType === "AppointmentCreated") {
            await db`
              insert into notification_intents
                (business_id, appointment_id, customer_id, notification_type,
                 scheduled_occurrence, channel, destination)
              values
                (${event.businessId}, ${event.resourceId}, ${target.customerId}, 'appointment_confirmation',
                 now(), 'email', ${target.email}),
                (${event.businessId}, ${event.resourceId}, ${target.customerId}, 'appointment_reminder',
                 ${new Date(target.startAt.getTime() - target.reminderLeadMinutes * 60_000)}, 'email', ${target.email})
              on conflict do nothing
            `;
          } else if (event.eventType === "AppointmentUpdated") {
            await db`
              delete from notification_intents
              where business_id=${event.businessId} and appointment_id=${event.resourceId}
                and notification_type='appointment_reminder' and status in ('pending','failed','cancelled')
            `;
            await db`
              insert into notification_intents
                (business_id,appointment_id,customer_id,notification_type,
                 scheduled_occurrence,channel,destination)
              values (${event.businessId},${event.resourceId},${target.customerId},'appointment_reminder',
                ${new Date(target.startAt.getTime()-target.reminderLeadMinutes*60_000)},'email',${target.email})
              on conflict do nothing
            `;
          } else {
            await db`
              update notification_intents set status='cancelled', updated_at=now()
              where business_id=${event.businessId} and appointment_id=${event.resourceId}
                and notification_type='appointment_reminder' and status='pending'
            `;
            await db`
              insert into notification_intents
                (business_id, appointment_id, customer_id, notification_type,
                 scheduled_occurrence, channel, destination)
              values
                (${event.businessId}, ${event.resourceId}, ${target.customerId},
                 'appointment_cancellation', now(), 'email', ${target.email})
              on conflict do nothing
            `;
          }
        }
      }
      if(["AppointmentCreated","AppointmentUpdated"].includes(event.eventType) && event.resourceId) {
        await reconcileRabiesNotifications(db,{businessId:event.businessId,appointmentId:event.resourceId});
      } else if(event.eventType === "RabiesComplianceUpdated" && event.resourceId) {
        await reconcileRabiesNotifications(db,{businessId:event.businessId,petId:event.resourceId});
      }
      await db`update outbox_events set processed_at=now(),last_error=null where id=${event.id}`;
    } catch (error) {
      await db`
        update outbox_events set last_error=${String(error)},
          next_attempt_at=now() + least(interval '1 hour', interval '1 minute' * power(2, attempts))
        where id=${event.id}
      `;
    }
  }
  return events.length;
}

/**
 * One tick's total send budget, and the share of it a first attempt can always take.
 *
 * `order by scheduled_occurrence` ALONE IS NOT A TOTAL ORDER, AND THAT IS THE DEFECT. Almost
 * every intent in this table is written with `scheduled_occurrence` of `now()` - the rabies
 * pair, the appointment confirmation and cancellation, the workspace access request, the
 * password reset, the agreement request, the report card - and rows written in one transaction
 * share one transaction timestamp exactly. Once more than `notificationDeliveryBatch` of them are
 * eligible, WHICH ones the tick claims is decided by whatever order the executor happens to
 * return equal keys in, and nothing about that is stable between two runs of the same query. A
 * particular intent therefore had no progress guarantee at all inside a burst: it could be
 * skipped over indefinitely while its tied peers were delivered around it. The intermittent
 * failure in the rabies suite was exactly this - two intents that mattered, thirty-four tied
 * peers, and a twenty-five row window whose membership was a coin toss.
 *
 * THE ORDER IS NOW TOTAL, AND ITS MIDDLE KEY IS THE ONE THE CLAIM ACTUALLY MOVES.
 * `scheduled_occurrence` stays the leading key because it is a PRODUCT fact - when the
 * notification is due to go out, computed from the appointment for a reminder - and it is also
 * part of `unique_appointment_notification`, so it is not a retry schedule and must never be
 * rewritten as one. `updated_at` is what the claim advances, so within a tie it demotes a row
 * that has just been attempted below the peers that have not: every tied row is claimed before
 * any of them is claimed twice. `id` last makes the order total, which is what removes the
 * arbitrariness rather than merely reducing it. All three columns are the ones
 * `notification_delivery_claim` is already built on - this claim finally plans the way 0001 said
 * it would.
 *
 * AND A RESERVE, FOR THE SAME REASON THE SQUARE DRAINS HAVE ONE. Ordering makes the wait bounded;
 * it does not make it short. A backlog of intents that are failing and being retried is claimed
 * ahead of anything created since, and while `attempts<5` does eventually retire each of them,
 * the number of ticks that takes grows with the size of the backlog. `attempts = 0` is exactly
 * "nothing has tried to send this yet", so reserving part of the budget for those rows gives a
 * newly created notification a claim on the first tick after it is due, whatever is queued in
 * front of it.
 *
 * THE LANES CANNOT CLAIM THE SAME ROW, for two independent reasons rather than one: the reserve's
 * own UPDATE moves the row to `attempts = 1`, which leaves the reserve's predicate, and to
 * `status='sending'` with `updated_at=now()`, which leaves the eligible set entirely for the next
 * ten minutes. That is the same fence that already stopped two consecutive ticks claiming one
 * row, and it is what keeps this a change of ORDER and BUDGET only - no intent is sent twice, no
 * intent is dropped, `attempts<5` still retires one for good, and `cancelled`, `suppressed` and
 * `sent` remain as invisible to the claim as they have always been.
 */
export const notificationDeliveryBatch = 25;
export const notificationFirstAttemptReserve = 10;

interface ClaimedNotificationIntent {
  id: string;
  businessId: string;
  destination: string | null;
  notificationType: string;
  attempts: number;
  encryptedBody: string | null;
  startAt: Date | null;
  timezone: string | null;
  businessName: string | null;
  petName: string | null;
  customerName: string | null;
  expirationDate: string | null;
  businessPhone: string | null;
  businessEmail: string | null;
  dateFormat: string | null;
  hourFormat: string | null;
  customerNotificationStatus: string | null;
}

/**
 * Takes one lane's worth of due intents.
 *
 * One function rather than two near-identical queries: the lanes differ only in which rows they
 * may see, and the claim itself - `for update skip locked`, the move to `sending`, the attempt
 * increment, and the long list of columns the message bodies are rendered from - is the part
 * that must never drift between them.
 */
async function claimNotificationIntents(
  db: Database,
  input: { lane: "first-attempt" | "due"; limit: number }
): Promise<ClaimedNotificationIntent[]> {
  if (input.limit <= 0) return [];
  const restriction = input.lane === "first-attempt" ? db`and due.attempts=0` : db`and true`;
  return db<ClaimedNotificationIntent[]>`
    with claim as (
      select due.id from notification_intents due
      where (
          due.status in ('pending','failed')
          or (due.status='sending' and due.updated_at<now()-interval '10 minutes')
        )
        and due.scheduled_occurrence<=now() and due.attempts<5
        ${restriction}
      order by due.scheduled_occurrence, due.updated_at, due.id
      for update skip locked limit ${input.limit}
    )
    update notification_intents intent set
      status='sending',attempts=intent.attempts+1,updated_at=now()
    from claim where intent.id=claim.id
    returning intent.id,intent.business_id,intent.destination,intent.notification_type,intent.attempts,
      intent.encrypted_body,
      (select appointment.start_at from appointments appointment where appointment.id=intent.appointment_id) as start_at,
      (select appointment.scheduling_timezone from appointments appointment where appointment.id=intent.appointment_id) as timezone,
      (select business.name from businesses business where business.id=intent.business_id) as business_name,
      (select pet.name from appointments appointment join pets pet on pet.id=appointment.pet_id where appointment.id=intent.appointment_id) as pet_name,
      (select concat_ws(' ',customer.first_name,customer.last_name) from appointments appointment
        join customers customer on customer.id=appointment.customer_id where appointment.id=intent.appointment_id) as customer_name,
      (select pet.vaccination_expires_on::text from appointments appointment
        join pets pet on pet.id=appointment.pet_id where appointment.id=intent.appointment_id) as expiration_date,
      (select business.phone from businesses business where business.id=intent.business_id) as business_phone,
      (select business.email from businesses business where business.id=intent.business_id) as business_email,
      (select business.date_format from businesses business where business.id=intent.business_id) as date_format,
      (select business.hour_format from businesses business where business.id=intent.business_id) as hour_format,
      (select customer_intent.status from notification_intents customer_intent
        where customer_intent.business_id=intent.business_id
          and customer_intent.appointment_id=intent.appointment_id
          and customer_intent.notification_type='rabies_expiration_customer'
        order by customer_intent.created_at desc limit 1) as customer_notification_status
  `;
}

/**
 * Sends what is due, and records what happened to each attempt.
 *
 * The tick's budget is claimed in two passes - see `notificationDeliveryBatch` - so that a
 * backlog of retrying intents cannot hold up one that has just become due. Nothing below the
 * claim knows which lane a row came from, and the return value is still the number of intents
 * this tick claimed.
 */
export async function deliverNotifications(
  db: Database,
  provider: EmailProvider,
  decryptBody?: (value: string) => string
): Promise<number> {
  const first = await claimNotificationIntents(db, {
    lane: "first-attempt", limit: notificationFirstAttemptReserve
  });
  const intents = first.concat(await claimNotificationIntents(db, {
    lane: "due", limit: notificationDeliveryBatch - first.length
  }));
  for (const intent of intents) {
    const attempt = intent.attempts;
    try {
      // The workspace's chosen date order and clock, not the `en-US` locale these hard-coded.
      // These bodies are what a client actually receives for an appointment confirmation, a
      // reminder, a cancellation and both rabies notices, so a date-format setting that did not
      // reach here would be a setting that changes nothing a client ever sees.
      const preferences = dateTimePreferences(intent);
      const when = intent.startAt && intent.timezone
        ? formatPreferredDateTime(intent.startAt, intent.timezone, preferences)
        : null;
      // `vaccination_expires_on` is a `date`, and the noon-UTC anchoring this used to need was
      // only ever a way to survive being passed through an instant formatter. A calendar date has
      // no time zone to be shifted by, so it is reordered directly.
      const expiration = intent.expirationDate
        ? formatPreferredLocalDate(intent.expirationDate, preferences) : "the recorded date";
      const contact=intent.businessPhone??intent.businessEmail??intent.businessName??"the business";
      const generated=intent.notificationType===RABIES_CUSTOMER
        ? `Your pet ${intent.petName??"pet"} is scheduled for ${when??"an upcoming appointment"}. The rabies vaccination information we have expires on ${expiration}, so it will not be current for the appointment. Please provide updated rabies information before the visit or contact ${intent.businessName??"the business"} at ${contact}.`
        : intent.notificationType===RABIES_STAFF
          ? `${intent.petName??"The pet"}'s rabies vaccination expires on ${expiration}, before the appointment scheduled for ${when??"an upcoming date"}. Updated rabies information is required. Customer notification status: ${intent.customerNotificationStatus??"unknown"}.`
          : `${intent.businessName ?? "Your salon"}: ${intent.petName ?? "Your pet"} has an appointment update${when ? ` for ${when}` : ""}.`;
      const body = intent.encryptedBody ? decryptBody?.(intent.encryptedBody) : generated;
      if (!body) throw new Error("Notification body cannot be decrypted");
      if(!intent.destination) throw new Error("Notification destination is unavailable");
      const result = await provider.send({
        idempotencyKey: intent.id,
        to: intent.destination,
        subject: intent.notificationType === "password_reset" ? "Reset your Pawsh password"
          : intent.notificationType === "workspace_access_request" ? "Pawsh workspace access requested"
          : intent.notificationType === "workspace_access_approved" ? "Your Pawsh workspace request was approved"
          : intent.notificationType === RABIES_CUSTOMER ? "Updated rabies information needed"
          : intent.notificationType === RABIES_STAFF ? "Rabies information needs attention"
          : intent.notificationType === "agreement_signature_request" ? "Please review your agreement"
          : intent.notificationType === "report_card" ? `How ${intent.petName ?? "your pet"} got on today`
          : intent.notificationType === "appointment_reminder" ? "Upcoming Pawsh appointment"
          : intent.notificationType === "appointment_cancellation" ? "Pawsh appointment cancelled"
          : "Pawsh appointment confirmation",
        text: body
      });
      await db.begin(async (tx) => {
        await tx`
          insert into notification_delivery_attempts
            (business_id, notification_intent_id, attempt_number, outcome, provider_reference)
          values (${intent.businessId}, ${intent.id}, ${attempt}, 'sent', ${result.providerReference})
          on conflict do nothing
        `;
        await tx`
          update notification_intents set status='sent', provider_message_id=${result.providerReference},
            updated_at=now() where id=${intent.id}
        `;
      });
    } catch (error) {
      await db`
        insert into notification_delivery_attempts
          (business_id, notification_intent_id, attempt_number, outcome, error)
        values (${intent.businessId}, ${intent.id}, ${attempt}, 'failed', ${String(error)})
        on conflict do nothing
      `;
      await db`
        update notification_intents set status='failed', last_error=${String(error)}, updated_at=now()
        where id=${intent.id}
      `;
    }
  }
  return intents.length;
}
