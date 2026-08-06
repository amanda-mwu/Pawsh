import { appendFileSync } from "node:fs";
import process from "node:process";
import { isInfrastructureBlocked } from "./ci-policy-status.mjs";

const classification = process.env.CLASSIFICATION_RESULT;
const executable = process.env.EXECUTABLE === "true";
const fullMatrix = process.env.FULL_MATRIX === "true";
const results = JSON.parse(process.env.JOB_RESULTS ?? "{}");
const hostedJobs = await loadHostedJobs();
const failures = [];
if (classification !== "success") failures.push(`classification=${classification ?? "missing"}`);

const expected = {
  "ubuntu-runtime": executable ? "required" : "not_required",
  "windows-runtime": fullMatrix ? "required" : "not_required",
  "macos-runtime": fullMatrix ? "required" : "not_required",
  "utc-canonicalization": fullMatrix ? "required" : "not_required"
};
const rows = [];
for (const [job, requirement] of Object.entries(expected)) {
  const observed = results[job]?.result ?? "missing";
  if (requirement === "required") {
    const status = observed === "success" ? "Required and passed"
      : isInfrastructureBlocked(job, hostedJobs) ? "Required but infrastructure blocked"
      : "Required and failed";
    rows.push([job, status, observed]);
    if (observed !== "success") failures.push(`${job}=${observed}`);
  } else {
    const status = observed === "skipped" ? "Not required under beta impact policy" : "Unexpected execution result";
    rows.push([job, status, observed]);
    if (observed !== "skipped") failures.push(`${job}=expected_skipped_received_${observed}`);
  }
}

const summary = [
  "## Cross-platform compatibility policy",
  "",
  `- Enforcement level: \`${process.env.ENFORCEMENT_LEVEL ?? "unknown"}\``,
  `- Change class: \`${process.env.CHANGE_CLASS ?? "unknown"}\``,
  `- Full matrix required: \`${fullMatrix}\``,
  `- Trusted reasons: \`${process.env.TRUSTED_REASONS ?? "none"}\``,
  "",
  "| Job group | Policy status | Workflow result |",
  "| --- | --- | --- |",
  ...rows.map(([job, status, observed]) => `| ${job} | ${status} | ${observed} |`),
  "",
  "Infrastructure-blocked and authorized-disposition states require external evidence review; this check never converts them into hosted passes."
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
else process.stdout.write(`${summary}\n`);
if (failures.length) throw new Error(`Required cross-platform evidence incomplete: ${failures.join(", ")}`);

async function loadHostedJobs() {
  const { GH_ACTIONS_TOKEN: token, GH_REPOSITORY: repository, GH_RUN_ID: runId } = process.env;
  if (!token || !repository || !runId) return [];
  const api = process.env.GH_API_URL ?? "https://api.github.com";
  try {
    const response = await globalThis.fetch(`${api}/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" }
    });
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body.jobs) ? body.jobs : [];
  } catch {
    return [];
  }
}
