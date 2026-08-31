import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { ZodType } from "zod";
import { describe, expect, it } from "vitest";
import { squareApiVersion } from "../../src/integrations/square/client.js";
import {
  squareDeviceCodePairedEventSchema, squareDeviceCodeResponseSchema, squareErrorBodySchema,
  squareLocationsSchema, squareMerchantSchema, squarePaymentResponseSchema,
  squareRefundEventSchema, squareRefundResponseSchema, squareRevocationEventSchema,
  squareTerminalCheckoutResponseSchema, squareTokenSchema, squareTokenStatusSchema,
  squareWebhookEnvelopeSchema
} from "../../src/integrations/square/schemas.js";

/**
 * The fixtures are only worth having if they still describe Square.
 *
 * Three things drift, and each one turns a green suite into a false report. The bytes can change
 * - somebody edits a payload to make a test pass and the recorded hash no longer matches. The
 * shape can change - a fixture keeps fields production has stopped accepting, so the tests
 * exercise a body the client would reject. And the API version can change - the pinned version
 * moves and every fixture is now a recording of a different API.
 *
 * So: every hash and size is verified, every payload is parsed with the SAME schema objects
 * production parses with, and the manifest's `squareApiVersion` must equal the client's pinned
 * constant. Bumping the version therefore fails CI until the fixtures have been re-reviewed
 * against the new one, which is the point.
 */

const fixtureDirectory = "tests/fixtures/square";

const schemas: Record<string, ZodType> = {
  squareToken: squareTokenSchema,
  squareTokenStatus: squareTokenStatusSchema,
  squareMerchant: squareMerchantSchema,
  squareLocations: squareLocationsSchema,
  squareErrorBody: squareErrorBodySchema,
  squareWebhookEnvelope: squareWebhookEnvelopeSchema,
  squareWebhookRevocation: squareRevocationEventSchema,
  squareWebhookDeviceCodePaired: squareDeviceCodePairedEventSchema,
  squareDeviceCodeResponse: squareDeviceCodeResponseSchema,
  squareTerminalCheckoutResponse: squareTerminalCheckoutResponseSchema,
  squarePaymentResponse: squarePaymentResponseSchema,
  squareRefundResponse: squareRefundResponseSchema,
  squareWebhookRefund: squareRefundEventSchema
};

interface ManifestEntry {
  name: string; sha256: string; size: number; schema: string; expected: string;
}
interface Manifest {
  format: string;
  synthetic: boolean;
  source: string;
  squareApiVersion: string;
  fixtures: ManifestEntry[];
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(`${fixtureDirectory}/fixture-manifest.json`, "utf8")) as Manifest;
}

describe("Square fixtures", () => {
  it("declares itself synthetic, sourced, and captured against the pinned API version", async () => {
    const recorded = await manifest();
    expect(recorded.format).toBe("pawsh-square-fixtures-v1");
    expect(recorded.synthetic).toBe(true);
    expect(recorded.source.length).toBeGreaterThan(40);
    // The assertion that makes a version bump a reviewed change rather than a silent one.
    expect(recorded.squareApiVersion).toBe(squareApiVersion);
  });

  it("matches every recorded hash and size", async () => {
    const recorded = await manifest();
    expect(recorded.fixtures.length).toBeGreaterThan(0);
    for (const entry of recorded.fixtures) {
      const bytes = await readFile(`${fixtureDirectory}/${entry.name}`);
      expect(bytes.byteLength, entry.name).toBe(entry.size);
      expect(createHash("sha256").update(bytes).digest("hex"), entry.name).toBe(entry.sha256);
    }
  });

  it("lists every file in the directory, so nothing arrives unreviewed", async () => {
    const recorded = await manifest();
    const present = (await readdir(fixtureDirectory)).filter((name) => name !== "fixture-manifest.json");
    expect([...present].sort()).toEqual(recorded.fixtures.map((entry) => entry.name).sort());
  });

  it("parses every payload with the schema production uses", async () => {
    const recorded = await manifest();
    for (const entry of recorded.fixtures) {
      const schema = schemas[entry.schema];
      expect(schema, `${entry.name} names an unknown schema: ${entry.schema}`).toBeDefined();
      const payload = JSON.parse(await readFile(`${fixtureDirectory}/${entry.name}`, "utf8"));
      const parsed = schema!.safeParse(payload);
      expect(parsed.success, `${entry.name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("carries no credential-shaped value into the repository", async () => {
    const recorded = await manifest();
    for (const entry of recorded.fixtures) {
      const text = await readFile(`${fixtureDirectory}/${entry.name}`, "utf8");
      // Every token in these files is a placeholder with a visible SAMPLE marker; a real Square
      // token would not be, and a fixture captured from a live account is a credential leak.
      for (const field of ["access_token", "refresh_token"]) {
        const value = JSON.parse(text)[field];
        if (typeof value === "string") expect(value, entry.name).toContain("SAMPLE");
      }
    }
  });
});
