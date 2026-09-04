import { describe, expect, it } from "vitest";
import { migrationVersions } from "../../scripts/apply-migrations.js";
import {
  describeLifecycle, duplicateNumbers, existsInFinalSchema, migrationFilePattern, numberingGaps,
  objectLifecycle, readMigrationChain, stripComments, type MigrationFile
} from "./schema-chain.js";

/**
 * A test that only ever sees a healthy directory cannot say whether it would notice an unhealthy
 * one. These build the two shapes the suite above exists to catch and require them to be caught,
 * so the checks are known to fail rather than merely observed to pass.
 */
function synthetic(files: Record<string, string>): MigrationFile[] {
  return Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, source]) => ({
      file,
      version: file.replace(/\.sql$/, ""),
      number: Number(file.slice(0, 4)),
      source,
      sql: stripComments(source)
    }));
}

describe("migration chain checks", () => {
  it("names both files when two claim one number", () => {
    const chain = synthetic({
      "0001_initial.sql": "select 1;\n",
      "0046_business_address_bound.sql": "select 1;\n",
      "0046_business_preferences.sql": "select 1;\n"
    });
    expect(duplicateNumbers(chain))
      .toEqual(["0046: 0046_business_address_bound.sql, 0046_business_preferences.sql"]);
    expect(duplicateNumbers(synthetic({ "0001_initial.sql": "select 1;\n" }))).toEqual([]);
  });

  it("names every missing number rather than only the first", () => {
    const chain = synthetic({
      "0001_initial.sql": "select 1;\n",
      "0004_late.sql": "select 1;\n",
      "0006_later.sql": "select 1;\n"
    });
    expect(numberingGaps(chain)).toEqual([2, 3, 5]);
  });

  it("reads a later drop as removing what an earlier migration created", () => {
    const chain = synthetic({
      "0001_initial.sql":
        "alter table appointments add constraint guard\n  exclude using gist (a with =);\n",
      "0002_replacement.sql": "alter table appointments\n  drop constraint guard;\n",
      "0003_prose.sql": "-- guard was replaced by a trigger; see 0002.\nselect 1;\n"
    });
    expect(objectLifecycle(chain, "guard").map((event) => event.kind)).toEqual(["create", "drop"]);
    expect(existsInFinalSchema(chain, "guard")).toBe(false);
    // Re-adding it restores it, which is how 0039 tightens a constraint in place.
    expect(existsInFinalSchema(synthetic({
      "0001_initial.sql": "alter table t add constraint guard check (a > 0);\n",
      "0002_tighten.sql":
        "alter table t drop constraint guard;\n"
        + "alter table t add constraint guard check (a > 1);\n"
    }), "guard")).toBe(true);
  });
});

/**
 * The properties of the migration DIRECTORY, as opposed to the contents of any one file.
 *
 * WHY THIS SUITE EXISTS. `0046` and `0047` were both written twice, on two branches, and the
 * collision reached the repository. Nothing noticed, because nothing here had ever looked at the
 * set of filenames as a set: the syntax suite parses each file and asserts strings inside a
 * handful of them, which is blind to two files claiming one number. That is not a cosmetic
 * problem. `applyMigrations` records progress in `schema_migrations` keyed on the version string
 * and applies files in `readdir().sort()` order, so a duplicate number is two versions whose
 * relative order is decided by the rest of the filename, and a gap is a chain nobody can reason
 * about by counting.
 *
 * NOTHING BELOW HARD-CODES THE HEAD OF THE CHAIN. These tests read the directory and assert
 * properties that stay true as migrations are added, so a new migration landing on another
 * branch does not turn this suite red for a reason unrelated to it.
 */
