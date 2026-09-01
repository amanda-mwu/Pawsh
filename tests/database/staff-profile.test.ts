import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { groomerPaletteSize } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "staff-profile-secret-at-least-thirty-two-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};
function cookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
}

/**
 * The rebuilt Settings -> Staff screen's backend: the linked workspace account, the assignable
 * colour slot, the staff phone, the service restriction that finally means something, and the
 * read-path split that keeps contact data off an `authenticate`-only response.
 */
describeDatabase("staff profile, account linking and service restrictions", () => {
  let db: Database; let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string; let groomerCookie: string;
  let businessId: string; let locationId: string;
  let ownerMembershipId: string; let groomerMembershipId: string;
  let customerId: string; let petId: string;
  let bathId: string; let nailsId: string;
  let linkedId: string; let unlinkedId: string;
  const suffix = crypto.randomUUID();
  const ownerEmail = `staff-profile-owner-${suffix}@example.test`;
  const groomerEmail = `staff-profile-groomer-${suffix}@example.test`;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: ownerEmail, password: "correct horse profile battery",
        businessName: "Staff Profile Salon", timezone: "America/Los_Angeles"
      }
    });
    expect(signup.statusCode).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());
    ownerMembershipId = (await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ownerCookie } }))
      .json().membershipId;

    // A session that can see the calendar and emphatically cannot manage the team.
    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations",
      headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
      payload: {
        email: groomerEmail,
        permissions: ["calendar.view", "appointments.view", "pets.view", "pets.edit", "pets.care.edit", "operations.perform_service"]
      }
    });
    const token = new URL(invitation.json().acceptancePath, "http://localhost").searchParams.get("invite");
    const accepted = await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: "correct horse groomer battery" }
    });
    groomerCookie = cookie(accepted);
    groomerMembershipId = (await app.inject({ method: "GET", url: "/api/me", headers: { cookie: groomerCookie } }))
      .json().membershipId;

    const service = async (name: string): Promise<string> => (await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name, baseDurationMinutes: 60, basePriceMinor: 6000 }
    })).json().id;
    bathId = await service("Profile Bath");
    nailsId = await service("Profile Nails");

    customerId = (await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName: "Robin", lastName: "Guardian", email: `client-${suffix}@example.test` }
    })).json().id;
    petId = (await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Juniper", species: "dog" }
    })).json().id;

    // Both created with no service rows: the state every existing workspace is in, and the state
    // that has to keep behaving exactly as it does today.
    linkedId = (await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: "Linked Groomer", membershipId: groomerMembershipId, phone: "(555) 010-2233" }
    })).json().id;
    unlinkedId = (await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: "Unlinked Groomer" }
    })).json().id;
  });
  afterAll(async () => { await app.close(); await db.end(); });

  const roster = async (sessionCookie: string): Promise<Record<string, unknown>[]> =>
    (await app.inject({ method: "GET", url: "/api/employees", headers: { cookie: sessionCookie } })).json();
  const find = (rows: Record<string, unknown>[], id: string): Record<string, unknown> => {
    const row = rows.find((employee) => employee.id === id);
    if (!row) throw new Error("Employee missing from roster");
    return row;
  };
  const phoneOf = async (employeeId: string): Promise<{ phone: string | null; normalizedPhone: string | null }> => {
    const [row] = await db<{ phone: string | null; normalizedPhone: string | null }[]>`
      select phone,normalized_phone from employees where business_id=${businessId} and id=${employeeId}
    `;
    return row!;
  };

  describe("the staff phone", () => {
    it("is stored the way every other phone in this schema is stored", async () => {
      expect(await phoneOf(linkedId)).toEqual({ phone: "(555) 010-2233", normalizedPhone: "5550102233" });
    });

    it("is left alone by an unrelated edit and cleared only on an explicit blank", async () => {
      await app.inject({
        method: "PUT", url: `/api/employees/${unlinkedId}`, headers: { cookie: ownerCookie },
        payload: { phone: "555.777.1000" }
      });
      expect(await phoneOf(unlinkedId)).toEqual({ phone: "555.777.1000", normalizedPhone: "5557771000" });
      await app.inject({
        method: "PUT", url: `/api/employees/${unlinkedId}`, headers: { cookie: ownerCookie },
        payload: { displayName: "Unlinked Groomer" }
      });
      expect(await phoneOf(unlinkedId)).toEqual({ phone: "555.777.1000", normalizedPhone: "5557771000" });
      await app.inject({
        method: "PUT", url: `/api/employees/${unlinkedId}`, headers: { cookie: ownerCookie },
        payload: { phone: "" }
      });
      expect(await phoneOf(unlinkedId)).toEqual({ phone: null, normalizedPhone: null });
    });
  });

  describe("the linked account", () => {
    it("names the claiming employee on every membership so the picker can exclude it", async () => {
      const members = (await app.inject({
        method: "GET", url: "/api/members", headers: { cookie: ownerCookie }
      })).json() as {
        id: string; email: string; isOwner: boolean;
        employeeId: string | null; employeeDisplayName: string | null;
      }[];
      const owner = members.find((member) => member.id === ownerMembershipId)!;
      const groomer = members.find((member) => member.id === groomerMembershipId)!;
      expect(owner).toMatchObject({ email: ownerEmail, isOwner: true, employeeId: null });
      expect(groomer).toMatchObject({
        email: groomerEmail, isOwner: false,
        employeeId: linkedId, employeeDisplayName: "Linked Groomer"
      });
    });

    it("refuses an account another team member already holds", async () => {
      const taken = await app.inject({
        method: "PUT", url: `/api/employees/${unlinkedId}`, headers: { cookie: ownerCookie },
        payload: { membershipId: groomerMembershipId }
      });
      expect(taken.statusCode).toBe(409);
      expect(taken.json()).toMatchObject({ code: "MEMBERSHIP_ALREADY_LINKED", employeeId: linkedId });
      const [row] = await db<{ membershipId: string | null }[]>`
        select membership_id from employees where business_id=${businessId} and id=${unlinkedId}
      `;
      expect(row?.membershipId).toBeNull();
    });

    it("lets an employee re-save the account it already holds", async () => {
      const same = await app.inject({
        method: "PUT", url: `/api/employees/${linkedId}`, headers: { cookie: ownerCookie },
        payload: { membershipId: groomerMembershipId }
      });
      expect(same.statusCode).toBe(200);
    });

    /**
     * `employees_membership_id_fkey` references `business_memberships(id)` alone, not
     * `(business_id, id)`, and referential integrity checks are not subject to row-level
     * security, so nothing in the schema refuses this. The route has to.
     */
    it("refuses a membership belonging to another workspace", async () => {
      const otherSignup = await app.inject({
        method: "POST", url: "/api/auth/signup",
        payload: {
          email: `other-salon-${suffix}@example.test`,
          password: "correct horse other battery", businessName: "Other Salon"
        }
      });
      const otherMembershipId = (await app.inject({
        method: "GET", url: "/api/me", headers: { cookie: cookie(otherSignup) }
      })).json().membershipId;
      const foreign = await app.inject({
        method: "PUT", url: `/api/employees/${unlinkedId}`, headers: { cookie: ownerCookie },
        payload: { membershipId: otherMembershipId }
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toMatchObject({ code: "MEMBERSHIP_NOT_LINKABLE" });
    });

    it("resolves which groomer a session is, and resolves nothing for an unlinked one", async () => {
      // The lookup the mobile app's `resolveMyEmployeeId` performs, run against the real roster
      // payload a groomer session receives.
      const mine = (employees: Record<string, unknown>[], membershipId: string | null): string | null => {
        if (!membershipId) return null;
        const match = employees.find((employee) => employee.membershipId === membershipId);
        return (match?.id as string | undefined) ?? null;
      };
      const asGroomer = await roster(groomerCookie);
      expect(mine(asGroomer, groomerMembershipId)).toBe(linkedId);
      expect(mine(asGroomer, ownerMembershipId)).toBeNull();
      expect(find(asGroomer, unlinkedId).membershipId).toBeNull();
    });
  });

  describe("attribution", () => {
    it("survives a rename, because the join is the membership and not the name", async () => {
      // `GET /api/pets` resolves the rabies verifier through membership -> employee, falling back
      // to the account's own email when that join finds nothing. The verifier is the membership of
      // whoever recorded the verification, so this pet is recorded by the groomer session.
      const verified = await app.inject({
        method: "POST", url: "/api/pets", headers: { cookie: groomerCookie },
        payload: {
          customerId, name: "Sorrel", species: "dog",
          vaccinationExpiresOn: "2033-01-15",
          rabiesVerificationStatus: "staff_verified",
          rabiesVerificationMethod: "document_review"
        }
      });
      expect(verified.statusCode).toBe(201);
      const verifiedPetId = verified.json().id;

      const appointment = await app.inject({
        method: "POST", url: "/api/appointments",
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: {
          locationId, customerId, petId, employeeId: linkedId,
          localStart: "2033-01-10T10:00", expectedLocationVersion: 1, serviceIds: [bathId]
        }
      });
      expect(appointment.statusCode).toBe(201);
      const appointmentId = appointment.json().id;
      // A report card's `authorName` resolves through the same membership -> employee join.
      const card = await app.inject({
        method: "POST", url: `/api/appointments/${appointmentId}/report-cards`,
        headers: { cookie: groomerCookie },
        payload: { petId, note: "Juniper did beautifully." }
      });
      expect(card.statusCode).toBe(201);

      const verifierName = async (): Promise<string | null> => {
        const pets = (await app.inject({
          method: "GET", url: "/api/pets", headers: { cookie: ownerCookie }
        })).json() as { id: string; rabiesVerifiedByName: string | null }[];
        return pets.find((row) => row.id === verifiedPetId)?.rabiesVerifiedByName ?? null;
      };
      const authorName = async (): Promise<string | null> => {
        const cards = (await app.inject({
          method: "GET", url: `/api/appointments/${appointmentId}/report-cards`,
          headers: { cookie: ownerCookie }
        })).json() as { items: { lastEditedBy: string | null }[] };
        return cards.items[0]?.lastEditedBy ?? null;
      };

      expect(await verifierName()).toBe("Linked Groomer");
      expect(await authorName()).toBe("Linked Groomer");

      const renamed = await app.inject({
        method: "PUT", url: `/api/employees/${linkedId}`, headers: { cookie: ownerCookie },
        payload: { displayName: "Renamed Linked Groomer" }
      });
      expect(renamed.statusCode).toBe(200);

      // The new name follows the person into work they already did, which only happens because
      // the link that carries it survived the rename.
      expect(await verifierName()).toBe("Renamed Linked Groomer");
      expect(await authorName()).toBe("Renamed Linked Groomer");
      expect(find(await roster(ownerCookie), linkedId).membershipId).toBe(groomerMembershipId);
    });
  });

  describe("the colour slot", () => {
    it("leaves an unassigned employee null, which is what keeps the hash in charge", async () => {
      expect(find(await roster(ownerCookie), unlinkedId).colorSlot).toBeNull();
    });

    it("round-trips an assignment, survives an unrelated edit, and takes null back", async () => {
      const assigned = await app.inject({
        method: "PUT", url: `/api/employees/${unlinkedId}`, headers: { cookie: ownerCookie },
        payload: { colorSlot: 3 }
      });
      expect(assigned.statusCode).toBe(200);
      expect(assigned.json().colorSlot).toBe(3);
      expect(find(await roster(ownerCookie), unlinkedId).colorSlot).toBe(3);
      await app.inject({
        method: "PUT", url: `/api/employees/${unlinkedId}`, headers: { cookie: ownerCookie },
        payload: { displayName: "Unlinked Groomer" }
      });
      expect(find(await roster(ownerCookie), unlinkedId).colorSlot).toBe(3);
      const cleared = await app.inject({
        method: "PUT", url: `/api/employees/${unlinkedId}`, headers: { cookie: ownerCookie },
        payload: { colorSlot: null }
      });
      expect(cleared.statusCode).toBe(200);
      expect(find(await roster(ownerCookie), unlinkedId).colorSlot).toBeNull();
    });

    /**
     * The database check is the durable outer bound; the palette's real size is
     * `groomerPaletteSize` and it is enforced here, so adding a colour is a change in
     * `packages/domain` and never a migration.
     */
    it("refuses a slot the palette does not have", async () => {
      for (const colorSlot of [groomerPaletteSize, -1, 1.5]) {
        const refused = await app.inject({
          method: "PUT", url: `/api/employees/${unlinkedId}`, headers: { cookie: ownerCookie },
          payload: { colorSlot }
        });
        expect(refused.statusCode).toBe(400);
      }
    });
  });

  describe("the read-path split", () => {
    it("gives a manager the account and contact detail", async () => {
      expect(find(await roster(ownerCookie), linkedId)).toMatchObject({
        phone: "(555) 010-2233", accountEmail: groomerEmail,
        accountIsOwner: false, accountStatus: "active"
      });
    });

    it("gives a session without team.manage the roster and nothing else", async () => {
      const rows = await roster(groomerCookie);
      // Present, because a calendar cannot be drawn without them and "which groomer am I" cannot
      // be answered without the membership.
      expect(Object.keys(find(rows, linkedId)).sort()).toEqual([
        "active", "businessId", "colorSlot", "createdAt", "displayName",
        "id", "membershipId", "serviceIds", "updatedAt"
      ]);
      // Absent, because a staff phone number and the email of the account behind a login are not
      // calendar data.
      expect(JSON.stringify(rows)).not.toContain("(555) 010-2233");
      expect(JSON.stringify(rows)).not.toContain(groomerEmail);
    });

    it("refuses every staff write from a session without team.manage", async () => {
      const created = await app.inject({
        method: "POST", url: "/api/employees", headers: { cookie: groomerCookie },
        payload: { displayName: "Should Not Exist" }
      });
      expect(created.statusCode).toBe(403);
      for (const payload of [
        { displayName: "Renamed By A Groomer" }, { phone: "555-000-0000" },
        { colorSlot: 1 }, { membershipId: null }, { serviceIds: [] }
      ]) {
        const write = await app.inject({
          method: "PUT", url: `/api/employees/${linkedId}`, headers: { cookie: groomerCookie }, payload
        });
        expect(write.statusCode).toBe(403);
      }
      const removed = await app.inject({
        method: "DELETE", url: `/api/employees/${linkedId}`, headers: { cookie: groomerCookie }
      });
      expect(removed.statusCode).toBe(403);
      const [row] = await db<{ displayName: string; phone: string | null; active: boolean }[]>`
        select display_name,phone,active from employees where business_id=${businessId} and id=${linkedId}
      `;
      expect(row).toMatchObject({
        displayName: "Renamed Linked Groomer", phone: "(555) 010-2233", active: true
      });
    });
  });

  /**
   * `DELETE` soft-deactivates and `PUT` can now bring someone back, so the Staff screen's Active
   * switch moves both ways. DELETE is deliberately unchanged, so deactivation has two paths and
   * reactivation has one.
   */
  describe("reactivation", () => {
    let restingId: string;

    const activeOf = async (employeeId: string): Promise<boolean> => {
      const [row] = await db<{ active: boolean }[]>`
        select active from employees where business_id=${businessId} and id=${employeeId}
      `;
      return row!.active;
    };

    beforeAll(async () => {
      restingId = (await app.inject({
        method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
        payload: { displayName: "Resting Groomer" }
      })).json().id;
    });

    it("brings a deactivated employee back and returns them to the roster", async () => {
      expect((await app.inject({
        method: "DELETE", url: `/api/employees/${restingId}`, headers: { cookie: ownerCookie }
      })).statusCode).toBe(204);
      expect(await activeOf(restingId)).toBe(false);
      expect(find(await roster(ownerCookie), restingId).active).toBe(false);

      const revived = await app.inject({
        method: "PUT", url: `/api/employees/${restingId}`, headers: { cookie: ownerCookie },
        payload: { active: true }
      });
      expect(revived.statusCode).toBe(200);
      expect(revived.json().active).toBe(true);
      expect(find(await roster(ownerCookie), restingId).active).toBe(true);
    });

    it("deactivates through PUT as well, without disturbing anything else", async () => {
      await app.inject({
        method: "PUT", url: `/api/employees/${restingId}`, headers: { cookie: ownerCookie },
        payload: { phone: "555-321-0000", colorSlot: 2 }
      });
      const off = await app.inject({
        method: "PUT", url: `/api/employees/${restingId}`, headers: { cookie: ownerCookie },
        payload: { active: false }
      });
      expect(off.statusCode).toBe(200);
      expect(off.json()).toMatchObject({ active: false, phone: "555-321-0000", colorSlot: 2 });
      // An unrelated edit must not silently reactivate anyone.
      const renamed = await app.inject({
        method: "PUT", url: `/api/employees/${restingId}`, headers: { cookie: ownerCookie },
        payload: { displayName: "Resting Groomer" }
      });
      expect(renamed.json().active).toBe(false);
      await app.inject({
        method: "PUT", url: `/api/employees/${restingId}`, headers: { cookie: ownerCookie },
        payload: { active: true }
      });
    });

    it("records the activation change", async () => {
      const [audit] = await db<{ count: number }[]>`
        select count(*)::int from audit_events
        where business_id=${businessId} and resource_id=${restingId}
          and action in ('employee.reactivate','employee.deactivate')
      `;
      expect(audit!.count).toBeGreaterThanOrEqual(2);
    });

    /**
     * The reachable stale-link path: link an account, deactivate the employee, revoke the
     * account's workspace access, then try to bring the employee back. Without the guard this
     * produces an active employee holding a disabled membership, which is precisely the row
     * `assertMembershipLinkable` refuses to create, and the membership would silently resume
     * collecting attribution while its unique index blocked anyone else from being linked.
     */
    it("refuses to reactivate an employee whose linked account was revoked", async () => {
      const memberEmail = `revoked-${suffix}@example.test`;
      const invitation = await app.inject({
        method: "POST", url: "/api/members/invitations",
        headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
        payload: { email: memberEmail, permissions: ["calendar.view"] }
      });
      const token = new URL(invitation.json().acceptancePath, "http://localhost").searchParams.get("invite");
      const accepted = await app.inject({
        method: "POST", url: "/api/auth/invitations/accept",
        payload: { token, password: "correct horse revoked battery" }
      });
      const revokedMembershipId = (await app.inject({
        method: "GET", url: "/api/me", headers: { cookie: cookie(accepted) }
      })).json().membershipId;

      const employeeId = (await app.inject({
        method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
        payload: { displayName: "Departed Groomer", membershipId: revokedMembershipId }
      })).json().id;
      expect((await app.inject({
        method: "DELETE", url: `/api/employees/${employeeId}`, headers: { cookie: ownerCookie }
      })).statusCode).toBe(204);
      expect((await app.inject({
        method: "DELETE", url: `/api/members/${revokedMembershipId}`, headers: { cookie: ownerCookie }
      })).statusCode).toBe(204);

      const refused = await app.inject({
        method: "PUT", url: `/api/employees/${employeeId}`, headers: { cookie: ownerCookie },
        payload: { active: true }
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        code: "EMPLOYEE_ACCOUNT_INACTIVE",
        membershipId: revokedMembershipId, accountEmail: memberEmail, accountStatus: "disabled"
      });
      expect(await activeOf(employeeId)).toBe(false);

      // Unlinking is the remedy the error names, and it has to work in ONE request or the switch
      // is still a toggle the operator cannot resolve.
      const unlinkedAndBack = await app.inject({
        method: "PUT", url: `/api/employees/${employeeId}`, headers: { cookie: ownerCookie },
        payload: { active: true, membershipId: null }
      });
      expect(unlinkedAndBack.statusCode).toBe(200);
      expect(unlinkedAndBack.json()).toMatchObject({ active: true, membershipId: null });
    });

    it("reactivates freely when the linked account is still good", async () => {
      expect((await app.inject({
        method: "DELETE", url: `/api/employees/${linkedId}`, headers: { cookie: ownerCookie }
      })).statusCode).toBe(204);
      const revived = await app.inject({
        method: "PUT", url: `/api/employees/${linkedId}`, headers: { cookie: ownerCookie },
        payload: { active: true }
      });
      expect(revived.statusCode).toBe(200);
      expect(revived.json()).toMatchObject({ active: true, membershipId: groomerMembershipId });
    });

    it("refuses an activation change from a session without team.manage", async () => {
      const write = await app.inject({
        method: "PUT", url: `/api/employees/${restingId}`, headers: { cookie: groomerCookie },
        payload: { active: false }
      });
      expect(write.statusCode).toBe(403);
      expect(await activeOf(restingId)).toBe(true);
    });

    it("answers 404 for an employee that does not exist, ahead of any account guard", async () => {
      const missing = await app.inject({
        method: "PUT", url: `/api/employees/${crypto.randomUUID()}`, headers: { cookie: ownerCookie },
        payload: { active: true, membershipId: ownerMembershipId }
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe("the service restriction", () => {
    let restrictedId: string;

    beforeAll(async () => {
      restrictedId = (await app.inject({
        method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
        payload: { displayName: "Bath Only Groomer", serviceIds: [bathId] }
      })).json().id;
    });

    const book = (employeeId: string, serviceIds: string[], localStart: string) => app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { locationId, customerId, petId, employeeId, localStart, expectedLocationVersion: 1, serviceIds }
    });

    it("keeps a groomer with no service rows assignable to everything", async () => {
      const anything = await book(unlinkedId, [bathId, nailsId], "2033-02-01T09:00");
      expect(anything.statusCode).toBe(201);
    });

    it("refuses a service a restricted groomer does not offer, with a code a picker can use", async () => {
      const refused = await book(restrictedId, [bathId, nailsId], "2033-02-02T09:00");
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        code: "EMPLOYEE_SERVICE_NOT_OFFERED",
        employeeId: restrictedId, employeeName: "Bath Only Groomer",
        unsupportedServiceIds: [nailsId], unsupportedServiceNames: ["Profile Nails"]
      });
      const [booked] = await db<{ count: number }[]>`
        select count(*)::int from appointments
        where business_id=${businessId} and employee_id=${restrictedId}
      `;
      expect(booked?.count).toBe(0);
    });

    it("allows the services a restricted groomer does offer", async () => {
      const allowed = await book(restrictedId, [bathId], "2033-02-03T09:00");
      expect(allowed.statusCode).toBe(201);
    });

    it("refuses moving an appointment onto a service its groomer does not offer", async () => {
      const appointmentId = (await book(restrictedId, [bathId], "2033-02-04T09:00")).json().id;
      const [current] = await db<{ version: number }[]>`
        select version from appointments where id=${appointmentId}
      `;
      const changed = await app.inject({
        method: "PUT", url: `/api/appointments/${appointmentId}/services`,
        headers: { cookie: ownerCookie },
        payload: { serviceIds: [nailsId], version: current!.version }
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ code: "EMPLOYEE_SERVICE_NOT_OFFERED" });
    });

    /**
     * A restriction written after a booking must not strand the appointment it was not written
     * for. Moving an appointment in time keeps the assignment it already had; reassigning it to
     * someone else does not, and that is a new assignment like any other.
     */
    it("still moves an existing appointment in time once a restriction would exclude it", async () => {
      const appointmentId = (await book(unlinkedId, [bathId, nailsId], "2033-03-01T09:00")).json().id;
      await app.inject({
        method: "PUT", url: `/api/employees/${unlinkedId}`, headers: { cookie: ownerCookie },
        payload: { serviceIds: [bathId] }
      });
      const [current] = await db<{ version: number }[]>`
        select version from appointments where id=${appointmentId}
      `;
      const moved = await app.inject({
        method: "PATCH", url: `/api/appointments/${appointmentId}/schedule`,
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: {
          employeeId: unlinkedId, localStart: "2033-03-02T09:00",
          expectedLocationVersion: 1, version: current!.version
        }
      });
      expect(moved.statusCode).toBe(200);

      const [afterMove] = await db<{ version: number }[]>`
        select version from appointments where id=${appointmentId}
      `;
      const reassigned = await app.inject({
        method: "PATCH", url: `/api/appointments/${appointmentId}/schedule`,
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: {
          employeeId: restrictedId, localStart: "2033-03-03T09:00",
          expectedLocationVersion: 1, version: afterMove!.version
        }
      });
      expect(reassigned.statusCode).toBe(409);
      expect(reassigned.json()).toMatchObject({ code: "EMPLOYEE_SERVICE_NOT_OFFERED" });

      await app.inject({
        method: "PUT", url: `/api/employees/${unlinkedId}`, headers: { cookie: ownerCookie },
        payload: { serviceIds: [] }
      });
    });
  });
});
