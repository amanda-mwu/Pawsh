import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * THE ORDER OF THE SERVICES ON A TICKET.
 *
 * `appointment_services` shipped in 0001 with no ordering column - no `created_at`, no
 * `position`, and a primary key of `gen_random_uuid()`. Every read of "the services on this
 * appointment" therefore ordered by that random uuid, which sorts by nothing, so a two-service
 * visit rendered either way round per appointment. 0054 adds `line_position` and both write paths
 * now record the order the operator submitted.
 *
 * WHY THE ASSERTIONS BELOW USE SIX SERVICES AND REPEAT THEMSELVES. Two services is a coin flip: a
 * test that books two and reads them once passes half the time under the defect and would have
 * been reported as a pass. Six services is one ordering out of 720, and each appointment is an
 * independent draw, so a suite that books several and reads each of them many times cannot pass
 * by luck. That is a deliberate property of these tests rather than an accident of the fixture.
 *
 * THE TICKET OWNS THIS ORDER AND DOES NOT BORROW IT FROM AN INVOICE. A Ticket is an operational
 * work sheet that exists from the moment a visit is booked; an invoice exists only after checkout.
 * The two specs at the end of this file state that as a property rather than as an intention: the
 * sheet's order is unchanged by an invoice existing, and rewriting every `invoice_items.line_position`
 * behind the API's back moves nothing on the sheet.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "appointment-service-order-secret-at-least-32-characters",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

/**
 * Six services, named so that the booked order below matches NO obvious sort.
 *
 * The submitted order is F, C, A, E, B, D. That is not alphabetical, not reverse alphabetical, not
 * by price and not by duration, so an implementation that quietly sorted by any stored column
 * would be caught by the same assertion that catches the random uuid.
 */
const catalogue = [
  { key: "A", name: "Alpha Bath", durationMinutes: 15, basePriceMinor: 3300 },
  { key: "B", name: "Bravo Brush", durationMinutes: 20, basePriceMinor: 1100 },
  { key: "C", name: "Charlie Clip", durationMinutes: 10, basePriceMinor: 5500 },
  { key: "D", name: "Delta Dry", durationMinutes: 25, basePriceMinor: 2200 },
  { key: "E", name: "Echo Ears", durationMinutes: 5, basePriceMinor: 6600 },
  { key: "F", name: "Foxtrot Feet", durationMinutes: 30, basePriceMinor: 4400 }
] as const;

const bookedOrder = ["F", "C", "A", "E", "B", "D"] as const;

type ServiceRow = { name: string; priceMinor: number };
/** An appointment and the local day it sits on, which the calendar list needs to find it. */
type Booking = { id: string; localDate: string };

