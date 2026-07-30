import { describe, expect, it } from "vitest";
import {
  PASSWORD_MAX_CODE_POINTS,
  hashPassword,
  validateNewPassword,
  verifyPassword
} from "../../src/security/passwords.js";

describe("password policy", () => {
  it("counts Unicode code points and preserves the 8-character MVP minimum", async () => {
    await expect(validateNewPassword("abcdefg")).rejects.toThrow("at least 8");
    await expect(validateNewPassword("🐾🐾🐾🐾🐾🐾🐾🐾")).resolves.toBeUndefined();
    await expect(validateNewPassword("calm dog")).resolves.toBeUndefined();
  });

  it("supports long values without truncation and rejects over-limit input", async () => {
    const long = "long passphrase ".repeat(5);
    expect(Array.from(long).length).toBeGreaterThanOrEqual(64);
    await expect(validateNewPassword(long)).resolves.toBeUndefined();
    await expect(validateNewPassword("x".repeat(PASSWORD_MAX_CODE_POINTS))).resolves.toBeUndefined();
    await expect(validateNewPassword("x".repeat(PASSWORD_MAX_CODE_POINTS + 1))).rejects.toThrow("no more than");
  });

  it("rejects deterministic whole-password matches without substring bans", async () => {
    await expect(validateNewPassword("password123")).rejects.toThrow("common");
    await expect(validateNewPassword("pawsh123")).rejects.toThrow("common");
    await expect(validateNewPassword("correct horse battery staple")).resolves.toBeUndefined();
    await expect(validateNewPassword("a dog named Password123 lives here")).resolves.toBeUndefined();
  });

  it("uses explicit Argon2id hashes with unique salts and full-value verification", async () => {
    const password = "quiet unicode 🐾 passphrase";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(second).not.toBe(first);
    await expect(verifyPassword(first, password)).resolves.toBe(true);
    await expect(verifyPassword(first, `${password}x`)).resolves.toBe(false);
  });
});
