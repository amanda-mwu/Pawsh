import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0054 adds `appointment_services.line_position`, backfills it, and then constrains it - which is
 * the shape most likely to fail at DEPLOY time rather than in a request. `set not null`, the check
 * and the unique key are all validated against every existing row the moment they are added, so a
 * backfill that misses a row, or leaves two rows at one position, aborts the migration on
 * somebody's production database rather than in a test.
 *
 * It runs against its own throwaway database rather than the shared test one, following
 * `appointment-times-migration-0049.test.ts` and `square-migration-0039.test.ts`: the property
 * under test is what the migration DOES to pre-existing rows, which a suite sharing an
 * already-migrated database cannot observe. The schema is built to exactly 0053, appointment
 * services are planted in the shapes real data actually takes, and only then is 0054 applied.
 *
 * WHAT THE BACKFILL IS ALLOWED TO CLAIM, AND WHAT THESE TESTS THEREFORE ASSERT. There is no
 * recorded booking order on an existing row - no timestamp, and a random primary key - so the
 * migration orders by `ctid` and calls the result DETERMINISTIC LEGACY ORDER rather than recorded
 * booking order. The assertions below hold it to exactly that promise and no more: every row gets
 * a position, the positions per appointment are 1..n with no gaps or repeats, and the order is
 * STABLE across repeated reads. There is deliberately NO assertion that a historical row landed in
 * the sequence its operator picked, because nothing in the database knows that and a test claiming
 * otherwise would be asserting the fixture's insert order back at itself.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const scratchDatabase = "pawsh_migration_0054_vitest";
const emptyChainDatabase = "pawsh_chain_0054_vitest";
const lastMigrationBefore = "0053_retire_coupon_stacking";
const migrationUnderTest = "0054_appointment_service_order";

