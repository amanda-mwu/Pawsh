import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { builtInRoles, permissionLabels, permissions, type Permission } from "@pawsh/domain";
import { provisionBusinessCatalog } from "../../src/domain/catalog-seed.js";
import { createRole } from "../support/roles.js";

/**
 * The roles API: who may call it, what it refuses, and the counts the editor cannot compute.
 *
 * The split under test is the one that matters. READING the team is a manager's job and mutating
 * access is not, so every write here is owner-only ON TOP OF `team.manage` - because a manager who
 * could edit the role they are standing in could grant themselves `settings.manage`, which is
 * privilege escalation with extra steps. A test that only checked "manager gets 200 on the list"
 * would miss it entirely, so each mutation is attempted as a manager and expected to be refused.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "roles-api-test-secret-at-least-32-characters",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};
const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("roles API", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  const ownerEmail = `roles-api-owner-${suffix}@example.test`;
  const managerEmail = `roles-api-manager-${suffix}@example.test`;
  let ownerCookie: string, managerCookie: string, businessId: string, managerMembershipId: string;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: ownerEmail, password: "correct horse roles api", businessName: `Roles API ${suffix}` }
    });
    ownerCookie = cookie(signup);
    businessId = signup.json().businessId;

    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email: managerEmail, roleId: await createRole(app, ownerCookie, `Bootstrap manager ${suffix}`, ["calendar.view", "team.manage"]) }
    });
    const token = new URL(invitation.json().acceptancePath, "http://localhost").searchParams.get("invite");
    const accepted = await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: "correct horse roles manager" }
    });
    managerCookie = cookie(accepted);
    managerMembershipId = (await app.inject({
      method: "GET", url: "/api/me", headers: { cookie: managerCookie }
    })).json().membershipId;
  });

  afterAll(async () => {
    // Roles are left in place: `membership_role_matches_ownership` forbids stranding a non-owner
    // without one, so clearing them would mean deleting the memberships as well. The unique suffix
    // keeps the residue from reaching any other suite.
    await app.close();
    await db.end();
  });

  const create = async (payload: Record<string, unknown>, sessionCookie = ownerCookie) =>
    await app.inject({ method: "POST", url: "/api/roles", headers: { cookie: sessionCookie }, payload });
  const list = async (sessionCookie = ownerCookie) =>
    await app.inject({ method: "GET", url: "/api/roles", headers: { cookie: sessionCookie } });
  const patch = async (id: string, payload: Record<string, unknown>, sessionCookie = ownerCookie) =>
    await app.inject({ method: "PATCH", url: `/api/roles/${id}`, headers: { cookie: sessionCookie }, payload });

  /** Invites `email` onto a fresh role and returns the membership id once accepted. */
  const joinAsMember = async (email: string, roleName: string): Promise<string> => {
    const roleId = await createRole(app, ownerCookie, roleName, ["calendar.view"]);
    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email, roleId }
    });
    const token = new URL(invitation.json().acceptancePath, "http://localhost").searchParams.get("invite");
    const accepted = await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: "correct horse joining member" }
    });
    return (await app.inject({ method: "GET", url: "/api/me", headers: { cookie: cookie(accepted) } }))
      .json().membershipId;
  };

  it("publishes a grouped catalog that covers every permission and flags what it enforces", async () => {
    const catalog = (await app.inject({
      method: "GET", url: "/api/permissions", headers: { cookie: ownerCookie }
    })).json();
    expect(catalog.permissions).toEqual([...permissions]);
    expect(catalog.presets.manager).toEqual([...permissions]);
    const catalogued = catalog.groups.flatMap(
      (group: { permissions: { key: string }[] }) => group.permissions.map((entry) => entry.key)
    );
    // Every permission is reachable through the editor, and none appears twice.
    expect([...permissions].filter((permission) => !catalogued.includes(permission))).toEqual([]);
    expect(catalogued.length).toBe(new Set(catalogued).size);
    for (const group of catalog.groups) {
      for (const entry of group.permissions) {
        expect(typeof entry.label).toBe("string");
        expect(typeof entry.enforced).toBe("boolean");
      }
    }
  });

  it("creates an empty role and reports the counts the editor needs", async () => {
    const created = await create({ name: `Front desk ${suffix}`, description: "Phones." });
    expect(created.statusCode).toBe(201);
    const role = created.json();
    // A new role grants NOTHING until somebody says otherwise. An owner who creates one and walks
    // away has not accidentally given anybody anything.
    expect(role.permissions).toEqual([]);
    expect(role).toMatchObject({
      name: `Front desk ${suffix}`, description: "Phones.", builtIn: false, enabled: true,
      version: 1, assignedCount: 0, grantedCount: 0, totalCount: permissions.length
    });
    expect(role.topPermissionLabels).toEqual([]);
  });

  it("copies permissions from an existing role only within the caller's own business", async () => {
    const source = (await create({ name: `Copy source ${suffix}` })).json();
    await patch(source.id, { version: source.version, permissions: ["calendar.view", "team.manage"] });
    const copy = (await create({ name: `Copy target ${suffix}`, copyFromRoleId: source.id })).json();
    expect(copy.permissions.sort()).toEqual(["calendar.view", "team.manage"]);

    // A role id belonging to somebody else is simply not found: the lookup carries the business
    // predicate, so the client cannot reach across the tenant boundary by naming an id.
    const [foreign] = await db<{ id: string }[]>`
      select id from roles where business_id <> ${businessId} limit 1
    `;
    if (foreign) {
      expect((await create({ name: `Foreign ${suffix}`, copyFromRoleId: foreign.id })).statusCode).toBe(404);
    }
  });

  it("refuses a duplicate role name in the same business, case-insensitively", async () => {
    await create({ name: `Duplicate ${suffix}` });
    const clash = await create({ name: `DUPLICATE ${suffix}` });
    expect(clash.statusCode).toBe(409);
  });

  it("refuses a stale version rather than silently taking the last write", async () => {
    const role = (await create({ name: `Concurrent ${suffix}` })).json();
    const first = await patch(role.id, { version: role.version, permissions: ["calendar.view"] });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(role.version + 1);
    // The second tab still holds the version it loaded. Taking this write would restore
    // permissions the first tab had just removed, and report success while doing it.
    const stale = await patch(role.id, { version: role.version, permissions: [...permissions] });
    expect(stale.statusCode).toBe(409);
    const unchanged = (await list()).json().roles.find((item: { id: string }) => item.id === role.id);
    expect(unchanged.permissions).toEqual(["calendar.view"]);
  });

  it("leaves omitted fields alone and treats an empty permission array as a real revocation", async () => {
    let role = (await create({ name: `Partial ${suffix}`, description: "Keep me." })).json();
    role = (await patch(role.id, { version: role.version, permissions: ["calendar.view", "pets.view"] })).json();
    // Renaming must not disturb permissions, and must not clear the description.
    role = (await patch(role.id, { version: role.version, name: `Renamed ${suffix}` })).json();
    expect(role.permissions.sort()).toEqual(["calendar.view", "pets.view"]);
    expect(role.description).toBe("Keep me.");
    // An explicit empty array is not "no change".
    role = (await patch(role.id, { version: role.version, permissions: [] })).json();
    expect(role.permissions).toEqual([]);
    expect(role.grantedCount).toBe(0);
  });

  it("rejects a permission the domain does not define", async () => {
    const role = (await create({ name: `Invalid ${suffix}` })).json();
    const response = await patch(role.id, { version: role.version, permissions: ["reports.veiw"] });
    expect(response.statusCode).toBe(400);
  });

  it("counts assignments and refuses to delete a role while anything points at it", async () => {
    const role = (await create({ name: `Assigned ${suffix}` })).json();
    await patch(role.id, { version: role.version, permissions: ["calendar.view", "pets.view", "team.manage"] });
    const assign = await app.inject({
      method: "PATCH", url: `/api/members/${managerMembershipId}/role`,
      headers: { cookie: ownerCookie }, payload: { roleId: role.id }
    });
    expect(assign.statusCode).toBe(200);
    expect(assign.json().role).toMatchObject({ id: role.id, enabled: true });

    const listed = (await list()).json().roles.find((item: { id: string }) => item.id === role.id);
    expect(listed.assignedCount).toBe(1);
    expect(listed.grantedCount).toBe(3);
    // Ordered by the domain tuple and capped, so the same role always describes itself the same
    // way and the confirmation can say "and N more" from grantedCount. Read through
    // `permissionLabels` rather than restated: a label is display copy and may be reworded, and a
    // test that hard-codes it fails on the wording instead of on the ordering it is here to pin.
    expect(listed.topPermissionLabels).toEqual(
      ["calendar.view", "pets.view", "team.manage"].map((key) => permissionLabels[key as Permission])
    );

    // The delete gate mirrors the `on delete restrict` foreign key exactly, so the caller gets a
    // 409 naming what is in the way rather than a 500 describing a constraint.
    const refused = await app.inject({
      method: "DELETE", url: `/api/roles/${role.id}`, headers: { cookie: ownerCookie }
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().assignedCount).toBe(1);
  });

  it("deletes a role nothing points at", async () => {
    const role = (await create({ name: `Disposable ${suffix}` })).json();
    const deleted = await app.inject({
      method: "DELETE", url: `/api/roles/${role.id}`, headers: { cookie: ownerCookie }
    });
    expect(deleted.statusCode).toBe(204);
    expect((await list()).json().roles.some((item: { id: string }) => item.id === role.id)).toBe(false);
  });

  it("never lets an owner be given a role", async () => {
    const role = (await create({ name: `For owner ${suffix}` })).json();
    const ownerMembershipId = (await app.inject({
      method: "GET", url: "/api/me", headers: { cookie: ownerCookie }
    })).json().membershipId;
    const refused = await app.inject({
      method: "PATCH", url: `/api/members/${ownerMembershipId}/role`,
      headers: { cookie: ownerCookie }, payload: { roleId: role.id }
    });
    expect(refused.statusCode).toBe(404);
    const [row] = await db<{ roleId: string | null }[]>`
      select role_id from business_memberships where id = ${ownerMembershipId}
    `;
    expect(row!.roleId).toBeNull();
  });

  it("lets a manager read roles but never change them", async () => {
    expect((await list(managerCookie)).statusCode).toBe(200);
    const role = (await list()).json().roles[0];
    // A manager who could edit the role they are standing in could grant themselves
    // settings.manage. Every mutation is owner-only on top of team.manage.
    expect((await create({ name: `Manager made ${suffix}` }, managerCookie)).statusCode).toBe(403);
    expect((await patch(role.id, { version: role.version, enabled: false }, managerCookie)).statusCode).toBe(403);
    expect((await app.inject({
      method: "DELETE", url: `/api/roles/${role.id}`, headers: { cookie: managerCookie }
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "PATCH", url: `/api/members/${managerMembershipId}/role`,
      headers: { cookie: managerCookie }, payload: { roleId: role.id }
    })).statusCode).toBe(403);
  });

  it("refuses a transfer that does not name a role for the outgoing owner", async () => {
    const heir = `heir-a-${suffix}@example.test`;
    const heirMembership = await joinAsMember(heir, `Heir A ${suffix}`);
    // No role for the outgoing owner is not a defaultable omission. Falling through would leave
    // the founder a non-owner with no role, which resolves to the empty set.
    expect((await app.inject({
      method: "POST", url: "/api/business/transfer-ownership", headers: { cookie: ownerCookie },
      payload: { membershipId: heirMembership }
    })).statusCode).toBe(400);
    // Nor may it name a role that is not this business's.
    const [foreign] = await db<{ id: string }[]>`
      select id from roles where business_id <> ${businessId} limit 1
    `;
    if (foreign) {
      expect((await app.inject({
        method: "POST", url: "/api/business/transfer-ownership", headers: { cookie: ownerCookie },
        payload: { membershipId: heirMembership, outgoingOwnerRoleId: foreign.id }
      })).statusCode).toBe(404);
    }
    // And the workspace still has exactly the owner it started with.
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } }))
      .json().isOwner).toBe(true);
  });

  it("lands the outgoing owner on the named role with real permissions, never the empty set", async () => {
    const founderEmail = `founder-${suffix}@example.test`;
    const founderSignup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: founderEmail, password: "correct horse founder here", businessName: `Handover ${suffix}` }
    });
    const founderCookie = cookie(founderSignup);
    const successorEmail = `successor-${suffix}@example.test`;
    const successorRole = await createRole(app, founderCookie, "Successor", ["calendar.view"]);
    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: founderCookie },
      payload: { email: successorEmail, roleId: successorRole }
    });
    const token = new URL(invitation.json().acceptancePath, "http://localhost").searchParams.get("invite");
    const successorCookie = cookie(await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: "correct horse successor here" }
    }));
    const successorMembership = (await app.inject({
      method: "GET", url: "/api/me", headers: { cookie: successorCookie }
    })).json().membershipId;
    const keptRole = await createRole(app, founderCookie, "Founder emeritus",
      ["calendar.view", "customers.view", "reports.view"]);

    const transfer = await app.inject({
      method: "POST", url: "/api/business/transfer-ownership", headers: { cookie: founderCookie },
      payload: { membershipId: successorMembership, outgoingOwnerRoleId: keptRole }
    });
    expect(transfer.statusCode).toBe(200);

    // The founder is no longer an owner and holds EXACTLY the role the transfer named - not the
    // empty set, which is what a transfer with no role would have produced once the denormalised
    // permission column was dropped.
    const founder = (await app.inject({
      method: "GET", url: "/api/me", headers: { cookie: founderCookie }
    })).json();
    expect(founder.isOwner).toBe(false);
    expect(founder.role).toMatchObject({ id: keptRole, name: "Founder emeritus", enabled: true });
    expect(founder.permissions.sort())
      .toEqual(["calendar.view", "customers.view", "reports.view"]);
    expect(founder.permissions.length).toBeGreaterThan(0);

    // The successor is an owner, holds no role, and holds everything.
    const successor = (await app.inject({
      method: "GET", url: "/api/me", headers: { cookie: successorCookie }
    })).json();
    expect(successor.isOwner).toBe(true);
    expect(successor.role).toBeNull();
    expect(successor.permissions).toEqual([...permissions]);
  });

  /** Signs a brand-new workspace up, the way a real salon arrives. */
  const signUp = async (label: string) => {
    const response = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `${label}-${suffix}@example.test`,
        password: "correct horse provisioning",
        businessName: `${label} ${suffix}`
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    return { cookie: cookie(response), businessId: response.json().businessId as string };
  };
  interface ListedRole {
    id: string; name: string; description: string | null; builtIn: boolean; enabled: boolean;
    version: number; permissions: string[]; assignedCount: number;
  }
  const rolesOf = async (sessionCookie: string): Promise<ListedRole[]> =>
    (await app.inject({ method: "GET", url: "/api/roles", headers: { cookie: sessionCookie } }))
      .json().roles;

  /**
   * A BUSINESS CREATED TODAY MUST ARRIVE WITH THE SAME ROLES A MIGRATED ONE HAS.
   *
   * 0041 seeded the three built-ins into every business that existed when it ran and could not
   * reach one created afterwards, so a new signup had NO roles at all - and because an invitation
   * must name a `roleId`, its owner could not invite anybody until they had hand-built one.
   */
  it("gives a newly created business exactly the built-in Pawsh roles", async () => {
    const fresh = await signUp("provisioned");
    const roles = await rolesOf(fresh.cookie);
    // Exactly the built-ins and nothing else: the provisioner does not invent a fourth, and it
    // does not leave the workspace empty.
    expect(roles.map((role) => role.name).sort())
      .toEqual(builtInRoles.map((role) => role.name).sort());
    for (const definition of builtInRoles) {
      const role = roles.find((candidate) => candidate.name === definition.name)!;
      expect(role.builtIn, definition.name).toBe(true);
      expect(role.enabled, definition.name).toBe(true);
      expect(role.assignedCount, definition.name).toBe(0);
      // The permissions are the canonical definitions, not a second hand-written copy of them.
      expect([...role.permissions].sort(), definition.name)
        .toEqual([...definition.permissions].sort());
    }
    // And the owner can now invite somebody immediately, which is the defect this closes.
    const invited = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: fresh.cookie },
      payload: {
        email: `provisioned-hire-${suffix}@example.test`,
        roleId: roles.find((role) => role.name === "Groomer")!.id
      }
    });
    expect(invited.statusCode, invited.body).toBe(201);
  });

  it("provisions idempotently, per business, and never resets what is already there", async () => {
    const first = await signUp("idempotent-one");
    const second = await signUp("idempotent-two");
    const houseRole = await createRole(app, first.cookie, `House style ${suffix}`, ["calendar.view"]);
    const before = await rolesOf(first.cookie);

    // Running the authority again is what `npm run db:migrate` does to every business, and what a
    // re-seeded QA workspace does to itself. It must be a no-op.
    for (let run = 0; run < 2; run++) {
      await db.begin(async (tx) => { await provisionBusinessCatalog(tx, first.businessId); });
    }

    const after = await rolesOf(first.cookie);
    // Same rows, same ids. Not "three built-ins again" - the SAME three, because a duplicate set
    // would break the unique index and a replaced set would strand every assignment pointing at
    // the old ids.
    expect(after.map((role) => role.id).sort()).toEqual(before.map((role) => role.id).sort());
    expect(after.filter((role) => role.builtIn)).toHaveLength(builtInRoles.length);
    const custom = after.find((role) => role.id === houseRole)!;
    expect(custom).toMatchObject({ name: `House style ${suffix}`, builtIn: false });
    expect(custom.permissions).toEqual(["calendar.view"]);

    // No leakage: the second workspace has its own three rows, sharing no id with the first.
    const neighbour = await rolesOf(second.cookie);
    expect(neighbour.filter((role) => role.builtIn)).toHaveLength(builtInRoles.length);
    const mine = new Set(after.map((role) => role.id));
    expect(neighbour.filter((role) => mine.has(role.id))).toEqual([]);
  });

  it("leaves a salon's own role alone when it already owns the name", async () => {
    // A business that predates provisioning may already have written its own "manager". The
    // built-in must not be forced alongside it - `roles_unique_name_per_business` compares
    // case-insensitively, so that would be a constraint violation - and must not overwrite it.
    const [legacy] = await db<{ id: string }[]>`
      insert into businesses (name,email)
      values (${`Legacy ${suffix}`},${`legacy-${suffix}@example.test`})
      returning id
    `;
    await db`
      insert into roles (business_id,name,permissions)
      values (${legacy!.id},'manager',${["calendar.view"]}::text[])
    `;
    await db.begin(async (tx) => { await provisionBusinessCatalog(tx, legacy!.id); });

    const rows = await db<{ name: string; builtIn: boolean; permissions: string[] }[]>`
      select name,built_in,permissions from roles where business_id=${legacy!.id}
    `;
    expect(rows.map((role) => role.name).sort()).toEqual(["Groomer", "Receptionist", "manager"]);
    const kept = rows.find((role) => role.name === "manager")!;
    expect(kept.builtIn).toBe(false);
    expect(kept.permissions).toEqual(["calendar.view"]);
  });

  it("lists roles in the order Pawsh states, not the order their names are spelled", async () => {
    const fresh = await signUp("role-order");

    // `builtInRoles` is the source and `sort_order` carries it into the database, so the top staff
    // role sits directly under the Owner because it is FIRST THERE. Sorted by name these are
    // Groomer, Manager, Receptionist - the most powerful of the three in the middle, and nobody
    // decided that. The assertion is against the array rather than a literal list of names so that
    // reordering the array is all it takes to move a role, and adding a fourth built-in cannot
    // land somewhere nobody chose.
    expect((await rolesOf(fresh.cookie)).map((role) => role.name))
      .toEqual(builtInRoles.map((role) => role.name));

    // A custom role sorts after every built-in whatever it is called: `built_in desc` decides
    // that before `sort_order` is consulted. "Aardvark" would otherwise lead the list.
    await createRole(app, fresh.cookie, `Aardvark ${suffix}`);
    await createRole(app, fresh.cookie, `Zebra ${suffix}`);
    expect((await rolesOf(fresh.cookie)).map((role) => role.name)).toEqual([
      ...builtInRoles.map((role) => role.name), `Aardvark ${suffix}`, `Zebra ${suffix}`
    ]);
  });

  it("publishes the taxonomy's groups, masters and descriptions", async () => {
    const catalog = (await app.inject({
      method: "GET", url: "/api/permissions", headers: { cookie: ownerCookie }
    })).json();
    type Entry = { key: string; label: string; hint?: string; enforced: boolean };
    type Group = { id: string; label: string; masterKey: string | null; permissions: Entry[] };
    const groups: Group[] = catalog.groups;
    const entries = groups.flatMap((group) => group.permissions);

    // A master is a real permission, and it is a listed row of exactly one group - being another
    // group's master is not membership, which is what lets `dashboard.view` head the Access
    // Control sheet's Dashboard group while living in the Permissions sheet's.
    for (const group of groups) {
      if (group.masterKey === null) continue;
      expect(entries.some((entry) => entry.key === group.masterKey), group.id).toBe(true);
    }
    expect(groups.find((group) => group.id === "setting")?.masterKey).toBe("settings.manage");
    expect(groups.find((group) => group.id === "dashboard-access")?.masterKey).toBe("dashboard.view");
    expect(groups.find((group) => group.id === "report-access")?.masterKey).toBe("reports.view");

    // EVERY KEY OF THE NEW TAXONOMY IS PUBLISHED AS UNENFORCED. The catalog is what tells an owner
    // whether a switch does anything, so one arriving as `enforced: true` while no route consults
    // it would be the editor claiming a restriction that is not there.
    for (const key of ["payments.edit", "customers.contact_info", "messages.view",
      "settings.business", "pets.breeds_edit", "dashboard.all_staff", "gift_cards.sell"]) {
      expect(entries.find((entry) => entry.key === key), key)
        .toMatchObject({ enforced: false });
    }
    // And the ones that do gate something still say so.
    expect(entries.find((entry) => entry.key === "settings.manage")).toMatchObject({ enforced: true });
    expect(entries.find((entry) => entry.key === "customers.view")).toMatchObject({ enforced: true });

    // The hint is the sentence the editor renders under the row and searches on. It is optional,
    // and where it is present it must not be blank - an empty string would render an empty line
    // under the badge and match every filter term.
    for (const entry of entries) {
      if (entry.hint === undefined) continue;
      expect(entry.hint.trim().length, entry.key).toBeGreaterThan(0);
    }
    expect(entries.find((entry) => entry.key === "customers.archive")?.hint)
      .toContain("rather than erasing");
  });

  /**
   * BUILT-IN ROLES ARE PAWSH TEMPLATES, NOT SALON PROPERTY.
   *
   * Their name is their identity, so they cannot be renamed and cannot be deleted. Retiring one is
   * expressed by DISABLING it, which grants nothing while off, keeps the assignments, and restores
   * exactly the same access under the same id when it is switched back on.
   */
  it("refuses to rename or delete a built-in role, and disables and restores it instead", async () => {
    const fresh = await signUp("built-in-authority");
    const seeded = (await rolesOf(fresh.cookie)).find((role) => role.name === "Manager")!;
    const editBuiltIn = async (payload: Record<string, unknown>) => await app.inject({
      method: "PATCH", url: `/api/roles/${seeded.id}`, headers: { cookie: fresh.cookie }, payload
    });

    const renamed = await editBuiltIn({ version: seeded.version, name: `Shift lead ${suffix}` });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json().code).toBe("ROLE_BUILT_IN_NAME_IMMUTABLE");

    const removed = await app.inject({
      method: "DELETE", url: `/api/roles/${seeded.id}`, headers: { cookie: fresh.cookie }
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.json().code).toBe("ROLE_BUILT_IN_UNDELETABLE");

    // Neither refusal touched anything, not even the concurrency token.
    expect((await rolesOf(fresh.cookie)).find((role) => role.id === seeded.id))
      .toMatchObject({ name: "Manager", builtIn: true, enabled: true, version: seeded.version });

    // Carrying the name it already has is a save, not a rename, so an editor that PATCHes the
    // whole role back is not refused for repeating what it was given.
    const described = await editBuiltIn({
      version: seeded.version, name: "Manager", description: "Runs the floor."
    });
    expect(described.statusCode, described.body).toBe(200);
    expect(described.json().description).toBe("Runs the floor.");

    const off = await editBuiltIn({ version: described.json().version, enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ id: seeded.id, name: "Manager", builtIn: true, enabled: false });

    const on = await editBuiltIn({ version: off.json().version, enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    // Canonical identity survives the round trip: same row, same name, same grants.
    expect(on.json()).toMatchObject({ id: seeded.id, name: "Manager", builtIn: true, enabled: true });
    expect([...on.json().permissions].sort()).toEqual([...seeded.permissions].sort());
  });

  it("hides a built-in role from every other business", async () => {
    const owner = await signUp("built-in-owner");
    const rival = await signUp("built-in-rival");
    const target = (await rolesOf(owner.cookie)).find((role) => role.name === "Receptionist")!;

    // The rival is a genuine owner of their own workspace, so `isOwner` passes and the tenant
    // predicate is the only thing standing between them and somebody else's role.
    expect((await app.inject({
      method: "PATCH", url: `/api/roles/${target.id}`, headers: { cookie: rival.cookie },
      payload: { version: target.version, enabled: false }
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "DELETE", url: `/api/roles/${target.id}`, headers: { cookie: rival.cookie }
    })).statusCode).toBe(404);
    expect((await rolesOf(owner.cookie)).find((role) => role.id === target.id))
      .toMatchObject({ enabled: true, name: "Receptionist" });
  });

  it("refuses every roles route to a member without team.manage", async () => {
    const plainEmail = `roles-api-plain-${suffix}@example.test`;
    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email: plainEmail, roleId: await createRole(app, ownerCookie, `Bootstrap plain ${suffix}`, ["calendar.view"]) }
    });
    const token = new URL(invitation.json().acceptancePath, "http://localhost").searchParams.get("invite");
    const plainCookie = cookie(await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: "correct horse roles plain" }
    }));
    expect((await list(plainCookie)).statusCode).toBe(403);
    expect((await create({ name: `Plain ${suffix}` }, plainCookie)).statusCode).toBe(403);
  });
});
