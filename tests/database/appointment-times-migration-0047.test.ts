import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0047 promotes check-in and check-out from a client-side derivation to stored columns, and the
 * ONE property that makes that safe to ship is that nothing a screen can currently see goes
 * blank.
 *
 * Every appointment that shows a duration today shows it because `appointmentLifecycleTimes()`
 * found two audit events and subtracted their `created_at`. Shipping the columns empty would
 * erase the check-in time, the check-out time and the actual duration on every historical visit
 * in the product, with nothing to distinguish that from the data never having been recorded. So
 * the backfill is not a convenience and this file is its release gate.
 *
 * It runs against its own throwaway database rather than the shared test one, following
 * `square-migration-0039.test.ts` and `roles-backfill.test.ts`: the property under test is what
 * the migration DOES to pre-existing rows, which a suite sharing an already-migrated database
 * cannot observe. The schema is built to exactly 0046, appointments and audit events are planted
 * in the shapes real data actually takes, and only then is 0047 applied.
 *
 * THE ONE DELIBERATE DIVERGENCE FROM THE CLIENT IS ASSERTED AS A DIVERGENCE. The derivation
 * treats `appointment.cancelled` and `appointment.no_show` as check-outs. A cancelled visit did
 * not check out - in most of those cases it never began - so the backfill leaves its check-out
 * null and the detail view keeps saying "not recorded". That is a decision, not an oversight,
 * and the test below states it in those terms so that reversing it is a conversation.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const scratchDatabase = "pawsh_migration_0047_vitest";
const lastMigrationBefore = "0046_discounts_and_coupons";
const migrationUnderTest = "0047_appointment_lifecycle_times";

/**
 * The client derivation, ported verbatim from `appointmentLifecycleTimes()` in `public/app.js`.
 *
 * Kept here rather than imported because it lives in a browser bundle with no export, and
 * restating it is what lets the assertions below compare the stored columns against WHAT THE
 * SCREEN SHOWS TODAY rather than against a second opinion written to match the migration.
 */
function derived(events: { action: string; createdAt: Date }[]) {
  const at = (action: string) => events.find((event) => event.action === action)?.createdAt ?? null;
  const checkedIn = at("appointment.checked_in");
  const finished = at("appointment.completed") ?? at("appointment.cancelled") ?? at("appointment.no_show");
  const minutes = checkedIn && finished
    ? Math.max(0, Math.round((finished.getTime() - checkedIn.getTime()) / 60000))
    : null;
  return { checkedIn, finished, minutes };
}

