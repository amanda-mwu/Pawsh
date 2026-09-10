import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0056 gives `blocked_times` the `updated_by` / `updated_at` pair every other mutable record in
 * this schema carries, because from this change on a block can BE mutated.
 *
 * THE BACKFILL IS THE PART THAT CAN GO WRONG SILENTLY, and it is the reason this suite builds its
 * own database rather than sharing the migrated one. The one-line version of this migration -
 * `add column updated_at timestamptz not null default now()` - compiles, passes every schema
 * assertion, and stamps every block that has ever been written with the moment the deploy ran, so
 * a calendar untouched since March reports that all of it was edited at release time. That is a
 * property about what the migration DOES TO PRE-EXISTING ROWS, which a suite running against an
 * already-migrated database cannot observe at all. So the schema is built to exactly 0055, blocks
 * are planted with creation times spread across a year, and only then is 0056 applied.
 *
 * It follows `blocked-time-management-migration-0055.test.ts` in structure, throwaway databases
 * included.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const scratchDatabase = "pawsh_migration_0056_vitest";
const emptyChainDatabase = "pawsh_chain_0056_vitest";
const lastMigrationBefore = "0055_blocked_time_management";
const migrationUnderTest = "0056_blocked_time_mutation_metadata";

describeDatabase("migration 0056 blocked time mutation metadata", () => {
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

  /** A database at exactly 0055, with nothing of 0056 applied. */
  async function databaseAt0055(): Promise<postgres.Sql> {
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

  /** Applies 0056, leaving the connection usable if it refused. */
  async function apply0056(sql: postgres.Sql): Promise<void> {
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
   * One block written the way the route writes it, with an explicit `created_at`.
   *
   * The naive local columns are DERIVED from the instant in SQL rather than bound as a string,
   * because 0051's check constraint compares them and a hand-typed local time is exactly the
   * mismatch that constraint exists to refuse.
   */
  async function block(
    sql: postgres.Sql, owner: Tenant, label: string, createdAt: string
  ): Promise<string> {
    // February is PST and July is PDT in America/Los_Angeles, so nothing here can pass by holding
    // a fixed offset - the same convention seams 1 and 2a set.
    const start = "2035-02-15T20:00:00Z";
    const end = "2035-02-15T20:30:00Z";
    const [row] = await sql<{ id: string }[]>`
      insert into blocked_times(business_id,employee_id,location_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_local_end,reason,created_by,created_at)
      values (${owner.businessId},${owner.employeeId},${owner.locationId},
        ${start}::timestamptz,${end}::timestamptz,'America/Los_Angeles',
        ${start}::timestamptz at time zone 'America/Los_Angeles',
        ${end}::timestamptz at time zone 'America/Los_Angeles',
        ${label},${owner.userId},${createdAt}::timestamptz)
      returning id
    `;
    return row!.id;
  }

  /**
   * A. THE COLUMNS ARRIVE NOT NULL, AND EVERY EXISTING BLOCK KEEPS ITS OWN HISTORY.
   *
   * This is the assertion the whole file exists for. `updated_at` must equal `created_at` for a
   * row nobody has ever edited, and `updated_by` must be its author - both are TRUE and both are
   * DERIVABLE, which is why they are backfilled rather than defaulted. A `default now()` would put
   * the deploy's own timestamp on a block written eleven months earlier.
   */
  it("backfills a block's last-writer from its author rather than from the deploy", async () => {
    const sql = await databaseAt0055();
    try {
      const owner = await tenant(sql, "backfill");
      const [before] = await sql<{ count: number }[]>`
        select count(*)::int as count from information_schema.columns
        where table_name='blocked_times' and column_name in ('updated_by','updated_at')
      `;
      expect(before!.count, "0055 must not already carry the pair").toBe(0);

      // Spread across a year, so a single `now()` cannot coincidentally satisfy all three.
      const planted = [
        { id: await block(sql, owner, "Old lunch", "2034-03-04T17:00:00Z"), createdAt: "2034-03-04T17:00:00.000Z" },
        { id: await block(sql, owner, "Vet run", "2034-09-19T22:30:00Z"), createdAt: "2034-09-19T22:30:00.000Z" },
        { id: await block(sql, owner, "Deep clean", "2035-01-02T01:15:00Z"), createdAt: "2035-01-02T01:15:00.000Z" }
      ];

      await apply0056(sql);

      const rows = await sql<{
        id: string; createdBy: string; updatedBy: string; createdAt: Date; updatedAt: Date;
      }[]>`
        select id,created_by,updated_by,created_at,updated_at from blocked_times
        where id in ${sql(planted.map((row) => row.id))}
      `;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        const expected = planted.find((entry) => entry.id === row.id)!;
        // The author is the last writer of a row nobody has written since.
        expect(row.updatedBy, "updated_by is backfilled from created_by").toBe(row.createdBy);
        expect(row.updatedBy).toBe(owner.userId);
        // AND THE TIME IS THE ROW'S OWN, NOT THE MIGRATION'S. This is the assertion that fails if
        // the two statements are ever collapsed into `default now()`.
        expect(row.updatedAt.toISOString()).toBe(expected.createdAt);
        expect(row.updatedAt.toISOString()).toBe(row.createdAt.toISOString());
      }
      // Stated as an invariant as well as row by row, because it is the property the migration's
      // own closing block asserts and the one that has to keep holding for every later write.
      const [offenders] = await sql<{ count: number }[]>`
        select count(*)::int as count from blocked_times where updated_at < created_at
      `;
      expect(offenders!.count).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * B. THE SHAPE, WHICH IS WHAT `if not exists` CANNOT CHECK FOR ITSELF.
   *
   * The pair is NOT NULL to match `appointments` and `appointment_report_cards` - the two other
   * versioned tables - rather than the nullable form `customers` and `pets` use. Those two are
   * nullable because their `created_by` is; `blocked_times.created_by` is not null, so every row
   * has an author, so every row can name a last writer and no reader has to handle an absent one.
   */
  it("adds the pair in the not-null shape the versioned tables use", async () => {
    const sql = await databaseAt0055();
    try {
      const owner = await tenant(sql, "shape");
      await block(sql, owner, "Shape", "2035-01-05T18:00:00Z");
      await apply0056(sql);

      const columns = await sql<{
        columnName: string; dataType: string; isNullable: string; columnDefault: string | null;
      }[]>`
        select column_name,data_type,is_nullable,column_default from information_schema.columns
        where table_name='blocked_times' and column_name in ('updated_by','updated_at')
        order by column_name
      `;
      expect(columns).toEqual([
        {
          columnName: "updated_at", dataType: "timestamp with time zone",
          isNullable: "NO", columnDefault: "now()"
        },
        { columnName: "updated_by", dataType: "uuid", isNullable: "NO", columnDefault: null }
      ]);

      // NOT NULL is enforced rather than merely declared: a writer that forgets `updated_by` is
      // refused, which is what makes the column answerable without a null branch.
      await expect(sql`
        insert into blocked_times(business_id,employee_id,location_id,start_at,end_at,
          scheduling_timezone,scheduled_local_start,scheduled_local_end,reason,created_by)
        values (${owner.businessId},${owner.employeeId},${owner.locationId},
          '2035-07-18T20:00:00Z'::timestamptz,'2035-07-18T20:30:00Z'::timestamptz,
          'America/Los_Angeles',
          '2035-07-18T20:00:00Z'::timestamptz at time zone 'America/Los_Angeles',
          '2035-07-18T20:30:00Z'::timestamptz at time zone 'America/Los_Angeles',
          'No writer',${owner.userId})
      `).rejects.toThrow(/updated_by/u);

      // `updated_by` is a real reference, so a last writer who is not a user cannot be recorded.
      await expect(sql`
        update blocked_times set updated_by=${crypto.randomUUID()}
      `).rejects.toThrow(/updated_by|foreign key/u);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * C. RE-RUNNING IT CHANGES NOTHING.
   *
   * Following 0052 and 0055, this file is idempotent: the DDL is `if not exists`, the backfills
   * are `where ... is null`, and `set not null` / `set default` are no-ops against a column that
   * already has them. The second application must not restamp a row that has since been edited -
   * which is the failure a `where ... is null` guard prevents and an unconditional update would
   * cause.
   */
  it("is a no-op on a second application, including for a block edited in between", async () => {
    const sql = await databaseAt0055();
    try {
      const owner = await tenant(sql, "rerun");
      const untouched = await block(sql, owner, "Untouched", "2034-11-11T19:00:00Z");
      const edited = await block(sql, owner, "Edited", "2034-11-12T19:00:00Z");
      await apply0056(sql);

      // A real edit lands between the two applications, exactly as one would in production between
      // a deploy and a re-run of the same file.
      const [second] = await sql<{ id: string }[]>`
        insert into users(email,normalized_email,password_hash)
        values ('rerun-editor@example.test','rerun-editor@example.test','test') returning id
      `;
      await sql`
        update blocked_times set reason='Edited later',version=version+1,
          updated_by=${second!.id},updated_at='2035-06-01T12:00:00Z'::timestamptz
        where id=${edited}
      `;
      const before = await sql<{ id: string; updatedBy: string; updatedAt: Date; version: number }[]>`
        select id,updated_by,updated_at,version from blocked_times order by reason
      `;

      // THE DDL HALVES ARE WHY THE SECOND APPLICATION RETURNS AT ALL. A plain `add column` throws
      // on a column that exists, so reaching the next line is itself the assertion that both are
      // `if not exists`.
      await apply0056(sql);

      const after = await sql<{ id: string; updatedBy: string; updatedAt: Date; version: number }[]>`
        select id,updated_by,updated_at,version from blocked_times order by reason
      `;
      expect(after).toEqual(before);
      // Named, because the edited row is the one an unconditional backfill would silently revert.
      const editedAfter = after.find((row) => row.id === edited)!;
      expect(editedAfter.updatedBy).toBe(second!.id);
      expect(editedAfter.updatedAt.toISOString()).toBe("2035-06-01T12:00:00.000Z");
      const untouchedAfter = after.find((row) => row.id === untouched)!;
      expect(untouchedAfter.updatedBy).toBe(owner.userId);
      expect(untouchedAfter.updatedAt.toISOString()).toBe("2034-11-11T19:00:00.000Z");

      const [columns] = await sql<{ count: number }[]>`
        select count(*)::int as count from information_schema.columns
        where table_name='blocked_times' and column_name in ('updated_by','updated_at')
      `;
      expect(columns!.count).toBe(2);
      const [blocks] = await sql<{ count: number }[]>`
        select count(*)::int as count from blocked_times
      `;
      expect(blocks!.count, "nothing here duplicates a row").toBe(2);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * D. THE WHOLE CHAIN STILL APPLIES TO AN EMPTY DATABASE.
   *
   * Both backfills and the closing verification block run over a table with no rows in it on a
   * fresh install. An aggregate written carelessly is exactly the kind of thing that passes
   * against seeded data and fails on the first deploy to a new environment.
   */
  it("applies the whole chain, 0056 included, to an empty database", async () => {
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
      // In the set rather than at the end of it, so the next migration does not fail this suite
      // for a reason that has nothing to do with the file it covers.
      expect(applied.map((row) => row.version)).toContain(migrationUnderTest);

      const columns = await sql<{ columnName: string }[]>`
        select column_name from information_schema.columns
        where table_name='blocked_times' and column_name in ('updated_at','updated_by')
        order by column_name
      `;
      expect(columns.map((row) => row.columnName)).toEqual(["updated_at", "updated_by"]);
      const [blocks] = await sql<{ count: number }[]>`
        select count(*)::int as count from blocked_times
      `;
      expect(blocks!.count, "a fresh install has no blocks").toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});
