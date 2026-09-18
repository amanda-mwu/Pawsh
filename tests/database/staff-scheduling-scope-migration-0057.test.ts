import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0057 is a data migration over `roles` and nothing else: `appointments.edit_all_staff` starts
 * enforcing in the same change, so the four keys it scopes - `appointments.create`,
 * `appointments.edit`, `calendar.blocks_create`, `calendar.blocks_edit` - narrow from "anybody's"
 * to "mine", and this file is what keeps that narrowing from taking a capability away from a role
 * that has it today.
 *
 * THE GRANT IS THE PART THAT CAN GO WRONG SILENTLY, which is why this suite builds its own
 * database rather than sharing the migrated one, exactly as 0055's does. What matters is what the
 * migration DOES TO PRE-EXISTING ROWS - a Receptionist that could move every groomer's bookings
 * yesterday must be able to today - and a suite against an already-migrated database cannot
 * observe that. So the schema is built to exactly 0056, roles are planted in the shapes real
 * customer data takes, and only then is 0057 applied.
 *
 * THE GROOMER IS THE OTHER THING THAT CAN GO WRONG SILENTLY. Step 1 grants the all-staff key to
 * every role overlapping the four scoped keys; step 2 grants three of them to the built-in
 * Groomer. A step 1 that looked at Groomers would hand the whole salon to any built-in Groomer an
 * owner had already hand-given a block key - and, run after step 2, to every Groomer in every
 * workspace, with no error. So step 1 excludes the built-in Groomer by name, and case B plants
 * one plain and one hand-widened and asserts both come out holding the scoped keys and NOT the
 * all-staff one.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const scratchDatabase = "pawsh_migration_0057_vitest";
const emptyChainDatabase = "pawsh_chain_0057_vitest";
const lastMigrationBefore = "0056_blocked_time_mutation_metadata";
const migrationUnderTest = "0057_staff_scheduling_scope";

/** The three keys step 2 gives the Groomer; with `appointments.create`, the four that narrow to "mine". */
const SCOPED_KEYS = ["appointments.edit", "calendar.blocks_create", "calendar.blocks_edit"];
const NARROWED_KEYS = ["appointments.create", ...SCOPED_KEYS];
/** The key that says scope does not apply. */
const ALL_STAFF = "appointments.edit_all_staff";

