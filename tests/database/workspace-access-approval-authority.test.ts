import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { createRole } from "../support/roles.js";

/**
 * Approving a workspace access request is OWNER-ONLY.
 *
 * The route carried `requirePermission("team.manage")` and nothing else, while every sibling that
 * grants membership - `POST /api/members/invitations`, `PATCH /api/members/:id/permissions`, the
 * three role routes - carries an explicit `isOwner` check on top of the same permission. The
 * comment above `POST /api/roles` says those checks are repeated per route "so that no future
 * route can quietly be added to this group without it". This route was.
 *
 * What that bought a Manager was not a smaller version of ownership. Approval takes a
 * caller-chosen `roleId`, so a member holding `team.manage` could admit an account of their
 * choosing at a role of their choosing - including one carrying `settings.manage` or
 * `team.manage` itself - which is the escalation the owner checks exist to stop, routed through a
 * second account rather than their own.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "workspace-approval-authority-secret-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("workspace access approval is owner-only", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID().slice(0, 8);
  const workspaceName = `Approval Salon ${suffix}`;
  const ownerEmail = `approval-owner-${suffix}@example.test`;
  let ownerCookie: string, businessId: string;
  let managerCookie: string, viewerCookie: string;
  let grantableRole: string, foreignRole: string, foreignBusinessId: string;

  /** Raises a pending request from a fresh outside account. */
  const raiseRequest = async (email: string) => {
    const created = await app.inject({
      method: "POST", url: "/api/workspace-access-requests",
      payload: {
        requesterName: "Prospective Groomer", requesterEmail: email,
        workspaceName, workspaceAdminEmail: ownerEmail, message: "Please review my request."
      }
    });
    expect(created.statusCode, created.body).toBe(202);
    const [row] = await db<{ id: string; status: string }[]>`
      select id,status from workspace_access_requests
      where business_id=${businessId} and normalized_email=${email.toLowerCase()}
    `;
    expect(row?.status).toBe("pending");
    return row!.id;
  };

  const approve = (as: string, id: string, roleId: string) => app.inject({
    method: "POST", url: `/api/workspace-access-requests/${id}/approve`,
    headers: { cookie: as }, payload: { roleId }
  });

  /** Everything an approval would leave behind, so a refusal can be proved to have left none. */
  const traces = async (id: string, email: string) => {
    const [request] = await db<{ status: string; membershipId: string | null; invitationId: string | null }[]>`
      select status,membership_id,invitation_id from workspace_access_requests
      where business_id=${businessId} and id=${id}
    `;
    const [counts] = await db<{ invitations: number; memberships: number }[]>`
      select
        (select count(*)::int from membership_invitations
          where business_id=${businessId} and normalized_email=${email.toLowerCase()}) as invitations,
        (select count(*)::int from business_memberships membership
          join users account on account.id=membership.user_id
          where membership.business_id=${businessId}
            and account.normalized_email=${email.toLowerCase()}) as memberships
    `;
    return { ...request!, ...counts! };
  };

  /** Signs a fresh invited member in and returns their session cookie. */
  const memberWithRole = async (label: string, permissions: readonly string[]) => {
    const email = `${label}-${suffix}@example.test`;
    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email, roleId: await createRole(app, ownerCookie, `${label} ${suffix}`, permissions) }
    });
    expect(invitation.statusCode, invitation.body).toBe(201);
    const token = new URL(invitation.json().acceptancePath, "http://localhost").searchParams.get("invite");
    const accepted = await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: `correct horse ${label} account` }
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    return cookie(accepted);
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: ownerEmail, password: "correct horse approval owner", businessName: workspaceName
    }});
    ownerCookie = cookie(signup);
    ({ businessId } = signup.json());
    grantableRole = await createRole(app, ownerCookie, `Granted ${suffix}`, ["calendar.view"]);
    managerCookie = await memberWithRole("manager", ["team.manage"]);
    viewerCookie = await memberWithRole("viewer", ["calendar.view"]);

    const otherSignup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `approval-other-${suffix}@example.test`,
      password: "correct horse other owner", businessName: `Other Approval Salon ${suffix}`
    }});
    const otherCookie = cookie(otherSignup);
    foreignBusinessId = otherSignup.json().businessId;
    foreignRole = await createRole(app, otherCookie, `Foreign ${suffix}`, ["team.manage"]);
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it("lets the Owner approve", async () => {
    const email = `owner-approved-${suffix}@example.test`;
    const id = await raiseRequest(email);
    const approved = await approve(ownerCookie, id, grantableRole);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ approved: true, invitationCreated: true });
    const [invitation] = await db<{ roleId: string }[]>`
      select role_id from membership_invitations
      where business_id=${businessId} and normalized_email=${email}
    `;
    expect(invitation?.roleId).toBe(grantableRole);
  });

  it("refuses a member who holds team.manage but is not the Owner, and leaves no trace", async () => {
    const email = `manager-attempt-${suffix}@example.test`;
    const id = await raiseRequest(email);
    // `team.manage` is real: the same session can read the pending list it is being refused on.
    const list = await app.inject({
      method: "GET", url: "/api/workspace-access-requests", headers: { cookie: managerCookie }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((item: { id: string }) => item.id === id)).toBe(true);

    const refused = await approve(managerCookie, id, grantableRole);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "Only an Owner can approve workspace access" });
    // A refusal that still admitted the person would be the whole defect.
    expect(await traces(id, email)).toMatchObject({
      status: "pending", membershipId: null, invitationId: null, invitations: 0, memberships: 0
    });
  });

  it("refuses a Manager trying to admit an account at a role carrying team.manage", async () => {
    const email = `escalation-${suffix}@example.test`;
    const id = await raiseRequest(email);
    const escalating = await createRole(app, ownerCookie, `Escalated ${suffix}`, ["team.manage", "settings.manage"]);
    const refused = await approve(managerCookie, id, escalating);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(await traces(id, email)).toMatchObject({ status: "pending", invitations: 0, memberships: 0 });
  });

  it("refuses a member who holds no team.manage at all", async () => {
    const email = `viewer-attempt-${suffix}@example.test`;
    const id = await raiseRequest(email);
    const refused = await approve(viewerCookie, id, grantableRole);
    // The permission gate answers first; either way nothing is granted.
    expect(refused.statusCode, refused.body).toBe(403);
    expect(await traces(id, email)).toMatchObject({ status: "pending", invitations: 0, memberships: 0 });
  });

  it("refuses an unauthenticated approval", async () => {
    const email = `anonymous-attempt-${suffix}@example.test`;
    const id = await raiseRequest(email);
    const refused = await app.inject({
      method: "POST", url: `/api/workspace-access-requests/${id}/approve`, payload: { roleId: grantableRole }
    });
    expect(refused.statusCode).toBe(401);
    expect(await traces(id, email)).toMatchObject({ status: "pending", invitations: 0, memberships: 0 });
  });

  it("cannot assign a role belonging to another business", async () => {
    const email = `cross-tenant-${suffix}@example.test`;
    const id = await raiseRequest(email);
    // The role is resolved inside the approver's OWN business, so another tenant's id is simply
    // not a role that exists - the same 404 `POST /api/members/invitations` gives.
    const refused = await approve(ownerCookie, id, foreignRole);
    expect(refused.statusCode, refused.body).toBe(404);
    expect(refused.json()).toMatchObject({ error: "Role not found" });
    expect(await traces(id, email)).toMatchObject({ status: "pending", invitations: 0, memberships: 0 });
    // And the foreign role is untouched on its own side.
    const [foreign] = await db<{ businessId: string }[]>`
      select business_id from roles where id=${foreignRole}
    `;
    expect(foreign?.businessId).toBe(foreignBusinessId);
  });

  it("cannot approve another workspace's request even as an Owner elsewhere", async () => {
    const email = `foreign-owner-${suffix}@example.test`;
    const id = await raiseRequest(email);
    const otherOwner = await app.inject({ method: "POST", url: "/api/auth/login", payload: {
      email: `approval-other-${suffix}@example.test`, password: "correct horse other owner"
    }});
    const refused = await approve(cookie(otherOwner), id, foreignRole);
    // Being an Owner is not a global capability: the request belongs to a business this session
    // is not in, so it is not found rather than approved.
    expect(refused.statusCode, refused.body).toBe(404);
    expect(await traces(id, email)).toMatchObject({ status: "pending", invitations: 0, memberships: 0 });
  });

  it("accepts a disabled role exactly as the invitation authority does, and it grants nothing", async () => {
    const email = `disabled-role-${suffix}@example.test`;
    const id = await raiseRequest(email);
    const created = await app.inject({
      method: "POST", url: "/api/roles", headers: { cookie: ownerCookie },
      payload: { name: `Retired ${suffix}` }
    });
    const retired = created.json();
    const disabled = await app.inject({
      method: "PATCH", url: `/api/roles/${retired.id}`, headers: { cookie: ownerCookie },
      payload: { version: retired.version, permissions: ["team.manage"], enabled: false }
    });
    expect(disabled.statusCode, disabled.body).toBe(200);

    // Pawsh has no "ineligible role" refusal anywhere - not here, not on
    // `POST /api/members/invitations`, not on `PATCH /api/members/:id/role`. Disabling is how a
    // role is RETIRED while keeping its assignments, and `effectivePermissions` resolves a
    // disabled role to the empty set, so assigning one grants nothing rather than granting
    // something unreviewed. Inventing a refusal on this route alone would make the approval
    // authority disagree with the invitation authority about the same role.
    const approved = await approve(ownerCookie, id, retired.id);
    expect(approved.statusCode, approved.body).toBe(200);
    const [invitation] = await db<{ roleId: string }[]>`
      select role_id from membership_invitations
      where business_id=${businessId} and normalized_email=${email}
    `;
    expect(invitation?.roleId).toBe(retired.id);
    const [effective] = await db<{ permissions: string[] }[]>`
      select case when granting_role.enabled then granting_role.permissions else '{}'::text[] end as permissions
      from roles granting_role where granting_role.business_id=${businessId} and granting_role.id=${retired.id}
    `;
    expect(effective?.permissions).toEqual([]);
  });

  it("keeps the unauthenticated request route scoped: it asks, it never grants", async () => {
    const email = `anonymous-scope-${suffix}@example.test`;
    // A requester cannot name a role, a permission, or an ownership flag: the schema is strict.
    for (const escalation of [{ roleId: grantableRole }, { role: "owner" }, { isOwner: true }, { businessId }]) {
      const rejected = await app.inject({
        method: "POST", url: "/api/workspace-access-requests",
        payload: {
          requesterName: "Escalation", requesterEmail: email,
          workspaceName, workspaceAdminEmail: ownerEmail, ...escalation
        }
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
    }
    // An accepted request creates a PENDING row and nothing else - no membership, no invitation,
    // no session - and answers the same generic body whether or not the workspace exists.
    const id = await raiseRequest(email);
    expect(await traces(id, email)).toMatchObject({
      status: "pending", membershipId: null, invitationId: null, invitations: 0, memberships: 0
    });
    const unknown = await app.inject({
      method: "POST", url: "/api/workspace-access-requests",
      payload: {
        requesterName: "Nobody", requesterEmail: `nowhere-${suffix}@example.test`,
        workspaceName: `No Such Salon ${suffix}`, workspaceAdminEmail: ownerEmail
      }
    });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual({
      accepted: true,
      message: "If the request can be processed, the workspace administrator will be notified."
    });
    // Reading the queue still needs a session, so the anonymous route cannot be used to confirm
    // which workspaces exist by watching what appears in it.
    expect((await app.inject({ method: "GET", url: "/api/workspace-access-requests" })).statusCode).toBe(401);
  });

  it("leaves rejection on team.manage, because refusing a request grants nothing", async () => {
    const email = `manager-rejects-${suffix}@example.test`;
    const id = await raiseRequest(email);
    const rejected = await app.inject({
      method: "POST", url: `/api/workspace-access-requests/${id}/reject`, headers: { cookie: managerCookie }
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await traces(id, email)).toMatchObject({
      status: "rejected", membershipId: null, invitationId: null, invitations: 0, memberships: 0
    });
  });
});
