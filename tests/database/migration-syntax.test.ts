import { readFile, readdir } from "node:fs/promises";
import { parse } from "pgsql-parser";
import { describe, expect, it } from "vitest";

describe("database migrations", () => {
  it("parses as PostgreSQL SQL", async () => {
    const migrations = (await readdir("migrations")).filter((file) => file.endsWith(".sql")).sort();
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    for (const migration of migrations) {
      const source = await readFile(`migrations/${migration}`, "utf8");
      const tree = await parse(source);
      expect(tree.stmts?.length ?? 0, migration).toBeGreaterThan(0);
    }
  });

  it("contains release-critical constraints", async () => {
    const source = await readFile("migrations/0001_initial.sql", "utf8");
    expect(source).toContain("employee_appointment_no_overlap");
    expect(source).toContain("prevent_last_owner_loss");
    expect(source).toContain("create policy tenant_isolation");
    expect(source).toContain("one_active_invoice_per_appointment");
    const scheduling = await readFile("migrations/0002_scheduling_conflict_overrides.sql", "utf8");
    expect(scheduling).toContain("employee_appointment_conflict_guard");
    expect(scheduling).toContain("pg_advisory_xact_lock");
    expect(scheduling).toContain("app.scheduling_conflict_override_appointment_id");
  });
});
