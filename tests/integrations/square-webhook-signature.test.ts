import { readFile } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  handledEventTypes, parseWebhookEnvelope, squareSignature, squareSignatureHeader,
  verifySquareSignature
} from "../../src/integrations/square/webhooks.js";

/**
 * The signature is the only authentication the webhook receiver has.
 *
 * `POST /webhooks/square` cannot be gated on a session, because the caller is Square. What
 * separates a Square notification from anything else on the internet posting to that path is an
 * HMAC over `notificationUrl + rawRequestBody`, keyed with the subscription signature key.
 *
 * The last test in this file is the important one. Fastify's JSON parser hands a route the
 * parsed object and throws the source bytes away, and `JSON.stringify` of that object is not the
 * same bytes back: whitespace, key order, number formatting and unicode escaping all move. So
 * the receiver registers its own parser that keeps the Buffer. Here we feed the verifier a
 * parse-then-stringify round trip of a real payload and require it to FAIL - the day somebody
 * simplifies the raw-body handling, this is what says so.
 *
 * The signing key below is generated in this file and exists only for the length of the run. No
 * Square signature key is stored in this repository.
 */

const fixtureSignatureKey = randomBytes(32).toString("base64");
const notificationUrl = "https://app.pawsh.example/webhooks/square";

let revocationBody: Buffer;
let pairedBody: Buffer;

beforeAll(async () => {
  revocationBody = await readFile("tests/fixtures/square/webhook-oauth-authorization-revoked.json");
  pairedBody = await readFile("tests/fixtures/square/webhook-device-code-paired.json");
});

function sign(body: Buffer, url = notificationUrl, key = fixtureSignatureKey): string {
  return squareSignature({ notificationUrl: url, rawBody: body, signatureKey: key });
}

function verify(input: {
  body: Buffer; signature?: string | undefined; url?: string; key?: string;
}): boolean {
  return verifySquareSignature({
    notificationUrl: input.url ?? notificationUrl,
    rawBody: input.body,
    signature: input.signature,
    signatureKey: input.key ?? fixtureSignatureKey
  });
}

