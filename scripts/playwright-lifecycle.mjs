/* global AbortController, fetch, setTimeout, clearTimeout, queueMicrotask */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

export const WRAPPER_TIMEOUT_CODE = 124;
export const WRAPPER_FAILURE_CODE = 125;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULTS = { smoke: 300_000, targeted: 600_000, full: 900_000 };
const CLEANUP_GRACE_MS = 5_000;

export function invocationProfile(args = []) {
  if (args.some((value) => value === "--grep" && /smoke/i.test(args[args.indexOf(value) + 1] ?? ""))) return "smoke";
  if (args.includes("--project") || args.includes("--grep")) return "targeted";
  return "full";
}

export function parseWrapperTimeout({ args = [], env = process.env, profile = invocationProfile(args) } = {}) {
  const raw = env.PAWSH_PLAYWRIGHT_WRAPPER_TIMEOUT_MS;
  const value = raw === undefined || raw === "" ? DEFAULTS[profile] : Number(raw);
  if (!Number.isFinite(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(`PAWSH_PLAYWRIGHT_WRAPPER_TIMEOUT_MS must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return { profile, timeoutMs: Math.trunc(value), source: raw === undefined || raw === "" ? "profile_default" : "environment" };
}

export function redactDiagnosticText(value) {
  return String(value)
    .replace(/(postgres(?:ql)?:\/\/)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:session[_-]?secret|token|password|api[_-]?key|authorization)[^=:\s]*\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]");
}

export function createBoundedOutputTail(limit = 16_384) {
  let stdout = "";
  let stderr = "";
  return {
    append(channel, value) {
      const text = String(value);
      if (channel === "stdout") stdout = `${stdout}${text}`.slice(-limit);
      else stderr = `${stderr}${text}`.slice(-limit);
    },
    get stdout() { return redactDiagnosticText(stdout); },
    get stderr() { return redactDiagnosticText(stderr); },
    get hasOutput() { return Boolean(stdout || stderr); }
  };
}

export function deriveTargetEndpoint(env = process.env) {
  const origin = env.PAWSH_E2E_BASE_URL ?? env.APP_ORIGIN ?? "http://127.0.0.1:3000";
  const url = new URL(origin);
  return { origin: url.origin, healthUrl: new URL("/health", url).toString(), hostname: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), local: ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) };
}

async function waitForEndpoint(url, { child, timeoutMs, requestTimeoutMs = 5_000, signal, output = () => "" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw lifecycleError("shutdown", "Readiness cancelled");
    if (child?.exitCode !== null || child?.signalCode !== null) throw lifecycleError("server_exit", `Server exited before readiness${output()}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 200) return;
    } catch { /* bounded request failed; retry until total deadline */ }
    finally { clearTimeout(timer); }
    await delay(100, undefined, { signal }).catch(() => { throw lifecycleError("shutdown", "Readiness cancelled"); });
  }
  throw lifecycleError("readiness_timeout", `Timed out waiting for ${url}${output()}`);
}

function lifecycleError(kind, message) { return Object.assign(new Error(message), { kind }); }

function attachOutput(child, tail, label, stdout = process.stdout, stderr = process.stderr) {
  const attach = (stream, channel, target) => {
    stream?.setEncoding("utf8");
    stream?.on("data", (value) => { tail.append(channel, value); target.write(value); });
  };
  attach(child.stdout, "stdout", stdout);
  attach(child.stderr, "stderr", stderr);
  return label;
}

function spawnOwned(command, args, options, spawnImplementation = spawn) {
  const child = spawnImplementation(command, args, options);
  return child;
}

async function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false)
  ]);
}

