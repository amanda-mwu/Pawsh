import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { migrationVersions } from "../../scripts/apply-migrations.js";
import { resolveDatabaseTestMode } from "../support/test-database.js";

const mode = resolveDatabaseTestMode();
const executed = mode.state === "executed" ? mode : null;

// This suite is deliberately NOT gated on a database being present: it is the guard that proves
// the rest of tests/database actually ran instead of silently skipping into a misleading green.
describe("database test harness", () => {
  it("resolves an explicit executed or excluded state, never a silent skip", () => {
    expect(mode.state).not.toBe("unavailable");
    expect(["executed", "excluded"]).toContain(mode.state);
  });

  it.runIf(Boolean(executed))("targets an isolated database rather than the development database", () => {
    expect(process.env.DATABASE_URL).toBe(executed!.url);
    if (process.env.PAWSH_TEST_DATABASE_URL) return;
    expect(executed!.database).toMatch(/_vitest$/);
    const development = process.env.DATABASE_URL_DEVELOPMENT ?? "";
    if (development) expect(executed!.url).not.toBe(development);
  });

  it.runIf(Boolean(executed))("has every migration from 0001 to current applied", async () => {
    const sql = postgres(executed!.url, { max: 1 });
    try {
      const applied = new Set(
        (await sql<{ version: string }[]>`select version from schema_migrations`).map((row) => row.version)
      );
      const expected = await migrationVersions();
      expect(expected[0]).toBe("0001_initial");
      for (const version of expected) expect([...applied]).toContain(version);
      expect(expected).toContain("0016_customer_preferred_groomer");
    } finally {
      await sql.end();
    }
  });
});
