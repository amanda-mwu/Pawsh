import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  IntegrationEncryptionError, IntegrationKeyring
} from "../../src/security/integration-encryption.js";
import { openSecret } from "../../src/security/secrets.js";

/**
 * The key that opens a salon's Square credentials.
 *
 * A refresh token from the authorization-code flow does not expire and does not rotate, so
 * whatever is sealed under this key is a standing authorisation to take money for as long as the
 * salon stays connected. These tests hold the four properties that follow from that: the key is
 * independent of `SESSION_SECRET`, a rotation does not strand what the old key sealed, a
 * ciphertext moved into another business's row does not open, and nothing anywhere falls back to
 * returning the stored bytes when it cannot decrypt them.
 */

const keyOne = randomBytes(32).toString("base64");
const keyTwo = randomBytes(32).toString("base64");
const context = { businessId: "11111111-1111-4111-8111-111111111111", table: "square_connections", column: "refresh_token" };
const otherBusiness = { ...context, businessId: "22222222-2222-4222-8222-222222222222" };

const sessionSecret = "session-secret-exactly-32-chars!";
const baseEnvironment = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://localhost/pawsh",
  SESSION_SECRET: sessionSecret,
  APP_ORIGIN: "http://127.0.0.1:3000",
  DOCUMENT_STORAGE_ADAPTER: "filesystem",
  DOCUMENT_STORAGE_PATH: ".documents"
};

function ring(keys: string, active: string): IntegrationKeyring {
  return IntegrationKeyring.parse(keys, active);
}

describe("integration credential encryption", () => {
  it("round-trips a sealed value", () => {
    const keyring = ring(`1:${keyOne}`, "1");
    const sealed = keyring.seal("EQAAsquare-refresh-token", context);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.value).not.toContain("EQAAsquare-refresh-token");
    expect(keyring.open(sealed.value, context)).toBe("EQAAsquare-refresh-token");
    // A fresh nonce every time: two seals of one value must not be the same bytes.
    expect(keyring.seal("EQAAsquare-refresh-token", context).value).not.toBe(sealed.value);
  });

  it("carries the key version outside the ciphertext so no reader has to guess", () => {
    const keyring = ring(`1:${keyOne},2:${keyTwo}`, "2");
    const sealed = keyring.seal("token", context);
    expect(sealed.value.startsWith("v2.")).toBe(true);
    expect(IntegrationKeyring.envelopeVersion(sealed.value)).toBe(2);
  });

  it("still opens a value sealed under v1 after rotating to v2", () => {
    const beforeRotation = ring(`1:${keyOne}`, "1");
    const sealedUnderOne = beforeRotation.seal("standing-authorisation", context);

    const afterRotation = ring(`1:${keyOne},2:${keyTwo}`, "2");
    expect(afterRotation.activeVersion).toBe(2);
    expect(afterRotation.versions).toEqual([1, 2]);
    // The old value still opens...
    expect(afterRotation.open(sealedUnderOne.value, context)).toBe("standing-authorisation");
    // ...and new values are sealed under the active key, which is what `key_version` records so
    // a retirement check can find the rows still resting on the old one.
    expect(afterRotation.seal("standing-authorisation", context).keyVersion).toBe(2);
  });

  it("refuses an unknown key version instead of trying every key", () => {
    const keyring = ring(`2:${keyTwo}`, "2");
    const sealedUnderOne = ring(`1:${keyOne}`, "1").seal("token", context).value;
    expect(() => keyring.open(sealedUnderOne, context)).toThrow(IntegrationEncryptionError);
    try {
      keyring.open(sealedUnderOne, context);
      expect.unreachable("an unknown key version must not open");
    } catch (error) {
      expect((error as IntegrationEncryptionError).code).toBe("unknown_key_version");
    }
  });

  it("fails the authentication tag under the wrong key", () => {
    const sealed = ring(`1:${keyOne}`, "1").seal("token", context).value;
    const impostor = ring(`1:${keyTwo}`, "1");
    try {
      impostor.open(sealed, context);
      expect.unreachable("a value must not open under another key");
    } catch (error) {
      expect((error as IntegrationEncryptionError).code).toBe("authentication_failed");
    }
  });

  it("rejects a tampered ciphertext, nonce and tag", () => {
    const keyring = ring(`1:${keyOne}`, "1");
    const sealed = keyring.seal("a-very-real-refresh-token", context).value;
    const [prefix, blob] = sealed.split(".") as [string, string];
    for (const index of [0, 12, 28, Buffer.from(blob, "base64url").byteLength - 1]) {
      const packed = Buffer.from(blob, "base64url");
      packed[index] = packed[index]! ^ 1;
      expect(() => keyring.open(`${prefix}.${packed.toString("base64url")}`, context))
        .toThrow(IntegrationEncryptionError);
    }
  });

  it("rejects a truncated or non-canonical envelope", () => {
    const keyring = ring(`1:${keyOne}`, "1");
    expect(() => keyring.open("", context)).toThrow(IntegrationEncryptionError);
    expect(() => keyring.open("v1.", context)).toThrow(IntegrationEncryptionError);
    expect(() => keyring.open(`v1.${Buffer.alloc(20).toString("base64url")}`, context))
      .toThrow(IntegrationEncryptionError);
    // No version prefix at all: the shape `secrets.ts` produces must not be mistaken for ours.
    expect(() => keyring.open(Buffer.alloc(64).toString("base64url"), context))
      .toThrow(IntegrationEncryptionError);
  });

  it("refuses a ciphertext lifted into another business's row", () => {
    const keyring = ring(`1:${keyOne}`, "1");
    const sealed = keyring.seal("another-salon-refresh-token", context).value;
    // Same key, same ciphertext, same column - only the tenant differs, and that is enough.
    try {
      keyring.open(sealed, otherBusiness);
      expect.unreachable("a ciphertext must not decrypt in another business's row");
    } catch (error) {
      expect((error as IntegrationEncryptionError).code).toBe("authentication_failed");
    }
    // The same discipline across columns: an access token pasted over a refresh token fails too.
    expect(() => keyring.open(sealed, { ...context, column: "access_token" }))
      .toThrow(IntegrationEncryptionError);
  });

  it("rejects malformed key material rather than accepting a short key", () => {
    expect(() => ring("", "1")).toThrow(IntegrationEncryptionError);
    expect(() => ring(`${keyOne}`, "1")).toThrow(IntegrationEncryptionError);
    expect(() => ring(`1:${randomBytes(16).toString("base64")}`, "1")).toThrow(IntegrationEncryptionError);
    expect(() => ring(`1:${keyOne}`, "2")).toThrow(IntegrationEncryptionError);
    expect(() => ring(`1:${keyOne},1:${keyTwo}`, "1")).toThrow(IntegrationEncryptionError);
    expect(() => ring(`0:${keyOne}`, "0")).toThrow(IntegrationEncryptionError);
  });
});

