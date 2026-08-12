import process from "node:process";
import { URL } from "node:url";

export function developmentChildCommand(platform, environment, script = "dev") {
  if (!/^[a-z0-9:_-]+$/i.test(script)) throw new Error("Invalid repository npm script name");
  const common = {
    env: environment,
    stdio: ["inherit", "pipe", "pipe"],
    detached: false
  };
  if (platform === "win32") {
    return {
      command: environment.ComSpec || environment.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", `npm run ${script}`],
      options: { ...common, windowsHide: true }
    };
  }
  return { command: "npm", args: ["run", script], options: common };
}

export async function spawnDevelopmentChild({
  platform = process.platform,
  environment = process.env,
  script = "dev",
  spawnImplementation
}) {
  const launch = developmentChildCommand(platform, environment, script);
  let child;
  try {
    child = spawnImplementation(launch.command, launch.args, launch.options);
  } catch (error) {
    throw spawnFailure(error, platform);
  }
  await new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener("error", onError);
      resolve();
    };
    const onError = (error) => {
      child.removeListener("spawn", onSpawn);
      reject(spawnFailure(error, platform));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
  return child;
}

export function formatDevelopmentChildSpawnFailure(error) {
  const category = error && typeof error === "object" && "category" in error
    ? error.category : "process_spawn_failed";
  const platform = error && typeof error === "object" && "platform" in error
    ? error.platform : process.platform;
  const osCode = error && typeof error === "object" && "osCode" in error
    ? error.osCode : undefined;
  return [
    "[ERROR] Failed to start Pawsh development process",
    `Platform: ${platform}`,
    `Error category: ${category}`,
    ...(osCode ? [`OS error code: ${osCode}`] : [])
  ].join("\n");
}

export function terminateDevelopmentChild(child, platform, signal, spawnImplementation) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform !== "win32") {
    child.kill(signal);
    return;
  }
  const killer = spawnImplementation("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true
  });
  killer.once("error", () => child.kill(signal));
}

function spawnFailure(error, platform) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const category = code === "EINVAL" ? "invalid_spawn_configuration" : "process_spawn_failed";
  return Object.assign(new Error("Pawsh development child could not be spawned"), {
    kind: "spawn_failure", category, platform, osCode: code, cause: error
  });
}

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
  announceBrowserLaunch = () => process.stdout.write("[DEV-BROWSER] Opening default browser\n"),
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
  announceBrowserLaunch();
  try {
    await launchBrowser(new URL(appOrigin).origin);
  } catch (error) {
    throw Object.assign(new Error("Default browser launch failed", { cause: error }), { kind: "browser_launch_failure" });
  }
}

export function formatBrowserReadinessFailure(error, tracker, child, timeoutMs) {
  const kind = error && typeof error === "object" && "kind" in error ? error.kind : "startup_failure";
  const category = kind === "timeout" ? "Timed out waiting for Pawsh readiness"
    : kind === "browser_launch_failure" ? "Default browser launch failed" : "Startup failed";
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
