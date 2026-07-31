import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "test-session-secret-at-least-thirty-two-characters",
  APP_ORIGIN: "http://localhost:3000",
  SMTP_PORT: 587,
  SMTP_SECURE: false
};

const oldView = "pets.safety.view";
const oldEdit = "pets.safety.edit";
const canonicalize = (values: string[]) => [...new Set(values.map((value) => {
  if (value === oldView) return "pets.care.view";
  if (value === oldEdit) return "pets.care.edit";
  return value;
}))];

describeDatabase("D3.1 Pet Care permission terminology migration", () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(config);
  });

  afterAll(async () => {
    await db.end();
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
