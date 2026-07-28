import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "../../src/security/secrets.js";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function flipByte(sealed: string, index: number): string {
  const packed = Buffer.from(sealed, "base64url");
  packed[index] = packed[index]! ^ 1;
  return packed.toString("base64url");
}

describe("short-lived secret encryption", () => {
  it("round-trips with authenticated encryption", () => {
    const secret = "a sufficiently long application secret";
    const sealed = sealSecret("reset-link-token", secret);
    expect(sealed).not.toContain("reset-link-token");
    expect(openSecret(sealed, secret)).toBe("reset-link-token");
    expect(sealSecret("reset-link-token", secret)).not.toBe(sealed);
  });

  it("rejects the wrong key", () => {
    const sealed = sealSecret("reset-link-token", "correct secret");
    expect(() => openSecret(sealed, "wrong secret")).toThrow();
  });

  it("rejects deterministic ciphertext and authentication-tag changes repeatedly", () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const sealed = sealSecret("reset-link-token", "correct secret");
      expect(() => openSecret(
        flipByte(sealed, NONCE_BYTES + TAG_BYTES),
        "correct secret"
      )).toThrow();
      expect(() => openSecret(flipByte(sealed, NONCE_BYTES), "correct secret")).toThrow();
    }
  });

  it("rejects malformed or non-canonical serialized values", () => {
    const sealed = sealSecret("reset-link-token", "correct secret");
    expect(() => openSecret("", "correct secret")).toThrow();
    expect(() => openSecret(Buffer.alloc(28).toString("base64url"), "correct secret")).toThrow();
    expect(() => openSecret(`${sealed}!`, "correct secret")).toThrow();
  });
});
