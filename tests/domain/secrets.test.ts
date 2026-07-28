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
    expect(() => openSecret(`${sealed.slice(0,-1)}x`, "correct secret")).toThrow();
  });
});
