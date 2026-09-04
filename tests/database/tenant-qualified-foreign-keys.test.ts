import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../src/db/client.js";
import type { Config } from "../../src/config.js";

/**
 * Migration 0052: every reference between two tenant tables is tenant-qualified, or is recorded
 * here as one that cannot be.
 *
 * These assertions are deliberately made in raw SQL against the schema rather than through the
 * API, because the API is exactly what was already relied on. Every one of these four references
 * had a careful handler in front of it and no constraint behind it, and `enable row level
 * security` enforces nothing here - Pawsh connects as the owner of these tables and no table sets
 * FORCE ROW LEVEL SECURITY, so PostgreSQL exempts the connection from its own policies. A test
 * that goes through a route would prove the route is careful, which was never in doubt.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "tenant-foreign-key-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

describeDatabase("tenant-qualified foreign keys", () => {
  let db: Database;
  const suffix = crypto.randomUUID().slice(0, 8);

  beforeAll(async () => { db = createDatabase(config); });
  afterAll(async () => { await db.end(); });

  const constraintDefinition = async (name: string) => {
    const [row] = await db<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint where conname=${name}
    `;
    return row?.definition ?? null;
  };

  it("carries the four composite references 0052 rewrote", async () => {
    expect(await constraintDefinition("invoice_item_source_service_tenant")).toBe(
      "FOREIGN KEY (business_id, source_appointment_service_id) REFERENCES appointment_services(business_id, id)"
    );
    expect(await constraintDefinition("employee_membership_tenant")).toBe(
      "FOREIGN KEY (business_id, membership_id) REFERENCES business_memberships(business_id, id)"
    );
    expect(await constraintDefinition("notification_delivery_attempt_tenant")).toBe(
      "FOREIGN KEY (business_id, notification_intent_id) REFERENCES notification_intents(business_id, id)"
    );
    // The column list on SET NULL is load-bearing: without it the cleanup that expires a request
    // would try to null `pet_documents.business_id`, which is `not null`.
    expect(await constraintDefinition("pet_document_request_tenant")).toBe(
      "FOREIGN KEY (business_id, request_id) REFERENCES pet_document_requests(business_id, id) ON DELETE SET NULL (request_id)"
    );
  });

  it("has dropped the single-column references they replaced", async () => {
    for (const retired of [
      "invoice_items_source_appointment_service_id_fkey",
      "employees_membership_id_fkey",
      "notification_delivery_attempts_notification_intent_id_fkey",
      "pet_documents_request_id_fkey",
      // 0009 left this one behind its own composite twin, `pet_document_request_actor`.
      "pet_document_requests_membership_id_fkey"
    ]) {
      expect(await constraintDefinition(retired), retired).toBeNull();
    }
    // The composite twin the redundant one stood beside is still there.
    expect(await constraintDefinition("pet_document_request_actor")).toBe(
      "FOREIGN KEY (business_id, membership_id) REFERENCES business_memberships(business_id, id)"
    );
  });

  it("leaves exactly one non-tenant-qualified reference, and it is the one that cannot be fixed", async () => {
    const rows = await db<{ constraint: string; source: string; target: string }[]>`
      with tenant as (
        select c.relname as tbl from pg_class c
        join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
        join pg_attribute a on a.attrelid=c.oid and a.attname='business_id'
          and a.attnum>0 and not a.attisdropped
        where c.relkind='r' and a.attnotnull
      )
      select con.conname as "constraint", src.relname as source, tgt.relname as target
      from pg_constraint con
      join pg_class src on src.oid=con.conrelid
      join pg_class tgt on tgt.oid=con.confrelid
      join pg_namespace n on n.oid=src.relnamespace and n.nspname='public'
      where con.contype='f'
        and src.relname in (select tbl from tenant)
        and tgt.relname in (select tbl from tenant)
        and array_length(con.conkey,1)=1
      order by src.relname, con.conname
    `;
    // `business_breed_settings.breed_id` is absent because `breeds.business_id` is NULLABLE by
    // design - null marks a row of the shared taxonomy - so `breeds` is not a tenant table by
    // this query's definition and a composite key cannot say "my row or the shared row". 0033's
    // `pet_breed_tenant` trigger is the model for closing it; see the note at the end of 0052.
    expect(rows).toEqual([]);
  });

  it("refuses a cross-tenant employee-to-membership link at the database, not just the API", async () => {
    const [left] = await db<{ id: string }[]>`
      insert into businesses(name) values (${`FK Left ${suffix}`}) returning id
    `;
    const [right] = await db<{ id: string }[]>`
      insert into businesses(name) values (${`FK Right ${suffix}`}) returning id
    `;
    const [account] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash)
      values (${`fk-${suffix}@example.test`},${`fk-${suffix}@example.test`},'x') returning id
    `;
    // A non-owner membership, so the fixture can be torn down: the schema refuses to remove the
    // final owner of a business, which is a different invariant and not the one under test.
    const [role] = await db<{ id: string }[]>`
      insert into roles(business_id,name,permissions)
      values (${right!.id},${`FK Role ${suffix}`},'{}'::text[]) returning id
    `;
    const [membership] = await db<{ id: string }[]>`
      insert into business_memberships(business_id,user_id,is_owner,role_id)
      values (${right!.id},${account!.id},false,${role!.id}) returning id
    `;
    // The membership belongs to the RIGHT business; the employee is being created in the LEFT.
    await expect(db`
      insert into employees(business_id,membership_id,display_name)
      values (${left!.id},${membership!.id},'Borrowed Groomer')
    `).rejects.toThrow(/employee_membership_tenant/);
    // The same row inside its own business is accepted, so this refuses the tenant mismatch and
    // not the link itself.
    const [ok] = await db<{ id: string }[]>`
      insert into employees(business_id,membership_id,display_name)
      values (${right!.id},${membership!.id},'Own Groomer') returning id
    `;
    expect(ok?.id).toBeTruthy();
    await db`delete from employees where id=${ok!.id}`;
    await db`delete from business_memberships where id=${membership!.id}`;
    await db`delete from roles where id=${role!.id}`;
    await db`delete from users where id=${account!.id}`;
    await db`delete from businesses where id in (${left!.id},${right!.id})`;
  });

  it("keeps the composite identities the four references point at", async () => {
    const rows = await db<{ table: string; definition: string }[]>`
      select c.relname as "table", pg_get_constraintdef(con.oid) as definition
      from pg_constraint con join pg_class c on c.oid=con.conrelid
      where con.contype='u'
        and c.relname in ('appointment_services','notification_intents','pet_document_requests')
        and pg_get_constraintdef(con.oid)='UNIQUE (business_id, id)'
      order by c.relname
    `;
    expect(rows.map((row) => row.table)).toEqual([
      "appointment_services", "notification_intents", "pet_document_requests"
    ]);
  });

  it("adds no duplicate identity to business_memberships, which already carries three", async () => {
    const [row] = await db<{ count: number }[]>`
      select count(*)::int count from pg_indexes
      where schemaname='public' and tablename='business_memberships'
        and indexdef like '%(business_id, id)'
    `;
    // 0009, 0010 and 0014 each added one independently. 0052 adds none, and deliberately does not
    // drop the surplus either: that is a separate change with its own locking cost.
    expect(row?.count).toBe(3);
  });

  it("has not enabled FORCE ROW LEVEL SECURITY anywhere", async () => {
    const rows = await db<{ table: string }[]>`
      select c.relname as "table" from pg_class c
      join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
      where c.relkind='r' and c.relforcerowsecurity
    `;
    // The composite foreign keys above are the boundary precisely BECAUSE this is empty. Turning
    // it on is a separate decision about a separate connection role, and 0052 does not take it.
    expect(rows).toEqual([]);
  });
});
