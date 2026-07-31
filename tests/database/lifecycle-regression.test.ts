import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { formatWallTime } from "../../src/domain/time.js";
import { hashPassword } from "../../src/security/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test",
  DOCUMENT_STORAGE_ADAPTER: "memory",
  PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "test-session-secret-at-least-thirty-two-characters",
  APP_ORIGIN: "http://localhost:3000",
  SMTP_PORT: 587,
  SMTP_SECURE: false
};

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
}

interface Gate {
  appointmentId: string;
  arrived: Promise<void>;
  signalArrived: () => void;
  release: () => void;
  released: Promise<void>;
}

function gate(appointmentId: string): Gate {
  let signalArrived = () => {};
  let release = () => {};
  return {
    appointmentId,
    arrived: new Promise<void>((resolve) => { signalArrived = resolve; }),
    signalArrived,
    released: new Promise<void>((resolve) => { release = resolve; }),
    release
  };
}

describeDatabase("D2 appointment lifecycle regression", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let completionBarrier: {
    appointmentId: string;
    arrived: number;
    released: Promise<void>;
    release: () => void;
  } | null = null;
  let lifecycleGate: Gate | null = null;
  let bookingGate: {
    arrived: Promise<void>;
    signalArrived: () => void;
    released: Promise<void>;
    release: () => void;
  } | null = null;
  let ownerCookie: string;
  let memberCookie: string;
  let businessId: string;
  let locationId: string;
  let customerId: string;
  let petId: string;
  let employeeId: string;
  let serviceId: string;

  const suffix = crypto.randomUUID();
  const createAppointment = async (startAt: string, cookie = ownerCookie) =>
    app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie },
      payload: { locationId, customerId, petId, employeeId, serviceIds: [serviceId], localStart:formatWallTime(startAt,"America/Los_Angeles"),expectedLocationVersion:1 }
    });
  const transition = (
    id: string,
    status: "checked_in" | "in_service" | "completed" | "cancelled" | "no_show",
    version?: number,
    cookie = ownerCookie
  ) => app.inject({
    method: "POST",
    url: `/api/appointments/${id}/transition`,
    headers: { cookie },
    payload: { status, ...(version === undefined ? {} : { version }) }
  });
  const advanceToInService = async (startAt: string) => {
    const created = await createAppointment(startAt);
    expect(created.statusCode).toBe(201);
    let appointment = created.json<{ id: string; version: number }>();
    for (const status of ["checked_in", "in_service"] as const) {
      const response = await transition(appointment.id, status, appointment.version);
      expect(response.statusCode).toBe(200);
      appointment = response.json();
    }
    return appointment;
  };
  const scopedCount = async (
    table: "audit_events" | "outbox_events" | "product_analytics_events",
    appointmentId: string,
    field: "action" | "event_type" | "event_name",
    value: string
  ) => {
    const rows = await db<{ count: number }[]>`
      select count(*)::int as count from ${db(table)}
      where business_id=${businessId}
        and resource_id=${appointmentId}
        and ${db(field)}=${value}
    `;
    return rows[0]!.count;
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, {
      runWorker: false,
      serveStatic: false,
      lifecycleHooks: {
        async beforeRowLock({ appointmentId, targetStatus }) {
          if (targetStatus !== "completed") return;
          if (completionBarrier?.appointmentId === appointmentId) {
            const active = completionBarrier;
            active.arrived += 1;
            if (active.arrived === 2) {
              completionBarrier = null;
              active.release();
            }
            await active.released;
          }
          if (lifecycleGate?.appointmentId === appointmentId) {
            const active = lifecycleGate;
            active.signalArrived();
            await active.released;
            lifecycleGate = null;
          }
        }
      },
      schedulingHooks: {
        async beforeLock({ operation }) {
          if (operation !== "create" || !bookingGate) return;
          const active = bookingGate;
          active.signalArrived();
          await active.released;
          bookingGate = null;
        }
      }
    });
    await app.ready();

    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        email: `lifecycle-owner-${suffix}@example.test`,
        password: "correct horse lifecycle battery",
        businessName: "D2 Lifecycle"
      }
    });
    expect(signup.statusCode).toBe(201);
    ownerCookie = sessionCookie(signup);
    ({ businessId, locationId } = signup.json());

    const service = await app.inject({
      method: "POST",
      url: "/api/services",
      headers: { cookie: ownerCookie },
      payload: { name: "D2 Groom", baseDurationMinutes: 60, basePriceMinor: 7000 }
    });
    serviceId = service.json().id;
    const employee = await app.inject({
      method: "POST",
      url: "/api/employees",
      headers: { cookie: ownerCookie },
      payload: { displayName: "D2 Groomer", serviceIds: [serviceId] }
    });
    employeeId = employee.json().id;
    const customer = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { cookie: ownerCookie },
      payload: { firstName: "D2", lastName: "Customer", preferredContactMethod: "none", emailAllowed: false }
    });
    customerId = customer.json().id;
    const pet = await app.inject({
      method: "POST",
      url: "/api/pets",
      headers: { cookie: ownerCookie },
      payload: { customerId, name: "D2 Pet", species: "dog" }
    });
    petId = pet.json().id;

    const email = `lifecycle-member-${suffix}@example.test`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash)
      values (${email},${email},${await hashPassword("correct horse lifecycle member")})
      returning id
    `;
    await db`
      insert into business_memberships(business_id,user_id,permissions)
      values (${businessId},${user!.id},${["appointments.view"]})
    `;
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "correct horse lifecycle member" }
    });
    memberCookie = sessionCookie(login);
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("enforces the transition, permission, tenant, repeat, and event contracts", async () => {
    const main = await createAppointment("2033-01-03T17:00:00.000Z");
    let current = main.json<{ id: string; version: number }>();
    const checkIn = await transition(current.id, "checked_in", current.version);
    expect(checkIn.statusCode).toBe(200);
    current = checkIn.json();
    const started = await transition(current.id, "in_service", current.version);
    expect(started.statusCode).toBe(200);
    current = started.json();
    const completed = await transition(current.id, "completed", current.version);
    expect(completed.statusCode).toBe(200);
    current = completed.json();

    expect((await transition(current.id, "completed")).statusCode).toBe(400);
    expect((await transition(main.json().id, "checked_in", main.json().version)).statusCode).toBe(409);
    expect((await transition(current.id, "checked_in", undefined, memberCookie)).statusCode).toBe(403);

    expect(await scopedCount("audit_events", current.id, "action", "appointment.checked_in")).toBe(1);
    expect(await scopedCount("audit_events", current.id, "action", "appointment.in_service")).toBe(1);
    expect(await scopedCount("audit_events", current.id, "action", "appointment.completed")).toBe(1);
    expect(await scopedCount("outbox_events", current.id, "event_type", "AppointmentCheckedIn")).toBe(1);
    expect(await scopedCount("outbox_events", current.id, "event_type", "AppointmentStarted")).toBe(1);
    expect(await scopedCount("outbox_events", current.id, "event_type", "AppointmentCompleted")).toBe(1);
    expect(await scopedCount("product_analytics_events", current.id, "event_name", "AppointmentCompleted")).toBe(1);

    const cancelled = await createAppointment("2033-01-04T17:00:00.000Z");
    const cancelledResult = await transition(cancelled.json().id, "cancelled", cancelled.json().version);
    expect(cancelledResult.statusCode).toBe(200);
    expect(await scopedCount("audit_events", cancelled.json().id, "action", "appointment.cancelled")).toBe(1);
    expect(await scopedCount("outbox_events", cancelled.json().id, "event_type", "AppointmentCancelled")).toBe(1);

    const noShow = await createAppointment("2033-01-05T17:00:00.000Z");
    const noShowResult = await transition(noShow.json().id, "no_show", noShow.json().version);
    expect(noShowResult.statusCode).toBe(200);
    expect((await transition(noShow.json().id, "no_show")).statusCode).toBe(400);
    expect(await scopedCount("audit_events", noShow.json().id, "action", "appointment.no_show")).toBe(1);
    expect(await scopedCount("outbox_events", noShow.json().id, "event_type", "AppointmentNoShow")).toBe(0);
    expect(await scopedCount("product_analytics_events", noShow.json().id, "event_name", "AppointmentNoShow")).toBe(0);

    const foreignSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        email: `lifecycle-foreign-${suffix}@example.test`,
        password: "correct horse lifecycle foreign",
        businessName: "Foreign D2"
      }
    });
    const foreignCookie = sessionCookie(foreignSignup);
    const foreignAttempt = await transition(current.id, "checked_in", undefined, foreignCookie);
    expect(foreignAttempt.statusCode).toBe(404);
  });

  it("preserves D1 occupancy across every blocking and nonblocking lifecycle state", async () => {
    const startAt = "2033-02-01T17:00:00.000Z";
    const created = await createAppointment(startAt);
    let appointment = created.json<{ id: string; version: number }>();
    expect((await createAppointment(startAt)).statusCode).toBe(409);
    for (const status of ["checked_in", "in_service"] as const) {
      const response = await transition(appointment.id, status, appointment.version);
      appointment = response.json();
      expect((await createAppointment(startAt)).statusCode).toBe(409);
    }
    const completed = await transition(appointment.id, "completed", appointment.version);
    expect(completed.statusCode).toBe(200);
    expect((await createAppointment(startAt)).statusCode).toBe(201);

    for (const [date, terminal] of [
      ["2033-02-02T17:00:00.000Z", "cancelled"],
      ["2033-02-03T17:00:00.000Z", "no_show"]
    ] as const) {
      const scheduled = await createAppointment(date);
      expect((await createAppointment(date)).statusCode).toBe(409);
      expect((await transition(scheduled.json().id, terminal, scheduled.json().version)).statusCode).toBe(200);
      expect((await createAppointment(date)).statusCode).toBe(201);
    }
  });

  it("serializes concurrent supplied-version completion into one 200 and one 409", async () => {
    const appointment = await advanceToInService("2033-03-01T17:00:00.000Z");
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    completionBarrier = { appointmentId: appointment.id, arrived: 0, released, release };
    const results = await Promise.all([
      transition(appointment.id, "completed", appointment.version),
      transition(appointment.id, "completed", appointment.version)
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const [persisted] = await db<{ status: string }[]>`
      select status from appointments where business_id=${businessId} and id=${appointment.id}
    `;
    expect(persisted?.status).toBe("completed");
    expect(await scopedCount("audit_events", appointment.id, "action", "appointment.completed")).toBe(1);
    expect(await scopedCount("outbox_events", appointment.id, "event_type", "AppointmentCompleted")).toBe(1);
    expect(await scopedCount("product_analytics_events", appointment.id, "event_name", "AppointmentCompleted")).toBe(1);
  });

  it("matches completion-versus-booking outcomes to scheduling-lock order", async () => {
    const bookingFirst = await advanceToInService("2033-03-02T17:00:00.000Z");
    lifecycleGate = gate(bookingFirst.id);
    const completionAfter = transition(bookingFirst.id, "completed", bookingFirst.version);
    await lifecycleGate.arrived;
    const rejectedBooking = await createAppointment("2033-03-02T17:00:00.000Z");
    expect(rejectedBooking.statusCode).toBe(409);
    lifecycleGate.release();
    expect((await completionAfter).statusCode).toBe(200);

    const lifecycleFirst = await advanceToInService("2033-03-03T17:00:00.000Z");
    let signalArrived = () => {};
    let release = () => {};
    bookingGate = {
      arrived: new Promise<void>((resolve) => { signalArrived = resolve; }),
      signalArrived,
      released: new Promise<void>((resolve) => { release = resolve; }),
      release
    };
    const bookingAfter = createAppointment("2033-03-03T17:00:00.000Z");
    await bookingGate.arrived;
    expect((await transition(lifecycleFirst.id, "completed", lifecycleFirst.version)).statusCode).toBe(200);
    bookingGate.release();
    expect((await bookingAfter).statusCode).toBe(201);
  });
});
