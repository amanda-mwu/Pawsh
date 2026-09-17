import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0057 is a data migration over `roles` and nothing else: `appointments.edit_all_staff` starts
 * enforcing in the same change, so the three keys it scopes - `appointments.edit`,
 * `calendar.blocks_create`, `calendar.blocks_edit` - narrow from "anybody's" to "mine", and this
 * file is what keeps that narrowing from taking a capability away from a role that has it today.
 *
 * THE GRANT IS THE PART THAT CAN GO WRONG SILENTLY, which is why this suite builds its own
 * database rather than sharing the migrated one, exactly as 0055's does. What matters is what the
 * migration DOES TO PRE-EXISTING ROWS - a Receptionist that could move every groomer's bookings
 * yesterday must be able to today - and a suite against an already-migrated database cannot
 * observe that. So the schema is built to exactly 0056, roles are planted in the shapes real
 * customer data takes, and only then is 0057 applied.
 *
 * THE ORDER OF ITS TWO STEPS IS THE OTHER THING THAT CAN GO WRONG SILENTLY. Step 1 grants the
 * all-staff key to every role overlapping the three scoped keys; step 2 grants the three scoped
 * keys to the built-in Groomer. Run the other way round, step 1 would find every Groomer holding
 * `appointments.edit` and hand it the whole salon - a widening nobody asked for, in every
 * workspace, with no error. Case B plants a built-in Groomer and asserts it comes out holding
 * the scoped keys and NOT the all-staff one.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const scratchDatabase = "pawsh_migration_0057_vitest";
const emptyChainDatabase = "pawsh_chain_0057_vitest";
const lastMigrationBefore = "0056_blocked_time_mutation_metadata";
const migrationUnderTest = "0057_staff_scheduling_scope";

/** The three keys whose meaning narrows to "mine". */
const SCOPED_KEYS = ["appointments.edit", "calendar.blocks_create", "calendar.blocks_edit"];
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
   *     can block any groomer's lunch today and must still be able to tomorrow.
   *
   * A role holding none of the three gains nothing: this step is a preservation, not a widening.
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
      const manager = await role(sql, first, "Manager",
        [...SCOPED_KEYS, ALL_STAFF, "reports.view"], { builtIn: true });
      // A SECOND BUSINESS. This is a data migration over every tenant's rows, not one workspace's.
      const otherTenant = await role(sql, second, "Reception", ["appointments.view", "appointments.edit"]);

      // Hold none of the three, and must gain nothing.
      const viewer = await role(sql, second, "Read only", ["calendar.view"]);
      const checkout = await role(sql, first, "Till",
        ["appointments.view", "checkout.perform", "payments.view", "operations.check_in"]);

      const before = new Map(await Promise.all(
        [renamed, custom, blockOnly, editOnlyBlocks, manager, otherTenant, viewer, checkout]
          .map(async (id) => [id, await roleState(sql, id)] as const)
      ));

      await apply0057(sql);

      for (const id of [renamed, custom, blockOnly, editOnlyBlocks, otherTenant]) {
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
        where permissions && ${SCOPED_KEYS}::text[]
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
   * scoped keys, and - the assertion the step order exists for - NOT the all-staff key. A custom
   * role named Groomer is an owner's own and is left exactly as they made it.
   */
  it("gives the built-in Groomer the three scoped keys without the all-staff key", async () => {
    const sql = await databaseAt0056();
    try {
      const salon = await tenant(sql, "groomer");
      const seeded = ["calendar.view", "appointments.view", "pets.view", "pets.care.view",
        "operations.check_in", "operations.perform_service", "operations.complete"];
      const groomer = await role(sql, salon, "Groomer", seeded, { builtIn: true });
      const customGroomer = await role(sql, salon, "Weekend groomer", seeded);
      // A Groomer somebody had already started widening by hand: idempotent over a partial grant.
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
        expect(after.permissions, label).toEqual(expect.arrayContaining(before[label].permissions));
        // THE ORDER. Step 1 ran first and found the Groomer holding no scoped key, so it matched
        // nothing; step 2 then granted the scoped keys alone. The half-granted one held a block
        // key going in, so step 1 DID reach it - that role could already block any groomer's
        // lunch, and the migration is not the place to take that away.
        if (label === "groomer") expect(after.permissions).not.toContain(ALL_STAFF);
        else expect(after.permissions).toContain(ALL_STAFF);
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
      // THE GROOMER IS THE SHARP CASE FOR A RE-RUN. After the first pass it holds the three scoped
      // keys, so a second pass's step 1 WOULD match it - which is why step 1 consults the record
      // the file wrote. The second run must leave the Groomer exactly as the first left it, still
      // without the all-staff key: a migration idempotent for every role but this one would widen
      // every Groomer on the day a runner replays the file.
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
