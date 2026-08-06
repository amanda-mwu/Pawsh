import { spawnSync } from "node:child_process";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { isInfrastructureBlocked } from "../../scripts/ci-policy-status.mjs";

function evaluate({ executable, fullMatrix, results }) {
  return spawnSync(process.execPath, ["scripts/evaluate-cross-platform-policy.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CLASSIFICATION_RESULT: "success",
      ENFORCEMENT_LEVEL: "beta_development",
      CHANGE_CLASS: executable ? "ordinary_executable" : "documentation_only",
      EXECUTABLE: String(executable),
      FULL_MATRIX: String(fullMatrix),
      TRUSTED_REASONS: "test",
      JOB_RESULTS: JSON.stringify(results)
    }
  });
}

const job = (result) => ({ result });

describe("cross-platform aggregate policy", () => {
  it("distinguishes pre-execution hosted blockage from repository failure", () => {
    expect(isInfrastructureBlocked("windows-runtime", [{
      name: "Runtime Compatibility — Windows Node 24", conclusion: "failure", steps: []
    }])).toBe(true);
    expect(isInfrastructureBlocked("windows-runtime", [{
      name: "Runtime Compatibility — Windows Node 24", conclusion: "failure",
      steps: [{ name: "Run tests", conclusion: "failure" }]
    }])).toBe(false);
  });
  it("accepts ordinary beta coverage and labels conditional jobs not required", () => {
    const run = evaluate({
      executable: true,
      fullMatrix: false,
      results: {
        "ubuntu-runtime": job("success"),
        "windows-runtime": job("skipped"),
        "macos-runtime": job("skipped"),
        "utc-canonicalization": job("skipped")
      }
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Not required under beta impact policy");
    expect(run.stdout).not.toContain("Not required under beta impact policy | success");
  });

  it("accepts documentation-only selection only when every runtime group skipped", () => {
    const skipped = {
      "ubuntu-runtime": job("skipped"), "windows-runtime": job("skipped"),
      "macos-runtime": job("skipped"), "utc-canonicalization": job("skipped")
    };
    expect(evaluate({ executable: false, fullMatrix: false, results: skipped }).status).toBe(0);
  });

  it("requires every supported group for full-matrix modes", () => {
    const allPassed = {
      "ubuntu-runtime": job("success"), "windows-runtime": job("success"),
      "macos-runtime": job("success"), "utc-canonicalization": job("success")
    };
    expect(evaluate({ executable: true, fullMatrix: true, results: allPassed }).status).toBe(0);
    const blocked = { ...allPassed, "windows-runtime": job("failure") };
    const run = evaluate({ executable: true, fullMatrix: true, results: blocked });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("windows-runtime=failure");
  });

  it("does not accept skipped, missing, cancelled, or externally disposed required jobs", () => {
    for (const result of ["skipped", "cancelled", "missing", "accepted_disposition"]) {
      const run = evaluate({
        executable: true,
        fullMatrix: true,
        results: {
          "ubuntu-runtime": job("success"), "windows-runtime": job(result),
          "macos-runtime": job("success"), "utc-canonicalization": job("success")
        }
      });
      expect(run.status).toBe(1);
    }
  });
});
