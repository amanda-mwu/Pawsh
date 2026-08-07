/* global console */
import process from "node:process";
import { formatQaReport, runQaCascade, runQaResume } from "./qa-cascade.mjs";

const requested = process.argv[2] ?? "quick";
const resume = requested === "resume";
const mode = resume ? undefined : requested;
const restart = process.argv.includes("--restart");
if (process.argv.some((value) => value.startsWith("--") && value !== "--restart")) {
  console.error("[ERROR] Supported QA option: --restart");
  process.exitCode = 1;
} else {
try {
  const report = resume ? await runQaResume({}) : await runQaCascade({ mode, restart });
  console.log(formatQaReport(report));
  if (report.blocker?.diagnostics) console.error(`Diagnostics:\n${JSON.stringify(report.blocker.diagnostics)}`);
  process.exitCode = report.status === "passed" ? 0 : 1;
} catch (error) {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 1;
}
}
