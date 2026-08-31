import { z } from "zod";

/**
 * Every Square response and every Square webhook body, as a schema.
 *
 * Nothing in this integration hands an unparsed body to a caller. A response that arrived with
 * the fields we expected on the day it was written is not the same thing as a response that has
 * them today, and the difference between those two shows up as `undefined` reaching the database
 * unless something refuses it at the boundary. These schemas are that refusal, and the fixture
 * suite parses its recorded bodies with these same objects so a fixture that has drifted from
 * what production accepts fails in CI rather than in a salon.
 *
 * Deliberately not `.strict()`. Square adds fields to responses without warning and an unknown
 * field is not an error - it is a field we have no use for. What matters is that the fields we
 * DO use are present and are the type we think they are.
 */

const identifier = z.string().min(1).max(192);
const timestamp = z.string().min(1).max(64);

export const squareErrorDetailSchema = z.object({
  category: z.string().min(1).max(64),
  code: z.string().min(1).max(96),
  detail: z.string().max(2048).optional(),
  field: z.string().max(256).optional()
});

export const squareErrorBodySchema = z.object({
  errors: z.array(squareErrorDetailSchema).min(1)
});

/**
 * `POST /oauth2/token`, for both the authorization-code exchange and the refresh.
 *
 * There is no `scope` here. The code grant's token response does not report what was granted, so
 * the scopes stored against a connection come from the token-status read below rather than being
 * assumed to equal what we asked for.
 */
export const squareTokenSchema = z.object({
  access_token: z.string().min(1).max(2048),
  token_type: z.string().max(64).optional(),
  expires_at: timestamp.optional(),
  merchant_id: identifier,
  refresh_token: z.string().min(1).max(2048).optional(),
  short_lived: z.boolean().optional()
});

/** `POST /oauth2/token/status` - what the merchant actually granted, as opposed to what we asked. */
export const squareTokenStatusSchema = z.object({
  scopes: z.array(z.string().min(1).max(96)).max(64).optional(),
  expires_at: timestamp.optional(),
  client_id: z.string().max(192).optional(),
  merchant_id: identifier.optional()
});

export const squareMerchantSchema = z.object({
  merchant: z.object({
    id: identifier,
    business_name: z.string().max(512).optional(),
    country: z.string().max(8).optional(),
    language_code: z.string().max(16).optional(),
    currency: z.string().max(8).optional(),
    status: z.string().max(32).optional(),
    main_location_id: z.string().max(192).optional()
  })
});

export const squareLocationsSchema = z.object({
  locations: z.array(z.object({
    id: identifier,
    name: z.string().max(512).optional(),
    status: z.string().max(32).optional(),
    currency: z.string().max(8).optional(),
    timezone: z.string().max(96).optional()
  })).default([])
});

/** An empty JSON object is a valid Square success body; several endpoints return exactly that. */
export const squareEmptySchema = z.object({}).loose();

/**
 * Money, as Square sends it.
 *
 * `amount` is minor units and `currency` is ISO-4217, which is the same pair every column in this
 * schema already stores. It is required rather than optional in both halves: a money object
 * missing its currency is not a smaller amount of information, it is an amount we cannot compare
 * to an invoice, and comparing it anyway is how a USD invoice gets settled in CAD.
 */
export const squareMoneySchema = z.object({
  amount: z.number().int(),
  currency: z.string().length(3)
});

// ---------------------------------------------------------------------------
// Terminal checkouts and payments
//
// The checkout is an intent and the payment is the money, and these two schemas keep that
// distinction legible. A checkout carries `payment_ids`, never amounts we would be tempted to
// post; a payment carries `amount_money`, `tip_money` and `total_money`, and it is the only one
// of the two this integration is allowed to treat as financial fact.
// ---------------------------------------------------------------------------

export const squareTerminalCheckoutSchema = z.object({
  id: identifier,
  amount_money: squareMoneySchema,
  reference_id: z.string().max(40).optional(),
  device_options: z.object({
    device_id: z.string().max(192).optional()
  }).optional(),
  status: z.string().max(32).optional(),
  cancel_reason: z.string().max(64).optional(),
  payment_ids: z.array(identifier).max(32).optional(),
  created_at: timestamp.optional(),
  updated_at: timestamp.optional()
});

export const squareTerminalCheckoutResponseSchema = z.object({
  checkout: squareTerminalCheckoutSchema
});

/**
 * A Square Payment.
 *
 * `amount_money` is the amount that was asked for, `tip_money` is what the customer added on the
 * device, and `total_money` is what the card was actually charged. All three are read, and the
 * reconciler checks Square's own arithmetic across them rather than assuming it: a payment whose
 * total is not its amount plus its tip is not a payment we understand well enough to post.
 *
 * `tip_money` is optional because a customer who left no tip produces no object at all, which is
 * a zero rather than a missing field.
 */
