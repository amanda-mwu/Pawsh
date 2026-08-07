/* global setTimeout, clearTimeout */
import { spawn } from "node:child_process";
import process from "node:process";
import { terminateOwnedProcessTree, createBoundedOutputTail, redactDiagnosticText } from "./playwright-lifecycle.mjs";

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
    { name: "critical", timeoutClass: "critical", command: "test -- tests/domain/playwright-lifecycle.test.mjs" },
    { name: "database", timeoutClass: "database", run: runDatabase },
    { name: "startup", timeoutClass: "startup", command: "compatibility:startup" },
    { name: "preflight", timeoutClass: "preflight", run: (env, timeoutMs, stageRunner) => runPreflights(mode, env, timeoutMs, stageRunner) },
    { name: "smoke", timeoutClass: "smoke", command: "test:smoke" }
  ];
  if (mode !== "quick") base.push({ name: "targeted", timeoutClass: "targeted", command: "test -- tests/domain/playwright-lifecycle.test.mjs tests/database/rabies-compliance.test.ts" });
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
  return runSeries(browsers.map((browser) => ({ name: `browser-preflight:${browser}`, command: `qa:browser-preflight ${browser}` })), timeoutMs, env, stageRunner);
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
  if (script === "test" && args.length) return process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `npm run test -- ${args.join(" ")}`] }
    : { command: "npm", args: ["run", "test", "--", ...args] };
  if (script === "qa:browser-preflight") return { command: process.execPath, args: ["scripts/browser-preflight.mjs", args[0]] };
  if (script === "test:cross-browser") return npmInvocation("test:cross-browser");
  if (args.length) return process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `npm run ${script} -- ${args.join(" ")}`] }
    : { command: "npm", args: ["run", script, "--", ...args] };
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

export async function runQaCascade({ mode = "quick", env = process.env, stageRunner = runStageProcess, timeouts = parseQaTimeouts(env) } = {}) {
  if (!QA_MODES.has(mode)) throw new Error(`Unknown QA mode: ${mode}`);
  const results = [];
  let blocker = null;
  for (const stage of stageDefinitions(mode)) {
    if (blocker) {
      results.push({ name: stage.name, status: "blocked", skippedReason: `blocked by ${blocker.name}` });
      continue;
    }
    const startedAt = Date.now();
    let result;
    try { result = stage.run ? await stage.run(env, timeouts[stage.timeoutClass], stageRunner) : await stageRunner(stage, timeouts[stage.timeoutClass], env); }
    catch (error) { result = { status: "failed", classification: "stage_exception", error: redactDiagnosticText(error.message) }; }
    result = { status: "passed", ...result, name: stage.name, startedAt, completedAt: Date.now(), durationMs: result.durationMs ?? Date.now() - startedAt, timeoutMs: timeouts[stage.timeoutClass] };
    results.push(result);
    if (result.status !== "passed") blocker = result;
  }
  return { mode, status: blocker ? "failed" : "passed", blocker, results };
}

export function formatQaReport(report) {
  const lines = [`QA mode: ${report.mode}`, `Overall: ${report.status}`];
  for (const stage of report.results) {
    const suffix = stage.status === "blocked" ? ` (${stage.skippedReason})` : stage.durationMs === undefined ? "" : ` (${stage.durationMs} ms)`;
    lines.push(`${stage.name}: ${stage.status}${suffix}`);
    if (stage === report.blocker) lines.push(`First failure: ${stage.classification ?? "stage failure"}${stage.error ? ` — ${stage.error}` : ""}`);
  }
  return lines.join("\n");
}
