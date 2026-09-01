import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectivePermissions } from "../../src/db/effective-permissions.js";

/**
 * 0041 moves every membership onto a named role, and the ONE property that makes that safe to
 * ship is that nobody's effective access changes. This file is that release gate.
 *
 * It runs against its own throwaway database rather than the shared test one, following the same
 * reasoning as `square-migration-0039.test.ts`: the property under test is what the migration DOES
 * to pre-existing rows, which a suite sharing an already-migrated database cannot observe. So the
 * schema is built to exactly 0040, rows are planted in the shapes real data actually takes, and
 * only then is 0041 applied.
 *
 * The permission sets planted below are deliberately awkward rather than tidy:
 *
 *   * the same set written in a DIFFERENT ORDER, because sets are compared as sets - two
 *     receptionists whose arrays happen to be ordered differently are one role, not two;
 *   * the same set with a DUPLICATE entry, for the same reason;
 *   * the empty set, which is a real state (an invited member nobody has granted anything yet);
 *   * a set matching no preset, which must survive verbatim rather than being rounded to the
 *     nearest preset - rounding would be a silent grant or a silent revocation;
 *   * the identical set in TWO BUSINESSES, which must produce two separate roles, because a role
 *     shared across tenants is the cross-tenant grant this whole design exists to prevent.
 *
 * Resolution is performed through `effectivePermissions` itself rather than a copy of its SQL, so
 * a divergence between what the migration writes and what the application reads fails here.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const scratchDatabase = "pawsh_roles_0041_vitest";
const lastMigrationBefore = "0040_staff_profile_fields";
const migrationUnderTest = "0041_roles";

/** The three shipped presets, as they stood when 0041 was written. */
const groomer = [
  "calendar.view", "appointments.view", "pets.view", "pets.care.view",
  "operations.check_in", "operations.perform_service", "operations.complete"
];
const receptionist = [
  "calendar.view", "appointments.view", "appointments.create", "appointments.edit",
  "appointments.cancel", "customers.view", "customers.edit", "pets.view", "pets.edit",
  "pets.care.view", "operations.check_in", "checkout.perform", "payments.view"
];

const asSet = (values: readonly string[]) => [...new Set(values)].sort();