export const squarePaymentSchema = z.object({
  id: identifier,
  status: z.string().max(32).optional(),
  amount_money: squareMoneySchema,
  tip_money: squareMoneySchema.optional(),
  total_money: squareMoneySchema.optional(),
  source_type: z.string().max(32).optional(),
  location_id: z.string().max(192).optional(),
  order_id: z.string().max(192).optional(),
  reference_id: z.string().max(40).optional(),
  terminal_checkout_id: z.string().max(192).optional(),
  /**
   * Square's optimistic-concurrency token for this payment, sent back on `POST /v2/refunds`.
   *
   * Optional because it is Square's to supply and a body without it must still parse, but a
   * refund that has one is a refund Square will refuse if the payment moved underneath us -
   * which is the entire reason to pass it rather than to hope.
   */
  version_token: z.string().max(192).optional(),
  created_at: timestamp.optional(),
  updated_at: timestamp.optional()
});

export const squarePaymentResponseSchema = z.object({
  payment: squarePaymentSchema
});

/**
 * A Square Refund, as `POST /v2/refunds` creates it and `GET /v2/refunds/{id}` reports it.
 *
 * `amount_money` is the whole refund and Square does not split it. It has no idea which part of
 * it was gratuity, because the tip was a component of the original Payment and a refund is just
 * an amount taken back off that Payment. So the service/tip split Pawsh records is a Pawsh
 * decision, stored in `payment_refunds.tip_refunded_minor`, and nothing here is asked about it.
 *
 * `status` is required to be present in neither direction - it is optional here for the same
 * reason every other Square status is, so a body that has stopped carrying it fails at the
 * mapping (which resolves an absent status to "still in flight") rather than at the parse.
 */
export const squareRefundSchema = z.object({
  id: identifier,
  status: z.string().max(32).optional(),
  amount_money: squareMoneySchema,
  payment_id: z.string().max(192).optional(),
  order_id: z.string().max(192).optional(),
  location_id: z.string().max(192).optional(),
  reason: z.string().max(192).optional(),
  created_at: timestamp.optional(),
  updated_at: timestamp.optional()
});

export const squareRefundResponseSchema = z.object({
  refund: squareRefundSchema
});

export const squareRefundEventSchema = z.object({
  data: z.object({
    object: z.object({
      refund: squareRefundSchema
    })
  })
});

export const squareTerminalCheckoutEventSchema = z.object({
  data: z.object({
    object: z.object({
      checkout: squareTerminalCheckoutSchema
    })
  })
});

export const squarePaymentEventSchema = z.object({
  data: z.object({
    object: z.object({
      payment: squarePaymentSchema
    })
  })
});

// ---------------------------------------------------------------------------
// Webhooks
//
// The envelope is what the receiver needs before it can do anything: an id to dedupe on, a
// merchant to resolve a tenant from, and a type to route on. It is parsed strictly enough that a
// body missing any of the three is refused rather than written to the inbox as a row nothing can
// ever process, and loosely enough that an event type we do not handle yet still lands whole.
// ---------------------------------------------------------------------------

export const squareWebhookEnvelopeSchema = z.object({
  merchant_id: z.string().min(1).max(64),
  type: z.string().min(1).max(128),
  event_id: z.string().min(1).max(128),
  created_at: timestamp.optional(),
  data: z.object({
    type: z.string().max(128).optional(),
    id: z.string().max(192).optional(),
    object: z.record(z.string(), z.unknown()).optional()
  }).optional()
});

export const squareRevocationEventSchema = z.object({
  data: z.object({
    object: z.object({
      revocation: z.object({
        revoked_at: timestamp.optional(),
        revoker_type: z.string().max(32).optional()
      })
    })
  })
});

export const squareDeviceCodeSchema = z.object({
  id: identifier,
  code: z.string().max(64).optional(),
  device_id: z.string().max(192).optional(),
  location_id: z.string().max(192).optional(),
  name: z.string().max(256).optional(),
  pair_by: timestamp.optional(),
  product_type: z.string().max(64).optional(),
  status: z.string().max(32).optional(),
  status_changed_at: timestamp.optional(),
  created_at: timestamp.optional()
});

export const squareDeviceCodePairedEventSchema = z.object({
  data: z.object({
    object: z.object({
      device_code: squareDeviceCodeSchema
    })
  })
});

/** `POST /v2/devices/codes` and `GET /v2/devices/codes/{id}` both wrap one device code. */
export const squareDeviceCodeResponseSchema = z.object({
  device_code: squareDeviceCodeSchema
});

export type SquareTokenResponse = z.infer<typeof squareTokenSchema>;
export type SquareTokenStatus = z.infer<typeof squareTokenStatusSchema>;
export type SquareMerchantResponse = z.infer<typeof squareMerchantSchema>;
export type SquareLocationsResponse = z.infer<typeof squareLocationsSchema>;
export type SquareWebhookEnvelope = z.infer<typeof squareWebhookEnvelopeSchema>;
export type SquareDeviceCode = z.infer<typeof squareDeviceCodeSchema>;
export type SquareMoney = z.infer<typeof squareMoneySchema>;
export type SquareTerminalCheckout = z.infer<typeof squareTerminalCheckoutSchema>;
export type SquarePayment = z.infer<typeof squarePaymentSchema>;
export type SquareRefund = z.infer<typeof squareRefundSchema>;
