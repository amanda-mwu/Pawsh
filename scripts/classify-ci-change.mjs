import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { classifyEntries, comparisonFromEvent, gitEntries } from "./ci-change-classifier.mjs";

const eventName = process.env.GITHUB_EVENT_NAME ?? "local";
const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
let mode = eventName === "schedule" ? "scheduled_full_matrix"
  : eventName === "workflow_dispatch" && event.inputs?.release_candidate === "true" ? "beta_release_candidate"
  : eventName === "workflow_dispatch" && event.inputs?.force_full_matrix === "true" ? "manual_full_matrix"
  : "beta_development";
let entries;
let failure;
try {
  const comparison = comparisonFromEvent(eventName, event, process.env.GITHUB_SHA);
  entries = gitEntries(comparison.base, comparison.head, { mergeBase: comparison.mergeBase });
} catch (error) {
  failure = error instanceof Error ? error.message : "classification_failed";
  entries = [{ status: "?", path: ".unknown-classification" }];
}

const result = classifyEntries(entries, {
  mode,
  forceFull: event.inputs?.force_full_matrix,
  rollbackFull: process.env.PAWSH_FORCE_FULL_MATRIX
});
if (failure) result.reasons = `${result.reasons},${failure}`;
const outputs = {
  enforcement_level: result.enforcementLevel,
  change_class: result.changeClass,
  documentation_only: String(result.documentationOnly),
  executable: String(result.executable),
  platform_sensitive: String(result.platformSensitive),
  database: String(result.database),
  browser: String(result.browser),
  workflow: String(result.workflow),
  dependency: String(result.dependency),
  mobile: String(result.mobile),
  server: String(result.server),
  full_matrix: String(result.fullMatrix),
  reasons: result.reasons
};
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
}
process.stdout.write(`${JSON.stringify(outputs)}\n`);