describeDatabase("migration 0041 roles backfill", () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let scratchUrl: string;
  /** businessId -> membershipId -> the permissions that membership held BEFORE 0041. */
  const planted = new Map<string, Map<string, string[]>>();
  let alpha = "";
  let beta = "";
  let alphaOwner = "";
  let alphaEmpty = "";
  let alphaCustom = "";
  let alphaReceptionist = "";
  let alphaReceptionistReordered = "";
  let betaReceptionist = "";
  let liveInvitation = "";
  let acceptedInvitation = "";
  let revokedInvitation = "";

  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const url = new URL(databaseUrl!);
    url.pathname = `/${scratchDatabase}`;
    scratchUrl = url.toString();

    await admin.unsafe(`drop database if exists ${scratchDatabase} with (force)`);
    await admin.unsafe(`create database ${scratchDatabase}`);
    // `transform: postgres.camel` matches `createDatabase`, so this test reads columns back under
    // the same names the application does rather than a second, snake_case convention.
    sql = postgres(scratchUrl, { max: 1, onnotice: () => {}, transform: postgres.camel });
    await sql`create table if not exists schema_migrations (
      version text primary key, applied_at timestamptz not null default now())`;
    for (const file of (await readdir("migrations")).filter((n) => n.endsWith(".sql")).sort()) {
      const version = file.replace(/\.sql$/, "");
      if (version > lastMigrationBefore) break;
      await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
      await sql`insert into schema_migrations (version) values (${version}) on conflict do nothing`;
    }

    alpha = await createBusiness("Alpha Grooming");
    beta = await createBusiness("Beta Grooming");

    // Owner: full authority, and must come out of the migration with no role at all.
    alphaOwner = await createMembership(alpha, "owner@alpha.test", { isOwner: true, permissions: receptionist });
    alphaReceptionist = await createMembership(alpha, "rec1@alpha.test", { permissions: receptionist });
    // Same SET, different ORDER, plus a duplicate. Must collapse onto the same role as the row above.
    alphaReceptionistReordered = await createMembership(alpha, "rec2@alpha.test", {
      permissions: [...receptionist].reverse().concat("payments.view")
    });
    alphaEmpty = await createMembership(alpha, "nobody@alpha.test", { permissions: [] });
    alphaCustom = await createMembership(alpha, "custom@alpha.test", {
      permissions: ["calendar.view", "discounts.apply", "reports.view"]
    });
    await createMembership(alpha, "groomer@alpha.test", { permissions: groomer });
    // A membership that is NOT active. It still needs a role: approving a workspace access
    // request reactivates exactly this row, and a reactivated member with no role would have
    // lost everything the day the old column is dropped.
    await createMembership(alpha, "disabled@alpha.test", { permissions: groomer, status: "disabled" });
    // The same permission set in a different tenant. Must NOT share Alpha's role.
    betaReceptionist = await createMembership(beta, "rec@beta.test", { permissions: receptionist });

    liveInvitation = await createInvitation(alpha, "invited@alpha.test", groomer, {});
    acceptedInvitation = await createInvitation(alpha, "accepted@alpha.test", groomer, { accepted: true });
    revokedInvitation = await createInvitation(alpha, "revoked@alpha.test", groomer, { revoked: true });

    for (const row of await sql<{ id: string; businessId: string; permissions: string[] }[]>`
      select id, business_id, permissions from business_memberships
    `) {
      const forBusiness = planted.get(row.businessId) ?? new Map<string, string[]>();
      forBusiness.set(row.id, row.permissions);
      planted.set(row.businessId, forBusiness);
    }

    await sql.unsafe(await readFile(resolve("migrations", `${migrationUnderTest}.sql`), "utf8"));
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`drop database if exists ${scratchDatabase} with (force)`).catch(() => {});
    await admin.end();
  });

  async function createBusiness(name: string): Promise<string> {
    const [business] = await sql<{ id: string }[]>`
      insert into businesses (name, email) values (${name}, ${`${name}@example.test`}) returning id
    `;
    return business!.id;
  }

  async function createMembership(
    businessId: string,
    email: string,
    options: { isOwner?: boolean; permissions: string[]; status?: string }
  ): Promise<string> {
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, normalized_email, password_hash, display_name)
      values (${email}, ${email}, 'x', ${email}) returning id
    `;
    const [membership] = await sql<{ id: string }[]>`
      insert into business_memberships (business_id, user_id, is_owner, permissions, status)
      values (${businessId}, ${user!.id}, ${options.isOwner ?? false},
        ${options.permissions}, ${options.status ?? "active"}::membership_status)
      returning id
    `;
    return membership!.id;
  }

  async function createInvitation(
    businessId: string,
    email: string,
    permissions: string[],
    lifecycle: { accepted?: boolean; revoked?: boolean }
  ): Promise<string> {
    const [inviter] = await sql<{ id: string }[]>`select id from users limit 1`;
    const [invitation] = await sql<{ id: string }[]>`
      insert into membership_invitations
        (business_id, email, normalized_email, token_hash, permissions, invited_by, expires_at,
         accepted_at, revoked_at)
      values (${businessId}, ${email}, ${email}, ${`hash-${email}`}, ${permissions}, ${inviter!.id},
        now() + interval '7 days',
        ${lifecycle.accepted ? sql`now()` : null}, ${lifecycle.revoked ? sql`now()` : null})
      returning id
    `;
    return invitation!.id;
  }

  /** Effective permissions, resolved through the shared application fragment. */
  async function effective(membershipId: string): Promise<string[]> {
    const [row] = await sql<{ permissions: string[] }[]>`
      select ${effectivePermissions(sql, "m")} as permissions
      from business_memberships m where m.id = ${membershipId}
    `;
    return row!.permissions;
  }

  it("changes no member's effective permissions - the release gate", async () => {
    let checked = 0;
    for (const [, memberships] of planted) {
      for (const [membershipId, before] of memberships) {
        expect(asSet(await effective(membershipId)), membershipId).toEqual(asSet(before));
        checked += 1;
      }
    }
    // Guards against the assertion loop silently checking nothing.
    expect(checked).toBe(8);
  });

  it("leaves every owner without a role and seeds no Admin role", async () => {
    const [owner] = await sql<{ roleId: string | null }[]>`
      select role_id from business_memberships where id = ${alphaOwner}
    `;
    expect(owner!.roleId).toBeNull();
    const admins = await sql`select id from roles where lower(name) in ('admin', 'owner')`;
    expect(admins).toHaveLength(0);
    // Every non-owner, including the disabled one, did get a role.
    const orphans = await sql`
      select id from business_memberships where not is_owner and role_id is null
    `;
    expect(orphans).toHaveLength(0);
  });

  it("names a preset-matching set after its preset and marks it built in", async () => {
    const [role] = await sql<{ name: string; builtIn: boolean; permissions: string[] }[]>`
      select r.name, r.built_in, r.permissions from roles r
      join business_memberships m on m.business_id = r.business_id and m.role_id = r.id
      where m.id = ${alphaReceptionist}
    `;
    expect(role!.name).toBe("Receptionist");
    expect(role!.builtIn).toBe(true);
    expect(asSet(role!.permissions)).toEqual(asSet(receptionist));
  });

  it("collapses the same set onto one role regardless of order or duplicates", async () => {
    const [pair] = await sql<{ first: string; second: string }[]>`
      select a.role_id as first, b.role_id as second
      from business_memberships a, business_memberships b
      where a.id = ${alphaReceptionist} and b.id = ${alphaReceptionistReordered}
    `;
    expect(pair!.first).toBe(pair!.second);
  });

  it("keeps an identical set in another business on its own role", async () => {
    const [pair] = await sql<{ mine: string; theirs: string }[]>`
      select a.role_id as mine, b.role_id as theirs
      from business_memberships a, business_memberships b
      where a.id = ${alphaReceptionist} and b.id = ${betaReceptionist}
    `;
    expect(pair!.mine).not.toBe(pair!.theirs);
    // And each role belongs to the business whose member points at it.
    const [check] = await sql<{ n: number }[]>`
      select count(*)::int as n from business_memberships m
      join roles r on r.id = m.role_id
      where m.role_id is not null and r.business_id <> m.business_id
    `;
    expect(check!.n).toBe(0);
  });

  it("gives an unmatched set its own custom role carrying that set verbatim", async () => {
    const [role] = await sql<{ name: string; builtIn: boolean; permissions: string[] }[]>`
      select r.name, r.built_in, r.permissions from roles r
      join business_memberships m on m.business_id = r.business_id and m.role_id = r.id
      where m.id = ${alphaCustom}
    `;
    expect(role!.name).toMatch(/^Custom access \d+$/);
    expect(role!.builtIn).toBe(false);
    expect(asSet(role!.permissions)).toEqual(asSet(["calendar.view", "discounts.apply", "reports.view"]));
  });

  it("names the empty set No access rather than granting anything", async () => {
    const [role] = await sql<{ name: string; permissions: string[] }[]>`
      select r.name, r.permissions from roles r
      join business_memberships m on m.business_id = r.business_id and m.role_id = r.id
      where m.id = ${alphaEmpty}
    `;
    expect(role!.name).toBe("No access");
    expect(role!.permissions).toEqual([]);
    expect(await effective(alphaEmpty)).toEqual([]);
  });

  it("puts a live invitation on the same role its permissions already describe", async () => {
    const [invitation] = await sql<{ roleId: string | null; name: string | null }[]>`
      select v.role_id, r.name from membership_invitations v
      left join roles r on r.business_id = v.business_id and r.id = v.role_id
      where v.id = ${liveInvitation}
    `;
    expect(invitation!.name).toBe("Groomer");
    // The groomer membership planted in the same business points at that very role, rather than
    // the migration minting a second, identical one for the invitation.
    const [shared] = await sql<{ n: number }[]>`
      select count(*)::int as n from roles where business_id = ${alpha} and name = 'Groomer'
    `;
    expect(shared!.n).toBe(1);
  });

  it("leaves accepted and revoked invitations without a role", async () => {
    const dead = await sql<{ id: string; roleId: string | null }[]>`
      select id, role_id from membership_invitations where id in (${acceptedInvitation}, ${revokedInvitation})
    `;
    expect(dead).toHaveLength(2);
    // A dead invitation holding a role_id would keep `on delete restrict` blocking the deletion
    // of a role nothing live is using.
    for (const row of dead) expect(row.roleId).toBeNull();
  });

  it("refuses a cross-tenant role assignment in the database, not just in the API", async () => {
    const [betaRole] = await sql<{ id: string }[]>`
      select id from roles where business_id = ${beta} limit 1
    `;
    // Raw SQL, deliberately bypassing every route, guard and policy in the application. The
    // composite foreign key is a constraint, so unlike the tenant_isolation policies it applies
    // to the table owner Pawsh connects as.
    await expect(sql`
      update business_memberships set role_id = ${betaRole!.id} where id = ${alphaReceptionist}
    `).rejects.toThrow(/business_memberships_role_tenant|foreign key/i);
    // And the membership is untouched.
    expect(asSet(await effective(alphaReceptionist))).toEqual(asSet(receptionist));
  });

  it("refuses to delete a role that is still assigned", async () => {
    const [role] = await sql<{ roleId: string }[]>`
      select role_id from business_memberships where id = ${alphaReceptionist}
    `;
    await expect(sql`delete from roles where id = ${role!.roleId}`)
      .rejects.toThrow(/business_memberships_role_tenant|foreign key/i);
  });

  it("grants nothing at all through a disabled role", async () => {
    const [role] = await sql<{ roleId: string }[]>`
      select role_id from business_memberships where id = ${alphaCustom}
    `;
    await sql`update roles set enabled = false where id = ${role!.roleId}`;
    expect(await effective(alphaCustom)).toEqual([]);
    await sql`update roles set enabled = true where id = ${role!.roleId}`;
    // Re-enabling restores exactly what it granted before: the assignment was never removed.
    expect(asSet(await effective(alphaCustom)))
      .toEqual(asSet(["calendar.view", "discounts.apply", "reports.view"]));
  });
});
