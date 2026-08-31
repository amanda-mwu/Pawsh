import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database, SqlExecutor } from "../../db/client.js";
import {
  squareDeviceCodePairedEventSchema, squareRevocationEventSchema, squareWebhookEnvelopeSchema,
  type SquareWebhookEnvelope
} from "./schemas.js";
import { markRevoked, type SquareWorkerDependencies } from "./oauth.js";
import { reconcileFromEvent } from "./reconciliation.js";
import { reconcileRefundFromEvent } from "./refunds.js";
import { applyDeviceCodeState } from "./terminal.js";

/**
 * Receiving Square's notifications, and the drain that acts on them.
 *
 * SIGNATURE FIRST, JSON SECOND. The receiver is unauthenticated by session because Square is the
 * caller; the signature is the only thing that says this body came from Square. So it is checked
 * before the body is parsed, before anything is looked up and before anything is written. An
 * invalid signature persists nothing at all: an inbox that stored unverified bodies would be a
 * place anybody on the internet could write rows into, and "we only stored it" stops being
 * reassuring the moment a later phase reads those rows.
 *
 * THE SIGNED STRING IS `notificationUrl + rawRequestBody`, URL FIRST, NO SEPARATOR. Both halves
 * have a trap in them. The URL must be the exact configured subscription string - scheme, host,
 * path and trailing slash as registered - and must never be reassembled from the inbound `Host`
 * header, because whoever sends the request also chooses that header and would then be choosing
 * the string we verify. The body must be the bytes that arrived. Fastify's JSON parser hands a
 * route the parsed object and discards the source, and `JSON.stringify` of that object is not
 * the same bytes: key order, whitespace, unicode escaping and number formatting all move. Any
 * one of those changes the HMAC. That is why the route registers its own content-type parser
 * that keeps the Buffer, and why the unit suite feeds this verifier a parse-then-stringify round
 * trip of a real payload and requires it to FAIL - the test exists to catch the day somebody
 * "tidies up" the raw-body handling.
 *
 * PERSIST AND ACK, RECONCILE LATER. Square expects a prompt 2xx and retries about eleven times
 * over twenty-four hours if it does not get one. Doing the work inline would make our latency
 * Square's retry trigger, and a slow tenant lookup would turn one event into eleven. So the
 * receiver writes a row and answers; the worker decides what the event means. A redelivery of an
 * event we already hold is an acknowledgement, not an error - the unique index on `event_id`
 * settles that in the database rather than in a check-then-insert that two retries could both
 * pass.
 *
 * AN EVENT COMES TO REST IN ONE OF THREE PLACES, AND THEY MEAN DIFFERENT THINGS. `processed` is
 * "we acted on this". `failed` is "something went wrong and we will try again", which is where a
 * notification that arrived before our own checkout row committed waits - retried, never dropped.
 * `parked` is "we saw this, we know it is not ours, and we are deliberately doing nothing": a
 * payment the salon took directly on its own Square account is not a Pawsh ledger event, and
 * neither claiming to have processed it nor retrying it forever would be true.
 *
 * EVENTS WE DO NOT HANDLE ARE STORED, NOT DROPPED. An unrecognised type still lands whole, so the
 * version that first handles it starts with history rather than a gap it cannot explain.
 */

export const squareSignatureHeader = "x-square-hmacsha256-signature";

/** The types this integration acts on. Everything else is recorded and marked processed as a no-op. */
export const handledEventTypes = [
  "oauth.authorization.revoked", "device.code.paired",
  "terminal.checkout.updated", "payment.updated", "refund.updated"
] as const;

export function squareSignature(input: {
  notificationUrl: string;
  rawBody: Buffer;
  signatureKey: string;
}): string {
  return createHmac("sha256", input.signatureKey)
    .update(Buffer.concat([Buffer.from(input.notificationUrl, "utf8"), input.rawBody]))
    .digest("base64");
}

/**
 * Whether this body was signed by Square with our subscription key.
 *
 * Returns false rather than throwing for every failure - missing header, malformed base64,
 * wrong length, wrong key - so the route has one branch and no failure mode can be told apart
 * from another by how it is reported. The comparison is `timingSafeEqual` over equal-length
 * buffers; the length check comes first because `timingSafeEqual` throws on a length mismatch.
 */
