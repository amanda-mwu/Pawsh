import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0058 is a data migration over `roles` and nothing else: the Groomer preset gained
 * `appointments.override_conflict` - a groomer may overlap their own day - and this file is what
 * gives the same key to every built-in Groomer that already exists, together with the
 * `appointments.service_price_edit` the Groomer and Receptionist presets had carried ahead of
 * their migration, and the override key the Receptionist preset had carried the same way.
 *
 * THE GRANT IS THE PART THAT CAN GO WRONG SILENTLY, which is why this suite builds its own
 * database rather than sharing the migrated one, exactly as 0057's does. What matters is what the
 * migration DOES TO PRE-EXISTING ROWS - a Groomer seeded in a salon that signed up last year must
 * come out overlapping its own day, and a custom role must come out untouched - and a suite
 * against an already-migrated database cannot observe that. So the schema is built to exactly
 * 0057, roles are planted in the shapes real customer data takes, and only then is 0058 applied.
 *
 * THE ALL-STAFF KEY IS THE THING THAT MUST NOT MOVE. The override key says nothing about whose
 * calendar, and a migration that granted it must not hand a Groomer the salon on the way through.
 * So case B plants a plain Groomer and a hand-widened one and asserts each comes out with exactly
 * the keys it lacked of the two, and never `appointments.edit_all_staff`.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const scratchDatabase = "pawsh_migration_0058_vitest";
const emptyChainDatabase = "pawsh_chain_0058_vitest";
const lastMigrationBefore = "0057_staff_scheduling_scope";
const migrationUnderTest = "0058_groomer_overlap_authority";

/** The two keys the file grants, to the built-in Groomer and the built-in Receptionist alike. */
const GRANTED_KEYS = ["appointments.override_conflict", "appointments.service_price_edit"];
/** The key that says scope does not apply, which this file must grant to nobody. */
const ALL_STAFF = "appointments.edit_all_staff";
/** The Groomer as 0057 left it: 0041's seven keys plus the three scoped ones. */
const GROOMER_AT_0057 = ["calendar.view", "appointments.view", "pets.view", "pets.care.view",
  "operations.check_in", "operations.perform_service", "operations.complete",
  "appointments.edit", "calendar.blocks_create", "calendar.blocks_edit"];
/** The Receptionist as 0057 left it. */
const RECEPTIONIST_AT_0057 = ["calendar.view", "appointments.view", "appointments.create",
  "appointments.edit", "appointments.edit_all_staff", "appointments.cancel",
  "calendar.blocks_create", "calendar.blocks_edit", "customers.view", "customers.edit",
  "pets.view", "pets.edit", "pets.care.view", "operations.check_in", "checkout.perform",
  "payments.view"];

