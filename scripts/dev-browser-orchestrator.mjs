import process from "node:process";
import { URL } from "node:url";

export function createLifecycleTracker(tailLimit = 8_192) {
  const state = {
    latestBoot: undefined,
    firstReady: undefined,
    latestError: undefined,
    tail: ""
  };
  const pending = { stdout: "", stderr: "" };
  return {
    state,
    ingest(channel, value) {
      const text = String(value);
      state.tail = `${state.tail}${text}`.slice(-tailLimit);
      const lines = `${pending[channel]}${text}`.split(/\r?\n/);
      pending[channel] = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("[BOOT] ")) state.latestBoot = line;
        else if (line.startsWith("[READY] ") && !state.firstReady) state.firstReady = line;
        else if (line.startsWith("[ERROR] ")) state.latestError = line;
      }
    }
  };
}

export function forwardAndTrackChildOutput(child, tracker, stdout = process.stdout, stderr = process.stderr) {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (value) => {
    stdout.write(value);
    tracker.ingest("stdout", value);
  });
  child.stderr?.on("data", (value) => {
    stderr.write(value);
    tracker.ingest("stderr", value);
  });
}

export async function waitAndLaunchBrowser({
  child,
  tracker,
  appOrigin,
  waitForHealth,
  launchBrowser,
  timeoutMs = 60_000
}) {
  const healthUrl = `${new URL(appOrigin).origin}/health`;
  await waitForHealth(healthUrl, child, {
    timeoutMs,
    readiness: () => Boolean(tracker.state.firstReady),
    failure: () => tracker.state.latestError
  });
  if (child.exitCode !== null || child.signalCode !== null) {
    throw Object.assign(new Error("Pawsh exited after readiness and before browser launch"), { kind: "child_exit" });
  }
  await launchBrowser(new URL(appOrigin).origin);
}

export function formatBrowserReadinessFailure(error, tracker, child, timeoutMs) {
  const kind = error && typeof error === "object" && "kind" in error ? error.kind : "startup_failure";
  const category = kind === "timeout" ? "Timed out waiting for Pawsh readiness" : "Startup failed";
  const exit = child.exitCode !== null ? `exitCode=${child.exitCode}`
    : child.signalCode !== null ? `signal=${child.signalCode}` : "childRunning=true";
  return [
    `[ERROR] ${category}`,
    `Last lifecycle stage: ${tracker.state.latestBoot ?? "none"}`,
    `Latest lifecycle error: ${tracker.state.latestError ?? "none"}`,
    `Child state: ${exit}`,
    ...(kind === "timeout" ? [`Readiness deadline: ${timeoutMs} ms`] : [])
  ].join("\n");
}

export function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode ?? 1);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}
