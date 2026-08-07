/* global console */
import process from "node:process";
import { formatQaReport, runQaCascade } from "./qa-cascade.mjs";

const mode = process.argv[2] ?? "quick";
try {
  const report = await runQaCascade({ mode });
  console.log(formatQaReport(report));
  if (report.blocker?.diagnostics) console.error(`Diagnostics:\n${JSON.stringify(report.blocker.diagnostics)}`);
  process.exitCode = report.status === "passed" ? 0 : 1;
} catch (error) {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 1;
}
