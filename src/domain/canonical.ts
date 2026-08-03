import { createHash } from "node:crypto";

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function withoutVariableFields(
  value: Record<string, unknown>,
  variableFields: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !variableFields.includes(key)));
}
