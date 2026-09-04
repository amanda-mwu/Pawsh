/* global setTimeout, clearTimeout */
import { spawn } from "node:child_process";
import process from "node:process";
import { terminateOwnedProcessTree, createBoundedOutputTail, redactDiagnosticText } from "./playwright-lifecycle.mjs";
import { buildIdentity, createPlaywrightQaEnvironment, currentQaIdentity, loadQaState, QA_ORCHESTRATOR_VERSION, QA_STATE_PATH, writeQaState } from "./qa-environment.mjs";

export const QA_MODES = new Set(["quick", "standard", "full", "release-candidate"]);
const DEFAULT_STAGE_TIMEOUTS = Object.freeze({
  environment: 30_000, static: 180_000, critical: 180_000, database: 180_000,
  startup: 45_000, preflight: 120_000, smoke: 300_000, targeted: 300_000,
  backend: 600_000, chromium: 900_000, expansion: 900_000, release: 900_000
});

function npmInvocation(script) {
  if (process.platform === "win32") return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `npm run ${script}`] };
  return { command: "npm", args: ["run", script] };
}

function stageDefinitions(mode) {
  const base = [
    { name: "environment", timeoutClass: "environment", run: runEnvironment },
    // The only stage that writes `dist/`. Every later stage that starts the application, and
    // every reuse of one of them, is standing on the build this stage produced - which is why
    // the run records what that build was and a resume that skips this stage has to check it.
    { name: "static", timeoutClass: "static", run: runStatic, producesBuild: true },
    { name: "critical", timeoutClass: "critical", command: "vitest-run tests/domain/playwright-lifecycle.test.mjs" },
    { name: "database", timeoutClass: "database", run: runDatabase },
    { name: "startup", timeoutClass: "startup", command: "compatibility:startup" },
    { name: "preflight", timeoutClass: "preflight", run: (env, timeoutMs, stageRunner) => runPreflights(mode, env, timeoutMs, stageRunner) },
    // Local browser stages create many tenants and browser contexts against a
    // single disposable server/database, which ten workers reproducibly starved.
    // The supported local concurrency is now encoded once in playwright.config.ts
    // (workers: 1 off CI); this explicit flag is kept as belt-and-braces so the
    // stage stays correct even if that default is ever revisited. The "chromium"
    // stage below relies on the same contract.
    { name: "smoke", timeoutClass: "smoke", command: "test:smoke -- --workers=1" }
  ];
  if (mode !== "quick") base.push({ name: "targeted", timeoutClass: "targeted", command: "vitest-run tests/domain/playwright-lifecycle.test.mjs tests/database/rabies-compliance.test.ts" });
  if (mode === "standard" || mode === "full" || mode === "release-candidate") base.push({ name: "backend", timeoutClass: "backend", command: "test" });
  if (mode === "full" || mode === "release-candidate") {
    base.push({ name: "chromium", timeoutClass: "chromium", command: "test:e2e -- --project=chromium" });
    base.push({ name: "expansion", timeoutClass: "expansion", command: "test:cross-browser", browsers: ["firefox", "webkit"] });
    base.push({ name: "release", timeoutClass: "release", command: "validate:qa" });
  }
  return base;
}

async function runSeries(commands, timeoutMs, env, stageRunner) {
  for (const entry of commands) {
    const command = typeof entry === "string" ? entry : entry.command;
    const result = await stageRunner({ name: command, command }, timeoutMs, env);
    if (result.status !== "passed") return result;
  }
  return { status: "passed" };
}

async function runStatic(env, timeoutMs, stageRunner) {
  return runSeries(["lint", "typecheck", "build"], timeoutMs, env, stageRunner);
}

async function runDatabase(env, timeoutMs, stageRunner) {
  return runSeries(["db:health", "db:migrate"], timeoutMs, env, stageRunner);
}

async function runPreflights(mode, env, timeoutMs, stageRunner) {
  const browsers = mode === "full" || mode === "release-candidate" ? ["chromium", "firefox", "webkit"] : ["chromium"];
  for (const browser of browsers) {
    const result = await stageRunner({ name: `browser-preflight:${browser}`, command: `qa:browser-preflight ${browser}` }, timeoutMs, env);
    if (result.status !== "passed") return { ...result, browser };
  }
  return { status: "passed" };
}

