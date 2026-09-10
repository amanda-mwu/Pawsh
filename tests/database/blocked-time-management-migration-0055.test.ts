import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0055 gives `blocked_times` a colour, a concurrency token and the index its reads have gone
 * without - and grants two permissions to roles that already exist.
 *
 * THE PERMISSION GRANT IS THE PART THAT CAN GO WRONG SILENTLY, and it is the reason this suite
 * builds its own database rather than sharing the migrated one. `POST /api/blocked-times` moves
 * off `appointments.edit` and onto `calendar.blocks_create` in the same change; without the
 * backfill, every role holding the old key and not the new pair loses the ability to block time
 * out, in every workspace that already exists, with no error that explains itself. That property
 * is about what the migration DOES TO PRE-EXISTING ROWS, which a suite running against an
 * already-migrated database cannot observe at all. So the schema is built to exactly 0054, roles
 * are planted in the shapes real customer data takes - including the two shapes a NOMINAL
 * predicate would get wrong - and only then is 0055 applied.
 *
 * It follows `appointment-service-order-migration-0054.test.ts` and
 * `appointment-times-migration-0049.test.ts` in structure, throwaway databases included.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED. Nothing here claims a colour for a historical block. The
 * column is nullable and every pre-existing row keeps null, which means "nobody chose"; a test
 * expecting a backfilled palette value would be asserting an invention.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const scratchDatabase = "pawsh_migration_0055_vitest";
const emptyChainDatabase = "pawsh_chain_0055_vitest";
const lastMigrationBefore = "0054_appointment_service_order";
const migrationUnderTest = "0055_blocked_time_management";

/** The pair the create route and its edit twin are gated on. */
const BLOCK_KEYS = ["calendar.blocks_create", "calendar.blocks_edit"];
/** The capability being migrated off, and therefore the backfill's whole predicate. */
const OLD_KEY = "appointments.edit";

