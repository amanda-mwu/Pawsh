import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissionPresets } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { roleFor } from "../support/roles.js";

/**
 * APPOINTMENT HISTORY - `GET /api/appointments/:id/activity` - as a person reads it.
 *
 * Every audit row about a visit, projected with names and times rather than ids: the groomer it
 * moved from and to, the services it was booked with and changed to, the start of the visit a
 * reschedule replaced. Never the text of a note. Money only for a caller who may see money, and
 * for anybody else exactly the appointment's own rows with no amount anywhere on them.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "appointment-history-secret-at-least-32-chars-long",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

interface HistoryLine { id: string; serviceId: string; name: string; durationMinutes: number; priceMinor: number; linePosition: number }

interface HistoryItem {
  id: string; action: string; at: string; createdAt: string;
  actor: { label: string; kind: "staff" | "customer" | "system" };
  actorName: string | null; reason: string | null;
  fromStatus: string | null; toStatus: string | null;
  fromStartAt: string | null; toStartAt: string | null; fromEndAt: string | null; toEndAt: string | null;
  fromGroomer: string | null; toGroomer: string | null;
  lines: { before: HistoryLine[] | null; after: HistoryLine[] | null } | null;
  line: { name: string | null; fromDurationMinutes: number | null; toDurationMinutes: number | null;
    fromPriceMinor: number | null; toPriceMinor: number | null } | null;
  amountMinor: number | null; method: string | null; totalMinor: number | null;
  relatedAppointmentId: string | null; relatedAppointmentStartAt: string | null;
}

interface History { items: HistoryItem[]; count: number }

const moneyActions = [
  "invoice.create", "payment.record", "payment.void", "payment.refund.request", "payment.refund.completed",
  "payment.refund.failed", "coupon.redeem", "credit.redeem", "credit.reverse"
];

describeDatabase("appointment history", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();

  let ownerCookie = "";
  let ownerUserId = "";
  let businessId = "";
  let locationId = "";
  let customerId = "";
  let petId = "";
  let groomId = "";
  let bathId = "";

  let employeeA = "";
  let employeeB = "";
  let groomerA = "";
  let receptionist = "";

  const key = () => crypto.randomUUID();
  let bookingDay = 0;
  const nextDay = () => {
    bookingDay += 1;
    const month = bookingDay > 28 ? "07" : "06";
    const day = bookingDay > 28 ? bookingDay - 28 : bookingDay;
    return `2036-${month}-${String(day).padStart(2, "0")}`;
  };

  async function seat(label: string, displayName: string, permissions: readonly string[]) {
    const email = `history-${label}-${suffix}@example.test`;
    const password = `correct horse ${label} battery`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash,display_name)
      values (${email},${email},${await hashPassword(password)},${displayName}) returning id
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
      payload: { displayName, serviceIds: [groomId, bathId], ...(membershipId ? { membershipId } : {}) }
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

  async function book(employeeId: string, serviceIds: string[], extra: Record<string, unknown> = {}, day = nextDay()) {
    const response = await request("POST", "/api/appointments", ownerCookie, {
      locationId, customerId, petId, employeeId, serviceIds,
      localStart: `${day}T09:00`, expectedLocationVersion: 1, ...extra
    });
    expect(response.statusCode, response.body).toBe(201);
    const json = response.json() as { id: string; version: number; startAt: string };
    return { id: json.id, version: json.version, startAt: json.startAt, day };
  }

  const version = async (id: string) => {
    const [row] = await db<{ version: number }[]>`select version from appointments where id=${id}`;
    return row!.version;
  };

  const history = async (id: string, sessionCookie = ownerCookie): Promise<History> => {
    const response = await request("GET", `/api/appointments/${id}/activity`, sessionCookie);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as History;
  };

  const transition = (id: string, status: string, sessionCookie = ownerCookie) =>
    request("POST", `/api/appointments/${id}/transition`, sessionCookie, { status });

  const lineNames = (lines: HistoryLine[] | null) => lines?.map((line) => line.name) ?? null;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `history-owner-${suffix}@example.test`,
        password: "correct horse history battery", businessName: "History Salon"
      }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());
    const [owner] = await db<{ userId: string }[]>`
      select user_id from business_memberships where business_id=${businessId} and is_owner
    `;
    ownerUserId = owner!.userId;

    const service = async (name: string, baseDurationMinutes: number, basePriceMinor: number) => {
      const response = await app.inject({
        method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
        payload: { name, baseDurationMinutes, basePriceMinor }
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().id as string;
    };
    groomId = await service("History Groom", 60, 8000);
    bathId = await service("History Bath", 30, 4000);

    const customer = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName: "History", lastName: "Client", phone: "555-0191" }
    });
    expect(customer.statusCode, customer.body).toBe(201);
    customerId = customer.json().id;
    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "History Pet", species: "dog", breed: "Poodle" }
    });
    expect(pet.statusCode, pet.body).toBe(201);
    petId = pet.json().id;

    const seatA = await seat("groomer-a", "Login Name A", permissionPresets.groomer!);
    groomerA = seatA.cookie;
    employeeA = await employeeFor("Grace Groomer", seatA.membershipId);
    employeeB = await employeeFor("Gabriel Groomer", null);
    receptionist = (await seat("receptionist", "Front Desk", permissionPresets.receptionist!)).cookie;
  }, 90_000);

  afterAll(async () => { await app.close(); await db.end(); });

  it("tells the story of a visit with names, services and times, never ids alone", async () => {
    const booking = await book(employeeA, [groomId, bathId]);

    // Moved onto the other groomer, an hour later.
    const moved = await request("PATCH", `/api/appointments/${booking.id}/schedule`, ownerCookie, {
      employeeId: employeeB, localStart: `${booking.day}T10:00`, version: booking.version, expectedLocationVersion: 1
    });
    expect(moved.statusCode, moved.body).toBe(200);

    // Services changed: keep the groom by id, drop the bath.
    const detail = (await request("GET", `/api/appointments/${booking.id}`, ownerCookie)).json() as
      { version: number; services: { id: string; serviceId: string }[] };
    const groom = detail.services.find((line) => line.serviceId === groomId)!;
    const services = await request("PUT", `/api/appointments/${booking.id}/services`, ownerCookie, {
      version: detail.version, lines: [{ id: groom.id, serviceId: groomId }]
    });
    expect(services.statusCode, services.body).toBe(200);

    // The groom's duration and price edited for this visit.
    const edit = await request("PATCH", `/api/appointments/${booking.id}/services/${groom.id}`, ownerCookie,
      { durationMinutes: 75, priceMinor: 9000 });
    expect(edit.statusCode, edit.body).toBe(200);

    // The booking note, then the lifecycle and the service note.
    const note = await request("PATCH", `/api/appointments/${booking.id}`, ownerCookie,
      { notes: "SECRET-BOOKING-NOTE", version: await version(booking.id) });
    expect(note.statusCode, note.body).toBe(200);
    expect((await transition(booking.id, "checked_in")).statusCode).toBe(200);
    const serviceNote = await request("PATCH", `/api/appointments/${booking.id}/operations`, ownerCookie,
      { operationalNotes: "SECRET-SERVICE-NOTE" });
    expect(serviceNote.statusCode, serviceNote.body).toBe(200);
    expect((await transition(booking.id, "in_service")).statusCode).toBe(200);
    expect((await transition(booking.id, "completed")).statusCode).toBe(200);

    const { items, count } = await history(booking.id);
    expect(count).toBe(items.length);
    const byAction = (action: string) => items.filter((item) => item.action === action);

    // Newest first, and every item carries the shape.
    const stamps = items.map((item) => item.at);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(item.actor).toEqual({ label: `history-owner-${suffix}`, kind: "staff" });
      expect(new Date(item.at).toISOString()).toBe(item.at);
    }

    const created = byAction("appointment.create")[0]!;
    expect(lineNames(created.lines!.after)).toEqual(["History Groom", "History Bath"]);
    expect(created.lines!.before).toBeNull();
    expect(created.lines!.after![0]).toMatchObject({ durationMinutes: 60, priceMinor: 8000, linePosition: 1 });

    const move = byAction("appointment.move")[0]!;
    expect(move.fromGroomer).toBe("Grace Groomer");
    expect(move.toGroomer).toBe("Gabriel Groomer");
    expect(move.fromStartAt).toBe(booking.startAt);
    expect(new Date(move.toStartAt!).getTime() - new Date(move.fromStartAt!).getTime()).toBe(3_600_000);

    const changed = byAction("appointment.services.update")[0]!;
    expect(lineNames(changed.lines!.before)).toEqual(["History Groom", "History Bath"]);
    expect(lineNames(changed.lines!.after)).toEqual(["History Groom"]);
    expect(changed.fromEndAt).not.toBeNull();
    expect(changed.toEndAt).not.toBeNull();

    const duration = byAction("appointment.service.duration_edit")[0]!;
    expect(duration.line).toEqual({ name: "History Groom", fromDurationMinutes: 60, toDurationMinutes: 75, fromPriceMinor: null, toPriceMinor: null });
    const price = byAction("appointment.service.price_edit")[0]!;
    expect(price.line).toEqual({ name: "History Groom", fromDurationMinutes: null, toDurationMinutes: null, fromPriceMinor: 8000, toPriceMinor: 9000 });

    for (const status of ["checked_in", "in_service", "completed"]) {
      const item = byAction(`appointment.${status}`)[0]!;
      expect(item.toStatus).toBe(status);
    }
    expect(byAction("appointment.notes_edit").length).toBe(1);
    expect(byAction("appointment.operational_notes_edit").length).toBe(1);

    // Neither note's text is anywhere in the payload, and no groomer or line id stands in for a name.
    const body = JSON.stringify(items);
    expect(body).not.toContain("SECRET-BOOKING-NOTE");
    expect(body).not.toContain("SECRET-SERVICE-NOTE");
    expect(body).not.toContain(employeeA);
    expect(body).not.toContain(employeeB);
    // Nothing here is money.
    for (const item of items) {
      expect(moneyActions).not.toContain(item.action);
      expect(item.amountMinor).toBeNull();
      expect(item.totalMinor).toBeNull();
    }
  });

  it("records the visit being called off, and a rebooking that names when the old one was", async () => {
    const source = await book(employeeA, [groomId]);
    expect((await transition(source.id, "cancelled")).statusCode).toBe(200);
    const rebooked = await book(employeeA, [groomId], { rescheduledFromAppointmentId: source.id });

    const oldSide = await history(source.id);
    const cancelled = oldSide.items.find((item) => item.action === "appointment.cancelled")!;
    expect(cancelled).toMatchObject({ fromStatus: "scheduled", toStatus: "cancelled" });
    const asItem = oldSide.items.find((item) => item.action === "appointment.rescheduled_as")!;
    expect(asItem.relatedAppointmentId).toBe(rebooked.id);
    expect(asItem.relatedAppointmentStartAt).toBe(rebooked.startAt);

    const newSide = await history(rebooked.id);
    const fromItem = newSide.items.find((item) => item.action === "appointment.rescheduled_from")!;
    expect(fromItem.relatedAppointmentId).toBe(source.id);
    expect(fromItem.relatedAppointmentStartAt).toBe(source.startAt);
    for (const item of newSide.items) {
      if (item.action !== "appointment.rescheduled_from") expect(item.relatedAppointmentStartAt).toBeNull();
    }

    const noShow = await book(employeeA, [groomId]);
    expect((await transition(noShow.id, "no_show")).statusCode).toBe(200);
    expect((await history(noShow.id)).items.map((item) => item.action)).toContain("appointment.no_show");
  });

  it("labels the actor by employee name when linked, by account name when not, and as the system when absent", async () => {
    const booking = await book(employeeA, [groomId]);
    // The linked groomer edits their own booking note; the unlinked receptionist checks it in.
    const byGroomer = await request("PATCH", `/api/appointments/${booking.id}`, groomerA, { notes: "Ramp" });
    expect(byGroomer.statusCode, byGroomer.body).toBe(200);
    expect((await transition(booking.id, "checked_in", receptionist)).statusCode).toBe(200);
    await db`
      insert into audit_events(business_id,actor_id,action,resource_type,resource_id,correlation_id,after_data)
      values (${businessId},null,'appointment.no_show','appointment',${booking.id},${crypto.randomUUID()},'{"status":"no_show"}')
    `;
    const { items } = await history(booking.id);
    expect(items.find((item) => item.action === "appointment.notes_edit")!.actor).toEqual({ label: "Grace Groomer", kind: "staff" });
    expect(items.find((item) => item.action === "appointment.checked_in")!.actor).toEqual({ label: "Front Desk", kind: "staff" });
    expect(items.find((item) => item.action === "appointment.no_show")!.actor).toEqual({ label: "System", kind: "system" });
    expect(JSON.stringify(items)).not.toContain("Login Name A");
  });

  describe("money", () => {
    let appointmentId = "";
    let invoiceId = "";

    beforeAll(async () => {
      const coupon = await request("POST", "/api/settings/coupons", ownerCookie, { code: "HISTORY10", kind: "amount", amountMinor: 1000 });
      expect(coupon.statusCode, coupon.body).toBe(201);
      const granted = await request("POST", `/api/customers/${customerId}/credit`, ownerCookie,
        { kind: "grant", amountMinor: 2000, reason: "Goodwill" });
      expect(granted.statusCode, granted.body).toBe(201);

      const booking = await book(employeeA, [groomId]);
      appointmentId = booking.id;
      expect((await transition(booking.id, "checked_in")).statusCode).toBe(200);
      const checkout = await request("POST", `/api/appointments/${booking.id}/checkout`, ownerCookie,
        { discountMinor: 0, tipMinor: 0, appliedDiscountIds: [], couponCode: "HISTORY10" });
      expect(checkout.statusCode, checkout.body).toBe(201);
      invoiceId = checkout.json().id;
      const balance = checkout.json().balanceMinor as number;
      const credit = await request("POST", `/api/invoices/${invoiceId}/payments`, ownerCookie,
        { amountMinor: 2000, expectedBalanceMinor: balance, method: "client_credit" });
      expect(credit.statusCode, credit.body).toBe(201);
      const cash = await request("POST", `/api/invoices/${invoiceId}/payments`, ownerCookie,
        { amountMinor: balance - 2000, expectedBalanceMinor: balance - 2000, method: "cash" });
      expect(cash.statusCode, cash.body).toBe(201);
      // A refund row as the Square path writes it, filed under the refund rather than the payment.
      const [refund] = await db<{ id: string }[]>`
        insert into payment_refunds(business_id,payment_id,invoice_id,amount_minor,currency,idempotency_key,status,requested_by)
        values (${businessId},${cash.json().id},${invoiceId},500,'USD',${crypto.randomUUID().slice(0, 32)},'pending',${ownerUserId})
        returning id
      `;
      await db`
        insert into audit_events(business_id,actor_id,action,resource_type,resource_id,correlation_id,after_data)
        values (${businessId},${ownerUserId},'payment.refund.request','payment_refund',${refund!.id},${crypto.randomUUID()},
          ${db.json({ paymentId: cash.json().id, invoiceId, amountMinor: 500 })})
      `;
    });

    it("shows the invoice, the payments, the coupon, the credit and the refund to a caller with payments.view", async () => {
      const { items } = await history(appointmentId, receptionist);
      const actions = items.map((item) => item.action);
      for (const action of ["invoice.create", "payment.record", "coupon.redeem", "credit.redeem", "payment.refund.request"]) {
        expect(actions, action).toContain(action);
      }
      expect(items.filter((item) => item.action === "payment.record").length).toBe(2);
      expect(items.find((item) => item.action === "invoice.create")!.totalMinor).toBe(7000);
      expect(items.find((item) => item.action === "coupon.redeem")!.amountMinor).toBe(1000);
      expect(items.find((item) => item.action === "credit.redeem")!.amountMinor).toBe(2000);
      expect(items.find((item) => item.action === "payment.refund.request")!.amountMinor).toBe(500);
      const cash = items.find((item) => item.action === "payment.record" && item.method === "cash")!;
      expect(cash.amountMinor).toBe(5000);
      // The same for the owner.
      expect((await history(appointmentId)).items.map((item) => item.action)).toEqual(actions);
    });

    it("shows a groomer exactly the appointment's own rows, with no amount anywhere", async () => {
      const { items, count } = await history(appointmentId, groomerA);
      expect(count).toBe(items.length);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.action.startsWith("appointment.")).toBe(true);
        expect(moneyActions).not.toContain(item.action);
        expect(item.amountMinor).toBeNull();
        expect(item.totalMinor).toBeNull();
        expect(item.method).toBeNull();
      }
      // NO AMOUNT REACHES THE GROOMER THROUGH ANY FIELD. Walked as values rather than searched as
      // text: a substring scan of the serialised body matched "500" inside a row id once
      // (`37a5b99f-…-80b1ad8fd15b` is as likely to carry the digits as a timestamp is), which
      // read as a leak that never happened. Ids and instants are the only fields free of the
      // check; every other value, at any depth, must be none of the amounts this invoice moved.
      const amounts = new Set([7000, 5000, 2000, 1000, 500]);
      const opaque = new Set(["id", "at", "createdAt", "relatedAppointmentId", "relatedAppointmentStartAt"]);
      const walk = (value: unknown, path: string): void => {
        if (value === null || value === undefined) return;
        if (typeof value === "number") {
          expect(amounts.has(value), `${path} carries an amount: ${value}`).toBe(false);
        } else if (typeof value === "string") {
          expect(value, `${path} names the invoice`).not.toBe(invoiceId);
          expect(amounts.has(Number(value)), `${path} carries an amount as text: ${value}`).toBe(false);
        } else if (Array.isArray(value)) {
          value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        } else if (typeof value === "object") {
          for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (opaque.has(key)) continue;
            walk(entry, `${path}.${key}`);
          }
        }
      };
      walk(items, "items");
      expect(JSON.stringify(items)).not.toContain(invoiceId);
      // And the same rows are what a payments viewer sees once the money is set aside.
      const full = await history(appointmentId, receptionist);
      expect(full.items.filter((item) => item.action.startsWith("appointment.")).map((item) => item.id))
        .toEqual(items.map((item) => item.id));
      expect(full.count).toBe(items.length + full.items.filter((item) => !item.action.startsWith("appointment.")).length);
    });

    it("answers 404 across the tenant boundary and 403 without appointments.view", async () => {
      const rival = await app.inject({
        method: "POST", url: "/api/auth/signup",
        payload: { email: `history-rival-${suffix}@example.test`, password: "correct horse rival battery", businessName: "Rival History" }
      });
      expect(rival.statusCode).toBe(201);
      const foreign = await request("GET", `/api/appointments/${appointmentId}/activity`, cookie(rival));
      expect(foreign.statusCode).toBe(404);
      const outsider = (await seat("no-view", "Nobody", ["calendar.view"])).cookie;
      expect((await request("GET", `/api/appointments/${appointmentId}/activity`, outsider)).statusCode).toBe(403);
    });
  });
});
