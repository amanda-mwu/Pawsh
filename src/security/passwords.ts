import { Algorithm, Version, hash, verify } from "@node-rs/argon2";
import { z } from "zod";

export const PASSWORD_MIN_CODE_POINTS = 8;
export const PASSWORD_MAX_CODE_POINTS = 256;
export const PASSWORD_MAX_UTF8_BYTES = 1024;

export const argon2idOptions = Object.freeze({
  algorithm: Algorithm.Argon2id,
  version: Version.V0x13,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32
});

const commonPasswords = new Set([
  "12345678",
  "abcdefgh",
  "aaaaaaaa",
  "password",
  "password123",
  "pawsh123"
]);

export interface CompromisedPasswordProvider {
  isCompromised(password: string): Promise<boolean>;
}

export const localCompromisedPasswordProvider: CompromisedPasswordProvider = {
  async isCompromised(password) {
    return commonPasswords.has(password.toLocaleLowerCase("en-US"));
  }
};

function passwordShapeIssue(password: string): string | null {
  const codePoints = Array.from(password).length;
  if (codePoints < PASSWORD_MIN_CODE_POINTS) {
    return `Password must contain at least ${PASSWORD_MIN_CODE_POINTS} Unicode characters`;
  }
  if (codePoints > PASSWORD_MAX_CODE_POINTS) {
    return `Password must contain no more than ${PASSWORD_MAX_CODE_POINTS} Unicode characters`;
  }
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_UTF8_BYTES) {
    return "Password exceeds the supported encoded size";
  }
  return null;
}

export const passwordSchema = z.string().superRefine((password, context) => {
  const issue = passwordShapeIssue(password);
  if (issue) context.addIssue({ code:"custom", message:issue });
});

export async function validateNewPassword(
  password: string,
  options: {
    email?: string | undefined;
    provider?: CompromisedPasswordProvider | undefined;
  } = {}
): Promise<void> {
  const issue = passwordShapeIssue(password);
  if (issue) throw new Error(issue);

  const normalized = password.toLocaleLowerCase("en-US");
  const normalizedEmail = options.email?.trim().toLocaleLowerCase("en-US");
  if (normalizedEmail && normalized === normalizedEmail) {
    throw new Error("Password is too easy to guess");
  }
  if (await (options.provider ?? localCompromisedPasswordProvider).isCompromised(password)) {
    throw new Error("Password is too common or has been compromised");
  }
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, argon2idOptions);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

