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
    const petVersions = await readFile("migrations/0003_pet_versions.sql", "utf8");
    expect(petVersions).toContain("add column version integer not null default 1");
    expect(petVersions).toContain("pet_version_positive");
    const petCare = await readFile("migrations/0004_pet_care_permissions.sql", "utf8");
    expect(petCare).toContain("update business_memberships");
    expect(petCare).toContain("update membership_invitations");
    expect(petCare).toContain("pets.care.view");
    expect(petCare).toContain("pets.care.edit");
    const petDocuments = await readFile("migrations/0005_pet_documents.sql", "utf8");
    expect(petDocuments).toContain("one_current_pet_document");
    expect(petDocuments).toContain("pet_document_lifecycle_guard");
    expect(petDocuments).toContain("foreign key (business_id,pet_id) references pets(business_id,id)");
    expect(petDocuments).toContain("create policy tenant_isolation on pet_documents");
    expect(petDocuments).toContain("create policy tenant_isolation on pet_document_requests");
    const malwareProtection = await readFile("migrations/0009_document_malware_protection.sql", "utf8");
    expect(malwareProtection).toContain("create table pet_document_scan_attempts");
    expect(malwareProtection).toContain("pet_document_scan_attempts_immutable");
    expect(malwareProtection).toContain("state in ('pending','pending_scan','rejected','current','superseded')");
    const rabiesCompliance = await readFile("migrations/0010_rabies_appointment_compliance.sql", "utf8");
    expect(rabiesCompliance).toContain("pet_rabies_verification_consistency");
    expect(rabiesCompliance).toContain("unique_notification_material_recipient");
    expect(rabiesCompliance).toContain("0010_rabies_appointment_compliance");
    expect(malwareProtection).toContain("create policy tenant_isolation on pet_document_scan_attempts");
  });
});
