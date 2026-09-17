import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissionPresets, unenforcedPermissions } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { roleFor } from "../support/roles.js";

/**
 * THE WORK LIST IS A LIST OF LINES, NOT A LIST OF SERVICE IDS.
 *
 * `PUT /api/appointments/:id/services` used to delete every `appointment_services` row and
 * reinsert from the catalog, so a line's id changed on every edit and anything snapshotted on it
 * for THIS appointment was lost. It is a keyed upsert now: a line sent with its id keeps its row
 * and its snapshots; a line without one is resolved from the catalog; rows not named are gone.
 * `PATCH /api/appointments/:id/services/:lineId` edits one line's reserved duration or price in
 * place, marks it `manual`, and touches nothing in the catalog.
 *
 * Both writes judge the resulting window the way a move is judged: the groomer's blocked time is
 * a hard refusal (`TIME_BLOCKED`), and running onto another appointment is `SCHEDULING_CONFLICT`
 * unless the caller asks to override and holds `appointments.override_conflict`. Neither route
 * ran either guard before.
 *
 * Price needs `appointments.service_price_edit`, which graduates from the unenforced list here:
 * a Manager holds it, the Groomer and Receptionist presets do not.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "appointment-service-lines-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

interface Line {
  id: string; serviceId: string; name: string; durationMinutes: number; priceMinor: number;
  linePosition: number; resolutionSource: string | null;
}

interface StoredLine {
  id: string; serviceId: string; name: string; durationMinutes: number; priceMinor: number;
  linePosition: number; resolutionSource: string | null;
}

describeDatabase("appointment service lines", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();

  let ownerCookie = "";
  let businessId = "";
  let locationId = "";
  let customerId = "";
  let petId = "";
  let groomId = "";
  let bathId = "";
  let nailsId = "";

  let employeeA = "";
  let employeeB = "";
  let groomerA = "";
  let manager = "";
  let receptionist = "";

  const key = () => crypto.randomUUID();
  let bookingDay = 0;
  const nextDay = () => {
    bookingDay += 1;
    const month = bookingDay > 28 ? "05" : "04";
    const day = bookingDay > 28 ? bookingDay - 28 : bookingDay;
    return `2036-${month}-${String(day).padStart(2, "0")}`;
  };

  async function seat(label: string, permissions: readonly string[]) {
    const email = `lines-${label}-${suffix}@example.test`;
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

  async function employeeFor(displayName: string, membershipId: string | null): Promise<string> {
    const response = await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName, serviceIds: [groomId, bathId, nailsId], ...(membershipId ? { membershipId } : {}) }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  const request = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string,
    sessionCookie: string, payload?: Record<string, unknown>) =>
    app.inject({
      method, url, headers: { cookie: sessionCookie, "idempotency-key": key() },
      ...(payload ? { payload } : {})
    });

  /** A booking on its own day at 09:00 with the given services, answering id, version and day. */
  async function book(employeeId: string, serviceIds: string[], localTime = "09:00", day = nextDay()) {
    const response = await request("POST", "/api/appointments", ownerCookie, {
      locationId, customerId, petId, employeeId, serviceIds,
      localStart: `${day}T${localTime}`, expectedLocationVersion: 1
    });
    expect(response.statusCode, response.body).toBe(201);
    const json = response.json() as { id: string; version: number };
    return { id: json.id, version: json.version, day };
  }

  const stored = async (id: string) => {
    const [row] = await db<{ version: number; endAt: Date; startAt: Date; conflictOverridden: boolean }[]>`
      select version,start_at,end_at,conflict_overridden from appointments where business_id=${businessId} and id=${id}
    `;
    return row!;
  };

  const storedLines = (id: string) => db<StoredLine[]>`
    select id,service_id,service_name_snapshot as name,duration_minutes_snapshot as duration_minutes,
      price_minor_snapshot as price_minor,line_position,resolution_source_snapshot as resolution_source
    from appointment_services where business_id=${businessId} and appointment_id=${id}
    order by line_position
  `;

  const detail = async (id: string, sessionCookie = ownerCookie) => {
    const response = await request("GET", `/api/appointments/${id}`, sessionCookie);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { version: number; endAt: string; services: Line[] };
  };

  const putLines = (id: string, sessionCookie: string, payload: Record<string, unknown>) =>
    request("PUT", `/api/appointments/${id}/services`, sessionCookie, payload);

  const patchLine = (id: string, lineId: string, sessionCookie: string, payload: Record<string, unknown>) =>
    request("PATCH", `/api/appointments/${id}/services/${lineId}`, sessionCookie, payload);

  const audit = (id: string, action: string) => db<{
    beforeData: Record<string, unknown> | null; afterData: Record<string, unknown> | null;
  }[]>`
    select before_data,after_data from audit_events
    where business_id=${businessId} and resource_type='appointment' and resource_id=${id} and action=${action}
    order by created_at desc,id desc
  `;

  const minutesBetween = (startAt: Date, endAt: Date) => Math.round((endAt.getTime() - startAt.getTime()) / 60_000);

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `lines-owner-${suffix}@example.test`,
        password: "correct horse lines battery", businessName: "Lines Salon"
      }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());

    const service = async (name: string, baseDurationMinutes: number, basePriceMinor: number) => {
      const response = await app.inject({
        method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
        payload: { name, baseDurationMinutes, basePriceMinor }
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().id as string;
    };
    groomId = await service("Lines Groom", 60, 8000);
    bathId = await service("Lines Bath", 30, 4000);
    nailsId = await service("Lines Nails", 15, 1500);

    const customer = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName: "Lines", lastName: "Client", phone: "555-0190" }
    });
    expect(customer.statusCode, customer.body).toBe(201);
    customerId = customer.json().id;
    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Lines Pet", species: "dog", breed: "Poodle" }
    });
    expect(pet.statusCode, pet.body).toBe(201);
    petId = pet.json().id;

    const seatA = await seat("groomer-a", permissionPresets.groomer!);
    const seatB = await seat("groomer-b", permissionPresets.groomer!);
    groomerA = seatA.cookie;
    employeeA = await employeeFor("Groomer A", seatA.membershipId);
    employeeB = await employeeFor("Groomer B", seatB.membershipId);
    manager = (await seat("manager", permissionPresets.manager!)).cookie;
    receptionist = (await seat("receptionist", permissionPresets.receptionist!)).cookie;
  }, 90_000);

  afterAll(async () => { await app.close(); await db.end(); });

  describe("the keyed upsert", () => {
    it("keeps an edited line by id, resolves a new one from the catalog, and drops the rest", async () => {
      const booking = await book(employeeA, [groomId, bathId]);
      const before = await detail(booking.id);
      expect(before.services.map((line) => [line.name, line.linePosition])).toEqual([["Lines Groom", 1], ["Lines Bath", 2]]);
      const bath = before.services.find((line) => line.serviceId === bathId)!;
      expect(bath.resolutionSource).not.toBe("manual");

      // Edit the bath's duration by hand, then send the list back keeping the bath by id, dropping
      // the groom, and adding nails.
      const edited = await patchLine(booking.id, bath.id, ownerCookie, { durationMinutes: 45, version: before.version });
      expect(edited.statusCode, edited.body).toBe(200);
      const afterEdit = await detail(booking.id);
      const reordered = await putLines(booking.id, ownerCookie, {
        version: afterEdit.version,
        lines: [{ id: bath.id, serviceId: bathId }, { serviceId: nailsId }]
      });
      expect(reordered.statusCode, reordered.body).toBe(200);
      // The calendar row comes back, carrying the fields the old `{ id, endAt }` answer carried.
      expect(reordered.json().id).toBe(booking.id);
      expect(typeof reordered.json().endAt).toBe("string");

      const rows = await storedLines(booking.id);
      expect(rows.map((row) => [row.name, row.linePosition])).toEqual([["Lines Bath", 1], ["Lines Nails", 2]]);
      const keptBath = rows.find((row) => row.serviceId === bathId)!;
      expect(keptBath.id).toBe(bath.id);
      expect(keptBath.durationMinutes).toBe(45);
      expect(keptBath.resolutionSource).toBe("manual");
      const nails = rows.find((row) => row.serviceId === nailsId)!;
      expect(nails.durationMinutes).toBe(15);
      expect(nails.priceMinor).toBe(1500);
      expect(nails.resolutionSource).not.toBe("manual");
      expect(rows.some((row) => row.serviceId === groomId)).toBe(false);

      const { startAt, endAt } = await stored(booking.id);
      expect(minutesBetween(startAt, endAt)).toBe(60);

      const [row] = await audit(booking.id, "appointment.services.update");
      const lines = (data: Record<string, unknown> | null) =>
        (data?.lines as { id: string; name: string; durationMinutes: number; priceMinor: number; linePosition: number }[])
          .map((line) => [line.name, line.durationMinutes, line.priceMinor, line.linePosition]);
      expect(lines(row!.beforeData)).toEqual([["Lines Groom", 60, 8000, 1], ["Lines Bath", 45, 4000, 2]]);
      expect(lines(row!.afterData)).toEqual([["Lines Bath", 45, 4000, 1], ["Lines Nails", 15, 1500, 2]]);
      expect(typeof row!.beforeData!.endAt).toBe("string");
      expect(typeof row!.afterData!.endAt).toBe("string");
    });

    it("renumbers a pure reorder and keeps every id", async () => {
      const booking = await book(employeeA, [groomId, bathId, nailsId]);
      const before = (await detail(booking.id)).services;
      const reversed = [...before].reverse();
      const response = await putLines(booking.id, ownerCookie, {
        lines: reversed.map((line) => ({ id: line.id, serviceId: line.serviceId }))
      });
      expect(response.statusCode, response.body).toBe(200);
      const rows = await storedLines(booking.id);
      expect(rows.map((row) => row.id)).toEqual(reversed.map((line) => line.id));
      expect(rows.map((row) => row.linePosition)).toEqual([1, 2, 3]);
    });

    it("still accepts the flat serviceIds body, re-resolving every row", async () => {
      const booking = await book(employeeA, [groomId, bathId]);
      const before = (await detail(booking.id)).services;
      const bath = before.find((line) => line.serviceId === bathId)!;
      expect((await patchLine(booking.id, bath.id, ownerCookie, { durationMinutes: 45 })).statusCode).toBe(200);
      const flat = await putLines(booking.id, ownerCookie, { serviceIds: [bathId, nailsId] });
      expect(flat.statusCode, flat.body).toBe(200);
      const rows = await storedLines(booking.id);
      expect(rows.map((row) => [row.name, row.linePosition, row.durationMinutes])).toEqual([["Lines Bath", 1, 30], ["Lines Nails", 2, 15]]);
      expect(rows.every((row) => row.resolutionSource !== "manual")).toBe(true);
      expect(rows.some((row) => row.id === bath.id)).toBe(false);
    });

    it("treats an id it does not own as a new line, and refuses both spellings at once", async () => {
      const theirs = await book(employeeB, [groomId]);
      const foreignLine = (await detail(theirs.id)).services[0]!;
      const booking = await book(employeeA, [groomId]);
      const response = await putLines(booking.id, ownerCookie, {
        lines: [{ id: foreignLine.id, serviceId: groomId }, { serviceId: bathId }]
      });
      expect(response.statusCode, response.body).toBe(200);
      const rows = await storedLines(booking.id);
      expect(rows.length).toBe(2);
      expect(rows.some((row) => row.id === foreignLine.id)).toBe(false);
      // The other appointment still has its line.
      expect((await storedLines(theirs.id)).map((row) => row.id)).toEqual([foreignLine.id]);

      const both = await putLines(booking.id, ownerCookie, { serviceIds: [groomId], lines: [{ serviceId: groomId }] });
      expect(both.statusCode).toBe(400);
      const neither = await putLines(booking.id, ownerCookie, { version: 1 });
      expect(neither.statusCode).toBe(400);
    });

    it("refuses a stale version and a list that runs onto the groomer's block", async () => {
      const booking = await book(employeeA, [groomId]);
      const stale = await putLines(booking.id, ownerCookie, { serviceIds: [groomId, bathId], version: booking.version + 5 });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe("Appointment changed; refresh before continuing");

      // A block from 10:30 on the booking's day; the groom ends at 10:00, a groom plus a bath at 10:30
      // touches it and a groom plus two more runs into it.
      const block = await request("POST", "/api/blocked-times", ownerCookie, {
        employeeId: employeeA, locationId, localStart: `${booking.day}T10:15`, localEnd: `${booking.day}T11:00`,
        expectedLocationVersion: 1, reason: "Lunch"
      });
      expect(block.statusCode, block.body).toBe(201);
      const before = await stored(booking.id);
      const blocked = await putLines(booking.id, ownerCookie, { serviceIds: [groomId, bathId] });
      expect(blocked.statusCode, blocked.body).toBe(409);
      expect(blocked.json().code).toBe("TIME_BLOCKED");
      // Nothing written: not a row, not the version, not end_at.
      expect(await stored(booking.id)).toEqual(before);
      expect((await storedLines(booking.id)).map((row) => row.name)).toEqual(["Lines Groom"]);
      // An availability override does not clear a block either.
      const overridden = await putLines(booking.id, ownerCookie, {
        serviceIds: [groomId, bathId], availabilityOverride: true, overrideReason: "Try anyway"
      });
      expect(overridden.statusCode).toBe(409);
      expect(overridden.json().code).toBe("TIME_BLOCKED");
    });
  });

  describe("editing a line's duration", () => {
    it("recomputes end_at and marks the line manual, leaving the catalog and other appointments alone", async () => {
      const booking = await book(employeeA, [groomId, bathId]);
      const other = await book(employeeB, [groomId]);
      const otherBefore = await storedLines(other.id);
      const groom = (await detail(booking.id)).services.find((line) => line.serviceId === groomId)!;

      const response = await patchLine(booking.id, groom.id, ownerCookie, { durationMinutes: 90, version: booking.version });
      expect(response.statusCode, response.body).toBe(200);
      const row = response.json() as { version: number; services: Line[] };
      expect(row.version).toBe(booking.version + 1);
      const edited = row.services.find((line) => line.id === groom.id)!;
      expect(edited.durationMinutes).toBe(90);
      expect(edited.priceMinor).toBe(8000);
      expect(edited.resolutionSource).toBe("manual");

      const { startAt, endAt } = await stored(booking.id);
      expect(minutesBetween(startAt, endAt)).toBe(120);

      const [catalog] = await db<{ baseDurationMinutes: number; basePriceMinor: number }[]>`
        select base_duration_minutes,base_price_minor from services where business_id=${businessId} and id=${groomId}
      `;
      expect(catalog).toEqual({ baseDurationMinutes: 60, basePriceMinor: 8000 });
      expect(await storedLines(other.id)).toEqual(otherBefore);

      const [audit1] = await audit(booking.id, "appointment.service.duration_edit");
      expect(audit1!.beforeData).toMatchObject({ lineId: groom.id, serviceId: groomId, name: "Lines Groom", durationMinutes: 60 });
      expect(audit1!.afterData).toMatchObject({ lineId: groom.id, serviceId: groomId, name: "Lines Groom", durationMinutes: 90 });
      expect(typeof audit1!.afterData!.endAt).toBe("string");
      expect(await audit(booking.id, "appointment.service.price_edit")).toEqual([]);
    });

    it("refuses extending into the groomer's block, writing nothing", async () => {
      const booking = await book(employeeA, [groomId]);
      const block = await request("POST", "/api/blocked-times", ownerCookie, {
        employeeId: employeeA, locationId, localStart: `${booking.day}T10:30`, localEnd: `${booking.day}T11:00`,
        expectedLocationVersion: 1, reason: "Lunch"
      });
      expect(block.statusCode, block.body).toBe(201);
      const groom = (await detail(booking.id)).services[0]!;
      const before = await stored(booking.id);
      const response = await patchLine(booking.id, groom.id, ownerCookie, { durationMinutes: 120 });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("TIME_BLOCKED");
      expect(await stored(booking.id)).toEqual(before);
      const [line] = await storedLines(booking.id);
      expect(line!.durationMinutes).toBe(60);
      expect(line!.resolutionSource).not.toBe("manual");
      expect(await audit(booking.id, "appointment.service.duration_edit")).toEqual([]);
    });

    it("refuses extending onto another appointment unless the override is asked for and held", async () => {
      const day = nextDay();
      const first = await book(employeeA, [groomId], "09:00", day);
      await book(employeeA, [groomId], "10:30", day);
      const groom = (await detail(first.id)).services[0]!;

      const refused = await patchLine(first.id, groom.id, ownerCookie, { durationMinutes: 120 });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe("SCHEDULING_CONFLICT");
      expect(refused.json().canOverride).toBe(true);
      expect((await storedLines(first.id))[0]!.durationMinutes).toBe(60);

      // A groomer holds no override permission: asking for one is refused by name.
      const asked = await patchLine(first.id, groom.id, groomerA, { durationMinutes: 120, overrideConflict: true });
      expect(asked.statusCode, asked.body).toBe(403);
      expect(asked.json().error).toContain("appointments.override_conflict");

      const overridden = await patchLine(first.id, groom.id, ownerCookie, { durationMinutes: 120, overrideConflict: true });
      expect(overridden.statusCode, overridden.body).toBe(200);
      const after = await stored(first.id);
      expect(minutesBetween(after.startAt, after.endAt)).toBe(120);
      expect(after.conflictOverridden).toBe(true);
      const [override] = await db<{ afterData: { operation: string } }[]>`
        select after_data from audit_events
        where business_id=${businessId} and resource_id=${first.id} and action='appointment.conflict_override'
      `;
      expect(override!.afterData.operation).toBe("services");
    });

    it("lets a groomer edit their own line and refuses a colleague's, with the scope code", async () => {
      const mine = await book(employeeA, [groomId]);
      const myLine = (await detail(mine.id)).services[0]!;
      const own = await patchLine(mine.id, myLine.id, groomerA, { durationMinutes: 75 });
      expect(own.statusCode, own.body).toBe(200);
      expect((await storedLines(mine.id))[0]!.durationMinutes).toBe(75);

      const theirs = await book(employeeB, [groomId]);
      const theirLine = (await detail(theirs.id)).services[0]!;
      const refused = await patchLine(theirs.id, theirLine.id, groomerA, { durationMinutes: 75 });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().code).toBe("NOT_ASSIGNED_TO_YOU");
      expect((await storedLines(theirs.id))[0]!.durationMinutes).toBe(60);
    });

    it("answers 409 to a stale version, 404 to a line of another appointment, and 400 to an empty edit", async () => {
      const booking = await book(employeeA, [groomId]);
      const other = await book(employeeA, [bathId]);
      const line = (await detail(booking.id)).services[0]!;
      const otherLine = (await detail(other.id)).services[0]!;
      const stale = await patchLine(booking.id, line.id, ownerCookie, { durationMinutes: 70, version: booking.version + 3 });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe("Appointment changed; refresh before continuing");
      const wrongAppointment = await patchLine(booking.id, otherLine.id, ownerCookie, { durationMinutes: 70 });
      expect(wrongAppointment.statusCode).toBe(404);
      const invented = await patchLine(booking.id, crypto.randomUUID(), ownerCookie, { durationMinutes: 70 });
      expect(invented.statusCode).toBe(404);
      const empty = await patchLine(booking.id, line.id, ownerCookie, { version: booking.version });
      expect(empty.statusCode).toBe(400);
      expect((await storedLines(booking.id))[0]!.durationMinutes).toBe(60);
    });
  });

  describe("editing a line's price", () => {
    it("has graduated the permission and left the presets alone", () => {
      expect(unenforcedPermissions.has("appointments.service_price_edit")).toBe(false);
      expect(permissionPresets.manager).toContain("appointments.service_price_edit");
      expect(permissionPresets.groomer).not.toContain("appointments.service_price_edit");
      expect(permissionPresets.receptionist).not.toContain("appointments.service_price_edit");
    });

    it("lets a Manager re-price a line for this appointment only, with before and after on record", async () => {
      const booking = await book(employeeA, [groomId]);
      const line = (await detail(booking.id)).services[0]!;
      const response = await patchLine(booking.id, line.id, manager, { priceMinor: 9500, version: booking.version });
      expect(response.statusCode, response.body).toBe(200);
      const row = response.json() as { version: number; services: Line[]; servicesSubtotalMinor: number };
      expect(row.version).toBe(booking.version + 1);
      expect(row.services[0]).toMatchObject({ id: line.id, priceMinor: 9500, durationMinutes: 60, resolutionSource: "manual" });
      expect(row.servicesSubtotalMinor).toBe(9500);
      const [catalog] = await db<{ basePriceMinor: number }[]>`
        select base_price_minor from services where business_id=${businessId} and id=${groomId}
      `;
      expect(catalog!.basePriceMinor).toBe(8000);
      const [priceAudit] = await audit(booking.id, "appointment.service.price_edit");
      expect(priceAudit!.beforeData).toMatchObject({ lineId: line.id, serviceId: groomId, name: "Lines Groom", priceMinor: 8000 });
      expect(priceAudit!.afterData).toMatchObject({ lineId: line.id, serviceId: groomId, name: "Lines Groom", priceMinor: 9500 });
      expect(await audit(booking.id, "appointment.service.duration_edit")).toEqual([]);
      // A price change alone moves no minute of the calendar.
      const { startAt, endAt } = await stored(booking.id);
      expect(minutesBetween(startAt, endAt)).toBe(60);
    });

    it("refuses a groomer and a receptionist by name, even on their own appointment", async () => {
      const mine = await book(employeeA, [groomId]);
      const line = (await detail(mine.id)).services[0]!;
      for (const [label, session] of [["groomer", groomerA], ["receptionist", receptionist]] as const) {
        const refused = await patchLine(mine.id, line.id, session, { priceMinor: 100 });
        expect(refused.statusCode, `${label}: ${refused.body}`).toBe(403);
        expect(refused.json().error, label).toBe("Missing permission: appointments.service_price_edit");
        // Sending both fields is refused whole: the duration does not slip through.
        const both = await patchLine(mine.id, line.id, session, { priceMinor: 100, durationMinutes: 70 });
        expect(both.statusCode, label).toBe(403);
      }
      expect((await storedLines(mine.id))[0]).toMatchObject({ priceMinor: 8000, durationMinutes: 60 });
    });

    it("edits both fields at once, writing one row of each kind", async () => {
      const booking = await book(employeeA, [groomId]);
      const line = (await detail(booking.id)).services[0]!;
      const response = await patchLine(booking.id, line.id, manager, { priceMinor: 7000, durationMinutes: 50 });
      expect(response.statusCode, response.body).toBe(200);
      expect((await storedLines(booking.id))[0]).toMatchObject({ priceMinor: 7000, durationMinutes: 50, resolutionSource: "manual" });
      expect((await audit(booking.id, "appointment.service.price_edit")).length).toBe(1);
      expect((await audit(booking.id, "appointment.service.duration_edit")).length).toBe(1);
      const { startAt, endAt } = await stored(booking.id);
      expect(minutesBetween(startAt, endAt)).toBe(50);
    });
  });

  describe("once the money starts", () => {
    it("refuses both routes the way the list edit always has", async () => {
      const booking = await book(employeeA, [groomId]);
      const line = (await detail(booking.id)).services[0]!;
      expect((await request("POST", `/api/appointments/${booking.id}/transition`, ownerCookie, { status: "checked_in" })).statusCode).toBe(200);
      const checkout = await request("POST", `/api/appointments/${booking.id}/checkout`, ownerCookie,
        { discountMinor: 0, tipMinor: 0, appliedDiscountIds: [] });
      expect(checkout.statusCode, checkout.body).toBe(201);
      const price = await patchLine(booking.id, line.id, manager, { priceMinor: 100 });
      expect(price.statusCode).toBe(400);
      expect(price.json().error).toBe("Services cannot change after checkout begins");
      const duration = await patchLine(booking.id, line.id, ownerCookie, { durationMinutes: 10 });
      expect(duration.statusCode).toBe(400);
      const list = await putLines(booking.id, ownerCookie, { lines: [{ id: line.id, serviceId: groomId }, { serviceId: bathId }] });
      expect(list.statusCode).toBe(400);
      expect(list.json().error).toBe("Services cannot change after checkout begins");
      expect((await storedLines(booking.id))[0]).toMatchObject({ priceMinor: 8000, durationMinutes: 60 });
    });
  });
});