/**
 * This block is the guard, not a demonstration.
 *
 * It fails if the integration key is ever the session secret, or the obvious derivation of it -
 * the SHA-256 that `secrets.ts` itself performs - or if this module ever learns the name
 * `SESSION_SECRET` at all. The failure it prevents is quiet: one leaked value would open both
 * the cookie signing and every salon's standing payment authorisation, and nothing in a passing
 * test suite would have said so.
 */
describe("integration keys are independent of SESSION_SECRET", () => {
  it("refuses a key that is the session secret", () => {
    const derived = Buffer.from(sessionSecret, "utf8").toString("base64");
    expect(Buffer.from(sessionSecret, "utf8").byteLength).toBe(32);
    expect(() => loadConfig({
      ...baseEnvironment,
      PAWSH_INTEGRATION_ENCRYPTION_KEYS: `1:${derived}`,
      PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE: "1"
    })).toThrow(/must not be SESSION_SECRET or derived from it/);
  });

  it("refuses a key derived from the session secret by hashing", () => {
    const derived = createHash("sha256").update(sessionSecret).digest("base64");
    expect(() => loadConfig({
      ...baseEnvironment,
      PAWSH_INTEGRATION_ENCRYPTION_KEYS: `1:${derived}`,
      PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE: "1"
    })).toThrow(/must not be SESSION_SECRET or derived from it/);
    // Also when it is merely one of several keys on the ring.
    expect(() => loadConfig({
      ...baseEnvironment,
      PAWSH_INTEGRATION_ENCRYPTION_KEYS: `1:${keyOne},2:${derived}`,
      PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE: "1"
    })).toThrow(/must not be SESSION_SECRET or derived from it/);
  });

  it("accepts independent key material", () => {
    const config = loadConfig({
      ...baseEnvironment,
      PAWSH_INTEGRATION_ENCRYPTION_KEYS: `1:${keyOne},2:${keyTwo}`,
      PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE: "2"
    });
    expect(config.PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE).toBe("2");
  });

  it("never mentions the session secret in the module that holds the keys", async () => {
    const source = await readFile("src/security/integration-encryption.ts", "utf8");
    // Comments stripped: the module's own documentation explains why the keys are separate from
    // the session secret, and naming it there is the explanation. What must not exist is a line
    // of code that reads it, hashes it, or falls back to it.
    const code = source
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/\/\/.*/g, "");
    expect(code).not.toContain("SESSION_SECRET");
    expect(code).not.toContain("sessionSecret");
    // `config.ts` may name it - that is where the guard above lives - but only to refuse it.
    const config = await readFile("src/config.ts", "utf8");
    expect(config).toContain("must not be SESSION_SECRET or derived from it");
  });

  it("does not produce values the session-secret sealer can open", () => {
    const keyring = ring(`1:${keyOne}`, "1");
    const sealed = keyring.seal("refresh-token", context).value;
    expect(() => openSecret(sealed, sessionSecret)).toThrow();
    expect(() => openSecret(sealed.slice(3), sessionSecret)).toThrow();
  });

  it("requires the keyring in production and leaves it optional elsewhere", () => {
    const production = {
      ...baseEnvironment,
      NODE_ENV: "production",
      APP_ORIGIN: "https://app.pawsh.example",
      SMTP_HOST: "smtp.example",
      EMAIL_FROM: "hello@pawsh.example",
      DOCUMENT_STORAGE_ADAPTER: "s3",
      DOCUMENT_STORAGE_BUCKET: "pawsh-private",
      DOCUMENT_STORAGE_REGION: "us-west-2"
    };
    expect(() => loadConfig(production)).toThrow(/PAWSH_INTEGRATION_ENCRYPTION_KEYS/);
    expect(loadConfig({
      ...production,
      PAWSH_INTEGRATION_ENCRYPTION_KEYS: `1:${keyOne}`,
      PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE: "1"
    }).NODE_ENV).toBe("production");
    // Absent outside production, the feature is unavailable rather than the process refusing.
    expect(loadConfig(baseEnvironment).PAWSH_INTEGRATION_ENCRYPTION_KEYS).toBeUndefined();
  });

  it("refuses a keyring without an active version, and an active version with no keyring", () => {
    expect(() => loadConfig({
      ...baseEnvironment, PAWSH_INTEGRATION_ENCRYPTION_KEYS: `1:${keyOne}`
    })).toThrow(/PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE/);
    expect(() => loadConfig({
      ...baseEnvironment, PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE: "1"
    })).toThrow(/PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE/);
  });
});