export function verifySquareSignature(input: {
  notificationUrl: string;
  rawBody: Buffer;
  signature: string | undefined;
  signatureKey: string;
}): boolean {
  if (!input.signature || typeof input.signature !== "string") return false;
  // Base64 decoding is permissive: it skips characters it cannot read and ignores anything after
  // the padding, so `<valid signature>AA` decodes to the same 32 bytes as the signature itself.
  // Re-encoding and comparing refuses a header that is not exactly the base64 Square sent.
  const supplied = Buffer.from(input.signature, "base64");
  if (supplied.toString("base64") !== input.signature.trim()) return false;
  const expected = Buffer.from(squareSignature({
    notificationUrl: input.notificationUrl,
    rawBody: input.rawBody,
    signatureKey: input.signatureKey
  }), "base64");
  if (supplied.byteLength !== expected.byteLength || expected.byteLength === 0) return false;
  return timingSafeEqual(supplied, expected);
}

export interface WebhookAcceptance {
  /** True when this event id was already in the inbox, which is an acknowledgement. */
  duplicate: boolean;
  eventId: string;
}

/**
 * Writes a verified event to the inbox.
 *
 * `on conflict (event_id) do nothing` is the dedupe. A redelivery reports `duplicate` and the
 * route answers 200, because Square asking twice is Square working correctly.
 */
export async function recordWebhookEvent(
  sql: SqlExecutor,
  input: { envelope: SquareWebhookEnvelope; payload: unknown }
): Promise<WebhookAcceptance> {
  const rows = await sql<{ eventId: string }[]>`
    insert into square_webhook_events (event_id, merchant_id, event_type, payload)
    values (${input.envelope.event_id}, ${input.envelope.merchant_id}, ${input.envelope.type},
      ${sql.json(input.payload as never)})
    on conflict (event_id) do nothing
    returning event_id
  `;
  return { duplicate: rows.length === 0, eventId: input.envelope.event_id };
}

/** Parses the envelope. A body without an id, a merchant and a type cannot be filed at all. */
export function parseWebhookEnvelope(payload: unknown): SquareWebhookEnvelope | null {
  return squareWebhookEnvelopeSchema.safeParse(payload).data ?? null;
}

/**
 * What the drain decided about one event.
 *
 * Three dispositions rather than a boolean, because "we could not do this yet" and "this is not
 * ours to do" are different facts and filing them together is how an inbox fills up with rows
 * nobody can explain. `retry` leaves the row claimable with a backoff; `parked` puts it to rest
 * without ever claiming Pawsh acted on somebody else's payment.
 */
export type WebhookDisposition =
  | { disposition: "processed"; businessIds: string[] }
  | { disposition: "retry"; reason: string }
  | { disposition: "parked"; reason: string; businessIds?: string[] };

/**
 * Acts on received events, claimed exactly as `processOutbox` claims outbox rows.
 *
 * Everything here is idempotent, because Square's retries and our own reprocessing both make
 * "this event again" ordinary. Failures record the reason and back off; they do not abandon the
 * row, because an event we could not process is a thing somebody has to be able to find.
 */