describeDatabase("migration 0054 appointment service order", () => {
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

  /** A database at exactly 0053, with nothing of 0054 applied. */
  async function databaseAt0053(): Promise<postgres.Sql> {
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

  /** Applies 0054, leaving the connection usable if it refused. See 0039's suite for why. */
  async function apply0054(sql: postgres.Sql): Promise<void> {
    try {
      await sql.unsafe(await readFile(resolve("migrations", `${migrationUnderTest}.sql`), "utf8"));
    } catch (error) {
      await sql.unsafe("rollback").catch(() => {});
      throw error;
    }
  }

  /** The minimum object graph an appointment needs, in one business. */
  async function tenant(sql: postgres.Sql, label: string) {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const [user] = await sql<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash) values (${email},${email},'test') returning id
    `;
    const [business] = await sql<{ id: string }[]>`
      insert into businesses(name) values (${label}) returning id
    `;
    const [location] = await sql<{ id: string }[]>`
      insert into locations(business_id,name) values (${business!.id},'Salon') returning id
    `;
    const [employee] = await sql<{ id: string }[]>`
      insert into employees(business_id,display_name) values (${business!.id},'Groomer') returning id
    `;
    const [customer] = await sql<{ id: string }[]>`
      insert into customers(business_id,first_name,last_name) values (${business!.id},'Pat','Owner') returning id
    `;
    const [pet] = await sql<{ id: string }[]>`
      insert into pets(business_id,customer_id,name) values (${business!.id},${customer!.id},'Mochi') returning id
    `;
    const services: string[] = [];
    for (const name of ["Bath", "Clip", "Dry", "Ears", "Feet", "Nails"]) {
      const [service] = await sql<{ id: string }[]>`
        insert into services(business_id,name,base_duration_minutes,base_price_minor)
        values (${business!.id},${name},30,5000) returning id
      `;
      services.push(service!.id);
    }
    return {
      businessId: business!.id, userId: user!.id, locationId: location!.id,
      employeeId: employee!.id, customerId: customer!.id, petId: pet!.id, services
    };
  }

  type Tenant = Awaited<ReturnType<typeof tenant>>;

  /** One appointment, at its own hour so the 0001 exclusion constraint never fires. */
  async function appointment(sql: postgres.Sql, owner: Tenant, hour: number) {
    const start = `2034-03-01T${String(hour).padStart(2, "0")}:00:00Z`;
    const end = `2034-03-01T${String(hour + 1).padStart(2, "0")}:00:00Z`;
    const [row] = await sql<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      values (${owner.businessId},${owner.locationId},${owner.customerId},${owner.petId},${owner.employeeId},
        ${start}::timestamptz,${end}::timestamptz,'America/Los_Angeles',
        ${start}::timestamptz at time zone 'America/Los_Angeles',-420,'completed',${owner.userId},${owner.userId})
      returning id
    `;
    return row!.id;
  }

  /** Services on an appointment, inserted one at a time the way both write paths do. */
  async function plant(sql: postgres.Sql, owner: Tenant, appointmentId: string, count: number) {
    for (let index = 0; index < count; index++) {
      await sql`
        insert into appointment_services(business_id,appointment_id,service_id,
          service_name_snapshot,duration_minutes_snapshot,price_minor_snapshot)
        values (${owner.businessId},${appointmentId},${owner.services[index]!},
          ${`Service ${index + 1}`},30,${1000 * (index + 1)})
      `;
    }
  }

  /**
   * J. EVERY PRE-EXISTING ROW GETS A DETERMINISTIC POSITION, AND THE CONSTRAINTS HOLD.
   *
   * The fixture deliberately covers the shapes that break a naive backfill: an appointment with
   * one service, several with many, two businesses so the partition has to be tenant-aware, and an
   * appointment with NO services at all, which contributes no rows and must not make the migration
   * or its contiguity check trip over an empty group.
   */
  it("gives every pre-existing row a gap-free position within its own appointment", async () => {
    const sql = await databaseAt0053();
    try {
      const first = await tenant(sql, "legacy-a");
      const second = await tenant(sql, "legacy-b");
      const planted: { id: string; businessId: string; count: number }[] = [];
      let hour = 6;
      for (const [owner, counts] of [[first, [1, 6, 2, 3]], [second, [4, 1, 5]]] as const) {
        for (const count of counts) {
          const id = await appointment(sql, owner as Tenant, hour++);
          await plant(sql, owner as Tenant, id, count);
          planted.push({ id, businessId: (owner as Tenant).businessId, count });
        }
      }
      // An appointment with no services at all, which the contiguity check must not choke on.
      const bare = await appointment(sql, first, hour++);

      // The column does not exist yet, which is what makes the assertions below mean something.
      const [before] = await sql<{ count: number }[]>`
        select count(*)::int as count from information_schema.columns
        where table_name='appointment_services' and column_name='line_position'
      `;
      expect(before!.count, "0053 must not already carry line_position").toBe(0);

      await apply0054(sql);

      for (const row of planted) {
        const positions = await sql<{ position: number }[]>`
          select line_position as position from appointment_services
          where business_id=${row.businessId} and appointment_id=${row.id}
          order by line_position
        `;
        expect(positions.map((entry) => entry.position), `appointment ${row.id}`)
          .toEqual(Array.from({ length: row.count }, (_, index) => index + 1));
      }
      const [empty] = await sql<{ count: number }[]>`
        select count(*)::int as count from appointment_services where appointment_id=${bare}
      `;
      expect(empty!.count, "an appointment with no services stays that way").toBe(0);

      // And nothing anywhere was left without a value.
      const [nulls] = await sql<{ count: number }[]>`
        select count(*)::int as count from appointment_services where line_position is null
      `;
      expect(nulls!.count).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * The other half of J: the constraints the backfill exists to make addable are actually there,
   * and actually refuse. `set not null` is asserted through `information_schema` rather than by
   * attempting a null insert, because a null would also be refused by the check.
   */
  it("leaves the column not null and the tenant-qualified unique key enforcing", async () => {
    const sql = await databaseAt0053();
    try {
      const owner = await tenant(sql, "constrained");
      const appointmentId = await appointment(sql, owner, 6);
      await plant(sql, owner, appointmentId, 3);
      await apply0054(sql);

      const [column] = await sql<{ isNullable: string; dataType: string }[]>`
        select is_nullable, data_type from information_schema.columns
        where table_name='appointment_services' and column_name='line_position'
      `;
      expect(column).toEqual({ isNullable: "NO", dataType: "integer" });

      // The unique key is on the three columns, in that order, and leads with the tenant.
      const [key] = await sql<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid='appointment_services'::regclass
          and conname='appointment_service_position_unique'
      `;
      expect(key!.definition).toBe("UNIQUE (business_id, appointment_id, line_position)");

      await expect(sql`
        insert into appointment_services(business_id,appointment_id,service_id,
          service_name_snapshot,duration_minutes_snapshot,price_minor_snapshot,line_position)
        values (${owner.businessId},${appointmentId},${owner.services[0]!},'Collides',30,100,2)
      `).rejects.toThrow(/appointment_service_position_unique/u);

      // The SAME positions on a DIFFERENT appointment are fine - the key must not couple two
      // appointments, and this is the assertion that would fail had it been written over
      // (business_id, line_position) instead.
      const other = await appointment(sql, owner, 7);
      for (const position of [1, 2, 3]) {
        await sql`
          insert into appointment_services(business_id,appointment_id,service_id,
            service_name_snapshot,duration_minutes_snapshot,price_minor_snapshot,line_position)
          values (${owner.businessId},${other},${owner.services[position - 1]!},
            ${`Second sheet ${position}`},30,100,${position})
        `;
      }
      const reused = await sql<{ position: number }[]>`
        select line_position as position from appointment_services
        where appointment_id=${other} order by line_position
      `;
      expect(reused.map((row) => row.position)).toEqual([1, 2, 3]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * The backfilled order is STABLE, which is the entire promise the migration makes about legacy
   * rows. Reading the same appointment repeatedly under the canonical ordering has to return one
   * answer; twelve rows means a random ordering would have to win a lottery to look stable.
   */
  it("returns one stable legacy order on repeated reads", async () => {
    const sql = await databaseAt0053();
    try {
      const owner = await tenant(sql, "stable");
      const appointmentId = await appointment(sql, owner, 6);
      await plant(sql, owner, appointmentId, 6);
      await apply0054(sql);
      const read = () => sql<{ name: string }[]>`
        select service_name_snapshot as name from appointment_services
        where business_id=${owner.businessId} and appointment_id=${appointmentId}
        order by line_position, id
      `;
      const first = (await read()).map((row) => row.name);
      expect(first).toHaveLength(6);
      for (let pass = 0; pass < 12; pass++) {
        expect((await read()).map((row) => row.name), `pass ${pass}`).toEqual(first);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * K. THE WHOLE CHAIN STILL APPLIES TO AN EMPTY DATABASE.
   *
   * 0054's backfill and its contiguity check both run over a table with no rows in it on a fresh
   * install, and an aggregate written carelessly - a `having` over an empty group, a division, a
   * `strict` function - is exactly the kind of thing that passes against seeded data and fails on
   * the first deploy to a new environment.
   */
  it("applies the whole chain, 0054 included, to an empty database", async () => {
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
        // 0050 records its own version from inside the file, so this is `on conflict do nothing`
        // and the recorded SET is asserted below rather than the number of inserts.
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

      const [column] = await sql<{ isNullable: string }[]>`
        select is_nullable from information_schema.columns
        where table_name='appointment_services' and column_name='line_position'
      `;
      expect(column!.isNullable).toBe("NO");
      const [rows] = await sql<{ count: number }[]>`
        select count(*)::int as count from appointment_services
      `;
      expect(rows!.count, "a fresh install has no appointment services").toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});
