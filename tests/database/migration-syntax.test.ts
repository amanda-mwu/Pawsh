import { readFile } from "node:fs/promises";
import { parse } from "pgsql-parser";
import { describe, expect, it } from "vitest";

describe("database migrations", () => {
  it("parses as PostgreSQL SQL", async () => {
    const source = await readFile("migrations/0001_initial.sql", "utf8");
    const tree = await parse(source);
    expect(tree.stmts?.length ?? 0).toBeGreaterThan(40);
  });

  it("contains release-critical constraints", async () => {
    const source = await readFile("migrations/0001_initial.sql", "utf8");
    expect(source).toContain("employee_appointment_no_overlap");
    expect(source).toContain("prevent_last_owner_loss");
    expect(source).toContain("create policy tenant_isolation");
    expect(source).toContain("one_active_invoice_per_appointment");
  });
});
