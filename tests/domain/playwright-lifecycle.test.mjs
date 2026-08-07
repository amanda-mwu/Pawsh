/* global process */
import { describe, expect, it } from "vitest";
import { parseWrapperTimeout, redactDiagnosticText, runPlaywrightInvocation } from "../../scripts/playwright-lifecycle.mjs";

const externalEnv = { ...process.env, PAWSH_E2E_BASE_URL: "http://127.0.0.1:39999", NODE_ENV: "test" };

function runChild(source, timeoutMs = 2_000) {
  return runPlaywrightInvocation({
    env: externalEnv,
    platform: process.platform,
    args: ["--project", "chromium"],
    timeoutMs,
    waitForServerReady: async () => {},
    playwrightCommand: process.execPath,
    playwrightArgs: ["-e", source],
    cleanupGraceMs: 500,
    portReleaseTimeoutMs: 200
  });
}

describe("Playwright lifecycle guard", () => {
  it("is import-safe and validates timeout profiles", () => {
    expect(parseWrapperTimeout({ args: ["--project", "chromium"], env: {} }).profile).toBe("targeted");
    expect(() => parseWrapperTimeout({ env: { PAWSH_PLAYWRIGHT_WRAPPER_TIMEOUT_MS: "0" } })).toThrow();
  });

  it("preserves a successful child result", async () => {
    const result = await runChild("process.exit(0)");
    expect(result.kind).toBe("success");
    expect(result.exitCode).toBe(0);
    expect(result.cleanup.status).toBe("complete");
  });

  it("preserves a nonzero child result", async () => {
    const result = await runChild("process.stderr.write('failure\\n');process.exit(7)");
    expect(result.kind).toBe("playwright_failure");
    expect(result.exitCode).toBe(7);
    expect(result.cleanup.status).toBe("complete");
    expect(result.output.playwright.stderr).toContain("failure");
  });

  it("bounds a hanging child and returns the watchdog code", async () => {
    const started = Date.now();
    const result = await runChild("setInterval(() => {}, 1000)", 1_000);
    expect(result.kind).toBe("watchdog_timeout");
    expect(result.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.cleanup.status).toBe("complete");
  });

  it("returns promptly when the Playwright child cannot spawn", async () => {
    const started = Date.now();
    const result = await runPlaywrightInvocation({
      env: externalEnv,
      platform: process.platform,
      args: ["--project", "chromium"],
      timeoutMs: 2_000,
      waitForServerReady: async () => {},
      playwrightCommand: `${process.execPath}.missing`,
      playwrightArgs: [],
      cleanupGraceMs: 100,
      portReleaseTimeoutMs: 100
    });
    expect(result.kind).toBe("playwright_spawn_error");
    expect(result.exitCode).toBe(125);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("redacts credential-bearing diagnostics", () => {
    const text = redactDiagnosticText("DATABASE_URL=postgres://user:secret@localhost/db token=abc authorization: Bearer xyz");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("abc");
    expect(text).not.toContain("xyz");
  });
});