function waitForSpawn(child) {
  if (!child || typeof child.once !== "function") return Promise.resolve();
  if (Number.isInteger(child.pid) && child.pid > 0) {
    // On Windows the child may be assigned a PID before the async `spawn`
    // event is observable by this wrapper. The PID is the authoritative
    // successful-spawn signal; retain a no-op error listener for the brief
    // post-spawn window so an asynchronous error is not unhandled.
    child.once("error", () => {});
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onSpawn = () => { child.removeListener("error", onError); resolve(); };
    const onError = (error) => { child.removeListener("spawn", onSpawn); reject(Object.assign(error, { kind: "spawn_error" })); };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function terminateRoot(child, platform, spawnImplementation = spawn, graceMs = CLEANUP_GRACE_MS) {
  if (!child?.pid || !Number.isInteger(child.pid) || child.pid <= 0) return { status: "complete", reason: "no_live_root" };
  if (child.exitCode !== null || child.signalCode !== null) return { status: "complete", reason: "already_exited" };
  if (platform === "win32") {
    try {
      const killer = spawnImplementation("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      const killResult = await Promise.race([
        new Promise((resolve) => killer.once("exit", (code, signal) => resolve({ completed: true, code, signal }))),
        delay(graceMs).then(() => ({ completed: false }))
      ]);
      if (!killResult.completed) return { status: "incomplete", reason: "taskkill_timeout" };
      if (killResult.code === 0) return { status: "complete", reason: "taskkill" };
      // taskkill may report a nonzero code when the root exited between the
      // state check and command execution. The bounded command itself has
      // completed; port verification and the retained PID evidence remain
      // authoritative for the final cleanup report.
      return { status: "complete", reason: `taskkill_completed_${killResult.code ?? "unknown"}` };
    } catch { return { status: "incomplete", reason: "taskkill_failed" }; }
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") return { status: "incomplete", reason: "group_term_failed" }; }
  if (await waitForProcessExit(child, graceMs)) return { status: "complete", reason: "group_term" };
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") return { status: "incomplete", reason: "group_kill_failed" }; }
  return { status: await waitForProcessExit(child, graceMs) ? "complete" : "incomplete", reason: "group_kill" };
}

export async function terminateOwnedProcessTree({ child, platform = process.platform, spawnImplementation = spawn, graceMs = CLEANUP_GRACE_MS } = {}) {
  return terminateRoot(child, platform, spawnImplementation, graceMs);
}

function closeChildStreams(child) {
  for (const stream of [child?.stdout, child?.stderr]) {
    if (stream && typeof stream.destroy === "function") stream.destroy();
  }
}

export async function verifyPortReleased({ hostname, port, timeoutMs = 5_000 } = {}) {
  if (!Number.isInteger(port) || port <= 0 || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) return { status: "not_applicable" };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const server = createServer();
    const available = await new Promise((resolve) => {
      const done = (value) => { server.removeAllListeners(); server.close(() => resolve(value)); };
      server.once("error", () => done(false));
      server.listen(port, hostname, () => done(true));
    });
    if (available) return { status: "released" };
    await delay(100);
  }
  return { status: "unavailable" };
}

export async function runPlaywrightInvocation(options = {}) {
  const env = options.env ?? process.env;
  const args = options.args ?? [];
  const platform = options.platform ?? process.platform;
  const endpoint = deriveTargetEndpoint(env);
  const profile = parseWrapperTimeout({ args, env, profile: options.profile });
  const timeoutMs = options.timeoutMs ?? profile.timeoutMs;
  const spawnImplementation = options.spawnImplementation ?? spawn;
  const output = {
    server: createBoundedOutputTail(options.tailLimit),
    playwright: createBoundedOutputTail(options.tailLimit)
  };
  const ownedServer = !env.PAWSH_E2E_BASE_URL;
  const roots = { server: null, playwright: null };
  const startedAt = Date.now();
  let shutdown = false;
  let settled = false;
  let timer;
  let watchdogTriggered = false;
  let resolveWatchdog = () => {};
  let resolveSignal = () => {};
  const abortController = new AbortController();
  let serverExit;
  let signalHandlers = [];
  let cleanupResult = { status: "complete", port: { status: "not_applicable" } };
  let cleanupPromise;
  let primary = null;
  const spawnOptions = { env: { ...env, APP_ORIGIN: env.APP_ORIGIN ?? endpoint.origin, PAWSH_E2E_BASE_URL: endpoint.origin }, stdio: ["inherit", "pipe", "pipe"], detached: platform !== "win32", windowsHide: platform === "win32" };
  const waitReady = options.waitForServerReady ?? ((child) => waitForEndpoint(endpoint.healthUrl, { child, timeoutMs: options.serverReadyTimeoutMs ?? 30_000, requestTimeoutMs: options.healthRequestTimeoutMs ?? 5_000, signal: abortController.signal, output: () => output.server.stderr }));
  const cleanup = async () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const results = [];
      if (roots.playwright) {
        results.push(await terminateRoot(roots.playwright, platform, spawnImplementation, options.cleanupGraceMs ?? CLEANUP_GRACE_MS));
        closeChildStreams(roots.playwright);
      }
      if (roots.server && ownedServer) {
        results.push(await terminateRoot(roots.server, platform, spawnImplementation, options.cleanupGraceMs ?? CLEANUP_GRACE_MS));
        closeChildStreams(roots.server);
      }
      cleanupResult = { status: results.every((item) => item.status === "complete") ? "complete" : "incomplete", roots: results, port: ownedServer ? await verifyPortReleased({ hostname: endpoint.hostname, port: endpoint.port, timeoutMs: options.portReleaseTimeoutMs ?? 5_000 }) : { status: "not_owned" } };
      return cleanupResult;
    })();
    return cleanupPromise;
  };
  const finish = async (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    for (const [event, handler] of signalHandlers) process.removeListener(event, handler);
    await cleanup();
    result.cleanup = cleanupResult;
    result.elapsedMs = Date.now() - startedAt;
    result.output = output;
    result.profile = profile.profile;
    result.timeoutMs = timeoutMs;
    result.roots = { server: roots.server?.pid ?? null, playwright: roots.playwright?.pid ?? null };
    result.endpoint = endpoint.origin;
    primary = result;
  };
  const signalResult = new Promise((resolve) => { resolveSignal = resolve; });
  const onSignal = () => {
    if (shutdown) return;
    shutdown = true;
    abortController.abort();
    resolveSignal({ kind: "signal", exitCode: WRAPPER_FAILURE_CODE, error: "Wrapper shutdown requested" });
  };
  signalHandlers = [["SIGINT", onSignal], ["SIGTERM", onSignal]];
  for (const [event, handler] of signalHandlers) process.once(event, handler);
  timer = setTimeout(() => { watchdogTriggered = true; abortController.abort(); resolveWatchdog({ kind: "watchdog_timeout", exitCode: WRAPPER_TIMEOUT_CODE, error: `Playwright wrapper timeout after ${timeoutMs} ms (profile ${profile.profile})` }); void cleanup(); }, timeoutMs);
  try {
    if (ownedServer) {
      try {
        roots.server = spawnOwned(process.execPath, ["--import", "./scripts/load-env.mjs", "--import", "tsx", "src/server.ts"], spawnOptions, spawnImplementation);
        attachOutput(roots.server, output.server, "server");
        serverExit = new Promise((resolve) => roots.server.once("exit", (code, signal) => resolve({ code, signal })));
        await waitForSpawn(roots.server);
        await waitReady(roots.server);
      } catch (error) {
        await finish(watchdogTriggered ? { kind: "watchdog_timeout", exitCode: WRAPPER_TIMEOUT_CODE, error: `Playwright wrapper timeout after ${timeoutMs} ms (profile ${profile.profile})` } : { kind: error.kind ?? "server_failure", exitCode: WRAPPER_FAILURE_CODE, error: error.message });
        return primary;
      }
    } else {
      try { await waitReady(null); } catch (error) { await finish({ kind: error.kind ?? "external_server_failure", exitCode: WRAPPER_FAILURE_CODE, error: error.message }); return primary; }
    }
    try {
      const playwrightCommand = options.playwrightCommand ?? process.execPath;
      const playwrightArgs = options.playwrightArgs ?? ["node_modules/@playwright/test/cli.js", "test", ...args];
      roots.playwright = spawnOwned(playwrightCommand, playwrightArgs, { ...spawnOptions, detached: platform !== "win32" }, spawnImplementation);
      attachOutput(roots.playwright, output.playwright, "playwright");
      await waitForSpawn(roots.playwright);
    } catch (error) {
      await finish({ kind: "playwright_spawn_error", exitCode: WRAPPER_FAILURE_CODE, error: error.message });
      return primary;
    }
    const resultPromise = new Promise((resolve) => {
      let playwrightSettled = false;
      const onError = (error) => {
        if (playwrightSettled) return;
        playwrightSettled = true;
        roots.playwright.removeListener("exit", onExit);
        resolve({ kind: "playwright_spawn_error", exitCode: WRAPPER_FAILURE_CODE, error: error.message });
      };
      const onExit = (code, signal) => {
        if (playwrightSettled) return;
        playwrightSettled = true;
        roots.playwright.removeListener("error", onError);
        resolve(shutdown ? { kind: "signal", exitCode: WRAPPER_FAILURE_CODE } : { kind: code === 0 ? "success" : "playwright_failure", exitCode: code ?? WRAPPER_FAILURE_CODE, signal });
      };
      roots.playwright.once("error", onError);
      roots.playwright.once("exit", onExit);
      if (roots.playwright.exitCode !== null || roots.playwright.signalCode !== null) {
        queueMicrotask(() => onExit(roots.playwright.exitCode, roots.playwright.signalCode));
      }
      if (serverExit && ownedServer) serverExit.then(() => { if (!settled && !playwrightSettled) resolve({ kind: "server_exit", exitCode: WRAPPER_FAILURE_CODE, error: "Owned Pawsh server exited unexpectedly" }); });
    });
    const watchdog = new Promise((resolve) => { resolveWatchdog = () => resolve({ kind: "watchdog_timeout", exitCode: WRAPPER_TIMEOUT_CODE, error: `Playwright wrapper timeout after ${timeoutMs} ms (profile ${profile.profile})` }); });
    const result = await Promise.race([resultPromise, watchdog, signalResult, watchdogTriggered ? Promise.resolve({ kind: "watchdog_timeout", exitCode: WRAPPER_TIMEOUT_CODE, error: `Playwright wrapper timeout after ${timeoutMs} ms (profile ${profile.profile})` }) : new Promise(() => {})]);
    await finish(result);
    return primary;
  } finally {
    if (!settled) await finish({ kind: "wrapper_failure", exitCode: WRAPPER_FAILURE_CODE, error: "Wrapper terminated before a result was settled" });
  }
}
