import { describe, expect, it } from "vitest";
import { formatQaReport, parseQaTimeouts, runQaCascade } from "../../scripts/qa-cascade.mjs";

const env = { DATABASE_URL: "postgres://pawsh:pawsh-local-only@127.0.0.1:55432/pawsh" };
const passRunner = async () => ({ status: "passed", durationMs: 1 });

describe("cascading QA orchestrator", () => {
  it("stops before database and browsers after a static failure", async () => {
    const commands = [];
    const report = await runQaCascade({ env, stageRunner: async (stage) => {
      commands.push(stage.command);
      return stage.command === "lint" ? { status: "failed", classification: "command_failure" } : { status: "passed" };
    }, persistState: false });
    expect(report.status).toBe("failed");
    expect(report.blocker.name).toBe("static");
    expect(commands).toEqual(["lint"]);
    expect(report.results.find((stage) => stage.name === "smoke").status).toBe("blocked");
  });

  it("preserves the first migration failure and blocks browser stages", async () => {
    const commands = [];
    const report = await runQaCascade({ env, stageRunner: async (stage) => {
      commands.push(stage.command);
      return stage.command === "db:migrate" ? { status: "failed", classification: "migration_failure" } : { status: "passed" };
    }, persistState: false });
    expect(report.blocker.name).toBe("database");
    expect(commands).toContain("db:health");
    expect(commands).toContain("db:migrate");
    expect(report.results.find((stage) => stage.name === "preflight").status).toBe("blocked");
  });

  it("blocks dependents after a stage timeout and preserves the timeout classification", async () => {
    const report = await runQaCascade({ env, stageRunner: async (stage) => stage.command === "db:health"
      ? { status: "timed_out", classification: "stage_timeout", cleanupStatus: "complete" }
      : { status: "passed" }, persistState: false });
    expect(report.blocker.name).toBe("database");
    expect(report.blocker.classification).toBe("stage_timeout");
    expect(report.results.find((stage) => stage.name === "smoke").status).toBe("blocked");
  });

  it("reports quick omissions truthfully and keeps output concise", async () => {
    const report = await runQaCascade({ env, stageRunner: passRunner, persistState: false });
    expect(report.status).toBe("passed");
    expect(report.results.map((stage) => stage.name)).toEqual(["environment", "static", "critical", "database", "startup", "preflight", "smoke"]);
    expect(formatQaReport(report)).toContain("QA mode: quick");
  });

  it("includes expansion and release stages in full mode", async () => {
    const report = await runQaCascade({ mode: "full", env, stageRunner: passRunner, persistState: false });
    expect(report.status).toBe("passed");
    expect(report.results.map((stage) => stage.name)).toContain("expansion");
    expect(report.results.map((stage) => stage.name)).toContain("release");
  });

  it("runs full browser preflights sequentially before smoke", async () => {
    const commands = [];
    const report = await runQaCascade({ mode: "full", env, stageRunner: async (stage) => { commands.push(stage.command); return { status: "passed" }; }, persistState: false });
    expect(report.status).toBe("passed");
    expect(commands.filter((command) => command.startsWith("qa:browser-preflight"))).toEqual([
      "qa:browser-preflight chromium", "qa:browser-preflight firefox", "qa:browser-preflight webkit"
    ]);
  });

  it("bounds the shared test timeout override", () => {
    expect(parseQaTimeouts({ PAWSH_QA_STAGE_TIMEOUT_MS: "2000" }).backend).toBe(2000);
    expect(() => parseQaTimeouts({ PAWSH_QA_STAGE_TIMEOUT_MS: "0" })).toThrow();
  });

  it("rejects unknown modes conservatively", async () => {
    await expect(runQaCascade({ mode: "unknown", env })).rejects.toThrow("Unknown QA mode");
  });
});
