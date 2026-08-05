import type { AddressInfo } from "node:net";
import type { Config } from "./config.js";

export type StartupPhase = "BOOT" | "READY" | "STOP" | "ERROR";

export interface StartupDiagnostics {
  log(message: string, details?: Record<string, string | number>): void;
  run(component: string, operation: string, task: () => PromiseLike<unknown> | unknown): Promise<void>;
}

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

export function createStartupDiagnostics(startedAt: number, waitDiagnosticMs = 3_000): StartupDiagnostics {
  return {
    log(message, details = {}) {
      writeLifecycleLog(true, "BOOT", message, details);
    },
    async run(component: string, operation: string, task: () => PromiseLike<unknown> | unknown): Promise<void> {
      const operationStartedAt = performance.now();
      writeLifecycleLog(true, "BOOT", `${operation} begin`, { component });
      const diagnostic = setTimeout(() => {
        writeLifecycleLog(true, "BOOT", `Still waiting for ${component}`, {
          operation,
          elapsedMs: Math.round(performance.now() - operationStartedAt)
        });
      }, waitDiagnosticMs);
      diagnostic.unref();
      try {
        await task();
        writeLifecycleLog(true, "BOOT", `${operation} complete`, {
          component,
          elapsedMs: Math.round(performance.now() - operationStartedAt)
        });
      } catch (error) {
        writeLifecycleLog(true, "ERROR", "Startup component failed", {
          component,
          operation,
          elapsedMs: Math.round(performance.now() - startedAt),
          error: startupFailureMessage(error)
        });
        throw error;
      } finally {
        clearTimeout(diagnostic);
      }
    }
  };
}
