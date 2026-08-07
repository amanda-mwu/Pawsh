import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlaywrightQaEnvironment, environmentFingerprint, loadQaState, writeQaState } from "../../scripts/qa-environment.mjs";
import { runQaCascade, runQaResume } from "../../scripts/qa-cascade.mjs";

const base = { DATABASE_URL: "postgres://pawsh:pawsh-local-only@127.0.0.1:55432/pawsh", CUSTOM_TEST_VALUE: "preserved" };

describe("disposable QA environment and resumable state", () => {
  it("injects safe Playwright settings without mutating the parent", () => {
    const env = createPlaywrightQaEnvironment(base);
    expect(env.NODE_ENV).toBe("test");
    expect(env.PAWSH_E2E_MODE).toBe("disposable");
    expect(env.DOCUMENT_STORAGE_ADAPTER).toBe("memory");
    expect(env.DOCUMENT_SCANNER_ADAPTER).toBe("deterministic");
    expect(env.CUSTOM_TEST_VALUE).toBe("preserved");
    expect(base.PAWSH_E2E_MODE).toBeUndefined();
  });

  it("rejects unsafe database and explicit unsafe modes", () => {
    expect(() => createPlaywrightQaEnvironment({ ...base, DATABASE_URL: "postgres://user:pw@example.com/pawsh" })).toThrow(/loopback/);
    expect(() => createPlaywrightQaEnvironment({ ...base, PAWSH_E2E_MODE: "shared" })).toThrow(/disposable/);
    expect(() => createPlaywrightQaEnvironment({ ...base, DOCUMENT_SCANNER_ADAPTER: "http" })).toThrow(/deterministic/);
  });

  it("writes atomic state without secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pawsh-qa-state-"));
    const path = join(dir, "state.json");
    await writeQaState({ sha: "abc", environmentFingerprint: environmentFingerprint(createPlaywrightQaEnvironment(base)), overallStatus: "failed", mode: "standard", firstFailedStage: "smoke", cleanupStatus: "complete", secret: "must-not-be-written" }, path);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("must-not-be-written");
    expect((await loadQaState(path)).schemaVersion).toBe(2);
  });

  it("constructs safe defaults from a normal developer shell", () => {
    const env = createPlaywrightQaEnvironment({ CUSTOM_TEST_VALUE: "preserved" });
    expect(env.NODE_ENV).toBe("test");
    expect(env.PAWSH_E2E_MODE).toBe("disposable");
    expect(env.DOCUMENT_SCANNER_ADAPTER).toBe("deterministic");
    expect(env.DOCUMENT_STORAGE_ADAPTER).toBe("memory");
    expect(env.APP_ORIGIN).toBe("http://127.0.0.1:3000");
    expect(env.DATABASE_URL).toMatch(/127\.0\.0\.1:55432\/pawsh/);
    expect(env.SESSION_SECRET).toHaveLength(45);
  });

  it("normalizes a development parent without mutating it", () => {
    const parent = { NODE_ENV: "development" };
    const env = createPlaywrightQaEnvironment(parent);
    expect(env.NODE_ENV).toBe("test");
    expect(parent.NODE_ENV).toBe("development");
  });

  it("rejects an explicitly unsafe production runtime override", () => {
    expect(() => createPlaywrightQaEnvironment({ ...base, NODE_ENV: "production" })).toThrow(/Unsafe QA NODE_ENV/);
    expect(() => createPlaywrightQaEnvironment({ ...base, APP_ORIGIN: "https://pawsh.example.com" })).toThrow(/APP_ORIGIN/);
    expect(() => createPlaywrightQaEnvironment({ ...base, PAWSH_E2E_BASE_URL: "http://127.0.0.1:3000" })).toThrow(/owns its Pawsh server/);
  });

  it("fingerprints only safe compatibility classes", () => {
    const env = createPlaywrightQaEnvironment(base);
    const fingerprint = environmentFingerprint(env);
    expect(fingerprint).not.toContain("pawsh-local-only");
    expect(fingerprint).not.toContain("postgres");
    expect(fingerprint).not.toContain(env.SESSION_SECRET);
    expect(environmentFingerprint({ ...env, DATABASE_URL: "postgres://other:secret@127.0.0.1:55432/another" })).toBe(fingerprint);
  });

  it("resumes only a compatible same-SHA failed stage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pawsh-qa-resume-"));
    const path = join(dir, "state.json");
    const env = { ...base, PAWSH_QA_SHA: "same-sha" };
    const calls = [];
    await runQaCascade({ mode: "standard", env, statePath: path, stageRunner: async (stage) => { calls.push(stage.command); return stage.command === "lint" ? { status: "failed", classification: "static_failure" } : { status: "passed" }; } });
    await expect(runQaResume({ env: { ...env, PAWSH_QA_SHA: "other-sha" }, statePath: path })).rejects.toThrow(/exact SHA/);
    calls.length = 0;
    const report = await runQaResume({ env, statePath: path, stageRunner: async (stage) => { calls.push(stage.command); return { status: "passed" }; } });
    expect(report.status).toBe("passed");
    expect(calls[0]).toBe("lint");
  });

  it("refuses full progression after an unresolved same-SHA failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pawsh-qa-progress-"));
    const path = join(dir, "state.json");
    const env = { ...base, PAWSH_QA_SHA: "same-sha" };
    await runQaCascade({ mode: "standard", env, statePath: path, stageRunner: async () => ({ status: "failed", classification: "failure" }) });
    const report = await runQaCascade({ mode: "full", env, statePath: path, stageRunner: async () => ({ status: "passed" }) });
    expect(report.blocker.classification).toBe("prior_run_unresolved");
  });
});