describeDatabase("migration 0047 appointment lifecycle times", () => {
  let admin: postgres.Sql;
  let scratchUrl: string;

  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const url = new URL(databaseUrl!);
    url.pathname = `/${scratchDatabase}`;
    scratchUrl = url.toString();
  }, 30_000);

  afterAll(async () => {
    await admin.unsafe(`drop database if exists ${scratchDatabase} with (force)`).catch(() => {});
    await admin.end();
  });

  /** A database at exactly 0046, with nothing of 0047 applied. */
  async function databaseAt0046(): Promise<postgres.Sql> {
    await admin.unsafe(`drop database if exists ${scratchDatabase} with (force)`);
    await admin.unsafe(`create database ${scratchDatabase}`);
    // Same `transform: postgres.camel` the application connects with, so what this suite reads
    // out of the backfilled table is shaped exactly like what a route would read.
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => {}, transform: postgres.camel });
    await sql`create table if not exists schema_migrations (
      version text primary key, applied_at timestamptz not null default now())`;
    for (const file of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      const version = file.replace(/\.sql$/, "");
      if (version > lastMigrationBefore) break;
      await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
      await sql`insert into schema_migrations (version) values (${version}) on conflict do nothing`;
    }
    return sql;
  }

  /** Applies 0047, leaving the connection usable if it refused. See 0039's suite for why. */
  async function apply0047(sql: postgres.Sql): Promise<void> {
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
    return {
      businessId: business!.id, userId: user!.id, locationId: location!.id,
      employeeId: employee!.id, customerId: customer!.id, petId: pet!.id
    };
  }

  type Tenant = Awaited<ReturnType<typeof tenant>>;

  /** One appointment, at its own hour so the 0001 exclusion constraint never fires. */
  async function appointment(sql: postgres.Sql, owner: Tenant, hour: number, status: string) {
    const start = `2034-03-01T${String(hour).padStart(2, "0")}:00:00Z`;
    const end = `2034-03-01T${String(hour + 1).padStart(2, "0")}:00:00Z`;
    const [row] = await sql<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      values (${owner.businessId},${owner.locationId},${owner.customerId},${owner.petId},${owner.employeeId},
        ${start}::timestamptz,${end}::timestamptz,'America/Los_Angeles',
        ${start}::timestamptz at time zone 'America/Los_Angeles',-420,${status},${owner.userId},${owner.userId})
      returning id
    `;
    return row!.id;
  }

  /** An audit event exactly as `record()` writes one. */
  async function audit(
    sql: postgres.Sql, owner: Tenant, appointmentId: string, action: string, createdAt: string
  ) {
    await sql`
      insert into audit_events(business_id,actor_id,action,resource_type,resource_id,correlation_id,created_at)
      values (${owner.businessId},${owner.userId},${action},'appointment',${appointmentId},
        ${crypto.randomUUID()},${createdAt}::timestamptz)
    `;
  }

  const times = async (sql: postgres.Sql, id: string) => {
    const [row] = await sql<{ checkedInAt: Date | null; checkedOutAt: Date | null }[]>`
      select checked_in_at,checked_out_at from appointments where id=${id}
    `;
    return row!;
  };

  it("backfills every duration the client can currently derive, and refuses none", async () => {
    const sql = await databaseAt0046();
    try {
      const alpha = await tenant(sql, "Alpha");
      const beta = await tenant(sql, "Beta");

      // A completed visit: the case that carries a duration on screen today.
      const completed = await appointment(sql, alpha, 9, "completed");
      await audit(sql, alpha, completed, "appointment.checked_in", "2034-03-01T09:04:00Z");
      await audit(sql, alpha, completed, "appointment.in_service", "2034-03-01T09:11:00Z");
      await audit(sql, alpha, completed, "appointment.completed", "2034-03-01T10:22:00Z");

      // A visit still on the table: an arrival with no departure.
      const inService = await appointment(sql, alpha, 11, "in_service");
      await audit(sql, alpha, inService, "appointment.checked_in", "2034-03-01T11:02:00Z");
      await audit(sql, alpha, inService, "appointment.in_service", "2034-03-01T11:09:00Z");

      // Checked in, then called off. The client calls the cancellation a check-out; 0047 does not.
      const cancelled = await appointment(sql, alpha, 13, "cancelled");
      await audit(sql, alpha, cancelled, "appointment.checked_in", "2034-03-01T13:03:00Z");
      await audit(sql, alpha, cancelled, "appointment.cancelled", "2034-03-01T13:40:00Z");

      // Never arrived at all.
      const noShow = await appointment(sql, alpha, 15, "no_show");
      await audit(sql, alpha, noShow, "appointment.no_show", "2034-03-01T15:30:00Z");

      // Predates the audit path entirely: nothing to derive from, then or now.
      const silent = await appointment(sql, alpha, 17, "completed");

      // Two check-ins for one visit. Unreachable through `canTransition`, planted anyway, because
      // `distinct on` has to pick one and the earliest is the honest answer to "when did this
      // arrive".
      const duplicated = await appointment(sql, alpha, 19, "completed");
      await audit(sql, alpha, duplicated, "appointment.checked_in", "2034-03-01T19:05:00Z");
      await audit(sql, alpha, duplicated, "appointment.checked_in", "2034-03-01T19:31:00Z");
      await audit(sql, alpha, duplicated, "appointment.completed", "2034-03-01T20:10:00Z");

      // A visit whose only event is neither of the two the backfill reads.
      const startedOnly = await appointment(sql, alpha, 21, "in_service");
      await audit(sql, alpha, startedOnly, "appointment.in_service", "2034-03-01T21:06:00Z");

      // ONE BUSINESS'S EVENT MUST NOT REACH ANOTHER BUSINESS'S APPOINTMENT. `resource_id` is an
      // untyped uuid with no foreign key, so the `business_id` equality in the join is the only
      // thing standing between these two rows.
      const crossTenant = await appointment(sql, beta, 9, "completed");
      await audit(sql, alpha, crossTenant, "appointment.checked_in", "2034-03-01T09:00:00Z");
      await audit(sql, alpha, crossTenant, "appointment.completed", "2034-03-01T10:00:00Z");

      await apply0047(sql);

      const applied = await sql<{ version: string }[]>`
        select version from schema_migrations order by version desc limit 1
      `;
      expect(applied[0]!.version).toBe(migrationUnderTest);

      // THE HEADLINE PROPERTY, stated against the client's own arithmetic: the visit that shows
      // "78 min" today shows the same 78 minutes from the stored columns afterwards.
      const events = await sql<{ action: string; createdAt: Date }[]>`
        select action,created_at from audit_events
        where business_id=${alpha.businessId} and resource_id=${completed} order by created_at
      `;
      const expected = derived(events);
      const storedCompleted = await times(sql, completed);
      expect(storedCompleted.checkedInAt!.getTime()).toBe(expected.checkedIn!.getTime());
      expect(storedCompleted.checkedOutAt!.getTime()).toBe(expected.finished!.getTime());
      expect(Math.round(
        (storedCompleted.checkedOutAt!.getTime() - storedCompleted.checkedInAt!.getTime()) / 60000
      )).toBe(expected.minutes);
      expect(expected.minutes).toBe(78);

      const storedInService = await times(sql, inService);
      expect(storedInService.checkedInAt!.toISOString()).toBe("2034-03-01T11:02:00.000Z");
      expect(storedInService.checkedOutAt).toBeNull();

      // THE DELIBERATE DIVERGENCE. The client derives 37 minutes for this visit from the
      // cancellation; the column says the visit never checked out, because it did not.
      const storedCancelled = await times(sql, cancelled);
      const cancelledEvents = await sql<{ action: string; createdAt: Date }[]>`
        select action,created_at from audit_events
        where business_id=${alpha.businessId} and resource_id=${cancelled} order by created_at
      `;
      expect(derived(cancelledEvents).minutes).toBe(37);
      expect(storedCancelled.checkedInAt!.toISOString()).toBe("2034-03-01T13:03:00.000Z");
      expect(storedCancelled.checkedOutAt).toBeNull();

      expect(await times(sql, noShow)).toEqual({ checkedInAt: null, checkedOutAt: null });
      expect(await times(sql, silent)).toEqual({ checkedInAt: null, checkedOutAt: null });
      expect(await times(sql, startedOnly)).toEqual({ checkedInAt: null, checkedOutAt: null });

      const storedDuplicated = await times(sql, duplicated);
      expect(storedDuplicated.checkedInAt!.toISOString()).toBe("2034-03-01T19:05:00.000Z");
      expect(storedDuplicated.checkedOutAt!.toISOString()).toBe("2034-03-01T20:10:00.000Z");

      expect(await times(sql, crossTenant)).toEqual({ checkedInAt: null, checkedOutAt: null });
    } finally {
      await sql.end();
    }
  }, 120_000);

  it("adds the ordering constraint and the two nullable columns", async () => {
    const sql = await databaseAt0046();
    try {
      const alpha = await tenant(sql, "Constraint");
      const id = await appointment(sql, alpha, 9, "completed");
      await apply0047(sql);

      const columns = await sql<{ columnName: string; isNullable: string; columnDefault: string | null }[]>`
        select column_name,is_nullable,column_default from information_schema.columns
        where table_name='appointments' and column_name in ('checked_in_at','checked_out_at')
        order by column_name
      `;
      // Nullable, no default. "Not checked in" is null, not an invented instant.
      expect(columns.map((column) => [column.columnName, column.isNullable, column.columnDefault])).toEqual([
        ["checked_in_at", "YES", null], ["checked_out_at", "YES", null]
      ]);

      await expect(sql`
        update appointments set checked_in_at='2034-03-01T10:00:00Z',checked_out_at='2034-03-01T09:00:00Z'
        where id=${id}
      `).rejects.toThrow(/appointment_times_ordered/);

      // Equal is admitted, and either side alone is unconstrained.
      await sql`update appointments set checked_in_at='2034-03-01T09:00:00Z',checked_out_at='2034-03-01T09:00:00Z' where id=${id}`;
      await sql`update appointments set checked_in_at='2034-03-01T09:00:00Z',checked_out_at=null where id=${id}`;
      await sql`update appointments set checked_in_at=null,checked_out_at='2034-03-01T09:00:00Z' where id=${id}`;

      // `end_at` IS NOT DERIVED FROM THESE. A check-out recorded after the booked end must leave
      // the schedule alone, or `employee_appointment_no_overlap` starts rejecting writes to
      // appointments nobody touched.
      const [schedule] = await sql<{ startAt: Date; endAt: Date }[]>`
        select start_at,end_at from appointments where id=${id}
      `;
      expect(schedule!.startAt.toISOString()).toBe("2034-03-01T09:00:00.000Z");
      expect(schedule!.endAt.toISOString()).toBe("2034-03-01T10:00:00.000Z");
    } finally {
      await sql.end();
    }
  }, 120_000);

  it("refuses rather than mangling a backfill that would invert a pair", async () => {
    const sql = await databaseAt0046();
    try {
      const alpha = await tenant(sql, "Inverted");
      const id = await appointment(sql, alpha, 9, "completed");
      // Unreachable through the routes - `completed` is only reachable from `in_service`, which is
      // only reachable from `checked_in`, and each transaction's `now()` is taken after the
      // previous one committed. Planted directly to prove the migration would notice, and would
      // say so in words rather than as a bare check violation on a table with two new columns.
      await audit(sql, alpha, id, "appointment.checked_in", "2034-03-01T10:00:00Z");
      await audit(sql, alpha, id, "appointment.completed", "2034-03-01T09:00:00Z");

      await expect(apply0047(sql)).rejects.toThrow(/check-out before its check-in on 1 appointment/);

      // And having refused, it changed nothing.
      const columns = await sql<{ columnName: string }[]>`
        select column_name from information_schema.columns
        where table_name='appointments' and column_name like 'checked%'
      `;
      expect(columns).toEqual([]);
      const applied = await sql<{ version: string }[]>`
        select version from schema_migrations order by version desc limit 1
      `;
      expect(applied[0]!.version).toBe(lastMigrationBefore);
    } finally {
      await sql.end();
    }
  }, 120_000);
});
