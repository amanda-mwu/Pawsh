import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * Invitations that name a role rather than a permission list.
 *
 * The property worth protecting here is that AN INVITATION IS A PROMISE OF A ROLE, NOT A SNAPSHOT
 * OF ONE. Somebody invited last week who accepts today must arrive holding the role as it stands
 * today. If the invitation carried a copy of the permissions, tightening the role would leave every
 * outstanding invitation quietly handing out the old, looser set - and nobody would find out,
 * because the person who accepted would simply be able to do more than the role says.
 *
 * The other half is bookkeeping that turns into a real bug if it is skipped: a consumed or revoked
 * invitation must RELEASE its role reference. The foreign key is `on delete restrict`, so an
 * invitation nobody can ever use would otherwise go on blocking that role's deletion, and the
 * delete gate - which counts live invitations - would be unable to explain what was holding it.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "roles-invitations-test-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};
const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("invitations on roles", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  const ownerEmail = `inv-owner-${suffix}@example.test`;
  let ownerCookie: string, businessId: string, roleId: string, roleVersion: number;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: ownerEmail, password: "correct horse invite owner", businessName: `Invite Salon ${suffix}` }
    });
    ownerCookie = cookie(signup);
    businessId = signup.json().businessId;
    const role = (await app.inject({
      method: "POST", url: "/api/roles", headers: { cookie: ownerCookie },
      payload: { name: `Bather ${suffix}` }
    })).json();
    roleId = role.id;
    const granted = (await app.inject({
      method: "PATCH", url: `/api/roles/${roleId}`, headers: { cookie: ownerCookie },
      payload: { version: role.version, permissions: ["calendar.view", "team.manage"] }
    })).json();
    roleVersion = granted.version;
  });

  afterAll(async () => {
    await db`update business_memberships set role_id = null where business_id = ${businessId}`;
    await db`update membership_invitations set role_id = null where business_id = ${businessId}`;
    await db`delete from roles where business_id = ${businessId}`;
    await app.close();
    await db.end();
  });

  const invite = async (payload: Record<string, unknown>, sessionCookie = ownerCookie) =>
    await app.inject({
      method: "POST", url: "/api/members/invitations",
      headers: { cookie: sessionCookie }, payload
    });
  const invitations = async (sessionCookie = ownerCookie) =>
    await app.inject({
      method: "GET", url: "/api/members/invitations", headers: { cookie: sessionCookie }
    });
  const acceptanceToken = (response: { json: () => { acceptancePath: string } }) =>
    new URL(response.json().acceptancePath, "http://localhost").searchParams.get("invite")!;

  it("stores the role and no permission list of its own", async () => {
    const email = `named-${suffix}@example.test`;
    const created = await invite({ email, roleId });
    expect(created.statusCode).toBe(201);
    const [row] = await db<{ roleId: string; permissions: string[] }[]>`
      select role_id, permissions from membership_invitations
      where business_id = ${businessId} and normalized_email = ${email}
    `;
    expect(row!.roleId).toBe(roleId);
    // A stored list would be a second, frozen answer to "what will this person be able to do".
    expect(row!.permissions).toEqual([]);

    const listed = (await invitations()).json().invitations
      .find((item: { email: string }) => item.email === email);
    expect(listed.role).toMatchObject({ id: roleId, name: `Bather ${suffix}`, enabled: true });
  });

  it("refuses an invitation that names both a role and a permission list", async () => {
    const response = await invite({
      email: `both-${suffix}@example.test`, roleId, permissions: ["calendar.view"]
    });
    // Two different answers to the same question; picking one silently is how the wrong one wins.
    expect(response.statusCode).toBe(400);
  });

  it("refuses a role belonging to another business", async () => {
    const [foreign] = await db<{ id: string }[]>`
      select id from roles where business_id <> ${businessId} limit 1
    `;
    if (!foreign) return;
    expect((await invite({ email: `foreign-${suffix}@example.test`, roleId: foreign.id })).statusCode)
      .toBe(404);
  });

  it("hands the accepting member the role AS IT STANDS AT ACCEPT TIME", async () => {
    const email = `late-${suffix}@example.test`;
    const created = await invite({ email, roleId });
    const token = acceptanceToken(created);

    // The role is tightened AFTER the invitation was written and BEFORE it is accepted.
    const tightened = (await app.inject({
      method: "PATCH", url: `/api/roles/${roleId}`, headers: { cookie: ownerCookie },
      payload: { version: roleVersion, permissions: ["calendar.view"] }
    })).json();
    roleVersion = tightened.version;

    const accepted = await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: "correct horse late joiner" }
    });
    const identity = (await app.inject({
      method: "GET", url: "/api/me", headers: { cookie: cookie(accepted) }
    })).json();
    // Not the looser set the invitation was written against.
    expect(identity.permissions).toEqual(["calendar.view"]);
    expect(identity.role).toMatchObject({ id: roleId, enabled: true });

    // The consumed invitation released its role reference and left the live list.
    const [row] = await db<{ roleId: string | null; acceptedAt: Date | null }[]>`
      select role_id, accepted_at from membership_invitations
      where business_id = ${businessId} and normalized_email = ${email}
    `;
    expect(row!.acceptedAt).not.toBeNull();
    expect(row!.roleId).toBeNull();
    expect((await invitations()).json().invitations
      .some((item: { email: string }) => item.email === email)).toBe(false);
  });

  it("releases the role when an invitation is revoked, freeing the role to be deleted", async () => {
    const disposable = (await app.inject({
      method: "POST", url: "/api/roles", headers: { cookie: ownerCookie },
      payload: { name: `Disposable ${suffix}` }
    })).json();
    const email = `revoked-${suffix}@example.test`;
    const created = await invite({ email, roleId: disposable.id });
    const invitationId = created.json().id;

    // While the invitation is live the role cannot be deleted, and the 409 says why.
    const blocked = await app.inject({
      method: "DELETE", url: `/api/roles/${disposable.id}`, headers: { cookie: ownerCookie }
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().pendingInvitationCount).toBe(1);

    const revoked = await app.inject({
      method: "DELETE", url: `/api/members/invitations/${invitationId}`,
      headers: { cookie: ownerCookie }
    });
    expect(revoked.statusCode).toBe(204);
    expect((await invitations()).json().invitations
      .some((item: { id: string }) => item.id === invitationId)).toBe(false);
    // The dead row no longer holds the role hostage.
    expect((await app.inject({
      method: "DELETE", url: `/api/roles/${disposable.id}`, headers: { cookie: ownerCookie }
    })).statusCode).toBe(204);
  });

  it("refuses to revoke an invitation twice", async () => {
    const created = await invite({ email: `twice-${suffix}@example.test`, roleId });
    const invitationId = created.json().id;
    const url = `/api/members/invitations/${invitationId}`;
    expect((await app.inject({ method: "DELETE", url, headers: { cookie: ownerCookie } })).statusCode)
      .toBe(204);
    expect((await app.inject({ method: "DELETE", url, headers: { cookie: ownerCookie } })).statusCode)
      .toBe(404);
  });

  it("lets a manager read invitations but only an owner revoke them", async () => {
    const managerEmail = `inv-manager-${suffix}@example.test`;
    // Its own role, because the shared one is deliberately tightened by an earlier test and a
    // manager needs team.manage to read the list at all.
    const managing = (await app.inject({
      method: "POST", url: "/api/roles", headers: { cookie: ownerCookie },
      payload: { name: `Managing ${suffix}` }
    })).json();
    await app.inject({
      method: "PATCH", url: `/api/roles/${managing.id}`, headers: { cookie: ownerCookie },
      payload: { version: managing.version, permissions: ["calendar.view", "team.manage"] }
    });
    const created = await invite({ email: managerEmail, roleId: managing.id });
    const managerCookie = cookie(await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token: acceptanceToken(created), password: "correct horse invite manager" }
    }));
    const target = await invite({ email: `target-${suffix}@example.test`, roleId });

    expect((await invitations(managerCookie)).statusCode).toBe(200);
    // Reading the team is a manager's job; changing who can join is not.
    expect((await app.inject({
      method: "DELETE", url: `/api/members/invitations/${target.json().id}`,
      headers: { cookie: managerCookie }
    })).statusCode).toBe(403);
    expect((await invite({ email: `by-manager-${suffix}@example.test`, roleId }, managerCookie))
      .statusCode).toBe(403);
  });

  it("keeps every invitation inside its own business", async () => {
    const otherEmail = `inv-other-${suffix}@example.test`;
    const other = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: otherEmail, password: "correct horse other salon", businessName: `Other Invite ${suffix}` }
    });
    await invite({ email: `scoped-${suffix}@example.test`, roleId });
    const theirs = (await invitations(cookie(other))).json().invitations;
    expect(theirs.some((item: { email: string }) => item.email.startsWith("scoped-"))).toBe(false);
  });
});