describe("migration chain", () => {
  it("names every migration as a four-digit number and a snake_case description", async () => {
    const chain = await readMigrationChain();
    expect(chain.length).toBeGreaterThanOrEqual(51);
    for (const migration of chain) {
      // Four digits exactly. `010_x.sql` would sort before `0099_x.sql` and be applied out of
      // order, which is the failure a looser pattern would let through.
      expect(migration.file, migration.file).toMatch(migrationFilePattern);
      expect(migration.source.trim().length, migration.file).toBeGreaterThan(0);
    }
  });

  it("gives every migration a distinct number", async () => {
    // The 0046/0047 defect, stated as the property it broke.
    expect(duplicateNumbers(await readMigrationChain())).toEqual([]);
  });

  it("runs from 0001 with no gaps", async () => {
    const chain = await readMigrationChain();
    expect(chain[0]!.version).toBe("0001_initial");
    expect(chain[0]!.number).toBe(1);
    // Contiguity is still policy: the number is the position in the chain, so a hole means either
    // a migration was deleted after being applied somewhere or one was never committed.
    expect(numberingGaps(chain)).toEqual([]);
    expect(Math.max(...chain.map((migration) => migration.number))).toBe(chain.length);
  });

  it("applies in the order the numbers imply", async () => {
    const chain = await readMigrationChain();
    // `applyMigrations` sorts filenames as text. That is only the intended order while the
    // numeric prefix is fixed-width, so the two orderings are asserted to agree rather than
    // assumed to.
    const byName = chain.map((migration) => migration.file);
    const byNumber = [...chain]
      .sort((left, right) => left.number - right.number || left.file.localeCompare(right.file))
      .map((migration) => migration.file);
    expect(byName).toEqual(byNumber);
    // And the runner's own view of the chain is the same list, discovered the same way.
    expect(await migrationVersions()).toEqual(chain.map((migration) => migration.version));
  });

  /**
   * The check that the syntax suite could not make.
   *
   * Each of these is a name the syntax suite asserts appears in some historical file. Appearing
   * there is not the same as existing, and for one of them it never did: 0001 adds
   * `employee_appointment_no_overlap` and 0002 drops it, so the original assertion held against a
   * schema without the constraint. Asking the chain instead of a file is what makes the answer
   * mean something.
   */
  it("keeps every release-critical object in the final schema", async () => {
    const chain = await readMigrationChain();
    for (const name of [
      // Scheduling: the exclusion constraint 0001 shipped was REPLACED by a trigger, so the
      // trigger is the live guard and the constraint is history.
      "employee_appointment_conflict_guard",
      "appointment_employee_conflict_guard",
      // Tenant isolation, ownership and the invariants that replaced the dropped permission
      // columns.
      "prevent_last_owner_loss",
      "membership_role_matches_ownership",
      "live_invitation_requires_role",
      // Money.
      "payment_provider_identity",
      "payment_refund_provider_identity",
      "payment_refund_settlement_time",
      "payment_refund_tip_within_amount",
      "one_active_invoice_per_appointment",
      // Square, including the two identifiers 0039 widened from per-business to global.
      "square_connection_token_presence",
      "square_device_pairing_consistency",
      "square_checkout_identifier",
      "payment_refund_identifier",
      "square_webhook_processed_time",
      // Documents, breeds and the local wall clock.
      "one_current_pet_document",
      "pet_document_lifecycle_guard",
      "breed_name_scope_guard",
      "pet_breed_tenant_guard",
      "appointment_local_start_matches_instant",
      "blocked_time_local_window_matches_instants"
    ]) {
      expect(existsInFinalSchema(chain, name), describeLifecycle(chain, name)).toBe(true);
    }
  });

  it("does not still hold the objects the chain deliberately retired", async () => {
    const chain = await readMigrationChain();
    for (const name of [
      // 0002 replaced it with `employee_appointment_conflict_guard`, which can be overridden.
      "employee_appointment_no_overlap",
      // 0039 replaced both with table-wide unique indexes; keeping the per-business ones would
      // have let two salons hold one Square identifier.
      "square_checkout_identifier_per_business",
      "payment_refund_provider_reference"
    ]) {
      expect(existsInFinalSchema(chain, name), describeLifecycle(chain, name)).toBe(false);
    }
  });
});

