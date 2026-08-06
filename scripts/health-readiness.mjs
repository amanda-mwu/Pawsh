/* global fetch */
import { setTimeout as delay } from "node:timers/promises";

export async function waitForHealth(url, child, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 100;
  const output = options.output ?? (() => "");
  const readiness = options.readiness;
  const failure = options.failure;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const delayImplementation = options.delayImplementation ?? delay;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw readinessError("child_exit", `Pawsh server exited before readiness (${child.exitCode ?? child.signalCode})${formatOutput(output())}`);
    }
    const failureReason = failure?.();
    if (failureReason) throw readinessError("startup_failure", failureReason);
    if (readiness && !readiness()) {
      await delayImplementation(intervalMs);
      continue;
    }
    try {
      const response = await fetchImplementation(url);
      if (response.status === 200) return;
    } catch {
      // The process is still starting or the listener is not accepting connections yet.
    }
    await delayImplementation(intervalMs);
  }
  throw readinessError("timeout", `Timed out waiting for ${url}${formatOutput(output())}`);
}

function formatOutput(value) {
  return value ? `\n${value}` : "";
}

function readinessError(kind, message) {
  return Object.assign(new Error(message), { kind });
}
