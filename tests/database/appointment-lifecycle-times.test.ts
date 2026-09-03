import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { roleFor } from "../support/roles.js";

/**
 * Check-in and check-out are STORED, and this is the suite that says what that means.
 *
 * Two writers touch these columns and they are deliberately unlike each other. The transition
 * route stamps them as a SIDE EFFECT OF DOING THE WORK - it never accepts a time, it takes the
 * clock - and `PATCH /api/appointments/:id/times` does nothing but accept times, because it
 * exists to correct a record after the fact. The tests below are grouped that way, and the
 * property that ties them together is that neither writer can produce a row the other would
 * have to reject: `appointment_times_ordered` holds across both.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "appointment-lifecycle-times-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("stored appointment check-in and check-out times", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  let ownerCookie = "";
  /** Holds every `operations.*` permission but NOT `appointments.edit`. */
  let operatorCookie = "";
  /** Holds `appointments.edit` but no `operations.*`. */
  let editorCookie = "";
  let businessId = "";
  let locationId = "";
  let employeeId = "";
  let serviceId = "";
  let customerId = "";
  let petId = "";
  let day = 1;

  /** One `scheduled` appointment, inserted directly so no two share an employee interval. */
  async function scheduled(): Promise<string> {
    const start = `2035-05-${String(day).padStart(2, "0")}T16:00:00.000Z`;
    const end = `2035-05-${String(day).padStart(2, "0")}T17:00:00.000Z`;
    const local = `2035-05-${String(day).padStart(2, "0")}T09:00:00`;
    day += 1;
    const [appointment] = await db<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      select ${businessId},${locationId},${customerId},${petId},${employeeId},
        ${start}::timestamptz,${end}::timestamptz,'America/Los_Angeles',${local},-420,'scheduled',user_id,user_id
      from business_memberships where business_id=${businessId} and is_owner returning id
    `;
    await db`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
        duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment!.id},${serviceId},'Lifecycle Groom',60,7200)
    `;
    return appointment!.id;
  }

  const transition = (id: string, status: string, session = ownerCookie) =>
    app.inject({
      method: "POST", url: `/api/appointments/${id}/transition`,
      headers: { cookie: session }, payload: { status }
    });

  const patchTimes = (id: string, payload: Record<string, unknown>, session = ownerCookie) =>
    app.inject({
      method: "PATCH", url: `/api/appointments/${id}/times`,
      headers: { cookie: session }, payload
    });

  /**
   * A timestamp far enough in the past to be a plausible correction, computed rather than
   * written down. A hardcoded year is a test that starts failing on a calendar rather than on a
   * defect - and this route deliberately refuses times in the future, so a literal chosen today
   * would eventually be one.
   */
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  const stored = async (id: string) => {
    const [row] = await db<{ checkedInAt: Date | null; checkedOutAt: Date | null; version: number }[]>`
      select checked_in_at,checked_out_at,version from appointments
      where business_id=${businessId} and id=${id}
    `;
    return row!;
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const ownerEmail = `times-owner-${suffix}@example.test`;
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: ownerEmail, password: "correct horse times battery", businessName: "Times Salon" }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());

    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
    serviceId = (await post("/api/services", {
      name: "Lifecycle Groom", baseDurationMinutes: 60, basePriceMinor: 7200
    })).json().id;
    employeeId = (await post("/api/employees", {
      displayName: "Lifecycle Groomer", serviceIds: [serviceId]
    })).json().id;
    customerId = (await post("/api/customers", {
      firstName: "Lifecycle", lastName: "Client", phone: "555-0177"
    })).json().id;
    petId = (await post("/api/pets", {
      customerId, name: "Lifecycle Pet", species: "dog", breed: "Poodle"
    })).json().id;

    const member = async (label: string, permissions: readonly string[]) => {
      const email = `times-${label}-${suffix}@example.test`;
      const password = `correct horse ${label} battery`;
      const [user] = await db<{ id: string }[]>`
        insert into users(email,normalized_email,password_hash,display_name)
        values (${email},${email},${await hashPassword(password)},${label}) returning id
      `;
      await db`
        insert into business_memberships(business_id,user_id,role_id)
        values (${businessId},${user!.id},${await roleFor(db, businessId, permissions)})
      `;
      return cookie(await app.inject({
        method: "POST", url: "/api/auth/login", payload: { email, password }
      }));
    };
    operatorCookie = await member("operator", [
      "calendar.view", "appointments.view",
      "operations.check_in", "operations.perform_service", "operations.complete"
    ]);
    editorCookie = await member("editor", [
      "calendar.view", "appointments.view", "appointments.edit"
    ]);
  }, 30_000);

  afterAll(async () => { await app.close(); await db.end(); });

  it("stamps check-in on checked_in and check-out on completed, and nothing in between", async () => {
    const id = await scheduled();
    expect((await stored(id)).checkedInAt).toBeNull();

    expect((await transition(id, "checked_in")).statusCode).toBe(200);
    const afterCheckIn = await stored(id);
    expect(afterCheckIn.checkedInAt).toBeInstanceOf(Date);
    expect(afterCheckIn.checkedOutAt).toBeNull();

    // `in_service` is a status change and not an arrival or a departure, so it moves neither
    // column - including, importantly, not re-stamping the check-in.
    expect((await transition(id, "in_service")).statusCode).toBe(200);
    const afterStart = await stored(id);
    expect(afterStart.checkedInAt?.getTime()).toBe(afterCheckIn.checkedInAt?.getTime());
    expect(afterStart.checkedOutAt).toBeNull();

    expect((await transition(id, "completed")).statusCode).toBe(200);
    const afterComplete = await stored(id);
    expect(afterComplete.checkedInAt?.getTime()).toBe(afterCheckIn.checkedInAt?.getTime());
    expect(afterComplete.checkedOutAt).toBeInstanceOf(Date);
    expect(afterComplete.checkedOutAt!.getTime())
      .toBeGreaterThanOrEqual(afterComplete.checkedInAt!.getTime());
  });

  it("writes the column in the same instant as the audit event it follows from", async () => {
    const id = await scheduled();
    await transition(id, "checked_in");
    await transition(id, "in_service");
    await transition(id, "completed");
    const row = await stored(id);
    const [audits] = await db<{ checkedIn: Date; completed: Date }[]>`
      select
        (select created_at from audit_events where business_id=${businessId} and resource_id=${id}
          and action='appointment.checked_in') as checked_in,
        (select created_at from audit_events where business_id=${businessId} and resource_id=${id}
          and action='appointment.completed') as completed
    `;
    // Same transaction, same `now()`. The stored value and the audit trail are one series, which
    // is what makes the 0049 backfill and every write after it comparable.
    expect(row.checkedInAt!.getTime()).toBe(audits!.checkedIn.getTime());
    expect(row.checkedOutAt!.getTime()).toBe(audits!.completed.getTime());
  });

  it("records no check-out for a cancellation or a no-show", async () => {
    for (const status of ["cancelled", "no_show"] as const) {
      const id = await scheduled();
      expect((await transition(id, status)).statusCode).toBe(200);
      const row = await stored(id);
      // A visit that was called off did not end. It never began, so neither column is written and
      // the detail view keeps saying "not recorded" rather than reporting a duration of nothing.
      expect(row.checkedInAt).toBeNull();
      expect(row.checkedOutAt).toBeNull();
    }
  });

  it("keeps a check-in that a later cancellation does not close", async () => {
    // There is no path from `checked_in` to `cancelled` in `canTransition`, so this is the
    // reachable version of the same shape: an arrival with no departure, which is what an
    // appointment still on the table looks like all day.
    const id = await scheduled();
    await transition(id, "checked_in");
    const row = await stored(id);
    expect(row.checkedInAt).toBeInstanceOf(Date);
    expect(row.checkedOutAt).toBeNull();
  });

  it("corrects both times, bumps the version, and writes its own audit event", async () => {
    const id = await scheduled();
    await transition(id, "checked_in");
    await transition(id, "in_service");
    await transition(id, "completed");
    const before = await stored(id);

    const checkedInAt = minutesAgo(200);
    const checkedOutAt = minutesAgo(95);
    const patched = await patchTimes(id, { checkedInAt, checkedOutAt, reason: "Keyed in late" });
    expect(patched.statusCode, patched.body).toBe(200);
    // The response is the calendar row, so a detail screen re-renders from the projection it
    // opened with instead of merging two shapes.
    expect(patched.json()).toMatchObject({ id, petName: "Lifecycle Pet", status: "completed" });
    expect(new Date(patched.json().checkedInAt).toISOString()).toBe(checkedInAt);
    expect(new Date(patched.json().checkedOutAt).toISOString()).toBe(checkedOutAt);

    const after = await stored(id);
    expect(after.checkedInAt!.toISOString()).toBe(checkedInAt);
    expect(after.checkedOutAt!.toISOString()).toBe(checkedOutAt);
    expect(after.version).toBe(before.version + 1);

    // The correction is appended, not substituted: the original transition events are untouched
    // and a second event says what was changed, from what, to what, and why.
    const audits = await db<{ action: string; beforeData: unknown; afterData: unknown; reason: string | null }[]>`
      select action,before_data,after_data,reason from audit_events
      where business_id=${businessId} and resource_id=${id} order by created_at,id
    `;
    expect(audits.map((audit) => audit.action)).toEqual([
      "appointment.checked_in", "appointment.in_service", "appointment.completed",
      "appointment.times_edit"
    ]);
    const edit = audits.at(-1)!;
    expect(edit.reason).toBe("Keyed in late");
    expect(new Date((edit.beforeData as { checkedInAt: string }).checkedInAt).getTime())
      .toBe(before.checkedInAt!.getTime());
    expect(new Date((edit.afterData as { checkedOutAt: string }).checkedOutAt).toISOString())
      .toBe(checkedOutAt);
  });

  it("clears a time that was recorded by mistake", async () => {
    const id = await scheduled();
    await transition(id, "checked_in");
    // `null` is a value the form can submit, not an absent field, because un-recording a time is
    // as much a correction as changing one.
    const cleared = await patchTimes(id, { checkedInAt: null, checkedOutAt: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const row = await stored(id);
    expect(row.checkedInAt).toBeNull();
    expect(row.checkedOutAt).toBeNull();
  });

  it("refuses a check-out earlier than its check-in, and admits an equal one", async () => {
    const id = await scheduled();
    const inverted = await patchTimes(id, {
      checkedInAt: minutesAgo(60), checkedOutAt: minutesAgo(120)
    });
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json().code).toBe("APPOINTMENT_TIMES_OUT_OF_ORDER");
    expect((await stored(id)).checkedInAt).toBeNull();

    const sameInstant = minutesAgo(120);
    const equal = await patchTimes(id, { checkedInAt: sameInstant, checkedOutAt: sameInstant });
    expect(equal.statusCode, equal.body).toBe(200);
  });

  it("refuses a recorded time in the future", async () => {
    const id = await scheduled();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rejected = await patchTimes(id, { checkedInAt: future, checkedOutAt: null });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe("APPOINTMENT_TIME_IN_FUTURE");
    expect((await stored(id)).checkedInAt).toBeNull();
    // The rule is about the future and not about this appointment's schedule: the visit above is
    // booked in 2035 and a past stamp on it is still a legitimate correction to accept.
    const past = await patchTimes(id, { checkedInAt: minutesAgo(300), checkedOutAt: null });
    expect(past.statusCode, past.body).toBe(200);
  });

  it("rejects a bare local timestamp with no offset", async () => {
    const id = await scheduled();
    const naive = await patchTimes(id, { checkedInAt: "2035-05-01T09:00:00", checkedOutAt: null });
    expect(naive.statusCode).toBe(400);
  });

  it("is gated on appointments.edit rather than on the operations permissions", async () => {
    const id = await scheduled();
    // The person who ran the front desk can check the dog in...
    expect((await transition(id, "checked_in", operatorCookie)).statusCode).toBe(200);
    // ...and cannot then rewrite the time they did it at.
    const forbidden = await patchTimes(id, { checkedInAt: minutesAgo(30), checkedOutAt: null }, operatorCookie);
    expect(forbidden.statusCode).toBe(403);

    // And the converse holds, so the assertion above is about the permission and not about the
    // member: `appointments.edit` may correct the record and may not perform the operation.
    const editing = await patchTimes(id, { checkedInAt: minutesAgo(30), checkedOutAt: null }, editorCookie);
    expect(editing.statusCode, editing.body).toBe(200);
    expect((await transition(id, "in_service", editorCookie)).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/api/appointments/${id}/times`, payload: {} })).statusCode).toBe(401);
  });

  it("rejects a stale version and 404s across a tenant boundary", async () => {
    const id = await scheduled();
    const { version } = await stored(id);
    const stale = await patchTimes(id, {
      checkedInAt: minutesAgo(45), checkedOutAt: null, version: version + 5
    });
    expect(stale.statusCode).toBe(409);
    expect((await stored(id)).checkedInAt).toBeNull();

    const current = await patchTimes(id, {
      checkedInAt: minutesAgo(45), checkedOutAt: null, version
    });
    expect(current.statusCode, current.body).toBe(200);

    const unknown = await patchTimes(crypto.randomUUID(), { checkedInAt: null, checkedOutAt: null });
    expect(unknown.statusCode).toBe(404);
  });

  it("holds the ordering constraint in the database, not only in the route", async () => {
    const id = await scheduled();
    await expect(db`
      update appointments set checked_in_at='2035-05-01T17:00:00Z', checked_out_at='2035-05-01T16:00:00Z'
      where business_id=${businessId} and id=${id}
    `).rejects.toThrow(/appointment_times_ordered/);
    // Either side alone is unconstrained, because a visit in progress has one and not the other.
    await db`
      update appointments set checked_in_at='2035-05-01T17:00:00Z', checked_out_at=null
      where business_id=${businessId} and id=${id}
    `;
    await db`
      update appointments set checked_in_at=null, checked_out_at='2035-05-01T16:00:00Z'
      where business_id=${businessId} and id=${id}
    `;
  });

  it("carries the times and the invoice id on the calendar projection", async () => {
    const id = await scheduled();
    await transition(id, "checked_in");
    await transition(id, "in_service");
    await transition(id, "completed");

    const detail = await app.inject({
      method: "GET", url: `/api/appointments/${id}`, headers: { cookie: ownerCookie }
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const row = detail.json();
    expect(row.checkedInAt).toEqual(expect.any(String));
    expect(row.checkedOutAt).toEqual(expect.any(String));
    // The number Check Out opens against, present before any invoice exists.
    expect(row.servicesSubtotalMinor).toBe(7200);
    // An uninvoiced visit is unbilled rather than unpaid, and the id says so by being absent.
    expect(row.invoiceId).toBeNull();

    const invoice = await app.inject({
      method: "POST", url: `/api/appointments/${id}/checkout`,
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { discountMinor: 0, discountType: null, tipMinor: 0 }
    });
    expect(invoice.statusCode, invoice.body).toBe(201);
    const billed = (await app.inject({
      method: "GET", url: `/api/appointments/${id}`, headers: { cookie: ownerCookie }
    })).json();
    // The join was always there for the status and the balance; the id is what lets a screen that
    // can see "Open · $72.00 due" open the bill that says so.
    expect(billed.invoiceId).toBe(invoice.json().id);
    expect(billed.invoiceStatus).toBe("open");

    // And the list projection agrees field for field, which is the contract those two endpoints
    // have always had.
    const [scheduledOn] = await db<{ localDate: string }[]>`
      select to_char(scheduled_local_start,'YYYY-MM-DD') as local_date from appointments
      where business_id=${businessId} and id=${id}
    `;
    const list = await app.inject({
      method: "GET", url: `/api/appointments?localDate=${scheduledOn!.localDate}&days=1`,
      headers: { cookie: ownerCookie }
    });
    expect(list.statusCode, list.body).toBe(200);
    const listed = (list.json() as { id: string }[]).find((candidate) => candidate.id === id);
    expect(listed).toEqual(billed);
  });
});