/**
 * 0051 is a data repair with a constraint on the end of it, which is the shape most likely to
 * fail at DEPLOY time rather than in a request: the constraint is validated against every
 * existing row the moment it is added, so if the repair does not run first, or does not cover
 * every damaged row, the migration aborts on somebody's production database.
 */
describe("0051 local wall clock integrity", () => {
  async function migration(): Promise<{ source: string; sql: string }> {
    const chain = await readMigrationChain();
    const found = chain.find((entry) => entry.version === "0051_local_wall_clock_integrity");
    expect(found, "0051_local_wall_clock_integrity is missing from the chain").toBeDefined();
    return { source: found!.source, sql: found!.sql };
  }

  it("recomputes both tables from the instant before constraining them", async () => {
    const { source } = await migration();
    const repairAppointments = source.indexOf(
      "update appointments\n  set scheduled_local_start = (start_at at time zone scheduling_timezone)"
    );
    const repairBlockedTimes = source.indexOf("update blocked_times");
    expect(repairAppointments).toBeGreaterThanOrEqual(0);
    expect(repairBlockedTimes).toBeGreaterThanOrEqual(0);
    expect(source).toContain(
      "set scheduled_local_start = (start_at at time zone scheduling_timezone),\n"
      + "      scheduled_local_end = (end_at at time zone scheduling_timezone)"
    );
    // Ordering is the whole safety argument. A constraint added before the repair is validated
    // against the damaged rows and fails the deploy.
    const constrainAppointments = source.indexOf("add constraint appointment_local_start_matches_instant");
    const constrainBlockedTimes = source.indexOf("add constraint blocked_time_local_window_matches_instants");
    expect(constrainAppointments).toBeGreaterThan(repairAppointments);
    expect(constrainBlockedTimes).toBeGreaterThan(repairBlockedTimes);
  });

  it("repairs idempotently rather than rewriting every row", async () => {
    const { sql } = await migration();
    // `is distinct from` is what makes each statement a no-op on rows that already agree, which
    // is what lets 0051 be re-run and what keeps it from touching rows it does not need to.
    // Three predicates: one for the appointment start, two for the blocked-time window.
    expect((sql.match(/is distinct from/g) ?? []).length).toBe(3);
    // The repair derives from the authoritative instant. Nothing here guesses, and nothing here
    // deletes: a row whose wall clock disagreed is corrected, never discarded, and neither
    // denormalised column is dropped in favour of computing it at read time.
    expect(sql).not.toContain("delete from");
    expect(sql).not.toContain("drop column");
  });

  it("checks the instant-to-local direction only, which is the total one", async () => {
    const { sql } = await migration();
    expect(sql).toContain(
      "check (scheduled_local_start = (start_at at time zone scheduling_timezone))"
    );
    expect(sql).toContain(
      "check (scheduled_local_start = (start_at at time zone scheduling_timezone)\n"
      + "     and scheduled_local_end = (end_at at time zone scheduling_timezone))"
    );
    // The reverse direction is NOT equivalent and must never appear IN THE SQL - the migration's
    // own prose quotes it, which is why this reads the comment-stripped text. In the repeated
    // hour of a fall-back DST transition a naive local time names two instants, PostgreSQL
    // resolves it to the later one, and a booking Pawsh deliberately placed on the earlier
    // instant - which `scheduled_disambiguation` exists to record - would be refused.
    expect(sql).not.toContain("start_at = scheduled_local_start at time zone");
    expect(sql).not.toContain("end_at = scheduled_local_end at time zone");
  });

  it("leaves both constraints in the final schema", async () => {
    const chain = await readMigrationChain();
    for (const name of [
      "appointment_local_start_matches_instant",
      "blocked_time_local_window_matches_instants"
    ]) {
      expect(existsInFinalSchema(chain, name), describeLifecycle(chain, name)).toBe(true);
    }
  });
});
