import { describe, expect, it } from "vitest";
import {
  classifyEntries, comparisonFromEvent, gitEntries, parseNameStatusZ
} from "../../scripts/ci-change-classifier.mjs";

const classify = (paths, options = {}) => classifyEntries(
  paths.map((path) => ({ status: "M", path })),
  { rollbackFull: "false", readFile: () => "", ...options }
);

describe("cross-platform CI change classifier", () => {
  it("parses null-delimited names safely, including rename and unusual names", () => {
    expect(parseNameStatusZ("M\0docs/file with spaces.md\0R100\0old;$name.ts\0new Ω name.ts\0D\0gone.ts\0"))
      .toEqual([
        { status: "M", path: "docs/file with spaces.md" },
        { status: "R100", oldPath: "old;$name.ts", path: "new Ω name.ts" },
        { status: "D", path: "gone.ts" }
      ]);
  });

  it("routes work to the surfaces a change can actually affect", () => {
    // Mobile-only work skips server validation; shared packages are consumed by both, so they
    // must run everything; anything mixed or unknown falls back to running both.
    const mobileOnly = classify(["apps/mobile/app/index.tsx"]);
    expect(mobileOnly.mobile).toBe(true);
    expect(mobileOnly.server).toBe(false);

    const shared = classify(["packages/domain/src/labels.ts"]);
    expect(shared.mobile).toBe(true);
    expect(shared.server).toBe(true);

    const serverOnly = classify(["src/http/routes.ts"]);
    expect(serverOnly.mobile).toBe(false);
    expect(serverOnly.server).toBe(true);

    const mixed = classify(["apps/mobile/app/index.tsx", "src/http/routes.ts"]);
    expect(mixed.mobile).toBe(true);
    expect(mixed.server).toBe(true);
  });

  it.each([
    [["README.md", "docs/architecture/overview.md"], "documentation_only", false],
    [["src/domain/money.ts"], "ordinary_executable", false],
    [["src/http/routes.ts"], "ordinary_executable", false],
    [["migrations/0010_example.sql"], "database_or_migration", false],
    [["tests/database/example.test.ts"], "database_or_migration", false],
    [["src/db.ts"], "database_or_migration", false],
    [["public/app.js"], "browser_or_ui", false],
    [[".github/workflows/ci.yml"], "workflow_or_ci", true],
    [["package.json"], "dependency_change", true],
    [["package-lock.json"], "dependency_change", true],
    [["scripts/start.mjs"], "platform_sensitive", true],
    [["src/default-browser.ts"], "platform_sensitive", true],
    [["src/filesystem/storage.ts"], "platform_sensitive", true],
    [["tools/postgres-service.ps1"], "platform_sensitive", true],
    [["apps/mobile/app/index.tsx"], "mobile_app", false],
    // A mobile lockfile bump must not escalate the Windows/macOS matrix, and a mobile file
    // named for a database must not read as a migration. Both are ordering-sensitive:
    // the apps/ branch has to sit above the dependency and database checks.
    [["apps/mobile/package-lock.json"], "mobile_app", false],
    [["apps/mobile/src/api/database.ts"], "mobile_app", false],
    [["packages/domain/src/labels.ts"], "shared_package", false],
    [["mystery.unclassified"], "unknown_or_mixed", true]
  ])("classifies %j as %s", (paths, expectedClass, expectedFull) => {
    const result = classify(paths);
    expect(result.changeClass).toBe(expectedClass);
    expect(result.fullMatrix).toBe(expectedFull);
  });

  it("ignores accompanying documentation when one executable class is clear", () => {
    expect(classify(["README.md", "src/domain/money.ts"]).changeClass).toBe("ordinary_executable");
  });

  it("treats multiple executable classes conservatively", () => {
    const result = classify(["src/domain/money.ts", "public/app.js"]);
    expect(result.changeClass).toBe("unknown_or_mixed");
    expect(result.fullMatrix).toBe(true);
  });

  it("detects bounded platform primitives using Node file inspection", () => {
    const result = classifyEntries([{ status: "M", path: "src/domain/helper.ts" }], {
      rollbackFull: "false", readFile: () => 'import { spawn } from "node:child_process";'
    });
    expect(result.changeClass).toBe("platform_sensitive");
    expect(result.fullMatrix).toBe(true);
  });

  it.each([
    [{ mode: "beta_release_candidate", rollbackFull: "false" }, "beta_release_candidate"],
    [{ mode: "scheduled_full_matrix", rollbackFull: "false" }, "scheduled_full_matrix"],
    [{ mode: "beta_development", forceFull: "true", rollbackFull: "false" }, "beta_development"],
    [{ mode: "beta_development", forceFull: "not-a-boolean", rollbackFull: "false" }, "beta_development"],
    [{ mode: "unexpected", rollbackFull: "false" }, "unknown"]
  ])("forces full matrix for control %j", (options, enforcementLevel) => {
    const result = classify(["src/domain/money.ts"], options);
    expect(result.fullMatrix).toBe(true);
    expect(result.enforcementLevel).toBe(enforcementLevel);
  });

  it("defaults an absent rollback control toward full coverage", () => {
    expect(classifyEntries([{ status: "M", path: "src/domain/money.ts" }]).fullMatrix).toBe(true);
  });

  it("fails conservatively when merge-base or diff computation fails", () => {
    const runner = () => ({ status: 1, stdout: "", stderr: "failure" });
    expect(() => gitEntries("base", "head", { mergeBase: true, runner })).toThrow("merge_base_unavailable");
    expect(classify([".unknown-classification"]).fullMatrix).toBe(true);
  });

  it("uses merge-base for pull requests and the exact before SHA for pushes", () => {
    expect(comparisonFromEvent("pull_request", {
      pull_request: { base: { sha: "base" }, head: { sha: "head" } }
    })).toEqual({ base: "base", head: "head", mergeBase: true });
    expect(comparisonFromEvent("push", { before: "before", after: "after" }))
      .toEqual({ base: "before", head: "after", mergeBase: false });
  });

  it.each([
    ["push", { after: "head" }],
    ["push", { before: "0000000000000000000000000000000000000000", after: "head" }],
    ["pull_request", { pull_request: { head: { sha: "head" } } }]
  ])("fails conservatively for unavailable comparison SHAs", (eventName, event) => {
    expect(() => comparisonFromEvent(eventName, event)).toThrow("comparison_sha_unavailable");
  });
});