describeDatabase("migration 0057 staff scheduling scope", () => {
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

  /** A database at exactly 0056, with nothing of 0057 applied. */
  async function databaseAt0056(): Promise<postgres.Sql> {
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

  /** Applies 0057, leaving the connection usable if it refused. See 0039's suite for why. */
  async function apply0057(sql: postgres.Sql): Promise<void> {
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
   * A. STEP 1 GRANTS THE ALL-STAFF KEY TO EXACTLY THE ROLES THAT CAN REACH ACROSS THE STAFF TODAY.
   *
   * The fixture is chosen around the shapes a NOMINAL predicate gets wrong, because those are the
   * failures that would reach a real salon:
   *
   *   * a built-in an owner RENAMED - "Front of house" rather than "Receptionist";
   *   * a CUSTOM role a salon authored for its own front desk;
   *   * a role holding ONLY a block key and no `appointments.edit` at all, which is a role that
   *     can block any groomer's lunch today and must still be able to tomorrow;
   *   * a BOOKING-ONLY desk holding `appointments.create` and nothing else scoped, which books
   *     onto any groomer's calendar today and must still be able to tomorrow.
   *
   * A role holding none of the four gains nothing: this step is a preservation, not a widening.
   */
  it("grants the all-staff key to every role holding any scoped key, in every business, and to no other", async () => {
    const sql = await databaseAt0056();
    try {
      const first = await tenant(sql, "grant-a");
      const second = await tenant(sql, "grant-b");

      const renamed = await role(sql, first, "Front of house",
        ["calendar.view", "appointments.view", "appointments.create", "appointments.edit",
          "calendar.blocks_create", "calendar.blocks_edit"], { builtIn: true });
      const custom = await role(sql, first, "Saturday desk",
        ["calendar.view", "appointments.edit", "customers.edit"]);
      const blockOnly = await role(sql, first, "Lunch planner",
        ["calendar.view", "calendar.blocks_create"]);
      const editOnlyBlocks = await role(sql, first, "Block fixer",
        ["calendar.view", "calendar.blocks_edit"]);
      const bookingOnly = await role(sql, first, "Booking desk",
        ["calendar.view", "appointments.view", "appointments.create"]);
      const manager = await role(sql, first, "Manager",
        [...SCOPED_KEYS, ALL_STAFF, "reports.view"], { builtIn: true });
      // A SECOND BUSINESS. This is a data migration over every tenant's rows, not one workspace's.
      const otherTenant = await role(sql, second, "Reception", ["appointments.view", "appointments.edit"]);

      // Hold none of the three, and must gain nothing.
      const viewer = await role(sql, second, "Read only", ["calendar.view"]);
      const checkout = await role(sql, first, "Till",
        ["appointments.view", "checkout.perform", "payments.view", "operations.check_in"]);

      const before = new Map(await Promise.all(
        [renamed, custom, blockOnly, editOnlyBlocks, bookingOnly, manager, otherTenant, viewer, checkout]
          .map(async (id) => [id, await roleState(sql, id)] as const)
      ));

      await apply0057(sql);

      for (const id of [renamed, custom, blockOnly, editOnlyBlocks, bookingOnly, otherTenant]) {
        const after = await roleState(sql, id);
        expect(after.permissions, `role ${id}`).toContain(ALL_STAFF);
        // Nothing was taken away in the process.
        expect(after.permissions, `role ${id}`)
          .toEqual(expect.arrayContaining(before.get(id)!.permissions));
        // And nothing else was added: a role that could block time out but not edit appointments
        // gains the all-staff key and NOT `appointments.edit`. Step 2 is for the Groomer alone.
        expect(after.permissions.length, `role ${id}`).toBe(before.get(id)!.permissions.length + 1);
        // The version moved, for 0043's and 0045's reason.
        expect(after.version, `role ${id}`).toBe(before.get(id)!.version + 1);
      }

      for (const id of [viewer, checkout]) {
        const after = await roleState(sql, id);
        expect(after.permissions, `role ${id}`).toEqual(before.get(id)!.permissions);
        expect(after.version, `role ${id}`).toBe(before.get(id)!.version);
      }

      // The Manager already held the all-staff key, so it was not a role that changed.
      expect(await roleState(sql, manager)).toEqual(before.get(manager));

      // The invariant the migration asserts for itself, checked from outside.
      const [stranded] = await sql<{ count: number }[]>`
        select count(*)::int as count from roles
        where permissions && ${NARROWED_KEYS}::text[]
          and not (${ALL_STAFF} = any(permissions))
          and not (built_in and lower(name) = 'groomer')
      `;
      expect(stranded!.count).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * B. STEP 2 GIVES THE BUILT-IN GROOMER ITS OWN DAY, AND ONLY THE BUILT-IN GROOMER.
   *
   * The Groomer as 0041 seeded it: seven keys, none of them scoped. Afterwards it holds the three
   * scoped keys and NOT the all-staff key. A custom role named Groomer is an owner's own and is
   * left exactly as they made it.
   *
   * THE HAND-WIDENED GROOMER IS THE CASE STEP 1'S EXCLUSION EXISTS FOR. A built-in Groomer an
   * owner had already given `calendar.blocks_create` could, before this change, block out ANY
   * groomer's calendar. A step 1 that preserved that reach would grant it the all-staff key, and
   * step 2 would then add `appointments.edit` - every appointment in the salon, handed to a
   * groomer by a migration. The owner's rule is that a Groomer must not gain cross-groomer
   * mutation authority, so this is the one narrowing 0057 makes without preserving: the Groomer
   * keeps its block key, gains the scoped keys, does NOT receive the all-staff key, and its
   * blocks become own-calendar only.
   */
  it("gives the built-in Groomer the three scoped keys without the all-staff key", async () => {
    const sql = await databaseAt0056();
    try {
      const salon = await tenant(sql, "groomer");
      const seeded = ["calendar.view", "appointments.view", "pets.view", "pets.care.view",
        "operations.check_in", "operations.perform_service", "operations.complete"];
      const groomer = await role(sql, salon, "Groomer", seeded, { builtIn: true });
      const customGroomer = await role(sql, salon, "Weekend groomer", seeded);
      // A Groomer somebody had already started widening by hand, before this change gave the key
      // its scope. Step 2 is idempotent over the partial grant; step 1 must not see it at all.
      const other = await tenant(sql, "groomer-b");
      const halfGranted = await role(sql, other, "Groomer",
        [...seeded, "calendar.blocks_create"], { builtIn: true });

      const before = {
        groomer: await roleState(sql, groomer),
        customGroomer: await roleState(sql, customGroomer),
        halfGranted: await roleState(sql, halfGranted)
      };

      await apply0057(sql);

      for (const [label, id] of [["groomer", groomer], ["halfGranted", halfGranted]] as const) {
        const after = await roleState(sql, id);
        expect(after.permissions, label).toEqual(expect.arrayContaining(SCOPED_KEYS));
        // Nothing taken away: the hand-given block key is still there.
        expect(after.permissions, label).toEqual(expect.arrayContaining(before[label].permissions));
        // And NOT the all-staff key, for either of them. The plain Groomer held no scoped key,
        // so step 1 had nothing to match; the half-granted one held a block key, and step 1
        // skipped it by name. Its `calendar.blocks_create` now reaches its own calendar only -
        // the meaning the preset gives the key - where before this change it reached every
        // groomer's. That is the deliberate narrowing, not a stranding: a Groomer must not be
        // handed cross-groomer authority by a migration, and an owner who wants this one to
        // have it flips the all-staff switch in the editor.
        expect(after.permissions, label).not.toContain(ALL_STAFF);
        // Step 2 granted exactly the two scoped keys it was missing, and nothing else.
        expect(after.permissions.length, label).toBe(
          before[label].permissions.length + SCOPED_KEYS.filter((key) => !before[label].permissions.includes(key)).length
        );
        expect(after.version, label).toBeGreaterThan(before[label].version);
      }

      const custom = await roleState(sql, customGroomer);
      expect(custom).toEqual(before.customGroomer);
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
    const sql = await databaseAt0056();
    try {
      const salon = await tenant(sql, "idempotent");
      const desk = await role(sql, salon, "Desk", ["calendar.view", "appointments.edit"]);
      const groomer = await role(sql, salon, "Groomer",
        ["calendar.view", "appointments.view"], { builtIn: true });
      const viewer = await role(sql, salon, "Viewer", ["calendar.view"]);

      await apply0057(sql);
      const afterFirst = {
        desk: await roleState(sql, desk),
        groomer: await roleState(sql, groomer),
        viewer: await roleState(sql, viewer)
      };
      expect(afterFirst.desk.permissions).toContain(ALL_STAFF);
      expect(afterFirst.groomer.permissions).toEqual(expect.arrayContaining(SCOPED_KEYS));
      expect(afterFirst.groomer.permissions).not.toContain(ALL_STAFF);

      // The file records itself, which is what makes the re-run below a no-op; the runner's own
      // insert is `on conflict do nothing` for exactly this case.
      const [recorded] = await sql<{ count: number }[]>`
        select count(*)::int as count from schema_migrations where version=${migrationUnderTest}
      `;
      expect(recorded!.count).toBe(1);

      await apply0057(sql);
      expect(await roleState(sql, desk)).toEqual(afterFirst.desk);
      // THE GROOMER, TWICE OVER. After the first pass it holds the three scoped keys; step 1
      // skips it by name AND consults the record the file wrote, so the second run must leave it
      // exactly as the first left it, still without the all-staff key. A migration idempotent
      // for every role but this one would widen every Groomer on the day a runner replays the
      // file.
      expect(await roleState(sql, groomer)).toEqual(afterFirst.groomer);
      expect(await roleState(sql, viewer)).toEqual(afterFirst.viewer);
      // And a role that would have qualified for step 1 had it existed the first time is NOT
      // reached by a re-run either: the file has run, and its grants are a one-time preservation
      // of what roles held at that moment, not a standing rule.
      const late = await role(sql, salon, "Late desk", ["calendar.view", "appointments.edit"]);
      await apply0057(sql);
      expect((await roleState(sql, late)).permissions).not.toContain(ALL_STAFF);
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
  it("applies the whole chain, 0057 included, to an empty database", async () => {
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