describeDatabase("migration 0055 blocked time management", () => {
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

  /** A database at exactly 0054, with nothing of 0055 applied. */
  async function databaseAt0054(): Promise<postgres.Sql> {
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

  /** Applies 0055, leaving the connection usable if it refused. See 0039's suite for why. */
  async function apply0055(sql: postgres.Sql): Promise<void> {
    try {
      await sql.unsafe(await readFile(resolve("migrations", `${migrationUnderTest}.sql`), "utf8"));
    } catch (error) {
      await sql.unsafe("rollback").catch(() => {});
      throw error;
    }
  }

  /** The minimum object graph a blocked time needs, in one business. */
  async function tenant(sql: postgres.Sql, label: string) {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const [user] = await sql<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash) values (${email},${email},'test') returning id
    `;
    const [business] = await sql<{ id: string }[]>`
      insert into businesses(name) values (${label}) returning id
    `;
    const [location] = await sql<{ id: string }[]>`
      insert into locations(business_id,name,timezone)
      values (${business!.id},'Salon','America/Los_Angeles') returning id
    `;
    const [employee] = await sql<{ id: string }[]>`
      insert into employees(business_id,display_name) values (${business!.id},'Groomer') returning id
    `;
    return {
      businessId: business!.id, userId: user!.id,
      locationId: location!.id, employeeId: employee!.id
    };
  }

  type Tenant = Awaited<ReturnType<typeof tenant>>;

  /**
   * One block, written the way the route writes it: the naive local columns are DERIVED from the
   * instant in SQL, never bound as a string, because 0051's check constraint compares them and a
   * hand-typed local time is exactly the mismatch that constraint exists to refuse.
   */
  async function block(
    sql: postgres.Sql, owner: Tenant, hour: number, colorSlot: number | null = null
  ) {
    const start = `2035-04-0${hour < 10 ? 1 : 2}T${String(hour).padStart(2, "0")}:00:00Z`;
    const end = `2035-04-0${hour < 10 ? 1 : 2}T${String(hour).padStart(2, "0")}:30:00Z`;
    const [row] = await sql<{ id: string }[]>`
      insert into blocked_times(business_id,employee_id,location_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_local_end,reason,created_by)
      values (${owner.businessId},${owner.employeeId},${owner.locationId},
        ${start}::timestamptz,${end}::timestamptz,'America/Los_Angeles',
        ${start}::timestamptz at time zone 'America/Los_Angeles',
        ${end}::timestamptz at time zone 'America/Los_Angeles',
        ${`Legacy block ${hour}`},${owner.userId})
      returning id
    `;
    if (colorSlot !== null) {
      await sql`update blocked_times set color_slot=${colorSlot} where id=${row!.id}`;
    }
    return row!.id;
  }

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
   * A. THE COLUMNS ARRIVE WITH THE BOUNDS THEY WERE SPECIFIED WITH, AND EXISTING ROWS SURVIVE.
   *
   * The colour check is 0040's, copied verbatim from `employees.color_slot`: a DURABLE OUTER BOUND
   * of 0-15 rather than the palette's real size, so growing the palette to twelve is a constant in
   * the domain package and never another migration on a table with rows in it. So the bound is
   * asserted at both ends and one step past each of them.
   */
  it("adds a bounded nullable colour and leaves every existing block without one", async () => {
    const sql = await databaseAt0054();
    try {
      const owner = await tenant(sql, "colour");
      const legacy = [await block(sql, owner, 6), await block(sql, owner, 7)];

      const [before] = await sql<{ count: number }[]>`
        select count(*)::int as count from information_schema.columns
        where table_name='blocked_times' and column_name='color_slot'
      `;
      expect(before!.count, "0054 must not already carry color_slot").toBe(0);

      await apply0055(sql);

      // NULL, not a hash-dealt colour. Nobody chose one for these, and inventing one would
      // recolour every block on every existing calendar in order to say nothing.
      const rows = await sql<{ colorSlot: number | null }[]>`
        select color_slot from blocked_times where id in ${sql(legacy)}
      `;
      expect(rows.map((row) => row.colorSlot)).toEqual([null, null]);

      const [column] = await sql<{ isNullable: string; dataType: string }[]>`
        select is_nullable, data_type from information_schema.columns
        where table_name='blocked_times' and column_name='color_slot'
      `;
      expect(column).toEqual({ isNullable: "YES", dataType: "smallint" });

      // Both ends of the durable bound, and null, are accepted.
      for (const slot of [0, 9, 15, null]) {
        const id = await block(sql, owner, 8);
        await expect(sql`update blocked_times set color_slot=${slot} where id=${id}`)
          .resolves.toBeDefined();
      }
      // One step past each end is not. 16 is the first slot outside the bound; a negative is not a
      // slot at all.
      const outside = await block(sql, owner, 9);
      for (const slot of [16, -1]) {
        await expect(
          sql`update blocked_times set color_slot=${slot} where id=${outside}`,
          `slot ${slot}`
        ).rejects.toThrow(/color_slot/u);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * B. THE CONCURRENCY TOKEN, WITH THE DEFAULT THAT BACKFILLS IT.
   *
   * Every row that exists when this runs has never been edited, so version 1 is the truth about
   * all of them and the column default is the whole backfill. The `> 0` check is 0022's and 0041's
   * spelling; it is asserted by attempting the value it exists to refuse, because a version that
   * could reach zero would make "the version I read" ambiguous.
   */
  it("adds a version column that starts every existing block at 1 and refuses to go below it", async () => {
    const sql = await databaseAt0054();
    try {
      const owner = await tenant(sql, "version");
      const legacy = await block(sql, owner, 6);
      await apply0055(sql);

      const [column] = await sql<{ isNullable: string; dataType: string; columnDefault: string }[]>`
        select is_nullable, data_type, column_default from information_schema.columns
        where table_name='blocked_times' and column_name='version'
      `;
      expect(column!.isNullable).toBe("NO");
      expect(column!.dataType).toBe("integer");
      expect(column!.columnDefault).toBe("1");

      const [migrated] = await sql<{ version: number }[]>`
        select version from blocked_times where id=${legacy}
      `;
      expect(migrated!.version, "a block nobody has edited is at version 1").toBe(1);
      // And a row written after the migration lands on the same default, without the writer
      // saying so.
      const [fresh] = await sql<{ version: number }[]>`
        select version from blocked_times where id=${await block(sql, owner, 7)}
      `;
      expect(fresh!.version).toBe(1);

      await expect(sql`update blocked_times set version=0 where id=${legacy}`)
        .rejects.toThrow(/version/u);
      // The ordinary increment - what an edit route will do - is fine.
      await sql`update blocked_times set version=version+1 where id=${legacy}`;
      expect((await sql<{ version: number }[]>`
        select version from blocked_times where id=${legacy}
      `)[0]!.version).toBe(2);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * C. THE INDEX THE CALENDAR READ HAS BEEN GOING WITHOUT.
   *
   * `blocked_times` carried its primary key and NOTHING ELSE, so every read of it - the
   * availability authority's subtraction and the calendar's range read - was a sequential scan.
   * The column ORDER is the assertion that matters: the two equalities the reads always carry lead
   * it, and the range column follows, which is the shape a btree answers in one descent.
   */
  it("indexes the calendar read on (business_id, location_id, start_at), in that order", async () => {
    const sql = await databaseAt0054();
    try {
      const [before] = await sql<{ count: number }[]>`
        select count(*)::int as count from pg_indexes
        where tablename='blocked_times' and indexname='blocked_time_location_calendar'
      `;
      expect(before!.count, "0054 must not already carry the index").toBe(0);

      await apply0055(sql);

      const [index] = await sql<{ definition: string }[]>`
        select indexdef as definition from pg_indexes
        where tablename='blocked_times' and indexname='blocked_time_location_calendar'
      `;
      expect(index!.definition).toContain("(business_id, location_id, start_at)");
      // Not unique: two shops, two groomers, or one groomer on two occasions may all start a block
      // at the same instant, and every one of those is ordinary.
      expect(index!.definition).not.toContain("UNIQUE");
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * D. THE BACKFILL GRANTS THE PAIR TO EXACTLY THE ROLES THAT COULD ALREADY BLOCK TIME OUT.
   *
   * The fixture is chosen around the two shapes a NOMINAL predicate gets wrong, because those are
   * the failures that would reach a real salon:
   *
   *   * a built-in an owner RENAMED - "Front of house" rather than "Receptionist", which owners do
   *     and are entitled to do;
   *   * a CUSTOM role a salon authored for its own front desk, which no name list could ever
   *     enumerate.
   *
   * Both hold `appointments.edit` and both must be covered. A role without it must gain nothing,
   * which is the other half: this migration is a preservation, not a widening, and a groomer who
   * could not block a calendar out before must not be able to now.
   */
  it("grants the pair to every role holding the old key, in every business, and to no other", async () => {
    const sql = await databaseAt0054();
    try {
      const first = await tenant(sql, "grant-a");
      const second = await tenant(sql, "grant-b");

      // Holds the old key. Each is a shape the name-matching version of this migration would miss.
      const renamed = await role(sql, first, "Front of house",
        ["calendar.view", "appointments.view", "appointments.create", OLD_KEY], { builtIn: true });
      const custom = await role(sql, first, "Saturday desk",
        ["calendar.view", OLD_KEY, "customers.edit"]);
      const manager = await role(sql, first, "Manager", [OLD_KEY, ...BLOCK_KEYS, "reports.view"]);
      const halfGranted = await role(sql, first, "Half granted",
        [OLD_KEY, "calendar.blocks_create"]);
      // A SECOND BUSINESS. This is a data migration over every tenant's rows, not one workspace's.
      const otherTenant = await role(sql, second, "Reception", ["appointments.view", OLD_KEY]);

      // Does NOT hold the old key, and must gain nothing.
      const groomer = await role(sql, first, "Groomer",
        ["calendar.view", "appointments.view", "pets.care.view"]);
      const viewer = await role(sql, second, "Read only", ["calendar.view"]);

      const before = new Map(await Promise.all(
        [renamed, custom, manager, halfGranted, otherTenant, groomer, viewer]
          .map(async (id) => [id, await roleState(sql, id)] as const)
      ));

      await apply0055(sql);

      // Everyone who could block time out still can, and now holds BOTH keys - the create one the
      // route takes today and the edit one its twin takes next, so the capability does not arrive
      // in halves.
      for (const id of [renamed, custom, manager, halfGranted, otherTenant]) {
        const after = await roleState(sql, id);
        expect(after.permissions, `role ${id}`).toEqual(expect.arrayContaining(BLOCK_KEYS));
        // Nothing was taken away in the process.
        expect(after.permissions, `role ${id}`)
          .toEqual(expect.arrayContaining(before.get(id)!.permissions));
      }

      // A role without the old key gains nothing at all, and is not touched.
      for (const id of [groomer, viewer]) {
        const after = await roleState(sql, id);
        expect(after.permissions.filter((key) => BLOCK_KEYS.includes(key)), `role ${id}`).toEqual([]);
        expect(after.permissions, `role ${id}`).toEqual(before.get(id)!.permissions);
        // Its optimistic-concurrency token did not move either: an editor holding this role open
        // must not be told it went stale by a migration that did not change it.
        expect(after.version, `role ${id}`).toBe(before.get(id)!.version);
      }

      // The version DID move for every role that changed, for the reason 0043 and 0045 moved it:
      // an editor holding the old copy must be told it is stale rather than allowed to write these
      // grants back out.
      for (const id of [renamed, custom, halfGranted, otherTenant]) {
        expect((await roleState(sql, id)).version, `role ${id}`).toBe(before.get(id)!.version + 1);
      }
      // The Manager already held both keys, so it was not a role that changed, and its version is
      // where it was. This is the clause that makes the whole file idempotent.
      expect((await roleState(sql, manager)).version).toBe(before.get(manager)!.version);

      // AND THE INVARIANT THE MIGRATION ASSERTS FOR ITSELF, checked here from outside: after this
      // file, no role anywhere can edit appointments without being able to block time out.
      const [stranded] = await sql<{ count: number }[]>`
        select count(*)::int as count from roles
        where ${OLD_KEY} = any(permissions)
          and not (permissions @> ${BLOCK_KEYS}::text[])
      `;
      expect(stranded!.count).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * E. RUNNING IT TWICE CHANGES NOTHING THE SECOND TIME.
   *
   * A migration re-applied by hand, by a restored snapshot replaying the directory, or by a runner
   * whose bookkeeping was lost must not keep bumping role versions - every bump invalidates an
   * editor somebody has open. 0045 did not need to be idempotent in that respect because it ran
   * once and its predicate went on matching; this one carries a second clause excluding roles that
   * already hold both keys, which is what makes the re-run match nothing at all.
   */
  it("is idempotent: a second application grants nothing and moves no version", async () => {
    const sql = await databaseAt0054();
    try {
      const owner = await tenant(sql, "idempotent");
      const desk = await role(sql, owner, "Desk", ["calendar.view", OLD_KEY]);
      const groomer = await role(sql, owner, "Groomer", ["calendar.view"]);
      await block(sql, owner, 6);

      await apply0055(sql);
      const afterFirst = {
        desk: await roleState(sql, desk), groomer: await roleState(sql, groomer)
      };
      expect(afterFirst.desk.permissions).toEqual(expect.arrayContaining(BLOCK_KEYS));

      await apply0055(sql);
      expect(await roleState(sql, desk)).toEqual(afterFirst.desk);
      expect(await roleState(sql, groomer)).toEqual(afterFirst.groomer);

      // THE DDL HALVES ARE WHY THE SECOND APPLICATION RETURNS AT ALL. A plain `add column` throws
      // on a column that exists, so reaching this line is itself the assertion that both are
      // `if not exists`; the counts then say they were added once rather than skipped entirely.
      const [columns] = await sql<{ count: number }[]>`
        select count(*)::int as count from information_schema.columns
        where table_name='blocked_times' and column_name in ('color_slot','version')
      `;
      expect(columns!.count).toBe(2);
      const [index] = await sql<{ count: number }[]>`
        select count(*)::int as count from pg_indexes
        where tablename='blocked_times' and indexname='blocked_time_location_calendar'
      `;
      expect(index!.count).toBe(1);
      // And the block written before the migration still has exactly one row's worth of state:
      // nothing here duplicates, resets or recolours anything on a re-run.
      const [blocks] = await sql<{ count: number; coloured: number; versions: number }[]>`
        select count(*)::int as count,
          count(color_slot)::int as coloured,
          count(*) filter (where version <> 1)::int as versions
        from blocked_times
      `;
      expect(blocks).toEqual({ count: 1, coloured: 0, versions: 0 });
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * F. THE WHOLE CHAIN STILL APPLIES TO AN EMPTY DATABASE.
   *
   * 0055's role UPDATE and its closing assertion both run over a table with no rows in it on a
   * fresh install. An aggregate or a `count(*)` written carelessly is exactly the kind of thing
   * that passes against seeded data and fails on the first deploy to a new environment.
   */
  it("applies the whole chain, 0055 included, to an empty database", async () => {
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
        // Some older migrations record their own version from inside the file, so this is
        // `on conflict do nothing` and the recorded SET is asserted below.
        await sql`insert into schema_migrations (version) values (${version}) on conflict do nothing`;
      }
      const applied = await sql<{ version: string }[]>`
        select version from schema_migrations order by version
      `;
      expect(applied.map((row) => row.version))
        .toEqual(files.map((file) => file.replace(/\.sql$/, "")));
      // ITS VERSION IS IN THE SET, NOT AT THE END OF IT. This asserted "last" while the file under
      // test was head; the next migration then failed this suite for a reason that had nothing to
      // do with the migration it covers. The line above already pins the whole recorded set to the
      // whole directory, which is the stronger statement; this one is about the file under test
      // being part of it.
      expect(applied.map((row) => row.version)).toContain(migrationUnderTest);

      const columns = await sql<{ columnName: string }[]>`
        select column_name from information_schema.columns
        where table_name='blocked_times' and column_name in ('color_slot','version')
        order by column_name
      `;
      expect(columns.map((row) => row.columnName)).toEqual(["color_slot", "version"]);
      const [index] = await sql<{ count: number }[]>`
        select count(*)::int as count from pg_indexes
        where tablename='blocked_times' and indexname='blocked_time_location_calendar'
      `;
      expect(index!.count).toBe(1);
      const [roles] = await sql<{ count: number }[]>`select count(*)::int as count from roles`;
      expect(roles!.count, "a fresh install has no roles until a business is provisioned").toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});
