/* global fetch */
import { setTimeout as delay } from "node:timers/promises";

export async function waitForHealth(url, child, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 100;
  const output = options.output ?? (() => "");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Pawsh server exited before readiness (${child.exitCode ?? child.signalCode})${formatOutput(output())}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process is still starting or the listener is not accepting connections yet.
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${url}${formatOutput(output())}`);
}

function formatOutput(value) {
  return value ? `\n${value}` : "";
}
