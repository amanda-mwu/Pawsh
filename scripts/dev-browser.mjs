import { spawn } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";
import { browserLaunchCommand } from "../src/default-browser.js";
import {
  createLifecycleTracker,
  formatDevelopmentChildSpawnFailure,
  formatBrowserReadinessFailure,
  forwardAndTrackChildOutput,
  spawnDevelopmentChild,
  terminateDevelopmentChild,
  waitAndLaunchBrowser,
  waitForChildExit
} from "./dev-browser-orchestrator.mjs";
import { waitForHealth } from "./health-readiness.mjs";

const readinessTimeoutMs = 60_000;
const appOrigin = new URL(process.env.APP_ORIGIN ?? "http://127.0.0.1:3000").origin;
let server;
try {
  server = await spawnDevelopmentChild({ spawnImplementation: spawn });
} catch (error) {
  process.stderr.write(`${formatDevelopmentChildSpawnFailure(error)}\n`);
  process.exitCode = 1;
}

if (server) {
  const tracker = createLifecycleTracker();
  forwardAndTrackChildOutput(server, tracker);

  let stopping = false;
  function stop(signal) {
    if (stopping || server.exitCode !== null || server.signalCode !== null) return;
    stopping = true;
    terminateDevelopmentChild(server, process.platform, signal, spawn);
  }

  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await waitAndLaunchBrowser({
      child: server,
      tracker,
      appOrigin,
      waitForHealth,
      launchBrowser: openDefaultBrowser,
      timeoutMs: readinessTimeoutMs
    });
    process.exitCode = await waitForChildExit(server);
  } catch (error) {
    if (!stopping) process.stderr.write(`${formatBrowserReadinessFailure(error, tracker, server, readinessTimeoutMs)}\n`);
    const kind = error && typeof error === "object" && "kind" in error ? error.kind : "startup_failure";
    if (kind !== "browser_launch_failure") stop("SIGTERM");
    process.exitCode = await waitForChildExit(server);
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

function openDefaultBrowser(url) {
  const launch = browserLaunchCommand(url);
  return new Promise((resolve, reject) => {
    const browser = spawn(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: true });
    browser.once("error", reject);
    browser.once("spawn", () => {
      browser.unref();
      resolve();
    });
  });
}
