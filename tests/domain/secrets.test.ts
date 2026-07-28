import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "../../src/security/secrets.js";

describe("short-lived secret encryption", () => {
  it("round-trips with authenticated encryption", () => {
    const sealed = sealSecret("reset-link-token", "a sufficiently long application secret");
    expect(sealed).not.toContain("reset-link-token");
    expect(openSecret(sealed, "a sufficiently long application secret")).toBe("reset-link-token");
  });

  it("rejects the wrong key and tampered values", () => {
    const sealed = sealSecret("reset-link-token", "correct secret");
    expect(() => openSecret(sealed, "wrong secret")).toThrow();
    const tampered = Buffer.from(sealed, "base64url");
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => openSecret(tampered.toString("base64url"), "correct secret")).toThrow();
  });
});
