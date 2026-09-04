import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIdentity, createPlaywrightQaEnvironment, environmentFingerprint, loadQaState, QA_ENVIRONMENT_SCHEMA_VERSION, workingTreeIdentity, writeQaState } from "../../scripts/qa-environment.mjs";
import { runQaCascade, runQaResume } from "../../scripts/qa-cascade.mjs";

const base = { DATABASE_URL: "postgres://pawsh:pawsh-local-only@127.0.0.1:55432/pawsh", CUSTOM_TEST_VALUE: "preserved" };

describe("disposable QA environment and resumable state", () => {
  it("injects safe Playwright settings without mutating the parent", () => {
    const env = createPlaywrightQaEnvironment(base);
    expect(env.NODE_ENV).toBe("test");
    expect(env.PAWSH_E2E_MODE).toBe("disposable");
    expect(env.DOCUMENT_STORAGE_ADAPTER).toBe("memory");
    expect(env.CUSTOM_TEST_VALUE).toBe("preserved");
    expect(base.PAWSH_E2E_MODE).toBeUndefined();
  });

  it("rejects unsafe database and explicit unsafe modes", () => {
    expect(() => createPlaywrightQaEnvironment({ ...base, DATABASE_URL: "postgres://user:pw@example.com/pawsh" })).toThrow(/loopback/);
    expect(() => createPlaywrightQaEnvironment({ ...base, PAWSH_E2E_MODE: "shared" })).toThrow(/disposable/);
  });

  it("writes atomic state without secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pawsh-qa-state-"));
    const path = join(dir, "state.json");
    await writeQaState({ sha: "abc", sourceFingerprint: "source-abc", environmentFingerprint: environmentFingerprint(createPlaywrightQaEnvironment(base)), overallStatus: "failed", mode: "standard", firstFailedStage: "smoke", cleanupStatus: "complete", secret: "must-not-be-written" }, path);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("must-not-be-written");
    expect((await loadQaState(path)).schemaVersion).toBe(QA_ENVIRONMENT_SCHEMA_VERSION);
    expect((await loadQaState(path)).sourceFingerprint).toBe("source-abc");
  });

  it("refuses to load a state file that names no source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pawsh-qa-legacy-"));
    const path = join(dir, "state.json");
    // A state file whose only identity is a commit - which is every file the previous
    // orchestrator wrote. Loading it would let a stage be reported as passed on evidence that
    // never established which code it passed against, so it is not loadable at all.
    await writeQaState({ sha: "abc", environmentFingerprint: "fingerprint", overallStatus: "failed", mode: "standard", firstFailedStage: "smoke", cleanupStatus: "complete" }, path);
    expect(await loadQaState(path)).toBeNull();
  });

  it("constructs safe defaults from a normal developer shell", () => {
    const env = createPlaywrightQaEnvironment({ CUSTOM_TEST_VALUE: "preserved" });
    expect(env.NODE_ENV).toBe("test");
    expect(env.PAWSH_E2E_MODE).toBe("disposable");
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

  /**
   * `qa:resume` reports the stages before the failed one as passed WITHOUT RUNNING THEM. Its only
   * compatibility check was `git rev-parse HEAD`, which does not move when a file is edited, so a
   * resumed run could declare green for a working tree that no stage in either run had seen.
   * These are the identities that now have to hold before any stage is reused.
   */
  describe("a resumed run may only reuse evidence about the code in front of it", () => {
    const pinned = (overrides = {}) => ({
      ...base,
      PAWSH_QA_SHA: "same-sha",
      PAWSH_QA_SOURCE_FINGERPRINT: "source-a",
      PAWSH_QA_BUILD_FINGERPRINT: "build-a",
      ...overrides
    });

    async function recordFailureAt(command, env) {
      const dir = await mkdtemp(join(tmpdir(), "pawsh-qa-trust-"));
      const path = join(dir, "state.json");
      await runQaCascade({ mode: "standard", env, statePath: path, stageRunner: async (stage) =>
        (stage.command === command ? { status: "failed", classification: "command_failure" } : { status: "passed" }) });
      return path;
    }

    it("resumes a clean, unchanged tree", async () => {
      const env = pinned();
      const path = await recordFailureAt("lint", env);
      const calls = [];
      const report = await runQaResume({ env, statePath: path, stageRunner: async (stage) => {
        calls.push(stage.command); return { status: "passed" };
      } });
      expect(report.status).toBe("passed");
      expect(calls[0]).toBe("lint");
      expect(report.sourceFingerprint).toBe("source-a");
    });

    it("refuses a stale resume once tracked source has been modified", async () => {
      const env = pinned();
      const path = await recordFailureAt("lint", env);
      // Same commit, different content: exactly the case the old check could not see.
      await expect(runQaResume({ env: pinned({ PAWSH_QA_SOURCE_FINGERPRINT: "source-b" }), statePath: path }))
        .rejects.toThrow(/unchanged working tree/);
    });

    it("does not let uncommitted code inherit a green status from HEAD", async () => {
      const env = pinned();
      const path = await recordFailureAt("lint", env);
      const state = await loadQaState(path);
      // The recorded run and the attempted resume agree on the commit and disagree on nothing
      // else that HEAD can express - and the resume is still refused, because the source is what
      // the stages actually validated.
      expect(state.sha).toBe("same-sha");
      const edited = pinned({ PAWSH_QA_SOURCE_FINGERPRINT: "source-edited", PAWSH_QA_WORKING_TREE: "dirty" });
      await expect(runQaResume({ env: edited, statePath: path })).rejects.toThrow(/unchanged working tree/);
      // And nothing about the refusal marks the run as validated.
      expect((await loadQaState(path)).overallStatus).toBe("failed");
    });

    it("will not reuse a build stage it cannot show produced the build on disk", async () => {
      const env = pinned();
      // Fails AFTER static, so a resume skips the stage that produced `dist/`.
      const path = await recordFailureAt("vitest-run tests/domain/playwright-lifecycle.test.mjs", env);
      expect((await loadQaState(path)).buildFingerprint).toBe("build-a");
      await expect(runQaResume({ env: pinned({ PAWSH_QA_BUILD_FINGERPRINT: "build-b" }), statePath: path }))
        .rejects.toThrow(/not the one the recorded run produced/);
      await expect(runQaResume({ env: pinned({ PAWSH_QA_BUILD_FINGERPRINT: "absent" }), statePath: path }))
        .rejects.toThrow(/no build on disk/);
      const report = await runQaResume({ env, statePath: path, stageRunner: async () => ({ status: "passed" }) });
      expect(report.status).toBe("passed");
      const reused = report.results.find((stage) => stage.name === "static");
      expect(reused.reused).toBe(true);
      expect(reused.reusedFrom.buildFingerprint).toBe("build-a");
      expect(reused.reusedFrom.sourceFingerprint).toBe("source-a");
    });
  });

  it("changes the build identity when the build changes, and reports its absence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pawsh-qa-build-"));
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "nested", "app.js"), "export const a = 1;\n");
    const first = await buildIdentity({}, [dir]);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await buildIdentity({}, [dir])).toBe(first);
    // A rebuild that produces different output is different evidence.
    await writeFile(join(dir, "nested", "app.js"), "export const a = 2;\n");
    expect(await buildIdentity({}, [dir])).not.toBe(first);
    // No build at all is a value a resume can refuse, not an error it has to interpret.
    await rm(join(dir, "nested"), { recursive: true });
    expect(await buildIdentity({}, [dir])).toBe("absent");
    expect(await buildIdentity({}, [join(dir, "never-built")])).toBe("absent");
  });

  it("moves the source identity when an uncommitted file appears", async () => {
    // The override the tests above use is only meaningful if the real computation responds to a
    // working tree change at all. This makes one, in the repository, and removes it again.
    const probe = join("tests", "domain", ".qa-source-identity-probe.tmp");
    const before = workingTreeIdentity({});
    expect(before.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(workingTreeIdentity({}).sourceFingerprint).toBe(before.sourceFingerprint);
    try {
      await writeFile(probe, `probe ${Date.now()}\n`);
      const during = workingTreeIdentity({});
      // An inequality, not a round trip back to `before`: another process may legitimately touch
      // the tree while this runs, and the property under test is that an uncommitted file MOVES
      // the identity, not that nothing else in the working tree ever moves.
      expect(during.sourceFingerprint).not.toBe(before.sourceFingerprint);
      expect(during.dirtyWorkingTree).toBe(true);
    } finally {
      await rm(probe, { force: true });
    }
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