async function runEnvironment(env = process.env) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22 || nodeMajor >= 25) throw new Error(`Unsupported Node.js runtime: ${process.versions.node}`);
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required for local QA");
  if (!/^postgres(?:ql)?:\/\/(?:[^@]+@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(env.DATABASE_URL)) throw new Error("QA requires a loopback DATABASE_URL; production targets are forbidden");
  return { diagnostics: `Node ${process.versions.node}; npm ${env.npm_config_user_agent ?? "unknown"}` };
}

export function parseQaTimeouts(env = process.env) {
  const value = env.PAWSH_QA_STAGE_TIMEOUT_MS;
  if (value === undefined || value === "") return { ...DEFAULT_STAGE_TIMEOUTS };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1_000 || parsed > 3_600_000) throw new Error("PAWSH_QA_STAGE_TIMEOUT_MS must be between 1000 and 3600000");
  return Object.fromEntries(Object.entries(DEFAULT_STAGE_TIMEOUTS).map(([key]) => [key, Math.trunc(parsed)]));
}

function commandFor(stage) {
  if (!stage.command) return null;
  const [script, ...args] = stage.command.split(" ");
  if (script === "vitest-run") return { command: process.execPath, args: ["node_modules/vitest/vitest.mjs", "run", ...args] };
  if (script === "test" && args.length) return process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `npm run test -- ${args.join(" ")}`] }
    : { command: "npm", args: ["run", "test", "--", ...args] };
  if (script === "qa:browser-preflight") return { command: process.execPath, args: ["scripts/browser-preflight.mjs", args[0]] };
  if (script === "test:cross-browser") return npmInvocation("test:cross-browser");
  if (args.length) {
    const forwarded = args[0] === "--" ? args.slice(1) : args;
    return process.platform === "win32"
      ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `npm run ${script} -- ${forwarded.join(" ")}`] }
      : { command: "npm", args: ["run", script, "--", ...forwarded] };
  }
  return npmInvocation(script);
}

function runStageProcess(stage, timeoutMs, env = process.env) {
  const invocation = commandFor(stage);
  const tail = createBoundedOutputTail(16_384);
  if (!invocation) return Promise.resolve({ status: "passed", diagnostics: stage.run ? "environment checked" : "no command" });
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, { env, stdio: ["inherit", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: process.platform === "win32" });
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (value) => { tail.append("stdout", value); });
    child.stderr?.on("data", (value) => { tail.append("stderr", value); });
    let settled = false;
    const startedAt = Date.now();
    const settle = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleanup = result.status === "passed" ? { status: "complete" } : await terminateOwnedProcessTree({ child, graceMs: 2_000 });
      resolve({ ...result, durationMs: Date.now() - startedAt, command: `${invocation.command} ${invocation.args.join(" ")}`, timeoutMs, cleanupStatus: cleanup.status, diagnostics: { stderr: tail.stderr, stdout: tail.stdout } });
    };
    const timer = setTimeout(() => { void settle({ status: "timed_out", classification: "stage_timeout", exitCode: 124 }); }, timeoutMs);
    child.once("error", (error) => { void settle({ status: "failed", classification: "spawn_error", error: redactDiagnosticText(error.message), exitCode: 125 }); });
    child.once("exit", (code, signal) => { void settle(code === 0 ? { status: "passed", exitCode: 0 } : { status: "failed", classification: "command_failure", exitCode: code ?? 125, signal }); });
  });
}

