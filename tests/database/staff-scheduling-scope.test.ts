import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissionPresets } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { roleFor } from "../support/roles.js";

/**
 * WHOSE APPOINTMENT IS IT, AND WHOSE CALENDAR.
 *
 * `appointments.edit_all_staff` enforces from this change on. The three keys it scopes -
 * `appointments.edit`, `calendar.blocks_create`, `calendar.blocks_edit` - and the three
 * `operations.*` keys now mean "on appointments and blocked time assigned to ME", where "me" is
 * the `employees` row whose `membership_id` is the session's membership, resolved by the server
 * on every write and never taken from the request. The all-staff key, and ownership, mean "on
 * anybody's".
 *
 * The file states that contract from the outside, through the routes, with real sessions:
 *
 *   - a groomer linked to their employee record may edit, re-service, annotate, transition and
 *     move their own appointment, and is refused a colleague's on every one of those routes with
 *     one code, `NOT_ASSIGNED_TO_YOU`, naming the key that would change the answer;
 *   - moving their own appointment onto a colleague is a reassignment and is refused the same
 *     way, because the scoped key never grants somebody else's calendar;
 *   - the same for blocked time, on create, edit, move and delete;
 *   - a member holding the scoped keys with NO employee record owns nothing and is refused
 *     everything, which is what step 1 of migration 0057 exists to make unreachable for any role
 *     that already existed;
 *   - the Receptionist preset, which gained the all-staff key, reaches every appointment and
 *     every block exactly as it did before, and gained nothing else;
 *   - the owner bypasses, as an owner bypasses every permission.
 *
 * It also pins the three things that shipped alongside: `GET /api/me` naming the caller's own
 * employee, the service note's window including `completed`, the appointment-scoped client read
 * with its financial withholding, and reschedule lineage recorded through the audit trail.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "staff-scheduling-scope-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

interface ScopeRefusal { code: string; error: string }

describeDatabase("staff scheduling scope", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();

  let ownerCookie = "";
  let businessId = "";
  let locationId = "";
  let serviceId = "";
  let secondServiceId = "";
  let customerId = "";
  let petId = "";

  let employeeA = "";
  let employeeB = "";
  let groomerA = "";
  let groomerB = "";
  let receptionist = "";
  /** Holds every scoped key and the operations keys, and NO employee record. */
  let unlinkedEditor = "";

  let rivalCookie = "";
  let rivalAppointmentId = "";

  const key = () => crypto.randomUUID();
  // One booking per LOCAL DAY per groomer rather than per hour, so no two cases can collide on
  // `employee_appointment_no_overlap`, and no booking runs into local midnight.
  let bookingDay = 0;
  const nextDay = () => {
    bookingDay += 1;
    const month = bookingDay > 28 ? "09" : "08";
    const day = bookingDay > 28 ? bookingDay - 28 : bookingDay;
    return `2035-${month}-${String(day).padStart(2, "0")}`;
  };

  /** Seats a member holding exactly `permissions`, and returns its cookie and membership id. */
  async function seat(label: string, permissions: readonly string[]) {
    const email = `scope-${label}-${suffix}@example.test`;
    const password = `correct horse ${label} battery`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash,display_name)
      values (${email},${email},${await hashPassword(password)},${label}) returning id
    `;
    const [membership] = await db<{ id: string }[]>`
      insert into business_memberships(business_id,user_id,role_id)
      values (${businessId},${user!.id},${await roleFor(db, businessId, permissions)})
      returning id
    `;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    expect(login.statusCode, login.body).toBe(200);
    return { cookie: cookie(login), membershipId: membership!.id };
  }

  /** A groomer the owner creates through the real route, linked to the given membership. */
  async function employeeFor(displayName: string, membershipId: string | null): Promise<string> {
    const response = await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName, serviceIds: [serviceId, secondServiceId], ...(membershipId ? { membershipId } : {}) }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  /** A real booking through the create route, for one groomer, on its own day. */
  async function book(employeeId: string, sessionCookie = ownerCookie, extra: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: sessionCookie, "idempotency-key": key() },
      payload: {
        locationId, customerId, petId, employeeId, serviceIds: [serviceId],
        localStart: `${nextDay()}T09:00`, expectedLocationVersion: 1, ...extra
      }
    });
    return response;
  }

  async function booked(employeeId: string, sessionCookie = ownerCookie) {
    const response = await book(employeeId, sessionCookie);
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; version: number; scheduledLocalStart: string };
  }

  const stored = async (id: string) => {
    const [row] = await db<{
      status: string; version: number; employeeId: string; startAt: Date;
      notes: string | null; operationalNotes: string | null; updatedAt: Date;
    }[]>`
      select status,version,employee_id,start_at,notes,operational_notes,updated_at
      from appointments where business_id=${businessId} and id=${id}
    `;
    return row!;
  };

  const request = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string,
    sessionCookie: string, payload?: Record<string, unknown>) =>
    app.inject({
      method, url, headers: { cookie: sessionCookie, "idempotency-key": key() },
      ...(payload ? { payload } : {})
    });

  const move = (id: string, sessionCookie: string, employeeId: string, localStart: string, version: number) =>
    request("PATCH", `/api/appointments/${id}/schedule`, sessionCookie,
      { employeeId, localStart, version, expectedLocationVersion: 1 });

  const transition = (id: string, sessionCookie: string, status: string) =>
    request("POST", `/api/appointments/${id}/transition`, sessionCookie, { status });

  /** Every appointment mutation the scope rule guards, against one appointment, from one session. */
  async function everyMutation(id: string, sessionCookie: string) {
    const { version } = await stored(id);
    const local = (await stored(id)).startAt;
    // A time-only move keeps the groomer, so the refusal (if any) is about the appointment and not
    // about a reassignment.
    const { employeeId } = await stored(id);
    const startLocal = `${local.toISOString().slice(0, 10)}T10:00`;
    return {
      notes: await request("PATCH", `/api/appointments/${id}`, sessionCookie, { notes: "edited", version }),
      times: await request("PATCH", `/api/appointments/${id}/times`, sessionCookie,
        { checkedInAt: null, checkedOutAt: null }),
      services: await request("PUT", `/api/appointments/${id}/services`, sessionCookie,
        { serviceIds: [serviceId, secondServiceId] }),
      operations: await request("PATCH", `/api/appointments/${id}/operations`, sessionCookie,
        { operationalNotes: "note" }),
      transition: await transition(id, sessionCookie, "checked_in"),
      schedule: await move(id, sessionCookie, employeeId, startLocal, (await stored(id)).version)
    };
  }

  const expectScopeRefusal = (response: { statusCode: number; body: string; json: () => unknown }, label: string) => {
    expect(response.statusCode, `${label}: ${response.body}`).toBe(403);
    const refusal = response.json() as ScopeRefusal;
    expect(refusal.code, label).toBe("NOT_ASSIGNED_TO_YOU");
    expect(refusal.error, label).toContain("appointments.edit_all_staff");
  };

  const blockPayload = (employeeId: string, day: string, extra: Record<string, unknown> = {}) => ({
    employeeId, locationId, localStart: `${day}T12:00`, localEnd: `${day}T12:30`,
    expectedLocationVersion: 1, reason: "Lunch", ...extra
  });

  const createBlock = (employeeId: string, sessionCookie: string, day = nextDay()) =>
    request("POST", "/api/blocked-times", sessionCookie, blockPayload(employeeId, day));

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `scope-owner-${suffix}@example.test`,
        password: "correct horse scope battery", businessName: "Scope Salon"
      }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());

    const service = async (name: string) => {
      const response = await app.inject({
        method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
        payload: { name, baseDurationMinutes: 60, basePriceMinor: 7000 }
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().id as string;
    };
    serviceId = await service("Scope Groom");
    secondServiceId = await service("Scope Bath");

    const customer = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName: "Scope", lastName: "Client", phone: "555-0180" }
    });
    expect(customer.statusCode, customer.body).toBe(201);
    customerId = customer.json().id;
    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Scope Pet", species: "dog", breed: "Poodle" }
    });
    expect(pet.statusCode, pet.body).toBe(201);
    petId = pet.json().id;

    // Two groomers, each a member on the Groomer preset AND an employee linked to that membership.
    const groomerSeatA = await seat("groomer-a", permissionPresets.groomer!);
    const groomerSeatB = await seat("groomer-b", permissionPresets.groomer!);
    groomerA = groomerSeatA.cookie;
    groomerB = groomerSeatB.cookie;
    employeeA = await employeeFor("Groomer A", groomerSeatA.membershipId);
    employeeB = await employeeFor("Groomer B", groomerSeatB.membershipId);

    receptionist = (await seat("receptionist", permissionPresets.receptionist!)).cookie;
    unlinkedEditor = (await seat("unlinked", [
      "calendar.view", "appointments.view", "appointments.edit",
      "operations.check_in", "operations.perform_service", "operations.complete",
      "calendar.blocks_create", "calendar.blocks_edit"
    ])).cookie;

    const rival = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `scope-rival-${suffix}@example.test`,
        password: "correct horse rival battery", businessName: "Rival Scope Salon"
      }
    });
    expect(rival.statusCode, rival.body).toBe(201);
    rivalCookie = cookie(rival);
    const rivalPost = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: rivalCookie, "idempotency-key": key() }, payload });
    const rivalService = (await rivalPost("/api/services", {
      name: "Rival Groom", baseDurationMinutes: 60, basePriceMinor: 7000
    })).json().id;
    const rivalEmployee = (await rivalPost("/api/employees", {
      displayName: "Rival Groomer", serviceIds: [rivalService]
    })).json().id;
    const rivalCustomer = (await rivalPost("/api/customers", {
      firstName: "Rival", lastName: "Client", phone: "555-0181"
    })).json().id;
    const rivalPet = (await rivalPost("/api/pets", {
      customerId: rivalCustomer, name: "Rival Pet", species: "dog", breed: "Poodle"
    })).json().id;
    const rivalBooking = await rivalPost("/api/appointments", {
      locationId: rival.json().locationId, customerId: rivalCustomer, petId: rivalPet,
      employeeId: rivalEmployee, serviceIds: [rivalService],
      localStart: "2035-08-01T09:00", expectedLocationVersion: 1
    });
    expect(rivalBooking.statusCode, rivalBooking.body).toBe(201);
    rivalAppointmentId = rivalBooking.json().id;
  }, 90_000);

  afterAll(async () => { await app.close(); await db.end(); });

  describe("who the caller is", () => {
    it("names the caller's own employee on /api/me, and null for a member with none", async () => {
      const linked = await request("GET", "/api/me", groomerA);
      expect(linked.statusCode).toBe(200);
      expect(linked.json().employeeId).toBe(employeeA);
      const other = await request("GET", "/api/me", groomerB);
      expect(other.json().employeeId).toBe(employeeB);
      const desk = await request("GET", "/api/me", receptionist);
      expect(desk.statusCode).toBe(200);
      expect(desk.json().employeeId).toBeNull();
      // The owner made nobody their groomer either.
      expect((await request("GET", "/api/me", ownerCookie)).json().employeeId).toBeNull();
    });
  });

  describe("a groomer and their own appointments", () => {
    it("edits, re-services, annotates, transitions and moves an appointment assigned to them", async () => {
      expect(permissionPresets.groomer).toEqual(expect.arrayContaining(
        ["appointments.edit", "calendar.blocks_create", "calendar.blocks_edit"]
      ));
      expect(permissionPresets.groomer).not.toContain("appointments.edit_all_staff");

      const mine = await booked(employeeA);
      const notes = await request("PATCH", `/api/appointments/${mine.id}`, groomerA, { notes: "Bring the ramp" });
      expect(notes.statusCode, notes.body).toBe(200);
      expect((await stored(mine.id)).notes).toBe("Bring the ramp");

      const services = await request("PUT", `/api/appointments/${mine.id}/services`, groomerA,
        { serviceIds: [serviceId, secondServiceId] });
      expect(services.statusCode, services.body).toBe(200);

      // Moved in time, keeping themselves as the groomer.
      const day = mine.scheduledLocalStart.slice(0, 10);
      const moved = await move(mine.id, groomerA, employeeA, `${day}T11:00`, (await stored(mine.id)).version);
      expect(moved.statusCode, moved.body).toBe(200);
      expect((await stored(mine.id)).employeeId).toBe(employeeA);

      const checkedIn = await transition(mine.id, groomerA, "checked_in");
      expect(checkedIn.statusCode, checkedIn.body).toBe(200);
      const note = await request("PATCH", `/api/appointments/${mine.id}/operations`, groomerA,
        { operationalNotes: "Matted behind the ears" });
      expect(note.statusCode, note.body).toBe(200);
      expect((await stored(mine.id)).operationalNotes).toBe("Matted behind the ears");
      const times = await request("PATCH", `/api/appointments/${mine.id}/times`, groomerA,
        { checkedInAt: new Date(Date.now() - 60_000).toISOString(), checkedOutAt: null });
      expect(times.statusCode, times.body).toBe(200);
    });

    it("is refused a colleague's appointment on every mutation route, with one code", async () => {
      const theirs = await booked(employeeB);
      const before = await stored(theirs.id);
      const outcomes = await everyMutation(theirs.id, groomerA);
      for (const [label, response] of Object.entries(outcomes)) expectScopeRefusal(response, label);
      // Nothing was written: not a note, not a version, not a status.
      expect(await stored(theirs.id)).toEqual(before);
    });

    it("may move their own appointment in time but not onto a colleague", async () => {
      const mine = await booked(employeeA);
      const day = mine.scheduledLocalStart.slice(0, 10);
      const reassigned = await move(mine.id, groomerA, employeeB, `${day}T09:00`, mine.version);
      expectScopeRefusal(reassigned, "reassign own to B");
      expect((await stored(mine.id)).employeeId).toBe(employeeA);
      expect((await stored(mine.id)).version).toBe(mine.version);

      const theirs = await booked(employeeB);
      const theirDay = theirs.scheduledLocalStart.slice(0, 10);
      // Taking a colleague's appointment for themselves is still a change to the colleague's
      // calendar, and is refused before "would it be mine afterwards" is even asked.
      const taken = await move(theirs.id, groomerA, employeeA, `${theirDay}T09:00`, theirs.version);
      expectScopeRefusal(taken, "move B's onto A");
      expect((await stored(theirs.id)).employeeId).toBe(employeeB);
    });

    it("recognises an assignment through appointment_employees as well as employee_id", async () => {
      // The two columns are kept in step by the routes; the scope check consults both so a row
      // where only the assignment table names the groomer is still theirs. `one_groomer_per_
      // appointment` (0017) allows one assignment row, so the drift is simulated by re-pointing
      // it rather than adding a second.
      const mine = await booked(employeeB);
      await db`
        update appointment_employees set employee_id=${employeeA}
        where business_id=${businessId} and appointment_id=${mine.id}
      `;
      const notes = await request("PATCH", `/api/appointments/${mine.id}`, groomerA, { notes: "Shared" });
      expect(notes.statusCode, notes.body).toBe(200);
    });
  });

  describe("a member with nothing assigned to them", () => {
    it("is refused every appointment mutation while holding every scoped key", async () => {
      const appointment = await booked(employeeA);
      const outcomes = await everyMutation(appointment.id, unlinkedEditor);
      for (const [label, response] of Object.entries(outcomes)) expectScopeRefusal(response, label);
      const block = await createBlock(employeeA, unlinkedEditor);
      expectScopeRefusal(block, "block create");
    });
  });

  describe("the receptionist and the owner", () => {
    it("lets the Receptionist preset reach anybody's appointment, as it always could", async () => {
      expect(permissionPresets.receptionist).toContain("appointments.edit_all_staff");
      const appointment = await booked(employeeA);
      const notes = await request("PATCH", `/api/appointments/${appointment.id}`, receptionist, { notes: "Front desk" });
      expect(notes.statusCode, notes.body).toBe(200);
      const day = appointment.scheduledLocalStart.slice(0, 10);
      const moved = await move(appointment.id, receptionist, employeeB, `${day}T13:00`, (await stored(appointment.id)).version);
      expect(moved.statusCode, moved.body).toBe(200);
      expect((await stored(appointment.id)).employeeId).toBe(employeeB);
      const checkedIn = await transition(appointment.id, receptionist, "checked_in");
      expect(checkedIn.statusCode, checkedIn.body).toBe(200);
    });

    it("gave the Receptionist nothing else", async () => {
      for (const key of ["payments.edit", "settings.services", "services.manage", "customers.credit_edit"]) {
        expect(permissionPresets.receptionist, key).not.toContain(key);
      }
      const service = await request("POST", "/api/services", receptionist,
        { name: "Not allowed", baseDurationMinutes: 30, basePriceMinor: 1000 });
      expect(service.statusCode).toBe(403);
      expect(service.json().error).toContain("services.manage");
      const credit = await request("POST", `/api/customers/${customerId}/credit`, receptionist,
        { kind: "grant", amountMinor: 500, reason: "No" });
      expect(credit.statusCode).toBe(403);
      expect(credit.json().error).toContain("customers.credit_edit");
    });

    it("lets the owner do everything to everybody's", async () => {
      const appointment = await booked(employeeB);
      const day = appointment.scheduledLocalStart.slice(0, 10);
      const moved = await move(appointment.id, ownerCookie, employeeA, `${day}T14:00`, appointment.version);
      expect(moved.statusCode, moved.body).toBe(200);
      const notes = await request("PATCH", `/api/appointments/${appointment.id}`, ownerCookie, { notes: "Owner" });
      expect(notes.statusCode, notes.body).toBe(200);
    });

    it("still answers a missing permission with the permission's own shape", async () => {
      // Scope is decided AFTER the permission gate: a member without the key is told about the
      // key, not about the assignment.
      const viewer = (await seat("viewer-only", ["calendar.view", "appointments.view"])).cookie;
      const appointment = await booked(employeeA);
      const refused = await request("PATCH", `/api/appointments/${appointment.id}`, viewer, { notes: "No" });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ error: "Missing permission: appointments.edit" });
    });
  });

  describe("blocked time", () => {
    it("lets a groomer create, edit and delete a block on their own calendar", async () => {
      const day = nextDay();
      const created = await createBlock(employeeA, groomerA, day);
      expect(created.statusCode, created.body).toBe(201);
      const block = created.json() as { id: string; version: number };

      const edited = await request("PATCH", `/api/blocked-times/${block.id}`, groomerA,
        { version: block.version, reason: "Late lunch" });
      expect(edited.statusCode, edited.body).toBe(200);
      // Moved in time, on their own calendar.
      const moved = await request("PATCH", `/api/blocked-times/${block.id}`, groomerA, {
        version: edited.json().version, employeeId: employeeA,
        localStart: `${day}T13:00`, localEnd: `${day}T13:30`, expectedLocationVersion: 1
      });
      expect(moved.statusCode, moved.body).toBe(200);
      const removed = await request("DELETE", `/api/blocked-times/${block.id}?version=${moved.json().version}`, groomerA);
      expect(removed.statusCode, removed.body).toBe(204);
    });

    it("refuses a groomer another groomer's calendar on create, edit, move and delete", async () => {
      const day = nextDay();
      expectScopeRefusal(await createBlock(employeeB, groomerA, day), "create for B");

      const theirs = (await createBlock(employeeB, ownerCookie, day)).json() as { id: string; version: number };
      expectScopeRefusal(await request("PATCH", `/api/blocked-times/${theirs.id}`, groomerA,
        { version: theirs.version, reason: "No" }), "edit B's");
      expectScopeRefusal(await request("DELETE", `/api/blocked-times/${theirs.id}?version=${theirs.version}`, groomerA), "delete B's");
      const [still] = await db<{ reason: string; version: number }[]>`
        select reason,version from blocked_times where id=${theirs.id}
      `;
      expect(still).toEqual({ reason: "Lunch", version: theirs.version });

      // Their own block, pushed onto a colleague's calendar.
      const ownDay = nextDay();
      const mine = (await createBlock(employeeA, groomerA, ownDay)).json() as { id: string; version: number };
      expectScopeRefusal(await request("PATCH", `/api/blocked-times/${mine.id}`, groomerA, {
        version: mine.version, employeeId: employeeB,
        localStart: `${ownDay}T12:00`, localEnd: `${ownDay}T12:30`, expectedLocationVersion: 1
      }), "move own onto B");
      const [unmoved] = await db<{ employeeId: string }[]>`select employee_id from blocked_times where id=${mine.id}`;
      expect(unmoved!.employeeId).toBe(employeeA);
    });

    it("lets the Receptionist create, edit, move and delete a block on another employee's calendar", async () => {
      // The front desk is assigned nothing, so every block it writes is somebody else's calendar:
      // `calendar.blocks_create` and `calendar.blocks_edit` ride `appointments.edit_all_staff`,
      // which the preset holds. The groomer case above is the same four routes refused.
      const day = nextDay();
      const created = await createBlock(employeeA, receptionist, day);
      expect(created.statusCode, created.body).toBe(201);
      const block = created.json() as { id: string; version: number; employeeId: string };
      expect(block.employeeId).toBe(employeeA);

      const edited = await request("PATCH", `/api/blocked-times/${block.id}`, receptionist,
        { version: block.version, reason: "Front desk relabel" });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json().reason).toBe("Front desk relabel");

      const moved = await request("PATCH", `/api/blocked-times/${block.id}`, receptionist, {
        version: edited.json().version, employeeId: employeeA,
        localStart: `${day}T14:00`, localEnd: `${day}T14:30`, expectedLocationVersion: 1
      });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().scheduledLocalStart).toBe(`${day}T14:00`);

      const removed = await request("DELETE", `/api/blocked-times/${block.id}?version=${moved.json().version}`, receptionist);
      expect(removed.statusCode, removed.body).toBe(204);
      const [gone] = await db<{ count: number }[]>`select count(*)::int as count from blocked_times where id=${block.id}`;
      expect(gone!.count).toBe(0);
    });

    it("lets the Receptionist move any block onto any calendar", async () => {
      const day = nextDay();
      const block = (await createBlock(employeeA, ownerCookie, day)).json() as { id: string; version: number };
      const moved = await request("PATCH", `/api/blocked-times/${block.id}`, receptionist, {
        version: block.version, employeeId: employeeB,
        localStart: `${day}T12:00`, localEnd: `${day}T12:30`, expectedLocationVersion: 1
      });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().employeeId).toBe(employeeB);
    });

    it("remains a hard scheduling constraint", async () => {
      const day = nextDay();
      expect((await createBlock(employeeA, groomerA, day)).statusCode).toBe(201);
      const refused = await app.inject({
        method: "POST", url: "/api/appointments",
        headers: { cookie: ownerCookie, "idempotency-key": key() },
        payload: {
          locationId, customerId, petId, employeeId: employeeA, serviceIds: [serviceId],
          localStart: `${day}T12:00`, expectedLocationVersion: 1
        }
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe("TIME_BLOCKED");
    });
  });

  describe("the service note", () => {
    it("persists on a completed appointment, and is still refused on scheduled and cancelled ones", async () => {
      const done = await booked(employeeA);
      expect((await transition(done.id, ownerCookie, "checked_in")).statusCode).toBe(200);
      expect((await transition(done.id, ownerCookie, "completed")).statusCode).toBe(200);
      const written = await request("PATCH", `/api/appointments/${done.id}/operations`, groomerA,
        { operationalNotes: "Check the left dewclaw next time", version: (await stored(done.id)).version });
      expect(written.statusCode, written.body).toBe(200);
      expect((await stored(done.id)).operationalNotes).toBe("Check the left dewclaw next time");

      const waiting = await booked(employeeA);
      const early = await request("PATCH", `/api/appointments/${waiting.id}/operations`, groomerA,
        { operationalNotes: "Too soon" });
      expect(early.statusCode).toBe(404);
      expect((await stored(waiting.id)).operationalNotes).toBeNull();

      expect((await transition(waiting.id, ownerCookie, "cancelled")).statusCode).toBe(200);
      const late = await request("PATCH", `/api/appointments/${waiting.id}/operations`, groomerA,
        { operationalNotes: "Called off" });
      expect(late.statusCode).toBe(404);
      expect((await stored(waiting.id)).operationalNotes).toBeNull();
    });

    it("tells a stale version apart from a missing or out-of-window appointment", async () => {
      // In the window, but the editor's copy is behind: 409 in the shape the note edit uses,
      // and nothing written.
      const done = await booked(employeeA);
      expect((await transition(done.id, ownerCookie, "checked_in")).statusCode).toBe(200);
      const { version } = await stored(done.id);
      const stale = await request("PATCH", `/api/appointments/${done.id}/operations`, groomerA,
        { operationalNotes: "Stale", version: version - 1 });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toEqual({ error: "Appointment changed; refresh before continuing" });
      expect((await stored(done.id))).toMatchObject({ operationalNotes: null, version });

      // The version the row actually holds is the one that works.
      const fresh = await request("PATCH", `/api/appointments/${done.id}/operations`, groomerA,
        { operationalNotes: "Fresh", version });
      expect(fresh.statusCode, fresh.body).toBe(200);
      expect(fresh.json().version).toBe(version + 1);
      expect((await stored(done.id)).operationalNotes).toBe("Fresh");

      // Out of the window with a stale version: the window answers first, and it is a 404.
      const waiting = await booked(employeeA);
      const early = await request("PATCH", `/api/appointments/${waiting.id}/operations`, groomerA,
        { operationalNotes: "Too soon", version: 1 });
      expect(early.statusCode, early.body).toBe(404);
      expect(early.json()).toEqual({ error: "Active service appointment not found" });

      // An id this business does not hold is a 404 whatever version is sent: one that never
      // existed, and another salon's appointment that is in its window but stale, so that a 409
      // here would mean the version had been read across the tenant boundary.
      expect((await transition(rivalAppointmentId, rivalCookie, "checked_in")).statusCode).toBe(200);
      for (const [label, id] of [["invented", crypto.randomUUID()], ["rival", rivalAppointmentId]] as const) {
        const refused = await request("PATCH", `/api/appointments/${id}/operations`, ownerCookie,
          { operationalNotes: "Elsewhere", version: 1 });
        expect(refused.statusCode, `${label}: ${refused.body}`).toBe(404);
        expect(refused.json(), label).toEqual({ error: "Active service appointment not found" });
      }
      const [rival] = await db<{ operationalNotes: string | null }[]>`
        select operational_notes from appointments where id=${rivalAppointmentId}
      `;
      expect(rival!.operationalNotes).toBeNull();
    });
  });

  describe("the client behind an appointment", () => {
    const client = (id: string, sessionCookie: string) =>
      request("GET", `/api/appointments/${id}/client`, sessionCookie);

    it("gives a groomer the history, notes and agreements with the money withheld", async () => {
      const appointment = await booked(employeeA);
      const response = await client(appointment.id, groomerA);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(Object.keys(body).sort()).toEqual(["agreements", "financialsWithheld", "history", "notes"]);
      expect(body.financialsWithheld).toBe(true);
      expect(body.history.customer.id).toBe(customerId);
      expect(body.history.summary).toBeNull();
      expect(body.history.invoices).toEqual([]);
      expect(body.history.upcoming.items.map((item: { id: string }) => item.id)).toContain(appointment.id);
      expect(body.notes).toMatchObject({ page: 1, pageSize: 50, total: expect.any(Number) });
      expect(Array.isArray(body.notes.items)).toBe(true);
      expect(body.agreements.customerId).toBe(customerId);
      expect(body.agreements.summary).toBeDefined();
      // Not only their own appointment: reading is gated on `appointments.view`, not on scope.
      const theirs = await booked(employeeB);
      expect((await client(theirs.id, groomerA)).statusCode).toBe(200);
    });

    it("hands a payments.view holder the same shapes the customer routes answer with", async () => {
      const payer = (await seat("payer", ["calendar.view", "appointments.view", "payments.view", "customers.view"])).cookie;
      const appointment = await booked(employeeA);
      const response = await client(appointment.id, payer);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body.financialsWithheld).toBe(false);
      expect(body.history.summary).not.toBeNull();
      expect(body.history.summary.credit).toBeDefined();
      expect(Array.isArray(body.history.invoices)).toBe(true);
      // Field for field what the three customer routes answer this caller with, minus the
      // per-request ordering nothing here relies on.
      const viaCustomer = async (path: string) =>
        (await request("GET", `/api/customers/${customerId}/${path}`, payer)).json();
      expect(body.history).toEqual(await viaCustomer("history"));
      expect(body.notes).toEqual(await viaCustomer("notes"));
      expect(body.agreements).toEqual(await viaCustomer("agreements"));
    });

    it("refuses a member without appointments.view and answers 404 across the tenant boundary", async () => {
      const outsider = (await seat("no-view", ["calendar.view"])).cookie;
      const appointment = await booked(employeeA);
      const refused = await client(appointment.id, outsider);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toContain("appointments.view");

      const foreign = await client(rivalAppointmentId, groomerA);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: "Appointment not found" });
      expect((await client(crypto.randomUUID(), ownerCookie)).statusCode).toBe(404);
    });
  });

  describe("reschedule lineage", () => {
    const activity = async (id: string) => {
      const response = await request("GET", `/api/appointments/${id}/activity`, ownerCookie);
      expect(response.statusCode, response.body).toBe(200);
      return response.json().items as { action: string; relatedAppointmentId: string | null; toStartAt: string | null }[];
    };

    it("records the thread on both rows and leaves the cancelled visit untouched", async () => {
      const source = await booked(employeeA);
      expect((await transition(source.id, ownerCookie, "cancelled")).statusCode).toBe(200);
      const before = await stored(source.id);
      expect(before.status).toBe("cancelled");

      const rebooked = await book(employeeA, ownerCookie, { rescheduledFromAppointmentId: source.id });
      expect(rebooked.statusCode, rebooked.body).toBe(201);
      const replacement = rebooked.json() as { id: string; version: number; startAt: string };
      // The create route's answer is unchanged in shape: nothing about the source rides on it.
      expect(replacement).not.toHaveProperty("rescheduledFromAppointmentId");
      expect((await stored(replacement.id)).status).toBe("scheduled");

      // The cancelled row is exactly as it was: status, version, timestamps.
      expect(await stored(source.id)).toEqual(before);

      const newSide = (await activity(replacement.id)).find((item) => item.action === "appointment.rescheduled_from");
      expect(newSide).toBeDefined();
      expect(newSide!.relatedAppointmentId).toBe(source.id);
      const oldSide = (await activity(source.id)).find((item) => item.action === "appointment.rescheduled_as");
      expect(oldSide).toBeDefined();
      expect(oldSide!.relatedAppointmentId).toBe(replacement.id);
      expect(oldSide!.toStartAt).toBe(replacement.startAt);
      // No other entry carries the field.
      for (const item of await activity(replacement.id)) {
        if (item.action !== "appointment.rescheduled_from") expect(item.relatedAppointmentId).toBeNull();
      }
    });

    it("also accepts a no-show as the source", async () => {
      const source = await booked(employeeA);
      expect((await transition(source.id, ownerCookie, "no_show")).statusCode).toBe(200);
      const rebooked = await book(employeeA, ownerCookie, { rescheduledFromAppointmentId: source.id });
      expect(rebooked.statusCode, rebooked.body).toBe(201);
    });

    it("refuses a source that still stands, a source that never existed, and another salon's", async () => {
      const standing = await booked(employeeA);
      for (const [label, id] of [
        ["scheduled", standing.id], ["invented", crypto.randomUUID()], ["rival", rivalAppointmentId]
      ] as const) {
        const refused = await book(employeeA, ownerCookie, { rescheduledFromAppointmentId: id });
        expect(refused.statusCode, `${label}: ${refused.body}`).toBe(400);
        expect(refused.json().code, label).toBe("RESCHEDULE_SOURCE_INVALID");
      }
      // A refused create wrote nothing: no appointment, no lineage.
      const [count] = await db<{ count: number }[]>`
        select count(*)::int as count from audit_events
        where business_id=${businessId} and action in ('appointment.rescheduled_as','appointment.rescheduled_from')
          and resource_id=${standing.id}
      `;
      expect(count!.count).toBe(0);
      // And a malformed id is refused by the schema.
      const malformed = await book(employeeA, ownerCookie, { rescheduledFromAppointmentId: "not-a-uuid" });
      expect(malformed.statusCode).toBe(400);
    });
  });
});