describeDatabase("appointment service order", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  const ownerEmail = `service-order-${suffix}@example.test`;
  let ownerCookie: string;
  let businessId: string;
  let locationId: string;
  let customerId: string;
  let petId: string;
  let employeeId: string;
  const serviceIdByKey = new Map<string, string>();

  const idFor = (key: string) => serviceIdByKey.get(key)!;
  const nameFor = (key: string) => catalogue.find((entry) => entry.key === key)!.name;
  const priceFor = (key: string) => catalogue.find((entry) => entry.key === key)!.basePriceMinor;

  /**
   * One appointment per DAY, at 09:00, and the day is the caller's slot number.
   *
   * Six services run 105 minutes together, so several bookings in one day would collide on the
   * single groomer and be refused by the scheduling conflict guard - a 409 that says nothing
   * about service order. A day each keeps every fixture independent and keeps the assertions
   * about the thing they are actually testing.
   */
  const localDateFor = (slot: number) => `2034-07-${String(slot).padStart(2, "0")}`;

  const book = async (keys: readonly string[], slot: number) => {
    const response = await app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId,
        serviceIds: keys.map(idFor),
        localStart: `${localDateFor(slot)}T09:00`,
        expectedLocationVersion: 1
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    return { id: response.json().id as string, localDate: localDateFor(slot) };
  };

  /** The services array exactly as `GET /api/appointments/:id` hands it to the Ticket. */
  const detailServices = async (appointmentId: string): Promise<ServiceRow[]> => {
    const response = await app.inject({
      method: "GET", url: `/api/appointments/${appointmentId}`, headers: { cookie: ownerCookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().services as ServiceRow[])
      .map((service) => ({ name: service.name, priceMinor: service.priceMinor }));
  };

  /** The same array from the calendar LIST, which is the other caller of the same projection. */
  const listServices = async (booking: Booking): Promise<ServiceRow[]> => {
    const response = await app.inject({
      method: "GET", url: `/api/appointments?localDate=${booking.localDate}&days=1`,
      headers: { cookie: ownerCookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json() as { id: string; services: ServiceRow[] }[];
    const found = items.find((item) => item.id === booking.id);
    expect(found, "the booked appointment is in the calendar window").toBeTruthy();
    return found!.services.map((service) => ({ name: service.name, priceMinor: service.priceMinor }));
  };

  /** And from the client profile's history page, which is a SECOND, separate projection. */
  const historyServices = async (appointmentId: string): Promise<ServiceRow[]> => {
    const response = await app.inject({
      method: "GET", url: `/api/customers/${customerId}/appointments?pageSize=100`,
      headers: { cookie: ownerCookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json().items as { id: string; services: ServiceRow[] }[];
    const found = items.find((item) => item.id === appointmentId);
    expect(found, "the booked appointment is in the client's history").toBeTruthy();
    return found!.services.map((service) => ({ name: service.name, priceMinor: service.priceMinor }));
  };

  const storedPositions = (appointmentId: string) => db<{ name: string; position: number }[]>`
    select service_name_snapshot as name, line_position as position
    from appointment_services
    where business_id=${businessId} and appointment_id=${appointmentId}
    order by line_position
  `;

  const expected = (keys: readonly string[]): ServiceRow[] =>
    keys.map((key) => ({ name: nameFor(key), priceMinor: priceFor(key) }));

  const complete = async (appointmentId: string) => {
    for (const status of ["checked_in", "in_service", "completed"]) {
      const moved = await app.inject({
        method: "POST", url: `/api/appointments/${appointmentId}/transition`,
        headers: { cookie: ownerCookie }, payload: { status }
      });
      expect(moved.statusCode, moved.body).toBe(200);
    }
  };

  const checkout = async (appointmentId: string) => {
    const response = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { discountMinor: 0, tipMinor: 0 }
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: ownerEmail, password: "correct horse service order", businessName: "Service Order Salon"
    }});
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());

    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });

    for (const entry of catalogue) {
      const created = await post("/api/services", {
        name: entry.name, baseDurationMinutes: entry.durationMinutes,
        basePriceMinor: entry.basePriceMinor
      });
      expect(created.statusCode, created.body).toBe(201);
      serviceIdByKey.set(entry.key, created.json().id as string);
    }
    // One groomer who offers all six, so `ensureGroomersOfferServices` never decides the fixture.
    const employee = await post("/api/employees", {
      displayName: "Ordered Groomer", serviceIds: catalogue.map((entry) => idFor(entry.key))
    });
    expect(employee.statusCode, employee.body).toBe(201);
    employeeId = employee.json().id as string;
    const customer = await post("/api/customers", {
      firstName: "Order", lastName: "Client", phone: "555-0142"
    });
    expect(customer.statusCode, customer.body).toBe(201);
    customerId = customer.json().id as string;
    const pet = await post("/api/pets", {
      customerId, name: "Sequence", species: "dog", breed: "Poodle"
    });
    expect(pet.statusCode, pet.body).toBe(201);
    petId = pet.json().id as string;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await db?.end({ timeout: 5 });
  });

  /**
   * A. AN UNINVOICED APPOINTMENT HAS AN ORDER.
   *
   * The Ticket is most useful before the visit, so this is the case that matters most and the one
   * an invoice-derived order could never have served.
   */
  it("returns an uninvoiced appointment's services in the order they were booked", async () => {
    const booking = await book(bookedOrder, 8);
    expect(await detailServices(booking.id)).toEqual(expected(bookedOrder));
    // Uninvoiced, stated rather than assumed - the property under test is worthless if the
    // fixture has quietly been checked out.
    const [invoice] = await db`
      select id from invoices where business_id=${businessId} and appointment_id=${booking.id}
    `;
    expect(invoice, "this appointment must have no invoice").toBeUndefined();
  });

  /**
   * H. THE POSITIONS THEMSELVES, not merely the order they happen to produce.
   *
   * Asserting the rendered order alone would pass against a column that was written backwards and
   * read backwards. This asserts what is actually stored: 1..6, in the submitted order.
   */
  it("assigns 1..n in the submitted order when an appointment is created", async () => {
    const booking = await book(bookedOrder, 9);
    expect(await storedPositions(booking.id)).toEqual(
      bookedOrder.map((key, index) => ({ name: nameFor(key), position: index + 1 }))
    );
  });

  /**
   * B and D. THE SAME ORDER, EVERY READ, AND FROM EVERY PROJECTION.
   *
   * Three separate SQL projections serve this array - the calendar list, the single-appointment
   * detail and the client history page - and under the defect each was an independent draw from
   * 720 orderings. Six appointments read three ways, twelve times over, is 216 draws that all had
   * to agree; the chance of that happening by accident is not worth writing down.
   */
  it("returns one identical order from every projection, on every read", async () => {
    const bookings: Booking[] = [];
    for (let index = 0; index < 6; index++) bookings.push(await book(bookedOrder, 10 + index));
    const want = expected(bookedOrder);
    for (let pass = 0; pass < 12; pass++) {
      for (const booking of bookings) {
        expect(await detailServices(booking.id), `detail pass ${pass}`).toEqual(want);
        expect(await listServices(booking), `list pass ${pass}`).toEqual(want);
        expect(await historyServices(booking.id), `history pass ${pass}`).toEqual(want);
      }
    }
  }, 60_000);

  /**
   * G. NAMES AND PRICES STAY ON THE SAME ROW.
   *
   * An ordering change that reordered one column independently of another would produce a sheet
   * that looks plausible and charges the wrong price for the wrong service, which is worse than
   * the arbitrary order it replaced. The six prices are all distinct, so a mispairing cannot hide.
   */
  it("keeps every service name paired with its own price and duration", async () => {
    const booking = await book(bookedOrder, 16);
    const response = await app.inject({
      method: "GET", url: `/api/appointments/${booking.id}`, headers: { cookie: ownerCookie }
    });
    expect(response.statusCode, response.body).toBe(200);
    const services = response.json().services as
      { name: string; priceMinor: number; durationMinutes: number }[];
    expect(services).toEqual(bookedOrder.map((key) => {
      const entry = catalogue.find((row) => row.key === key)!;
      return expect.objectContaining({
        name: entry.name, priceMinor: entry.basePriceMinor, durationMinutes: entry.durationMinutes
      });
    }));
  });

  /**
   * I. AN EDIT RENUMBERS THE SHEET RATHER THAN APPENDING TO IT.
   *
   * `PUT /api/appointments/:id/services` deletes every row for the appointment and reinserts from
   * the submitted list, so the result must be 1..n with no gaps whatever the edit did - dropped
   * services, added services, or the same set in a different order, which is itself a real edit an
   * operator makes.
   */
  it("leaves gap-free positions in the submitted order after an edit", async () => {
    const booking = await book(bookedOrder, 17);
    const edits = [
      ["D", "B", "E", "A", "C", "F"],   // the same six, reversed - order alone is the change
      ["C", "A"],                        // fewer
      ["B", "F", "D", "A"],              // fewer still, different set, different order
      ["E"]                              // one
    ] as const;
    for (const keys of edits) {
      const response = await app.inject({
        method: "PUT", url: `/api/appointments/${booking.id}/services`,
        headers: { cookie: ownerCookie }, payload: { serviceIds: keys.map(idFor) }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(await storedPositions(booking.id), keys.join(",")).toEqual(
        keys.map((key, index) => ({ name: nameFor(key), position: index + 1 }))
      );
      expect(await detailServices(booking.id), keys.join(",")).toEqual(expected(keys));
    }
  }, 30_000);

  /**
   * E. AN INVOICE APPEARING DOES NOT MOVE THE SHEET.
   *
   * Checkout is the moment a Ticket-order derived from `invoice_items` would have started to
   * differ, so the order is captured before the invoice exists and compared with the order after.
   */
  it("does not change the sheet's order when the appointment is checked out", async () => {
    const booking = await book(bookedOrder, 18);
    const before = await detailServices(booking.id);
    expect(before).toEqual(expected(bookedOrder));
    await complete(booking.id);
    await checkout(booking.id);
    expect(await detailServices(booking.id)).toEqual(before);
    expect(await listServices(booking)).toEqual(before);
    expect(await historyServices(booking.id)).toEqual(before);
  }, 30_000);

  /**
   * F. `invoice_items.line_position` IS ITS OWN COLUMN, AND THE DEPENDENCY RUNS ONE WAY ONLY.
   *
   * Checkout numbers the invoice lines from the appointment's order, so the two AGREE when the
   * invoice is raised - but nothing reads the invoice back. Rewriting every invoice line's
   * position behind the API's back is the strongest available statement of that: if the Ticket
   * were deriving its order from the invoice, every read below would come back reversed.
   */
  it("keeps the invoice's own line order independent of the sheet's", async () => {
    const booking = await book(bookedOrder, 19);
    await complete(booking.id);
    const invoiceId = await checkout(booking.id);

    const lines = await db<{ id: string; description: string; position: number }[]>`
      select id, description, line_position as position from invoice_items
      where business_id=${businessId} and invoice_id=${invoiceId} order by line_position
    `;
    // The invoice was numbered FROM the sheet, so at this point they agree.
    expect(lines.map((line) => ({ description: line.description, position: line.position })))
      .toEqual(bookedOrder.map((key, index) => ({ description: nameFor(key), position: index + 1 })));

    // Now make them disagree, in the database, where no API would allow it. Every position is
    // parked above the range first, because `invoice_item_position_unique` from 0006 is checked
    // per statement and a straight reversal would collide with the rows it had yet to move.
    await db`
      update invoice_items set line_position = line_position + 1000
      where business_id=${businessId} and invoice_id=${invoiceId}
    `;
    for (const [index, line] of [...lines].reverse().entries()) {
      await db`
        update invoice_items set line_position=${index + 1}
        where business_id=${businessId} and id=${line.id}
      `;
    }
    const rewritten = await db<{ description: string; position: number }[]>`
      select description, line_position as position from invoice_items
      where business_id=${businessId} and invoice_id=${invoiceId} order by line_position
    `;
    expect(rewritten.map((line) => line.description)).toEqual(
      [...bookedOrder].reverse().map(nameFor)
    );

    // The sheet has not moved, from any of its three projections.
    const want = expected(bookedOrder);
    expect(await detailServices(booking.id)).toEqual(want);
    expect(await listServices(booking)).toEqual(want);
    expect(await historyServices(booking.id)).toEqual(want);
    // And the appointment's own positions are untouched.
    expect(await storedPositions(booking.id)).toEqual(
      bookedOrder.map((key, index) => ({ name: nameFor(key), position: index + 1 }))
    );
  }, 30_000);

  /**
   * The constraint, asserted from the outside.
   *
   * `appointment_service_position_unique` is what stops a future write path inventing a second
   * line 1, and a constraint nobody has ever seen refuse anything is a constraint that might have
   * been created against the wrong columns.
   */
  it("refuses a second row at the same position on one appointment", async () => {
    const booking = await book(["A", "B"], 20);
    const [row] = await db<{ serviceId: string }[]>`
      select service_id from appointment_services
      where business_id=${businessId} and appointment_id=${booking.id} and line_position=2
    `;
    await expect(db`
      insert into appointment_services
        (business_id,appointment_id,service_id,service_name_snapshot,
         duration_minutes_snapshot,price_minor_snapshot,line_position)
      values (${businessId},${booking.id},${row!.serviceId},'Duplicate Position',10,100,1)
    `).rejects.toThrow(/appointment_service_position_unique/u);
    // And zero is not a position.
    await expect(db`
      insert into appointment_services
        (business_id,appointment_id,service_id,service_name_snapshot,
         duration_minutes_snapshot,price_minor_snapshot,line_position)
      values (${businessId},${booking.id},${row!.serviceId},'Zeroth Position',10,100,0)
    `).rejects.toThrow(/appointment_service_position_positive/u);
  });
});
