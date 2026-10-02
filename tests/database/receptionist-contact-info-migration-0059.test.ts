import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0059 is a data migration over `roles` and nothing else: `customers.contact_info` started
 * withholding client contact details, the Receptionist preset holds it, and this file gives it to
 * every built-in Receptionist that already exists. Like 0057's and 0058's suites, this one builds
 * its own database at exactly 0058, plants roles in the shapes real data takes, and only then
 * applies 0059 - a suite against an already-migrated database cannot see what the file does to
 * rows that existed before it.
 *
 * THE GROOMER IS THE ROLE THAT MUST NOT MOVE, and so is any custom role, whatever it is called:
 * a salon's own "Receptionist" or "Front desk" means what the owner made it mean.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const scratchDatabase = "pawsh_migration_0059_vitest";
const lastMigrationBefore = "0058_groomer_overlap_authority";
const migrationUnderTest = "0059_receptionist_contact_info";
const KEY = "customers.contact_info";

/** The Receptionist as 0058 left it. */
const RECEPTIONIST_AT_0058 = ["calendar.view", "appointments.view", "appointments.create",
  "appointments.edit", "appointments.edit_all_staff", "appointments.cancel",
  "calendar.blocks_create", "calendar.blocks_edit", "appointments.override_conflict",
  "appointments.service_price_edit", "customers.view", "customers.edit", "pets.view", "pets.edit",
  "pets.care.view", "operations.check_in", "checkout.perform", "payments.view"];
/** The Groomer as 0058 left it. */
const GROOMER_AT_0058 = ["calendar.view", "appointments.view", "pets.view", "pets.care.view",
  "operations.check_in", "operations.perform_service", "operations.complete",
  "appointments.edit", "calendar.blocks_create", "calendar.blocks_edit",
  "appointments.override_conflict", "appointments.service_price_edit"];

describeDatabase("migration 0059 receptionist contact info", () => {
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

  async function databaseAt0058(): Promise<postgres.Sql> {
    await admin.unsafe(`drop database if exists ${scratchDatabase} with (force)`);
    await admin.unsafe(`create database ${scratchDatabase}`);
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => {}, transform: postgres.camel });
    await sql`create table if not exists schema_migrations (
      version text primary key, applied_at timestamptz not null default now())`;
    const files = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (version > lastMigrationBefore) break;
      await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
      await sql`insert into schema_migrations (version) values (${version}) on conflict do nothing`;
    }
    return sql;
  }

  const apply0059 = async (sql: postgres.Sql) => {
    try {
      await sql.unsafe(await readFile(resolve("migrations", `${migrationUnderTest}.sql`), "utf8"));
    } catch (error) {
      await sql.unsafe("rollback").catch(() => {});
      throw error;
    }
  };

  async function role(sql: postgres.Sql, label: string, name: string, permissions: string[], builtIn = false) {
    const [business] = await sql<{ id: string }[]>`insert into businesses(name) values (${label}) returning id`;
    const [row] = await sql<{ id: string }[]>`
      insert into roles(business_id,name,permissions,built_in)
      values (${business!.id},${name},${permissions}::text[],${builtIn}) returning id
    `;
    return row!.id;
  }
  const state = async (sql: postgres.Sql, id: string) =>
    (await sql<{ permissions: string[]; version: number }[]>`select permissions,version from roles where id=${id}`)[0]!;

  it("grants the key to every built-in Receptionist and to no other role, once", async () => {
    const sql = await databaseAt0058();
    try {
      const desks = [
        await role(sql, "desk-a", "Receptionist", RECEPTIONIST_AT_0058, true),
        await role(sql, "desk-b", "Receptionist", RECEPTIONIST_AT_0058, true)
      ];
      const untouched = [
        await role(sql, "groomer", "Groomer", GROOMER_AT_0058, true),
        await role(sql, "custom-receptionist", "Receptionist", RECEPTIONIST_AT_0058),
        await role(sql, "front-desk", "Front desk", RECEPTIONIST_AT_0058),
        await role(sql, "manager", "Manager", [...RECEPTIONIST_AT_0058, KEY, "settings.manage"], true)
      ];
      const before = new Map(await Promise.all([...desks, ...untouched].map(async (id) => [id, await state(sql, id)] as const)));

      await apply0059(sql);

      for (const id of desks) {
        const after = await state(sql, id);
        expect(after.permissions).toContain(KEY);
        expect(after.permissions.length).toBe(before.get(id)!.permissions.length + 1);
        expect(after.permissions).toEqual(expect.arrayContaining(before.get(id)!.permissions));
        expect(after.version).toBe(before.get(id)!.version + 1);
      }
      for (const id of untouched) expect(await state(sql, id)).toEqual(before.get(id));

      // Idempotent: a second pass grants nothing and moves no version.
      const afterFirst = new Map(await Promise.all(desks.map(async (id) => [id, await state(sql, id)] as const)));
      await apply0059(sql);
      for (const id of desks) expect(await state(sql, id)).toEqual(afterFirst.get(id));

      const [stranded] = await sql<{ count: number }[]>`
        select count(*)::int as count from roles
        where built_in and lower(name)='receptionist' and not (${KEY} = any(permissions))
      `;
      expect(stranded!.count).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});
