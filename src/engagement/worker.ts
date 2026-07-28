import type { Database } from "../db/client.js";
import nodemailer from "nodemailer";
import type { Config } from "../config.js";

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
    destination: string;
    notificationType: string;
    attempts: number;
    encryptedBody: string | null;
    startAt: Date | null;
    timezone: string | null;
    businessName: string | null;
    petName: string | null;
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
      (select location.timezone from appointments appointment join locations location on location.id=appointment.location_id where appointment.id=intent.appointment_id) as timezone,
      (select business.name from businesses business where business.id=intent.business_id) as business_name,
      (select pet.name from appointments appointment join pets pet on pet.id=appointment.pet_id where appointment.id=intent.appointment_id) as pet_name
  `;
  for (const intent of intents) {
    const attempt = intent.attempts;
    try {
      const when = intent.startAt && intent.timezone
        ? new Intl.DateTimeFormat("en-US", {
          timeZone: intent.timezone, dateStyle: "full", timeStyle: "short"
        }).format(intent.startAt)
        : null;
      const body = intent.encryptedBody
        ? decryptBody?.(intent.encryptedBody)
        : `${intent.businessName ?? "Your salon"}: ${intent.petName ?? "Your pet"} has an appointment update${when ? ` for ${when}` : ""}.`;
      if (!body) throw new Error("Notification body cannot be decrypted");
      const result = await provider.send({
        idempotencyKey: intent.id,
        to: intent.destination,
        subject: intent.notificationType === "password_reset" ? "Reset your Pawsh password"
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