export async function runQaCascade({ mode = "quick", env = process.env, stageRunner = runStageProcess, timeouts = parseQaTimeouts(env), statePath = QA_STATE_PATH, persistState = true, restart = false, allowPriorFailure = false, startAt = 0, reusedEvidence = null } = {}) {
  if (!QA_MODES.has(mode)) throw new Error(`Unknown QA mode: ${mode}`);
  const qaEnv = createPlaywrightQaEnvironment(env);
  const identity = currentQaIdentity(qaEnv);
  const prior = persistState ? await loadQaState(statePath) : null;
  // The progression gate compares the SOURCE, not only the commit. A prior failure on a tree that
  // has since been edited is not a statement about the tree in front of us, and blocking a fresh
  // run on it would be the same conflation `qa:resume` used to make, in the other direction.
  if ((mode === "full" || mode === "release-candidate") && prior && prior.sha === identity.sha && prior.sourceFingerprint === identity.sourceFingerprint && prior.overallStatus === "failed" && !restart && !allowPriorFailure) {
    return { mode, status: "failed", blocker: { name: "progression", classification: "prior_run_unresolved", error: `A prior ${prior.mode} run failed at ${prior.firstFailedStage ?? "an unknown stage"}. Use qa:resume or --restart.` }, results: [] };
  }
  const stages = stageDefinitions(mode);
  const results = [];
  let blocker = null;
  // What this run knows about the compiled output. A resume inherits the recorded value for the
  // build stage it is skipping - `runQaResume` has already proved that build is still on disk -
  // and any run that executes the build stage replaces it with what the stage just produced.
  let buildFingerprint = reusedEvidence?.buildFingerprint ?? null;
  const evidence = () => ({ sourceFingerprint: identity.sourceFingerprint, dirtyWorkingTree: identity.dirtyWorkingTree, ...(buildFingerprint === null ? {} : { buildFingerprint }) });
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (index < startAt) {
      // A reused stage says whose evidence it is standing on. "passed" with no provenance is how
      // a resumed report came to look identical to a report that had actually run everything.
      results.push({ name: stage.name, status: "passed", reused: true, reusedFrom: reusedEvidence ?? undefined, skippedReason: reusedEvidence ? `reused from the ${reusedEvidence.mode} run on source ${reusedEvidence.sourceFingerprint.slice(0, 12)}` : "reused after compatible state validation" });
      continue;
    }
    if (blocker) {
      results.push({ name: stage.name, status: "blocked", skippedReason: `blocked by ${blocker.name}` });
      continue;
    }
    const startedAt = Date.now();
    let result;
    try { result = stage.run ? await stage.run(qaEnv, timeouts[stage.timeoutClass], stageRunner) : await stageRunner(stage, timeouts[stage.timeoutClass], qaEnv); }
    catch (error) { result = { status: "failed", classification: "stage_exception", error: redactDiagnosticText(error.message) }; }
    result = { status: "passed", ...result, name: stage.name, startedAt, completedAt: Date.now(), durationMs: result.durationMs ?? Date.now() - startedAt, timeoutMs: timeouts[stage.timeoutClass] };
    if (stage.producesBuild && result.status === "passed") {
      buildFingerprint = await buildIdentity(qaEnv);
      result.buildFingerprint = buildFingerprint;
    }
    results.push(result);
    if (result.status !== "passed") blocker = result;
    if (persistState) await writeQaState({ sha: identity.sha, branch: identity.branch, mode, startedAt: results[0]?.startedAt ?? Date.now(), completedAt: result.status === "passed" && index === stages.length - 1 ? Date.now() : undefined, overallStatus: result.status === "passed" && index === stages.length - 1 ? "passed" : "failed", lastCompletedStage: result.status === "passed" ? stage.name : results[index - 1]?.name, firstFailedStage: result.status === "passed" ? undefined : stage.name, failureClassification: result.classification, cleanupStatus: result.cleanupStatus ?? "complete", environmentFingerprint: identity.fingerprint, ...evidence(), orchestratorVersion: QA_ORCHESTRATOR_VERSION }, statePath);
  }
  const report = { mode, status: blocker ? "failed" : "passed", blocker, results, ...evidence() };
  if (persistState) await writeQaState({ sha: identity.sha, branch: identity.branch, mode, startedAt: results[0]?.startedAt ?? Date.now(), completedAt: Date.now(), overallStatus: report.status, lastCompletedStage: results.at(-1)?.name, firstFailedStage: blocker?.name, failureClassification: blocker?.classification, cleanupStatus: results.every((item) => item.cleanupStatus !== "incomplete") ? "complete" : "incomplete", environmentFingerprint: identity.fingerprint, ...evidence(), orchestratorVersion: QA_ORCHESTRATOR_VERSION }, statePath);
  return report;
}