export async function processSquareWebhooks(
  db: Database,
  dependencies: SquareWorkerDependencies
): Promise<number> {
  // `payload::text`, not `payload`. The database client is configured with `postgres.camel`,
  // which camel-cases the keys of a jsonb value on the way out as well as column names - a
  // stored `device_code` comes back as `deviceCode`, and the schemas that parse Square's own
  // vocabulary would stop matching. Reading the document as text and parsing it here returns
  // exactly the bytes the receiver stored.
  const events = await db<{
    id: string; eventId: string; merchantId: string; eventType: string;
    payloadText: string; attempts: number;
  }[]>`
    with claim as (
      select id from square_webhook_events
      where processed_at is null and next_attempt_at <= now()
      order by received_at for update skip locked limit 25
    )
    update square_webhook_events event set
      attempts=event.attempts+1,
      next_attempt_at=now() + interval '10 minutes'
    from claim where event.id=claim.id
    returning event.id, event.event_id, event.merchant_id, event.event_type,
      event.payload::text as payload_text, event.attempts
  `;
  for (const event of events) {
    try {
      const outcome = await applyWebhookEvent(db, {
        eventType: event.eventType,
        merchantId: event.merchantId,
        payload: JSON.parse(event.payloadText),
        attempts: event.attempts,
        dependencies
      });
      if (outcome.disposition === "retry") {
        await db`
          update square_webhook_events set
            status='failed', last_error=${outcome.reason.slice(0, 500)},
            next_attempt_at=now() + least(interval '1 hour',
              interval '1 minute' * power(2, ${event.attempts}))
          where id=${event.id}
        `;
        continue;
      }
      await db`
        update square_webhook_events set
          status=${outcome.disposition === "parked" ? "parked" : "processed"},
          processed_at=now(),
          last_error=${outcome.disposition === "parked" ? outcome.reason.slice(0, 500) : null},
          business_id=coalesce(business_id, ${outcome.businessIds?.[0] ?? null})
        where id=${event.id}
      `;
    } catch (error) {
      await db`
        update square_webhook_events set
          status='failed', last_error=${String(error)},
          next_attempt_at=now() + least(interval '1 hour',
            interval '1 minute' * power(2, ${event.attempts}))
        where id=${event.id}
      `;
    }
  }
  return events.length;
}

/**
 * What one event means, in terms of rows.
 *
 * Returns the businesses it touched, which is also how `business_id` gets filled in on the inbox
 * row: the tenant is a conclusion of processing, not an input to receiving.
 */
export async function applyWebhookEvent(
  db: Database,
  input: {
    eventType: string;
    merchantId: string;
    payload: unknown;
    attempts: number;
    dependencies: SquareWorkerDependencies;
  }
): Promise<WebhookDisposition> {
  if (input.eventType === "oauth.authorization.revoked") {
    const parsed = squareRevocationEventSchema.safeParse(input.payload);
    const revokedAtText = parsed.data?.data.object.revocation.revoked_at;
    const revokedAt = revokedAtText ? new Date(revokedAtText) : null;
    // Keyed on merchant, and applied to every match. This is the one place a merchant id is the
    // right key: Square revokes a merchant's authorisation of this application, not one row of
    // ours, so marking every connection for that merchant revoked is exactly what happened.
    const businessIds = await markRevoked(db, {
      merchantId: input.merchantId,
      environment: input.dependencies.environment,
      revokedAt: revokedAt && !Number.isNaN(revokedAt.getTime()) ? revokedAt : null
    });
    return { disposition: "processed", businessIds };
  }

  if (input.eventType === "device.code.paired") {
    const parsed = squareDeviceCodePairedEventSchema.safeParse(input.payload);
    const deviceCode = parsed.data?.data.object.device_code;
    // A paired notification for a code we never issued is not an error: it belongs to another
    // application, or to a device row that has since been deleted. Nothing to do, and nothing to
    // fail about.
    if (!deviceCode) return { disposition: "processed", businessIds: [] };
    const applied = await applyDeviceCodeState(db, { deviceCode });
    return { disposition: "processed", businessIds: applied ? [applied.businessId] : [] };
  }

  if (input.eventType === "terminal.checkout.updated" || input.eventType === "payment.updated") {
    return reconcileFromEvent(db, input.dependencies, {
      eventType: input.eventType, payload: input.payload, attempts: input.attempts
    });
  }

  if (input.eventType === "refund.updated") {
    // The same discipline as the two above: the event says which refund to look at, and the
    // retrieved Refund says what happened to the money. Nothing is settled from this body.
    return reconcileRefundFromEvent(db, input.dependencies, {
      payload: input.payload, attempts: input.attempts
    });
  }

  // Stored and acknowledged. An event type this integration does not act on is still a fact about
  // the merchant's account, and the version that first handles it should not start with a gap.
  return { disposition: "processed", businessIds: [] };
}
