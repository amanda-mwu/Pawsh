import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0004 renamed `pets.safety.*` to `pets.care.*` in the denormalised permission columns, and this
 * asserts it did so without changing anybody's effective access, twice over (it is replayed to
 * prove idempotency).
 *
 * IT RUNS AGAINST ITS OWN THROWAWAY DATABASE, built to 0041 and no further. Those columns were
 * dropped by 0042, so the shared test database no longer has anything for 0004 to migrate - and a
 * historical migration test has to run against the schema of its own era, not today's. Same
 * reasoning as `square-migration-0039.test.ts` and `roles-backfill.test.ts`.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const scratchDatabase = "pawsh_pet_care_0004_vitest";
/** The last migration at which `business_memberships.permissions` still exists. */
const lastMigrationWithPermissionColumns = "0041_roles";

const oldView = "pets.safety.view";
const oldEdit = "pets.safety.edit";
const canonicalize = (values: string[]) => [...new Set(values.map((value) => {
  if (value === oldView) return "pets.care.view";
  if (value === oldEdit) return "pets.care.edit";
  return value;
}))];

describeDatabase("D3.1 Pet Care permission terminology migration", () => {
  let admin: postgres.Sql;
  let db: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const url = new URL(databaseUrl!);
    url.pathname = `/${scratchDatabase}`;
    await admin.unsafe(`drop database if exists ${scratchDatabase} with (force)`);
    await admin.unsafe(`create database ${scratchDatabase}`);
    db = postgres(url.toString(), { max: 1, onnotice: () => {}, transform: postgres.camel });
    await db`create table if not exists schema_migrations (
      version text primary key, applied_at timestamptz not null default now())`;
    for (const file of (await readdir("migrations")).filter((n) => n.endsWith(".sql")).sort()) {
      const version = file.replace(/\.sql$/, "");
      if (version > lastMigrationWithPermissionColumns) break;
      await db.unsafe(await readFile(resolve("migrations", file), "utf8"));
      await db`insert into schema_migrations (version) values (${version}) on conflict do nothing`;
    }
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await admin.unsafe(`drop database if exists ${scratchDatabase} with (force)`).catch(() => {});
    await admin.end();
  });

  it("preserves each membership's effective permission set, status, timestamps, and ordering", async () => {
    const suffix = crypto.randomUUID();
    const [business] = await db<{ id: string }[]>`
      insert into businesses(name) values (${`D3.1 ${suffix}`}) returning id
    `;
    const cases: Array<{ permissions: string[]; status: "active" | "invited" | "disabled" }> = [
      { permissions: [oldView], status: "active" },
      { permissions: [oldEdit], status: "active" },
      { permissions: [oldView, oldEdit], status: "active" },
      { permissions: [oldView, "pets.care.view"], status: "active" },
      { permissions: [oldEdit, "pets.care.edit"], status: "active" },
      { permissions: [oldView, oldEdit, "pets.care.view", "pets.care.edit"], status: "active" },
      { permissions: [], status: "invited" },
      { permissions: ["calendar.view"], status: "disabled" },
      { permissions: ["customers.view", oldEdit, "calendar.view", oldView], status: "disabled" }
    ];
    const before = [];
    for (const [index, entry] of cases.entries()) {
      const email = `d31-${index}-${suffix}@example.test`;
      const [user] = await db<{ id: string }[]>`
        insert into users(email,normalized_email,password_hash)
        values (${email},${email},'not-used') returning id
      `;
      const [membership] = await db<{
        id: string; permissions: string[]; status: string; updatedAt: Date;
      }[]>`
        insert into business_memberships(business_id,user_id,permissions,status)
        values (${business!.id},${user!.id},${entry.permissions},${entry.status})
        returning id,permissions,status,updated_at
      `;
      before.push(membership!);
    }

    const [inviter] = await db<{ id: string }[]>`
      select user_id as id from business_memberships where business_id=${business!.id} limit 1
    `;
    const invitationCases = [
      [oldView, "pets.care.view", "calendar.view"],
      [oldEdit, oldView, "customers.view"]
    ];
    const invitations: Array<{ id: string; permissions: string[] }> = [];
    for (const [index, permissionSet] of invitationCases.entries()) {
      const email = `invite-${index}-${suffix}@example.test`;
      const [invitation] = await db<{ id: string; permissions: string[] }[]>`
        insert into membership_invitations(
          business_id,email,normalized_email,token_hash,permissions,invited_by,expires_at
        ) values (
          ${business!.id},${email},${email},${crypto.randomUUID()},${permissionSet},
          ${inviter!.id},now()+interval '1 day'
        ) returning id,permissions
      `;
      invitations.push(invitation!);
    }

    const migration = await readFile("migrations/0004_pet_care_permissions.sql", "utf8");
    await db.unsafe(migration);
    await db.unsafe(migration);

    const after = await db<{
      id: string; permissions: string[]; status: string; updatedAt: Date;
    }[]>`
      select id,permissions,status,updated_at from business_memberships
      where business_id=${business!.id} order by created_at,id
    `;
    expect(after).toHaveLength(cases.length);
    for (const original of before) {
      const migrated = after.find((entry) => entry.id === original.id)!;
      expect(migrated.permissions).toEqual(canonicalize(original.permissions));
      expect(migrated.status).toBe(original.status);
      expect(migrated.updatedAt).toEqual(original.updatedAt);
      expect(new Set(migrated.permissions).size).toBe(migrated.permissions.length);
    }

    const migratedInvitations = await db<{ id: string; permissions: string[] }[]>`
      select id,permissions from membership_invitations where business_id=${business!.id}
      order by created_at,id
    `;
    for (const original of invitations) {
      expect(migratedInvitations.find((entry) => entry.id === original.id)!.permissions)
        .toEqual(canonicalize(original.permissions));
    }
    const [remaining] = await db<{ count: number }[]>`
      select (
        (select count(*) from business_memberships where permissions && array[${oldView},${oldEdit}])
        +
        (select count(*) from membership_invitations where permissions && array[${oldView},${oldEdit}])
      )::int as count
    `;
    expect(remaining!.count).toBe(0);
  });
});
