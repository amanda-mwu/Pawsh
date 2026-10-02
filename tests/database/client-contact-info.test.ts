import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissionPresets, unenforcedPermissions } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { roleFor } from "../support/roles.js";

/**
 * `customers.contact_info` IS THE SWITCH, AND THE SERVER IS WHERE IT BITES.
 *
 * A client's phone, email and postal address - and a secondary contact's phone - leave the server
 * only for a member holding the key, or the owner. Everybody else gets the field as null and the
 * owning object says `contactWithheld: true`; the client's name, the pet and its care, the notes
 * and the services stay, because they are what the appointment is about. Every case below is
 * stated by PERMISSION, never by role name: the Receptionist and the Groomer appear with and
 * without the key, and a custom role does too, so a check that read the role's name would fail
 * here. The sweep at the end asks every read a member without the key can reach whether any of
 * the seeded contact strings appear anywhere in it.
 *
 * The contact values are synthetic sentinels in the reserved 555-01xx range and the
 * `example.test` domain, chosen so a substring match cannot be satisfied by anything else.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "client-contact-info-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const sessionCookie = (response: { headers: Record<string, unknown> }) => {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
};

const KEY = "customers.contact_info";
const without = (permissions: readonly string[]) => permissions.filter((key) => key !== KEY);

describeDatabase("customers.contact_info withholds client contact details at the projection", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string, businessId: string, locationId: string;
  let customerId: string, petId: string, serviceId: string, employeeId: string, appointmentId: string;
  let rivalCookie: string;
  const suffix = crypto.randomUUID().slice(0, 8);
  const day = "2036-02-03";
  const PHONE = "555-0142";
  const PHONE_DIGITS = "5550142";
  const EMAIL = `contact-sentinel-${suffix}@example.test`;
  const ADDRESS = `77 Sentinel Lane ${suffix}`;
  const SECOND_ADDRESS = `9 Beacon Row ${suffix}`;
  const CONTACT_PHONE = "555-0177";
  const CONTACT_DIGITS = "5550177";
  const sentinels = [PHONE, PHONE_DIGITS, EMAIL, ADDRESS, SECOND_ADDRESS, CONTACT_PHONE, CONTACT_DIGITS];

  const seats: Record<string, string> = {};

  const request = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, cookie: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

  async function seat(label: string, permissions: readonly string[]) {
    const email = `contact-${label}-${suffix}@example.test`;
    const password = `correct horse contact ${label}`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash,display_name)
      values (${email},${email},${await hashPassword(password)},${label}) returning id
    `;
    const [membership] = await db<{ id: string }[]>`
      insert into business_memberships(business_id,user_id,role_id)
      values (${businessId},${user!.id},${await roleFor(db, businessId, permissions)}) returning id
    `;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    expect(login.statusCode, login.body).toBe(200);
    return { cookie: sessionCookie(login), membershipId: membership!.id };
  }

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `contact-owner-${suffix}@example.test`, password: "correct horse contact owner",
      businessName: `Contact Salon ${suffix}`
    }});
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = sessionCookie(signup);
    ({ businessId, locationId } = signup.json());
    const post = async (url: string, payload: Record<string, unknown>) => {
      const response = await request("POST", url, ownerCookie, payload);
      expect(response.statusCode, `${url}: ${response.body}`).toBeLessThan(300);
      return response.json();
    };
    serviceId = (await post("/api/services", { name: `Contact Groom ${suffix}`, baseDurationMinutes: 60, basePriceMinor: 6000 })).id;
    customerId = (await post("/api/customers", {
      firstName: "Sentinel", lastName: "Client", phone: PHONE, email: EMAIL, address: ADDRESS
    })).id;
    await post(`/api/customers/${customerId}/addresses`, { address: SECOND_ADDRESS, label: "Cabin" });
    await post(`/api/customers/${customerId}/contacts`, { name: "Partner Person", phone: CONTACT_PHONE });
    petId = (await post("/api/pets", { customerId, name: "Sentinel Pet", species: "dog", breed: "Poodle" })).id;

    const groomerSeat = await seat("groomer", permissionPresets.groomer!);
    seats.groomerWithout = groomerSeat.cookie;
    employeeId = (await post("/api/employees", {
      displayName: `Contact Groomer ${suffix}`, serviceIds: [serviceId], membershipId: groomerSeat.membershipId
    })).id;
    const booking = await app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: { locationId, customerId, petId, employeeId, serviceIds: [serviceId], localStart: `${day}T10:00`, expectedLocationVersion: 1 }
    });
    expect(booking.statusCode, booking.body).toBe(201);
    appointmentId = booking.json().id;
    // A client reminder, so the reminder list has a client-email destination to withhold.
    await db`
      insert into notification_intents
        (business_id,appointment_id,customer_id,notification_type,scheduled_occurrence,channel,destination)
      values (${businessId},${appointmentId},${customerId},'appointment_reminder',now(),'email',${EMAIL})
    `;

    seats.receptionistWith = (await seat("desk-with", permissionPresets.receptionist!)).cookie;
    seats.receptionistWithout = (await seat("desk-without", without(permissionPresets.receptionist!))).cookie;
    seats.groomerWith = (await seat("groomer-with", [...permissionPresets.groomer!, KEY])).cookie;
    const custom = ["calendar.view", "appointments.view", "customers.view", "pets.view"];
    seats.customWith = (await seat("custom-with", [...custom, KEY])).cookie;
    seats.customWithout = (await seat("custom-without", custom)).cookie;
    seats.owner = ownerCookie;

    const rival = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `contact-rival-${suffix}@example.test`, password: "correct horse contact rival",
      businessName: `Rival Salon ${suffix}`
    }});
    rivalCookie = sessionCookie(rival);
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it("is an enforced permission the Receptionist preset holds and the Groomer preset does not", () => {
    expect(unenforcedPermissions.has(KEY)).toBe(false);
    expect(permissionPresets.receptionist).toContain(KEY);
    expect(permissionPresets.groomer).not.toContain(KEY);
    expect(permissionPresets.manager).toContain(KEY);
  });

  it("provisions a new workspace's Receptionist with the key and its Groomer without it", async () => {
    const roles = await db<{ name: string; permissions: string[] }[]>`
      select name,permissions from roles where business_id=${businessId} and built_in
    `;
    const named = (name: string) => roles.find((role) => role.name === name)!.permissions;
    expect(named("Receptionist")).toContain(KEY);
    expect(named("Manager")).toContain(KEY);
    expect(named("Groomer")).not.toContain(KEY);
  });

  const visible = ["owner", "receptionistWith", "groomerWith", "customWith"] as const;
  const hidden = ["receptionistWithout", "groomerWithout", "customWithout"] as const;

  it("decides the appointment's phone, the rail's client and the pet's owner by the key alone", async () => {
    for (const label of [...visible, ...hidden]) {
      const shows = (visible as readonly string[]).includes(label);
      const cookie = seats[label]!;
      const appointment = await request("GET", `/api/appointments/${appointmentId}`, cookie);
      expect(appointment.statusCode, `${label}: ${appointment.body}`).toBe(200);
      expect(appointment.json(), label).toMatchObject({
        customerPhone: shows ? PHONE : null, contactWithheld: !shows,
        // Appointment context is never withheld.
        firstName: "Sentinel", lastName: "Client", petName: "Sentinel Pet"
      });
      const client = await request("GET", `/api/appointments/${appointmentId}/client`, cookie);
      expect(client.statusCode, `${label}: ${client.body}`).toBe(200);
      expect(client.json().history.customer, label).toMatchObject({
        firstName: "Sentinel", phone: shows ? PHONE : null, email: shows ? EMAIL : null,
        contactWithheld: !shows
      });
      const emailChannel = client.json().agreements.delivery.channels
        .find((channel: { channel: string }) => channel.channel === "email");
      expect(emailChannel.destination, label).toBe(shows ? EMAIL : null);
      const pet = await request("GET", `/api/pets/${petId}`, cookie);
      expect(pet.statusCode, `${label}: ${pet.body}`).toBe(200);
      expect(pet.json(), label).toMatchObject({
        name: "Sentinel Pet", customerPhone: shows ? PHONE : null, customerEmail: shows ? EMAIL : null,
        contactWithheld: !shows
      });
    }
  });

  it("decides the client record, the directory and its search by the key alone", async () => {
    for (const label of ["owner", "receptionistWith", "customWith", "receptionistWithout", "customWithout"]) {
      const shows = (visible as readonly string[]).includes(label);
      const cookie = seats[label]!;
      const history = await request("GET", `/api/customers/${customerId}/history`, cookie);
      expect(history.statusCode, `${label}: ${history.body}`).toBe(200);
      expect(history.json().customer, label).toMatchObject({
        phone: shows ? PHONE : null, email: shows ? EMAIL : null, contactWithheld: !shows
      });
      const addresses = await request("GET", `/api/customers/${customerId}/addresses`, cookie);
      expect(addresses.json().contactWithheld, label).toBe(!shows);
      expect(addresses.json().items.length, label).toBe(shows ? 2 : 0);
      const contacts = await request("GET", `/api/customers/${customerId}/contacts`, cookie);
      expect(contacts.json().contactWithheld, label).toBe(!shows);
      expect(contacts.json().items[0], label).toMatchObject({
        name: "Partner Person", phone: shows ? CONTACT_PHONE : null
      });
      const paged = await request("GET", `/api/customers?paged=true&q=Sentinel`, cookie);
      expect(paged.json().items[0], label).toMatchObject({ phone: shows ? PHONE : null, contactWithheld: !shows });
      // A number is not a search key for somebody who may not read it.
      const byPhone = await request("GET", `/api/customers?paged=true&q=${PHONE_DIGITS}`, cookie);
      expect(byPhone.json().items.length, label).toBe(shows ? 1 : 0);
      const byEmail = await request("GET", `/api/customers?q=${encodeURIComponent(EMAIL)}`, cookie);
      expect(byEmail.json().length, label).toBe(shows ? 1 : 0);
    }
  });

  it("refuses a contact write from a caller without the key, and leaves the record untouched", async () => {
    const desk = seats.receptionistWithout!;
    const stored = async () => (await db<{ phone: string | null; email: string | null; address: string | null }[]>`
      select phone,email,address from customers where id=${customerId}
    `)[0]!;
    const forbidden = { code: "CONTACT_INFO_FORBIDDEN" };
    for (const payload of [{ phone: "555-0100" }, { email: null }, { address: "" }]) {
      const refused = await request("PUT", `/api/customers/${customerId}`, desk, { firstName: "Sentinel", ...payload });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject(forbidden);
    }
    expect(await stored()).toEqual({ phone: PHONE, email: EMAIL, address: ADDRESS });
    // The rest of the record is still theirs to edit, and the answer withholds what it withheld.
    const renamed = await request("PUT", `/api/customers/${customerId}`, desk, { lastName: "Client" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ phone: null, email: null, contactWithheld: true });
    expect(await stored()).toEqual({ phone: PHONE, email: EMAIL, address: ADDRESS });

    expect((await request("POST", "/api/customers", desk, { firstName: "Walk", phone: "555-0101" })).json())
      .toMatchObject(forbidden);
    const nameOnly = await request("POST", "/api/customers", desk, { firstName: "Walk", lastName: "In" });
    expect(nameOnly.statusCode, nameOnly.body).toBe(201);

    for (const [method, url, payload] of [
      ["POST", `/api/customers/${customerId}/addresses`, { address: "1 Elsewhere" }],
      ["POST", `/api/customers/${customerId}/contacts`, { name: "Someone", phone: "555-0102" }]
    ] as const) {
      const refused = await request(method, url, desk, payload);
      expect(refused.statusCode, `${url}: ${refused.body}`).toBe(403);
      expect(refused.json()).toMatchObject(forbidden);
    }
    // The same edit from the desk WITH the key lands.
    const edited = await request("PUT", `/api/customers/${customerId}`, seats.receptionistWith!, { phone: PHONE });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ phone: PHONE, contactWithheld: false });
  });

  it("still answers another business's client and appointment as not found", async () => {
    for (const url of [`/api/customers/${customerId}/history`, `/api/appointments/${appointmentId}`,
      `/api/appointments/${appointmentId}/client`, `/api/pets/${petId}`]) {
      const response = await request("GET", url, rivalCookie);
      expect(response.statusCode, url).toBe(404);
      for (const value of sentinels) expect(response.body, url).not.toContain(value);
    }
  });

  it("lets no read a member without the key can reach carry a seeded contact string", async () => {
    const reads = [
      `/api/appointments?localDate=${day}&days=1`, `/api/appointments/${appointmentId}`,
      `/api/appointments/${appointmentId}/client`, `/api/appointments/${appointmentId}/activity`,
      `/api/appointments/${appointmentId}/report-cards`,
      `/api/customers`, `/api/customers?paged=true`, `/api/customers?q=Sentinel`,
      `/api/customers/${customerId}/history`, `/api/customers/${customerId}/addresses`,
      `/api/customers/${customerId}/contacts`, `/api/customers/${customerId}/agreements`,
      `/api/customers/${customerId}/notes`, `/api/customers/${customerId}/appointments`,
      `/api/pets`, `/api/pets?customerId=${customerId}`, `/api/pets/${petId}`,
      `/api/pets/${petId}/appointments`,
      `/api/reminders?type=appointment_reminder`, `/api/dashboard`
    ];
    let reached = 0;
    for (const label of hidden) {
      for (const url of reads) {
        const response = await request("GET", url, seats[label]!);
        if (response.statusCode === 200) reached += 1;
        for (const value of sentinels) {
          expect(response.body.includes(value), `${label} ${url} carries ${value}`).toBe(false);
        }
      }
    }
    // The sweep is only evidence if it reached things: each of the three answered most reads.
    expect(reached).toBeGreaterThan(20);
    // And the same reads DO carry them for a holder, so the sweep is not passing on empty bodies.
    const holder = await request("GET", `/api/reminders?type=appointment_reminder`, seats.receptionistWith!);
    expect(holder.body).toContain(EMAIL);
    const withheld = await request("GET", `/api/reminders?type=appointment_reminder`, seats.receptionistWithout!);
    expect(withheld.json().items[0]).toMatchObject({ destination: null, contactWithheld: true });
  });
});
