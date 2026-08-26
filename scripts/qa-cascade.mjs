/* global setTimeout, clearTimeout */
import { spawn } from "node:child_process";
import process from "node:process";
import { terminateOwnedProcessTree, createBoundedOutputTail, redactDiagnosticText } from "./playwright-lifecycle.mjs";
import { createPlaywrightQaEnvironment, currentQaIdentity, loadQaState, QA_ORCHESTRATOR_VERSION, QA_STATE_PATH, writeQaState } from "./qa-environment.mjs";

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
    { name: "static", timeoutClass: "static", run: runStatic },
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

export async function runQaCascade({ mode = "quick", env = process.env, stageRunner = runStageProcess, timeouts = parseQaTimeouts(env), statePath = QA_STATE_PATH, persistState = true, restart = false, allowPriorFailure = false, startAt = 0 } = {}) {
  if (!QA_MODES.has(mode)) throw new Error(`Unknown QA mode: ${mode}`);
  const qaEnv = createPlaywrightQaEnvironment(env);
  const identity = currentQaIdentity(qaEnv);
  const prior = persistState ? await loadQaState(statePath) : null;
  if ((mode === "full" || mode === "release-candidate") && prior && prior.sha === identity.sha && prior.overallStatus === "failed" && !restart && !allowPriorFailure) {
    return { mode, status: "failed", blocker: { name: "progression", classification: "prior_run_unresolved", error: `A prior ${prior.mode} run failed at ${prior.firstFailedStage ?? "an unknown stage"}. Use qa:resume or --restart.` }, results: [] };
  }
  const stages = stageDefinitions(mode);
  const results = [];
  let blocker = null;
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (index < startAt) {
      results.push({ name: stage.name, status: "passed", reused: true, skippedReason: "reused after compatible state validation" });
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
    results.push(result);
    if (result.status !== "passed") blocker = result;
    if (persistState) await writeQaState({ sha: identity.sha, branch: identity.branch, mode, startedAt: results[0]?.startedAt ?? Date.now(), completedAt: result.status === "passed" && index === stages.length - 1 ? Date.now() : undefined, overallStatus: result.status === "passed" && index === stages.length - 1 ? "passed" : "failed", lastCompletedStage: result.status === "passed" ? stage.name : results[index - 1]?.name, firstFailedStage: result.status === "passed" ? undefined : stage.name, failureClassification: result.classification, cleanupStatus: result.cleanupStatus ?? "complete", environmentFingerprint: identity.fingerprint, orchestratorVersion: QA_ORCHESTRATOR_VERSION }, statePath);
  }
  const report = { mode, status: blocker ? "failed" : "passed", blocker, results };
  if (persistState) await writeQaState({ sha: identity.sha, branch: identity.branch, mode, startedAt: results[0]?.startedAt ?? Date.now(), completedAt: Date.now(), overallStatus: report.status, lastCompletedStage: results.at(-1)?.name, firstFailedStage: blocker?.name, failureClassification: blocker?.classification, cleanupStatus: results.every((item) => item.cleanupStatus !== "incomplete") ? "complete" : "incomplete", environmentFingerprint: identity.fingerprint, orchestratorVersion: QA_ORCHESTRATOR_VERSION }, statePath);
  return report;
}

export async function runQaResume({ env = process.env, stageRunner = runStageProcess, statePath = QA_STATE_PATH } = {}) {
  const qaEnv = createPlaywrightQaEnvironment(env);
  const state = await loadQaState(statePath);
  if (!state) throw new Error("No valid QA state is available for resume");
  const identity = currentQaIdentity(qaEnv);
  if (state.sha !== identity.sha) throw new Error("QA resume requires an exact SHA match");
  if (state.environmentFingerprint !== identity.fingerprint) throw new Error("QA resume requires a compatible environment fingerprint");
  if (state.cleanupStatus !== "complete") throw new Error("QA resume refused because prior cleanup was incomplete");
  if (state.overallStatus !== "failed" || !state.firstFailedStage) throw new Error("QA resume requires a failed stage");
  const index = stageDefinitions(state.mode).findIndex((stage) => stage.name === state.firstFailedStage);
  if (index < 0) throw new Error("QA resume state names an unknown stage");
  return runQaCascade({ mode: state.mode, env, stageRunner, statePath, persistState: true, allowPriorFailure: true, startAt: index });
}

export function formatQaReport(report) {
  const lines = [`QA mode: ${report.mode}`, `Overall: ${report.status}`];
  if (report.blocker && !report.results.includes(report.blocker)) {
    lines.push(`First failure: ${report.blocker.classification ?? "stage failure"}${report.blocker.error ? ` — ${report.blocker.error}` : ""}`);
    lines.push("Use npm run qa:resume to retry a compatible failed stage, or npm run qa:full -- --restart for a clearly new run.");
  }
  for (const stage of report.results) {
    const suffix = stage.status === "blocked" ? ` (${stage.skippedReason})` : stage.durationMs === undefined ? "" : ` (${stage.durationMs} ms)`;
    lines.push(`${stage.name}: ${stage.status}${suffix}`);
    if (stage === report.blocker) lines.push(`First failure: ${stage.classification ?? "stage failure"}${stage.error ? ` — ${stage.error}` : ""}`);
  }
  return lines.join("\n");
}