/**
 * Restarts a failed run at the stage that failed, reporting the earlier stages as passed.
 *
 * EVERY CHECK BELOW EXISTS TO STOP THE SAME LIE. The stages before `startAt` are never executed;
 * they are reported as passed on the strength of a state file. That is only honest while the
 * thing they passed against is the thing in front of us now, so a resume has to establish three
 * separate identities and refuse if any of them has moved:
 *
 *   the commit         `sha`, as before
 *   the SOURCE         `sourceFingerprint` - HEAD plus the content of everything that differs
 *                      from it. This is the check that was missing: `git rev-parse HEAD` does
 *                      not move when a file is edited, so a resume could declare green for a
 *                      working tree no stage had ever seen.
 *   the BUILD          only when the resume skips the stage that produces it. Unchanged source
 *                      does not prove the `dist/` on disk came from that source: it may have
 *                      been rebuilt from something else, half-deleted, or never built at all.
 *
 * A refusal here is cheap - the operator reruns the cascade - and is always the right answer,
 * because the alternative is a report that claims code was validated when it was not.
 */
export async function runQaResume({ env = process.env, stageRunner = runStageProcess, statePath = QA_STATE_PATH } = {}) {
  const qaEnv = createPlaywrightQaEnvironment(env);
  const state = await loadQaState(statePath);
  if (!state) throw new Error("No valid QA state is available for resume");
  const identity = currentQaIdentity(qaEnv);
  if (state.sha !== identity.sha) throw new Error("QA resume requires an exact SHA match");
  if (state.sourceFingerprint !== identity.sourceFingerprint) throw new Error("QA resume requires an unchanged working tree: the source differs from the tree the recorded run validated. Run the cascade again rather than resuming.");
  if (state.environmentFingerprint !== identity.fingerprint) throw new Error("QA resume requires a compatible environment fingerprint");
  if (state.cleanupStatus !== "complete") throw new Error("QA resume refused because prior cleanup was incomplete");
  if (state.overallStatus !== "failed" || !state.firstFailedStage) throw new Error("QA resume requires a failed stage");
  const stages = stageDefinitions(state.mode);
  const index = stages.findIndex((stage) => stage.name === state.firstFailedStage);
  if (index < 0) throw new Error("QA resume state names an unknown stage");
  const buildStage = stages.findIndex((stage) => stage.producesBuild);
  if (buildStage >= 0 && buildStage < index) {
    const current = await buildIdentity(qaEnv);
    if (typeof state.buildFingerprint !== "string") throw new Error("QA resume cannot reuse the build stage: the recorded run did not record what it built");
    if (current === "absent") throw new Error("QA resume cannot reuse the build stage: there is no build on disk to reuse");
    if (state.buildFingerprint !== current) throw new Error("QA resume cannot reuse the build stage: the build on disk is not the one the recorded run produced");
  }
  return runQaCascade({ mode: state.mode, env, stageRunner, statePath, persistState: true, allowPriorFailure: true, startAt: index, reusedEvidence: { mode: state.mode, sha: state.sha, sourceFingerprint: state.sourceFingerprint, buildFingerprint: state.buildFingerprint } });
}

export function formatQaReport(report) {
  const lines = [`QA mode: ${report.mode}`, `Overall: ${report.status}`];
  // The source the run was about, said out loud. A report headed only by a commit reads as a
  // statement about that commit, which is wrong the moment anything is uncommitted.
  if (report.sourceFingerprint) {
    lines.push(`Source: ${report.sourceFingerprint.slice(0, 12)}${report.dirtyWorkingTree ? " (working tree has uncommitted changes; this is NOT a statement about HEAD alone)" : " (clean working tree)"}`);
  }
  if (report.blocker && !report.results.includes(report.blocker)) {
    lines.push(`First failure: ${report.blocker.classification ?? "stage failure"}${report.blocker.error ? ` — ${report.blocker.error}` : ""}`);
    lines.push("Use npm run qa:resume to retry a compatible failed stage, or npm run qa:full -- --restart for a clearly new run.");
  }
  for (const stage of report.results) {
    // A reused stage is reported as reused. It passed in an earlier run and was not executed
    // here, and a reader has to be able to see that without opening the state file.
    const suffix = stage.status === "blocked" || stage.reused ? ` (${stage.skippedReason})` : stage.durationMs === undefined ? "" : ` (${stage.durationMs} ms)`;
    lines.push(`${stage.name}: ${stage.reused ? "passed (reused, not re-run)" : stage.status}${suffix}`);
    if (stage === report.blocker) lines.push(`First failure: ${stage.classification ?? "stage failure"}${stage.error ? ` — ${stage.error}` : ""}`);
  }
  return lines.join("\n");
}