describe("Square webhook signature verification", () => {
  it("names the header Square actually sends", () => {
    expect(squareSignatureHeader).toBe("x-square-hmacsha256-signature");
  });

  it("signs the notification URL and the raw body, URL first and with no separator", () => {
    const expected = createHmac("sha256", fixtureSignatureKey)
      .update(Buffer.concat([Buffer.from(notificationUrl, "utf8"), revocationBody]))
      .digest("base64");
    expect(sign(revocationBody)).toBe(expected);
    // Order matters, and so does the absence of a separator: both alternatives must differ.
    const reversed = createHmac("sha256", fixtureSignatureKey)
      .update(Buffer.concat([revocationBody, Buffer.from(notificationUrl, "utf8")]))
      .digest("base64");
    const separated = createHmac("sha256", fixtureSignatureKey)
      .update(`${notificationUrl}\n${revocationBody.toString("utf8")}`)
      .digest("base64");
    expect(sign(revocationBody)).not.toBe(reversed);
    expect(sign(revocationBody)).not.toBe(separated);
  });

  it("accepts a correctly signed notification", () => {
    expect(verify({ body: revocationBody, signature: sign(revocationBody) })).toBe(true);
    expect(verify({ body: pairedBody, signature: sign(pairedBody) })).toBe(true);
  });

  it("rejects a signature made with a different key", () => {
    const otherKey = randomBytes(32).toString("base64");
    expect(verify({ body: revocationBody, signature: sign(revocationBody, notificationUrl, otherKey) }))
      .toBe(false);
  });

  it("rejects a tampered body", () => {
    const signature = sign(revocationBody);
    const tampered = Buffer.from(revocationBody);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
    expect(verify({ body: tampered, signature })).toBe(false);

    // A body that merely grew - an appended field - is a different body.
    const appended = Buffer.concat([revocationBody, Buffer.from(" ")]);
    expect(verify({ body: appended, signature })).toBe(false);
  });

  it("rejects a notification URL that is not the exact configured string", () => {
    const signature = sign(revocationBody);
    for (const wrong of [
      "https://app.pawsh.example/webhooks/square/",
      "http://app.pawsh.example/webhooks/square",
      "https://app.pawsh.example/webhooks/Square",
      "https://APP.pawsh.example/webhooks/square",
      "https://attacker.example/webhooks/square"
    ]) {
      expect(verify({ body: revocationBody, signature, url: wrong })).toBe(false);
    }
  });

  it("rejects a missing or malformed signature header", () => {
    expect(verify({ body: revocationBody, signature: undefined })).toBe(false);
    expect(verify({ body: revocationBody, signature: "" })).toBe(false);
    expect(verify({ body: revocationBody, signature: "not base64 at all !!!" })).toBe(false);
    // Right alphabet, wrong length: `timingSafeEqual` throws on unequal buffers, so the length
    // check has to come first rather than the comparison.
    expect(verify({ body: revocationBody, signature: Buffer.alloc(16).toString("base64") })).toBe(false);
    expect(verify({ body: revocationBody, signature: Buffer.alloc(64).toString("base64") })).toBe(false);
    expect(verify({ body: revocationBody, signature: `${sign(revocationBody)}AA` })).toBe(false);
  });

  it("rejects a body that has been through JSON.parse and JSON.stringify", () => {
    const signature = sign(revocationBody);
    const roundTripped = Buffer.from(JSON.stringify(JSON.parse(revocationBody.toString("utf8"))), "utf8");
    // The round trip must actually change the bytes, otherwise this test proves nothing.
    expect(roundTripped.equals(revocationBody)).toBe(false);
    // The parsed object is identical; only the bytes differ, and the bytes are what is signed.
    expect(JSON.parse(roundTripped.toString("utf8")))
      .toEqual(JSON.parse(revocationBody.toString("utf8")));
    expect(verify({ body: roundTripped, signature })).toBe(false);
    // Pretty-printing it back is no better: there is no re-serialisation that reproduces bytes.
    const reformatted = Buffer.from(
      `${JSON.stringify(JSON.parse(revocationBody.toString("utf8")), null, 2)}\r\n`, "utf8"
    );
    expect(verify({ body: reformatted, signature })).toBe(false);
  });
});

describe("Square webhook envelopes", () => {
  it("accepts every recorded event body, including the ones this phase does not act on", async () => {
    for (const name of [
      "webhook-oauth-authorization-revoked.json", "webhook-device-code-paired.json",
      "webhook-terminal-checkout-updated.json", "webhook-payment-updated.json"
    ]) {
      const body = await readFile(`tests/fixtures/square/${name}`, "utf8");
      const envelope = parseWebhookEnvelope(JSON.parse(body));
      expect(envelope, name).not.toBeNull();
      expect(envelope!.event_id.length, name).toBeGreaterThan(0);
      expect(envelope!.merchant_id, name).toBe("MLSAMPLE00000001");
    }
  });

  it("refuses a body that cannot be filed", () => {
    const valid = JSON.parse(revocationBody.toString("utf8"));
    // Without an event id there is nothing to dedupe on; without a merchant there is no tenant
    // to resolve later; without a type nothing can ever route it.
    for (const missing of ["event_id", "merchant_id", "type"]) {
      const broken = { ...valid };
      delete broken[missing];
      expect(parseWebhookEnvelope(broken), missing).toBeNull();
    }
    expect(parseWebhookEnvelope(null)).toBeNull();
    expect(parseWebhookEnvelope("a string")).toBeNull();
    expect(parseWebhookEnvelope({ ...valid, event_id: "" })).toBeNull();
  });

  it("handles exactly the event types this integration claims to handle", () => {
    // A list, asserted, so subscribing to a new type in Square's dashboard without writing the
    // handler for it fails here rather than filling the inbox with rows nothing acts on.
    expect([...handledEventTypes]).toEqual([
      "oauth.authorization.revoked", "device.code.paired",
      "terminal.checkout.updated", "payment.updated", "refund.updated"
    ]);
  });
});
