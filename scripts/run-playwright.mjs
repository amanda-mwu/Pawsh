/* global console */
import process from "node:process";
import { runPlaywrightInvocation } from "./playwright-lifecycle.mjs";

const result = await runPlaywrightInvocation({ args: process.argv.slice(2) });
if (result.kind === "watchdog_timeout") {
  console.error(`[ERROR] Playwright wrapper timeout: ${result.error}`);
  console.error(`[ERROR] Profile: ${result.profile}; deadline: ${result.timeoutMs} ms; elapsed: ${result.elapsedMs} ms`);
  console.error(`[ERROR] Endpoint: ${result.endpoint}; server PID: ${result.roots?.server ?? "none"}; Playwright PID: ${result.roots?.playwright ?? "none"}`);
  console.error(`[ERROR] Cleanup: ${JSON.stringify(result.cleanup)}`);
  const serverTail = result.output?.server;
  const playwrightTail = result.output?.playwright;
  if (serverTail?.stderr || serverTail?.stdout) console.error(`[ERROR] Server output tail:\n${serverTail.stderr || serverTail.stdout}`);
  if (playwrightTail?.stderr || playwrightTail?.stdout) console.error(`[ERROR] Playwright output tail:\n${playwrightTail.stderr || playwrightTail.stdout}`);
}
if (result.error && result.kind !== "watchdog_timeout") console.error(`[ERROR] ${result.error}`);
if (result.cleanup?.status !== "complete") console.error(`[ERROR] Process cleanup incomplete: ${JSON.stringify(result.cleanup)}`);
const finalExitCode = result.cleanup?.status === "complete" ? result.exitCode : 126;
// Cleanup has already settled above; exit explicitly so inherited pipe handles
// from a misbehaving browser cannot keep the thin CLI alive indefinitely.
process.exit(finalExitCode);
