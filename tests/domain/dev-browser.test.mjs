import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  createLifecycleTracker,
  developmentChildCommand,
  formatDevelopmentChildSpawnFailure,
  formatBrowserReadinessFailure,
  spawnDevelopmentChild,
  terminateDevelopmentChild,
  waitAndLaunchBrowser
} from "../../scripts/dev-browser-orchestrator.mjs";
import { waitForHealth } from "../../scripts/health-readiness.mjs";

function runningChild() {
  return { exitCode: null, signalCode: null };
}

describe("dev browser readiness correlation", () => {
  it("constructs a Windows cmd child using ComSpec without detaching", () => {
    const environment = { ComSpec: "C:\\Windows\\System32\\cmd.exe", EXAMPLE: "preserved" };
    const launch = developmentChildCommand("win32", environment);
    expect(launch).toEqual({
      command: environment.ComSpec,
      args: ["/d", "/s", "/c", "npm run dev"],
      options: {
        env: environment,
        stdio: ["inherit", "pipe", "pipe"],
        detached: false,
        windowsHide: true
      }
    });
  });

  it("falls back to cmd.exe on Windows and invokes npm directly elsewhere", () => {
    expect(developmentChildCommand("win32", {}).command).toBe("cmd.exe");
    for (const platform of ["darwin", "linux"]) {
      expect(developmentChildCommand(platform, { EXAMPLE: "preserved" })).toEqual({
        command: "npm",
        args: ["run", "dev"],
        options: {
          env: { EXAMPLE: "preserved" },
          stdio: ["inherit", "pipe", "pipe"],
          detached: false
        }
      });
    }
  });

  it("reports synchronous EINVAL safely and does not begin readiness", async () => {
    const health = vi.fn();
    const launch = vi.fn();
    let failure;
    try {
      await spawnDevelopmentChild({
        platform: "win32",
        environment: { ComSpec: "cmd.exe", SECRET: "not-reported" },
        spawnImplementation: () => { throw Object.assign(new Error("raw secret"), { code: "EINVAL" }); }
      });
    } catch (error) {
      failure = error;
    }
    const message = formatDevelopmentChildSpawnFailure(failure);
    expect(message).toContain("invalid_spawn_configuration");
    expect(message).toContain("OS error code: EINVAL");
    expect(message).not.toContain("raw secret");
    expect(message).not.toContain("not-reported");
    expect(health).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("reports an emitted spawn error immediately", async () => {
    const child = new EventEmitter();
    child.stdout = null;
    child.stderr = null;
    const pending = spawnDevelopmentChild({
      platform: "win32",
      environment: {},
      spawnImplementation: () => child
    });
    child.emit("error", Object.assign(new Error("missing command processor"), { code: "ENOENT" }));
    await expect(pending).rejects.toMatchObject({ kind: "spawn_failure", category: "process_spawn_failed" });
  });

  it("accepts a real spawn event before returning the child", async () => {
    const child = new EventEmitter();
    child.stdout = null;
    child.stderr = null;
    const pending = spawnDevelopmentChild({
      platform: "linux",
      environment: {},
      spawnImplementation: () => child
    });
    child.emit("spawn");
    await expect(pending).resolves.toBe(child);
  });

  it("terminates the full Windows child tree without detaching a helper", () => {
    const child = { exitCode: null, signalCode: null, pid: 321, kill: vi.fn() };
    const killer = new EventEmitter();
    const spawnImplementation = vi.fn(() => killer);
    terminateDevelopmentChild(child, "win32", "SIGINT", spawnImplementation);
    expect(spawnImplementation).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/pid", "321", "/t", "/f"],
      { stdio: "ignore", windowsHide: true }
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("forwards signals directly on POSIX", () => {
    const child = { exitCode: null, signalCode: null, kill: vi.fn() };
    terminateDevelopmentChild(child, "linux", "SIGTERM", vi.fn());
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("waits for child READY before accepting a later HTTP 200 and launches once", async () => {
    const tracker = createLifecycleTracker();
    const child = runningChild();
    let clock = 0;
    let fetches = 0;
    const launch = vi.fn();
    const correlatedWait = (url, observedChild, options) => waitForHealth(url, observedChild, {
      ...options,
      intervalMs: 1,
      now: () => clock,
      delayImplementation: async () => {
        clock += 1;
        tracker.ingest("stdout", "[READY] Pawsh listening\n");
      },
      fetchImplementation: async () => {
        fetches += 1;
        return { status: 200 };
      }
    });
    await waitAndLaunchBrowser({
      child,
      tracker,
      appOrigin: "http://127.0.0.1:3000",
      waitForHealth: correlatedWait,
      launchBrowser: launch,
      timeoutMs: 60_000
    });
    expect(fetches).toBe(1);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith("http://127.0.0.1:3000");
  });

  it("announces Pawsh browser provenance exactly once immediately before launch", async () => {
    const tracker = createLifecycleTracker();
    tracker.ingest("stdout", "[READY] Pawsh listening\n");
    const order = [];
    await waitAndLaunchBrowser({
      child: runningChild(), tracker, appOrigin: "http://127.0.0.1:3000",
      waitForHealth: async () => order.push("health"),
      announceBrowserLaunch: () => order.push("[DEV-BROWSER] Opening default browser"),
      launchBrowser: async () => order.push("launch")
    });
    expect(order).toEqual(["health", "[DEV-BROWSER] Opening default browser", "launch"]);
  });

  it("classifies browser launch failure separately from child startup", async () => {
    const tracker = createLifecycleTracker();
    tracker.ingest("stdout", "[READY] Pawsh listening\n");
    await expect(waitAndLaunchBrowser({
      child: runningChild(), tracker, appOrigin: "http://127.0.0.1:3000",
      waitForHealth: async () => {}, announceBrowserLaunch: () => {},
      launchBrowser: async () => { throw Object.assign(new Error("launcher detail"), { code: "EINVAL" }); }
    })).rejects.toMatchObject({ kind: "browser_launch_failure", message: "Default browser launch failed" });
  });

  it("does not query a stale health responder or launch without child READY", async () => {
    const tracker = createLifecycleTracker();
    tracker.ingest("stdout", "[BOOT] Plugin registration begin component=\"cors\"\n");
    let clock = 0;
    const fetchImplementation = vi.fn(async () => ({ status: 200 }));
    const launch = vi.fn();
    const correlatedWait = (url, child, options) => waitForHealth(url, child, {
      ...options,
      timeoutMs: 3,
      intervalMs: 1,
      now: () => clock,
      delayImplementation: async () => { clock += 1; },
      fetchImplementation
    });
    await expect(waitAndLaunchBrowser({
      child: runningChild(), tracker, appOrigin: "http://127.0.0.1:3000",
      waitForHealth: correlatedWait, launchBrowser: launch, timeoutMs: 3
    })).rejects.toMatchObject({ kind: "timeout" });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("stops immediately when the spawned child exits before readiness", async () => {
    const child = { exitCode: 1, signalCode: null };
    await expect(waitForHealth("http://127.0.0.1:3000/health", child, {
      readiness: () => false,
      fetchImplementation: vi.fn()
    })).rejects.toMatchObject({ kind: "child_exit" });
  });

  it("captures a safe configuration failure and prevents browser launch", async () => {
    const tracker = createLifecycleTracker();
    tracker.ingest("stderr", "[ERROR] Configuration validation failed\n");
    const launch = vi.fn();
    await expect(waitAndLaunchBrowser({
      child: runningChild(), tracker, appOrigin: "http://127.0.0.1:3000",
      waitForHealth, launchBrowser: launch, timeoutMs: 60_000
    })).rejects.toMatchObject({ kind: "startup_failure" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a port-conflicted child even when a stale process answers health", async () => {
    const tracker = createLifecycleTracker();
    tracker.ingest("stderr", "[ERROR] Application initialization failed\n");
    const health = vi.fn(async () => ({ status: 200 }));
    const launch = vi.fn();
    const correlatedWait = (url, child, options) => waitForHealth(url, child, {
      ...options,
      fetchImplementation: health
    });
    await expect(waitAndLaunchBrowser({
      child: runningChild(), tracker, appOrigin: "http://127.0.0.1:3000",
      waitForHealth: correlatedWait, launchBrowser: launch
    })).rejects.toMatchObject({ kind: "startup_failure" });
    expect(health).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("reports timeout, lifecycle, and child state without raw output", () => {
    const tracker = createLifecycleTracker();
    tracker.ingest("stdout", "[BOOT] Waiting for PostgreSQL\nraw-secret-that-is-not-reported\n");
    const message = formatBrowserReadinessFailure({ kind: "timeout" }, tracker, runningChild(), 60_000);
    expect(message).toContain("Timed out waiting for Pawsh readiness");
    expect(message).toContain("[BOOT] Waiting for PostgreSQL");
    expect(message).toContain("childRunning=true");
    expect(message).toContain("60000 ms");
    expect(message).not.toContain("raw-secret");
  });

  it("uses the first READY, launches once, and bounds retained output", async () => {
    const tracker = createLifecycleTracker(32);
    tracker.ingest("stdout", `${"x".repeat(100)}\n[READY] first\n[READY] second\n`);
    const launch = vi.fn();
    await waitAndLaunchBrowser({
      child: runningChild(), tracker, appOrigin: "http://127.0.0.1:3000",
      waitForHealth: async (_url, _child, options) => {
        expect(options.readiness()).toBe(true);
      },
      launchBrowser: launch
    });
    expect(tracker.state.firstReady).toBe("[READY] first");
    expect(tracker.state.tail.length).toBeLessThanOrEqual(32);
    expect(launch).toHaveBeenCalledOnce();
  });

  it("does not launch when the child is terminated by a signal", async () => {
    const tracker = createLifecycleTracker();
    tracker.ingest("stdout", "[READY] Pawsh listening\n");
    const child = { exitCode: null, signalCode: "SIGTERM" };
    const launch = vi.fn();
    await expect(waitAndLaunchBrowser({
      child, tracker, appOrigin: "http://127.0.0.1:3000",
      waitForHealth, launchBrowser: launch
    })).rejects.toMatchObject({ kind: "child_exit" });
    expect(launch).not.toHaveBeenCalled();
  });
});
