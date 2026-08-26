import type { Database } from "../db/client.js";
import nodemailer from "nodemailer";
import type { Config } from "../config.js";
import { createHash } from "node:crypto";

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
      (m.is_owner or 'settings.manage'=any(m.permissions)) as default_recipient
    from business_memberships m join users u on u.id=m.user_id
    left join employees e on e.business_id=m.business_id and e.membership_id=m.id and e.active
    where m.business_id=${input.businessId} and m.status='active'
      and (m.is_owner or 'settings.manage'=any(m.permissions) or e.id is not null)
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

export async function deliverNotifications(
  db: Database,
  provider: EmailProvider,
  decryptBody?: (value: string) => string
): Promise<number> {
  const intents = await db<{
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
    customerNotificationStatus: string | null;
  }[]>`
    with claim as (
      select id from notification_intents
      where (
          status in ('pending','failed')
          or (status='sending' and updated_at<now()-interval '10 minutes')
        )
        and scheduled_occurrence<=now() and attempts<5
      order by scheduled_occurrence for update skip locked limit 25
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
      (select customer_intent.status from notification_intents customer_intent
        where customer_intent.business_id=intent.business_id
          and customer_intent.appointment_id=intent.appointment_id
          and customer_intent.notification_type='rabies_expiration_customer'
        order by customer_intent.created_at desc limit 1) as customer_notification_status
  `;
  for (const intent of intents) {
    const attempt = intent.attempts;
    try {
      const when = intent.startAt && intent.timezone
        ? new Intl.DateTimeFormat("en-US", {
          timeZone: intent.timezone, dateStyle: "full", timeStyle: "short"
        }).format(intent.startAt)
        : null;
      const expiration=intent.expirationDate ? new Intl.DateTimeFormat("en-US",{dateStyle:"long",timeZone:"UTC"})
        .format(new Date(`${intent.expirationDate}T12:00:00.000Z`)) : "the recorded date";
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
