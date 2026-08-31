import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Envelope encryption for third-party credentials at rest.
 *
 * `secrets.ts` next door seals short-lived, single-purpose values - a password-reset body, a
 * notification body - under the application session secret. This is a different job and it is
 * deliberately a different module with a different key.
 *
 * A Square refresh token does not expire and does not rotate. It is a standing, transferable
 * authorisation to take money on a salon's behalf, and it lives in the database for as long as
 * the salon stays connected. Three properties follow from that, and none of them are true of the
 * session secret:
 *
 *   SEPARATE KEY MATERIAL. `SESSION_SECRET` signs cookies and is held by everything that serves a
 *   request. Rotating it logs everybody out, which makes it the kind of secret an operator
 *   changes; a key that opens standing payment credentials is not. They must be able to move
 *   independently, so the integration keyring is its own variable and is never derived from
 *   `SESSION_SECRET` - not by hashing it, not by stretching it. `config.ts` refuses a keyring
 *   whose bytes are the session secret or its SHA-256, so the separation is checked rather than
 *   merely intended.
 *
 *   VERSIONED, WITH BOTH KEYS RESIDENT. Rotation is not a flag day. Several keys are loaded at
 *   once, new values are sealed under the active one, and old values keep opening under the key
 *   that sealed them. The version travels OUTSIDE the ciphertext - `v2.<blob>` - so a reader
 *   selects the key by reading it rather than by trying each key until one authenticates. Trial
 *   decryption would turn a wrong-key bug into a slow, silent, timing-visible search.
 *
 *   BOUND TO WHERE IT LIVES. The additional authenticated data is
 *   `<business_id>|<table>|<column>`, so a ciphertext lifted out of one business's row and
 *   written into another's fails authentication instead of decrypting. Tenant isolation in this
 *   schema is enforced by row-level security and by every query carrying a business id; this is
 *   the layer that makes a stolen ciphertext useless even if both of those were bypassed.
 *
 * There is no plaintext fallback anywhere in this module. An unknown key version, a truncated
 * envelope and a failed authentication tag are all typed errors, because the alternative -
 * returning the stored string when it cannot be opened - would hand a caller a ciphertext and
 * let it be sent to Square as a bearer token.
 */

export type IntegrationEncryptionErrorCode =
  | "keyring_unconfigured"
  | "keyring_invalid"
  | "unknown_key_version"
  | "malformed_envelope"
  | "authentication_failed";

export class IntegrationEncryptionError extends Error {
  constructor(public readonly code: IntegrationEncryptionErrorCode, message: string) {
    super(message);
    this.name = "IntegrationEncryptionError";
  }
}

/** Where a sealed value lives. Reproduced byte for byte as the AES-GCM additional data. */
export interface SealedFieldContext {
  businessId: string;
  table: string;
  column: string;
}

export interface SealedValue {
  value: string;
  keyVersion: number;
}

const keyBytes = 32;
const nonceBytes = 12;
const tagBytes = 16;
const envelopePattern = /^v(\d+)\.([A-Za-z0-9_-]+)$/;
const keyEntryPattern = /^(\d+):(.+)$/;

export function sealedFieldAad(context: SealedFieldContext): Buffer {
  if (!context.businessId || !context.table || !context.column) {
    throw new IntegrationEncryptionError(
      "malformed_envelope",
      "Sealed field context requires a business, a table and a column"
    );
  }
  if ([context.businessId, context.table, context.column].some((part) => part.includes("|"))) {
    // A pipe inside a part would let two different locations produce one AAD string.
    throw new IntegrationEncryptionError(
      "malformed_envelope",
      "Sealed field context parts must not contain a separator"
    );
  }
  return Buffer.from(`${context.businessId}|${context.table}|${context.column}`, "utf8");
}

export class IntegrationKeyring {
  private constructor(
    private readonly keys: ReadonlyMap<number, Buffer>,
    readonly activeVersion: number
  ) {}