describeDatabase("migration 0058 groomer overlap authority", () => {
  let admin: postgres.Sql;
  let scratchUrl: string;
  let emptyChainUrl: string;

  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const url = new URL(databaseUrl!);
    url.pathname = `/${scratchDatabase}`;
    scratchUrl = url.toString();
    const chain = new URL(databaseUrl!);
    chain.pathname = `/${emptyChainDatabase}`;
    emptyChainUrl = chain.toString();
  }, 30_000);

  afterAll(async () => {
    await admin.unsafe(`drop database if exists ${scratchDatabase} with (force)`).catch(() => {});
    await admin.unsafe(`drop database if exists ${emptyChainDatabase} with (force)`).catch(() => {});
    await admin.end();
  });

  const migrationFiles = async () =>
    (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();

  /** A database at exactly 0057, with nothing of 0058 applied. */
  async function databaseAt0057(): Promise<postgres.Sql> {
    await admin.unsafe(`drop database if exists ${scratchDatabase} with (force)`);
    await admin.unsafe(`create database ${scratchDatabase}`);
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => {}, transform: postgres.camel });
    await sql`create table if not exists schema_migrations (
      version text primary key, applied_at timestamptz not null default now())`;
    for (const file of await migrationFiles()) {
      const version = file.replace(/\.sql$/, "");
      if (version > lastMigrationBefore) break;
      await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
      await sql`insert into schema_migrations (version) values (${version}) on conflict do nothing`;
    }
    return sql;
  }

  /** Applies 0058, leaving the connection usable if it refused. See 0039's suite for why. */
  async function apply0058(sql: postgres.Sql): Promise<void> {
    try {
      await sql.unsafe(await readFile(resolve("migrations", `${migrationUnderTest}.sql`), "utf8"));
    } catch (error) {
      await sql.unsafe("rollback").catch(() => {});
      throw error;
    }
  }

  async function tenant(sql: postgres.Sql, label: string) {
    const [business] = await sql<{ id: string }[]>`
      insert into businesses(name) values (${label}) returning id
    `;
    return { businessId: business!.id };
  }

  type Tenant = Awaited<ReturnType<typeof tenant>>;

  /** A role in one business, with exactly the permissions given. */
  async function role(sql: postgres.Sql, owner: Tenant, name: string, permissions: string[],
    options: { builtIn?: boolean } = {}) {
    const [row] = await sql<{ id: string }[]>`
      insert into roles(business_id,name,permissions,built_in)
      values (${owner.businessId},${name},${permissions}::text[],${options.builtIn ?? false})
      returning id
    `;
    return row!.id;
  }

  const roleState = (sql: postgres.Sql, id: string) =>
    sql<{ permissions: string[]; version: number }[]>`
      select permissions, version from roles where id=${id}
    `.then((rows) => rows[0]!);

  /**
   * A. THE BUILT-IN GROOMER AND RECEPTIONIST GAIN THE TWO KEYS, IN EVERY BUSINESS, AND NOBODY ELSE
   * GAINS ANYTHING.
   *
   * The fixture is chosen around the shapes a nominal predicate has to get right:
   *
   *   * the Groomer and the Receptionist exactly as 0057 left them, in two businesses, because
   *     this is a data migration over every tenant's rows and not one workspace's;
   *   * a CUSTOM role a salon authored for its groomers, holding the same keys, which means
   *     whatever the owner made it mean and must come out exactly as they made it;
   *   * a custom role that happens to be NAMED Groomer, which is not the Groomer Pawsh shipped;
   *   * the Manager, which already holds both keys and so is not a role that changed;
   *   * a viewer and a checkout-only desk, which hold neither key and match neither step.
   */
  it("grants both keys to every built-in Groomer and Receptionist, in every business, and to no other role", async () => {
    const sql = await databaseAt0057();
    try {
      const first = await tenant(sql, "grant-a");
      const second = await tenant(sql, "grant-b");

      const groomer = await role(sql, first, "Groomer", GROOMER_AT_0057, { builtIn: true });
      const receptionist = await role(sql, first, "Receptionist", RECEPTIONIST_AT_0057, { builtIn: true });
      const otherGroomer = await role(sql, second, "Groomer", GROOMER_AT_0057, { builtIn: true });
      const otherReceptionist = await role(sql, second, "Receptionist", RECEPTIONIST_AT_0057, { builtIn: true });
      const manager = await role(sql, first, "Manager",
        [...RECEPTIONIST_AT_0057, ...GRANTED_KEYS, "reports.view", "settings.manage"], { builtIn: true });

      // Must gain nothing.
      const customGroomer = await role(sql, first, "Weekend groomer", GROOMER_AT_0057);
      // In a business of its own: `roles` is unique on (business_id, lower(name)).
      const namedGroomer = await role(sql, await tenant(sql, "grant-c"), "Groomer", GROOMER_AT_0057);
      const viewer = await role(sql, second, "Read only", ["calendar.view"]);
      const checkout = await role(sql, first, "Till",
        ["appointments.view", "checkout.perform", "payments.view", "operations.check_in"]);

      const ids = [groomer, receptionist, otherGroomer, otherReceptionist, manager,
        customGroomer, namedGroomer, viewer, checkout];
      const before = new Map(await Promise.all(
        ids.map(async (id) => [id, await roleState(sql, id)] as const)
      ));

      await apply0058(sql);

      for (const id of [groomer, receptionist, otherGroomer, otherReceptionist]) {
        const after = await roleState(sql, id);
        expect(after.permissions, `role ${id}`).toEqual(expect.arrayContaining(GRANTED_KEYS));
        // Nothing was taken away in the process.
        expect(after.permissions, `role ${id}`)
          .toEqual(expect.arrayContaining(before.get(id)!.permissions));
        // And nothing else was added: exactly the two keys, and never the all-staff one.
        expect(after.permissions.length, `role ${id}`).toBe(before.get(id)!.permissions.length + 2);
        expect(after.permissions.includes(ALL_STAFF), `role ${id}`)
          .toBe(before.get(id)!.permissions.includes(ALL_STAFF));
        // The version moved, for 0043's and 0045's reason.
        expect(after.version, `role ${id}`).toBe(before.get(id)!.version + 1);
      }

      for (const id of [manager, customGroomer, namedGroomer, viewer, checkout]) {
        expect(await roleState(sql, id), `role ${id}`).toEqual(before.get(id));
      }

      // The invariant the migration asserts for itself, checked from outside.
      const [stranded] = await sql<{ count: number }[]>`
        select count(*)::int as count from roles
        where built_in and lower(name) in ('groomer', 'receptionist')
          and not (permissions @> ${GRANTED_KEYS}::text[])
      `;
      expect(stranded!.count).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * B. A HAND-EDITED BUILT-IN KEEPS WHAT IT HAS AND GAINS ONLY WHAT IT LACKS.
   *
   * An owner may already have flipped one of the two switches on their Groomer, or flipped the
   * all-staff switch to let one Groomer reach across the staff. The file must add exactly the
   * keys missing - so a Groomer already holding the price key gains one key, not two - keep every
   * key the owner chose, and never itself hand a Groomer the all-staff key: the override key
   * decides whether two appointments may share an hour, and nothing about whose hour it is.
   */
  it("adds only the missing keys to a hand-edited built-in, and never the all-staff key", async () => {
    const sql = await databaseAt0057();
    try {
      const salon = await tenant(sql, "hand-edited");
      const priced = await role(sql, salon, "Groomer",
        [...GROOMER_AT_0057, "appointments.service_price_edit"], { builtIn: true });
      const other = await tenant(sql, "hand-edited-b");
      const overlapping = await role(sql, other, "Groomer",
        [...GROOMER_AT_0057, "appointments.override_conflict"], { builtIn: true });
      const reaching = await tenant(sql, "hand-edited-c");
      const allStaff = await role(sql, reaching, "Groomer",
        [...GROOMER_AT_0057, ALL_STAFF], { builtIn: true });
      const desk = await tenant(sql, "hand-edited-d");
      const halfDesk = await role(sql, desk, "Receptionist",
        [...RECEPTIONIST_AT_0057, "appointments.override_conflict"], { builtIn: true });

      const before = {
        priced: await roleState(sql, priced),
        overlapping: await roleState(sql, overlapping),
        allStaff: await roleState(sql, allStaff),
        halfDesk: await roleState(sql, halfDesk)
      };

      await apply0058(sql);

      for (const [label, id] of [
        ["priced", priced], ["overlapping", overlapping], ["allStaff", allStaff], ["halfDesk", halfDesk]
      ] as const) {
        const after = await roleState(sql, id);
        expect(after.permissions, label).toEqual(expect.arrayContaining(GRANTED_KEYS));
        expect(after.permissions, label).toEqual(expect.arrayContaining(before[label].permissions));
        expect(after.permissions.length, label).toBe(
          before[label].permissions.length
            + GRANTED_KEYS.filter((key) => !before[label].permissions.includes(key)).length
        );
        expect(after.version, label).toBe(before[label].version + 1);
      }
      // The Groomers that did not hold the all-staff key still do not; the one whose owner gave
      // it still does. The file moved that key in neither direction.
      expect((await roleState(sql, priced)).permissions).not.toContain(ALL_STAFF);
      expect((await roleState(sql, overlapping)).permissions).not.toContain(ALL_STAFF);
      expect((await roleState(sql, allStaff)).permissions).toContain(ALL_STAFF);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * C. RUNNING IT TWICE CHANGES NOTHING THE SECOND TIME.
   *
   * Every bump invalidates an editor somebody has open, so a re-run must match no rows at all:
   * each predicate excludes the roles it has already reached.
   */
  it("is idempotent: a second application grants nothing and moves no version", async () => {
    const sql = await databaseAt0057();
    try {
      const salon = await tenant(sql, "idempotent");
      const groomer = await role(sql, salon, "Groomer", GROOMER_AT_0057, { builtIn: true });
      const receptionist = await role(sql, salon, "Receptionist", RECEPTIONIST_AT_0057, { builtIn: true });
      const viewer = await role(sql, salon, "Viewer", ["calendar.view"]);

      await apply0058(sql);
      const afterFirst = {
        groomer: await roleState(sql, groomer),
        receptionist: await roleState(sql, receptionist),
        viewer: await roleState(sql, viewer)
      };
      expect(afterFirst.groomer.permissions).toEqual(expect.arrayContaining(GRANTED_KEYS));
      expect(afterFirst.groomer.permissions).not.toContain(ALL_STAFF);
      expect(afterFirst.receptionist.permissions).toEqual(expect.arrayContaining(GRANTED_KEYS));

      await apply0058(sql);
      expect(await roleState(sql, groomer)).toEqual(afterFirst.groomer);
      expect(await roleState(sql, receptionist)).toEqual(afterFirst.receptionist);
      expect(await roleState(sql, viewer)).toEqual(afterFirst.viewer);

      // A built-in Groomer provisioned AFTER the file ran - a new salon's, seeded from the preset
      // that already holds both keys - is not a role a replay touches either.
      const late = await tenant(sql, "late");
      const lateGroomer = await role(sql, late, "Groomer", [...GROOMER_AT_0057, ...GRANTED_KEYS], { builtIn: true });
      const lateBefore = await roleState(sql, lateGroomer);
      await apply0058(sql);
      expect(await roleState(sql, lateGroomer)).toEqual(lateBefore);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * D. THE WHOLE CHAIN STILL APPLIES TO AN EMPTY DATABASE.
   *
   * Both UPDATEs and the closing assertion run over a `roles` table with no rows in it on a fresh
   * install, which is exactly where an aggregate written carelessly fails first.
   */
  it("applies the whole chain, 0058 included, to an empty database", async () => {
    await admin.unsafe(`drop database if exists ${emptyChainDatabase} with (force)`);
    await admin.unsafe(`create database ${emptyChainDatabase}`);
    const sql = postgres(emptyChainUrl, { max: 1, onnotice: () => {}, transform: postgres.camel });
    try {
      await sql`create table if not exists schema_migrations (
        version text primary key, applied_at timestamptz not null default now())`;
      const files = await migrationFiles();
      for (const file of files) {
        const version = file.replace(/\.sql$/, "");
        await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
        await sql`insert into schema_migrations (version) values (${version}) on conflict do nothing`;
      }
      const applied = await sql<{ version: string }[]>`
        select version from schema_migrations order by version
      `;
      expect(applied.map((row) => row.version))
        .toEqual(files.map((file) => file.replace(/\.sql$/, "")));
      expect(applied.map((row) => row.version)).toContain(migrationUnderTest);
      const [roles] = await sql<{ count: number }[]>`select count(*)::int as count from roles`;
      expect(roles!.count, "a fresh install has no roles until a business is provisioned").toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});
