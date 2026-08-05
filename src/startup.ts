import type { AddressInfo } from "node:net";
import type { Config } from "./config.js";

export type StartupPhase = "BOOT" | "READY" | "STOP" | "ERROR";

export function lifecycleLoggingEnabled(environment: Config["NODE_ENV"]): boolean {
  return environment !== "test";
}

export function writeLifecycleLog(
  enabled: boolean,
  phase: StartupPhase,
  message: string,
  details: Record<string, string | number> = {}
): void {
  if (!enabled) return;
  const detailText = Object.entries(details)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  process.stdout.write(`[${phase}] ${message}${detailText ? ` ${detailText}` : ""}\n`);
}

export function formatBoundAddress(address: AddressInfo | string | null): string {
  if (!address) return "unknown";
  if (typeof address === "string") return address;
  const host = address.family === "IPv6" && address.address.includes(":") ? `[${address.address}]` : address.address;
  return `${host}:${address.port}`;
}

export function startupFailureMessage(error: unknown): string {
  if (error instanceof Error && error.name === "ZodError") return "Configuration validation failed";
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "28P01", "3D000"].includes(code)) {
    return "PostgreSQL connection failed";
  }
  return "Application initialization failed";
}