  /**
   * Builds a keyring from the two configuration values.
   *
   * `keys` is `<version>:<base64 32 bytes>` entries separated by commas; `activeVersion` names
   * the one new values are sealed under. Raw key material, not a passphrase: no stretching
   * happens here, because a stretched passphrase would be a password-strength key wearing a
   * key-strength costume, and the operator would have no way to tell.
   */
  static parse(keys: string, activeVersion: string): IntegrationKeyring {
    const parsed = new Map<number, Buffer>();
    const entries = keys.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (entries.length === 0) {
      throw new IntegrationEncryptionError("keyring_invalid", "The integration keyring is empty");
    }
    for (const entry of entries) {
      const match = keyEntryPattern.exec(entry);
      if (!match) {
        throw new IntegrationEncryptionError(
          "keyring_invalid",
          "Each integration key must be written as <version>:<base64 key>"
        );
      }
      const version = Number(match[1]);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new IntegrationEncryptionError("keyring_invalid", "Integration key versions start at 1");
      }
      if (parsed.has(version)) {
        throw new IntegrationEncryptionError(
          "keyring_invalid",
          `Integration key version ${version} is declared more than once`
        );
      }
      const material = decodeKey(match[2]!);
      parsed.set(version, material);
    }
    const active = Number(activeVersion.trim());
    if (!Number.isSafeInteger(active) || !parsed.has(active)) {
      throw new IntegrationEncryptionError(
        "keyring_invalid",
        "The active integration key version is not present in the keyring"
      );
    }
    return new IntegrationKeyring(parsed, active);
  }

  /** Every version the ring can still open. Drives the retirement check against `key_version`. */
  get versions(): number[] {
    return [...this.keys.keys()].sort((left, right) => left - right);
  }

  seal(plaintext: string, context: SealedFieldContext): SealedValue {
    const key = this.key(this.activeVersion);
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(sealedFieldAad(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const packed = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    return { value: `v${this.activeVersion}.${packed.toString("base64url")}`, keyVersion: this.activeVersion };
  }

  open(envelope: string, context: SealedFieldContext): string {
    const match = envelopePattern.exec(envelope);
    if (!match) {
      throw new IntegrationEncryptionError("malformed_envelope", "The sealed value is not a versioned envelope");
    }
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) {
      throw new IntegrationEncryptionError("malformed_envelope", "The sealed value declares an unreadable version");
    }
    const packed = Buffer.from(match[2]!, "base64url");
    if (packed.length < nonceBytes + tagBytes || packed.toString("base64url") !== match[2]) {
      throw new IntegrationEncryptionError("malformed_envelope", "The sealed value is truncated or non-canonical");
    }
    const key = this.key(version);
    const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, nonceBytes));
    decipher.setAuthTag(packed.subarray(nonceBytes, nonceBytes + tagBytes));
    decipher.setAAD(sealedFieldAad(context));
    try {
      return Buffer.concat([
        decipher.update(packed.subarray(nonceBytes + tagBytes)),
        decipher.final()
      ]).toString("utf8");
    } catch {
      // Wrong key, tampered ciphertext and a ciphertext moved to another business's row are the
      // same failure at this layer, and are reported as one rather than distinguished for an
      // attacker's benefit.
      throw new IntegrationEncryptionError(
        "authentication_failed",
        "The sealed value failed authentication"
      );
    }
  }

  /** The version stamped on a stored envelope, without opening it. */
  static envelopeVersion(envelope: string): number {
    const match = envelopePattern.exec(envelope);
    if (!match) {
      throw new IntegrationEncryptionError("malformed_envelope", "The sealed value is not a versioned envelope");
    }
    return Number(match[1]);
  }

  private key(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) {
      throw new IntegrationEncryptionError(
        "unknown_key_version",
        `Integration key version ${version} is not loaded`
      );
    }
    return key;
  }
}

function decodeKey(encoded: string): Buffer {
  const trimmed = encoded.trim();
  const material = Buffer.from(trimmed, "base64");
  // Base64 decoding in Node is permissive: it stops at the first character it cannot read and
  // returns the prefix. Re-encoding and comparing rejects a key that was silently truncated
  // rather than accepting whatever it managed to parse. Padding and the URL alphabet are both
  // accepted; a short key is not.
  const canonical = material.toString("base64").replace(/=+$/, "");
  const supplied = trimmed.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
  if (material.byteLength !== keyBytes || canonical !== supplied) {
    throw new IntegrationEncryptionError(
      "keyring_invalid",
      "Each integration key must be exactly 32 base64-encoded bytes"
    );
  }
  return material;
}

/**
 * Whether two key-sized buffers hold the same bytes, in constant time.
 *
 * Used by the configuration guard that refuses an integration key derived from `SESSION_SECRET`.
 */
export function sameKeyMaterial(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/** Parses the raw key material without building a ring, for configuration-time validation. */
export function integrationKeyMaterial(keys: string): Buffer[] {
  return keys
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = keyEntryPattern.exec(entry);
      if (!match) {
        throw new IntegrationEncryptionError(
          "keyring_invalid",
          "Each integration key must be written as <version>:<base64 key>"
        );
      }
      return decodeKey(match[2]!);
    });
}
