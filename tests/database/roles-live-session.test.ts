import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { createRole } from "../support/roles.js";

/**
 * A role is only useful if changing it CHANGES SOMETHING NOW.
 *
 * Nothing about a membership's authority is cached in the session row or in the token: the auth
 * middleware re-resolves permissions through the role on every request. So editing a role,
 * disabling it, or reassigning a member must take effect on the very next request the affected
 * session makes - with the same cookie, no re-login, and no revocation sweep. An owner who
 * disables a role during an incident has closed it, not scheduled it to close.
 *
 * This file proves that end to end through the HTTP surface, against a session established BEFORE
 * any of the changes below, and it asserts on a route that is really gated (`GET /api/members`
 * requires `team.manage`) rather than on a reported permission list, because what matters is
 * whether the server refuses the request.
 *
 * Roles are assigned here in raw SQL on purpose. At this phase the backfill migration is the only
 * thing that puts a membership on a role; the roles API arrives in the next phase, and writing
 * this test against an endpoint that does not exist yet would be writing it against a guess.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "roles-live-session-test-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};
const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("roles resolve live, without re-authentication", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  const ownerEmail = `roles-owner-${suffix}@example.test`;
  const memberEmail = `roles-member-${suffix}@example.test`;
  let ownerCookie: string, memberCookie: string, businessId: string, membershipId: string;
  let roleId: string;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: ownerEmail, password: "correct horse roles owner", businessName: `Roles Salon ${suffix}` }
    });
    ownerCookie = cookie(signup);
    businessId = signup.json().businessId;

    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email: memberEmail, roleId: await createRole(app, ownerCookie, `Bootstrap ${suffix}`, ["calendar.view", "team.manage"]) }
    });
    const token = new URL(invitation.json().acceptancePath, "http://localhost").searchParams.get("invite");
    const accepted = await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: "correct horse roles member" }
    });
    // This cookie is established now and never refreshed. Every assertion below uses it.
    memberCookie = cookie(accepted);
    membershipId = (await app.inject({ method: "GET", url: "/api/me", headers: { cookie: memberCookie } }))
      .json().membershipId;

    const [role] = await db<{ id: string }[]>`
      insert into roles (business_id, name, permissions)
      values (${businessId}, ${`Front desk ${suffix}`}, ${["calendar.view", "team.manage"]})
      returning id
    `;
    roleId = role!.id;
    await db`
      update business_memberships set role_id = ${roleId}
      where business_id = ${businessId} and id = ${membershipId}
    `;
  });

  afterAll(async () => {
    // Roles are left in place: `membership_role_matches_ownership` forbids stranding a non-owner
    // without one, so clearing them would mean deleting the memberships as well. The unique suffix
    // keeps the residue from reaching any other suite.
    await app.close();
    await db.end();
  });

  const members = (sessionCookie: string) =>
    app.inject({ method: "GET", url: "/api/members", headers: { cookie: sessionCookie } });
  const me = async (sessionCookie: string) =>
    (await app.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionCookie } })).json();

  it("resolves permissions through the assigned role and reports it on /api/me", async () => {
    expect((await members(memberCookie)).statusCode).toBe(200);
    const identity = await me(memberCookie);
    expect(identity.role).toEqual({ id: roleId, name: `Front desk ${suffix}`, enabled: true });
    expect(identity.permissions).toEqual(expect.arrayContaining(["calendar.view", "team.manage"]));
  });

  it("applies a role edit on the very next request of an existing session", async () => {
    await db`update roles set permissions = ${["calendar.view"]} where id = ${roleId}`;
    // Same cookie, no re-login, no session revocation.
    expect((await members(memberCookie)).statusCode).toBe(403);
    expect((await me(memberCookie)).permissions).not.toContain("team.manage");

    await db`update roles set permissions = ${["calendar.view", "team.manage"]} where id = ${roleId}`;
    expect((await members(memberCookie)).statusCode).toBe(200);
  });

  it("revokes everything the moment the role is disabled, and restores it on re-enable", async () => {
    await db`update roles set enabled = false where id = ${roleId}`;
    expect((await members(memberCookie)).statusCode).toBe(403);
    const disabled = await me(memberCookie);
    // The assignment survives - the member still shows the role, and it still says it is off.
    expect(disabled.role).toEqual({ id: roleId, name: `Front desk ${suffix}`, enabled: false });
    // But it grants nothing at all. Not a reduced set: the empty set.
    expect(disabled.permissions).toEqual([]);

    await db`update roles set enabled = true where id = ${roleId}`;
    expect((await members(memberCookie)).statusCode).toBe(200);
    expect((await me(memberCookie)).permissions).toEqual(expect.arrayContaining(["team.manage"]));
  });

  it("never lets a disabled role touch the owner", async () => {
    await db`update roles set enabled = false where id = ${roleId}`;
    // The owner holds no role and is authorised by is_owner, so nothing about the role reaches
    // them. This is the guard against a kill switch locking a workspace's owner out of it.
    expect((await members(ownerCookie)).statusCode).toBe(200);
    const owner = await me(ownerCookie);
    expect(owner.role).toBeNull();
    expect(owner.isOwner).toBe(true);
    await db`update roles set enabled = true where id = ${roleId}`;
  });

  it("reports the member's role on the members list and in the workspace list", async () => {
    const listed = (await members(ownerCookie)).json()
      .find((member: { email: string }) => member.email === memberEmail);
    expect(listed.role).toEqual({ id: roleId, name: `Front desk ${suffix}`, enabled: true });
    expect(listed.permissions).toEqual(expect.arrayContaining(["calendar.view", "team.manage"]));

    const workspaces = (await app.inject({
      method: "GET", url: "/api/workspaces", headers: { cookie: memberCookie }
    })).json();
    const current = workspaces.find((workspace: { id: string }) => workspace.id === businessId);
    expect(current.role).toEqual({ id: roleId, name: `Front desk ${suffix}`, enabled: true });
  });
});
