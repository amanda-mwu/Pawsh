import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { MemoryDocumentStorage } from "../../src/storage/documents.js";
import { openSecret } from "../../src/security/secrets.js";
import { decodablePng } from "../support/images.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const sessionSecret = "report-card-secret-at-least-thirty-two-characters";
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: sessionSecret,
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("appointment report cards", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string, businessId: string, locationId: string;
  let customerId: string, petId: string, employeeId: string, serviceId: string, appointmentId: string;
  let cardId: string, cardVersion: number;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, {
      runWorker: false, serveStatic: false, documentStorage: new MemoryDocumentStorage()
    });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `cards-${crypto.randomUUID()}@example.test`,
      password: "correct horse report battery", businessName: "Report Salon"
    }});
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
    serviceId = (await post("/api/services", {
      name: "Full Groom", baseDurationMinutes: 60, basePriceMinor: 8500
    })).json().id;
    employeeId = (await post("/api/employees", {
      displayName: "Grace Groomer", serviceIds: [serviceId]
    })).json().id;
    customerId = (await post("/api/customers", {
      firstName: "Simon", lastName: "Shen", email: `simon-${crypto.randomUUID()}@example.test`
    })).json().id;
    petId = (await post("/api/pets", {
      customerId, name: "Buster", species: "dog", breed: "Australian Cattle Dog"
    })).json().id;
    const booking = await app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId, serviceIds: [serviceId],
        localStart: "2034-06-12T09:00", expectedLocationVersion: 1
      }
    });
    expect(booking.statusCode).toBe(201);
    appointmentId = booking.json().id;
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it("creates one card per pet per visit and refuses a second", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/report-cards`,
      headers: { cookie: ownerCookie }, payload: { petId, note: "Buster was a superstar." }
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      petName: "Buster", customerName: "Simon Shen", note: "Buster was a superstar.", sendCount: 0
    });
    expect(created.json().lastSentAt).toBeNull();
    cardId = created.json().id;
    cardVersion = created.json().version;

    // Two cards for one groom would leave "which one did the client get?" unanswerable.
    const duplicate = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/report-cards`,
      headers: { cookie: ownerCookie }, payload: { petId }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("REPORT_CARD_EXISTS");
  });

  it("refuses an edit against a stale version", async () => {
    const stale = await app.inject({
      method: "PATCH", url: `/api/report-cards/${cardId}`,
      headers: { cookie: ownerCookie }, payload: { note: "Overwritten", version: cardVersion + 5 }
    });
    expect(stale.statusCode).toBe(409);
    const updated = await app.inject({
      method: "PATCH", url: `/api/report-cards/${cardId}`,
      headers: { cookie: ownerCookie },
      payload: { note: "Buster was calm for his nails.", version: cardVersion }
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().note).toBe("Buster was calm for his nails.");
    expect(updated.json().version).toBe(cardVersion + 1);
    cardVersion = updated.json().version;
  });

  it("renders a preview page that can neither run script nor be framed", async () => {
    // A photo on the appointment should appear on the card without being copied into it.
    const boundary = `pawsh-${crypto.randomUUID()}`;
    const image = decodablePng(600, 400);
    const upload = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/photos`,
      headers: {
        cookie: ownerCookie, "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n` +
          `${JSON.stringify({ petId, phase: "after", uploadRequestId: crypto.randomUUID() })}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`
        ),
        image,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ])
    });
    expect(upload.statusCode, upload.body).toBe(201);

    const preview = await app.inject({
      method: "GET", url: `/api/report-cards/${cardId}/preview`, headers: { cookie: ownerCookie }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("text/html");
    const policy = String(preview.headers["content-security-policy"]);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("img-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(preview.headers["x-content-type-options"]).toBe("nosniff");
    expect(preview.body).toContain("Buster");
    expect(preview.body).toContain("Full Groom");
    expect(preview.body).toContain("Buster was calm for his nails.");
    expect(preview.body).toContain(`/api/appointment-photos/${upload.json().id}/content`);
    expect(preview.body).toContain("not yet sent");
    // Staff-only: there is no token in the URL and nothing to hand a client.
    expect(preview.body).not.toContain("token");
  });

  it("escapes tenant text rather than letting it become markup", async () => {
    const hostile = await app.inject({
      method: "PATCH", url: `/api/report-cards/${cardId}`,
      headers: { cookie: ownerCookie },
      payload: { note: "<script>alert('x')</script> & \"quoted\"", version: cardVersion }
    });
    expect(hostile.statusCode).toBe(200);
    cardVersion = hostile.json().version;
    const preview = await app.inject({
      method: "GET", url: `/api/report-cards/${cardId}/preview`, headers: { cookie: ownerCookie }
    });
    expect(preview.body).not.toContain("<script>alert");
    expect(preview.body).toContain("&lt;script&gt;");
    expect(preview.body).toContain("&amp;");
  });

  it("emails the written card and says plainly that photos are not in it", async () => {
    const sent = await app.inject({
      method: "POST", url: `/api/report-cards/${cardId}/send`,
      headers: { cookie: ownerCookie }, payload: { channel: "email" }
    });
    expect(sent.statusCode, sent.body).toBe(202);
    expect(sent.json()).toMatchObject({ channel: "email", queued: true, photosIncluded: false });
    expect(sent.json().card.sendCount).toBe(1);
    expect(sent.json().card.lastSentAt).not.toBeNull();

    const [intent] = await db<{ notificationType: string; encryptedBody: string; destination: string }[]>`
      select notification_type,encrypted_body,destination from notification_intents
      where business_id=${businessId} and notification_type='report_card'
    `;
    expect(intent!.notificationType).toBe("report_card");
    const message = openSecret(intent!.encryptedBody, sessionSecret);
    expect(message).toContain("Buster");
    expect(message).toContain("Full Groom");
    // The client is told where the photographs are instead of being sent a card that silently
    // lacks the thing a report card is mostly about.
    expect(message).toContain("kept on your record at the salon");
  });

  it("refuses SMS by name instead of failing validation", async () => {
    const refused = await app.inject({
      method: "POST", url: `/api/report-cards/${cardId}/send`,
      headers: { cookie: ownerCookie }, payload: { channel: "sms" }
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("REPORT_CARD_CHANNEL_UNSUPPORTED");
    expect(refused.json().supportedChannels).toEqual(["email"]);
  });

  it("refuses a client who cannot be emailed", async () => {
    await db`
      update customers set email_allowed=false where business_id=${businessId} and id=${customerId}
    `;
    const refused = await app.inject({
      method: "POST", url: `/api/report-cards/${cardId}/send`,
      headers: { cookie: ownerCookie }, payload: { channel: "email" }
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("REPORT_CARD_UNDELIVERABLE");
    await db`
      update customers set email_allowed=true where business_id=${businessId} and id=${customerId}
    `;
  });

  it("records create, edit, send, and delete on the appointment's activity", async () => {
    const removed = await app.inject({
      method: "DELETE", url: `/api/report-cards/${cardId}`, headers: { cookie: ownerCookie }
    });
    expect(removed.statusCode).toBe(204);
    const gone = await app.inject({
      method: "GET", url: `/api/report-cards/${cardId}/preview`, headers: { cookie: ownerCookie }
    });
    expect(gone.statusCode).toBe(404);

    const activity = await app.inject({
      method: "GET", url: `/api/appointments/${appointmentId}/activity`, headers: { cookie: ownerCookie }
    });
    const actions = activity.json().items.map((item: { action: string }) => item.action);
    for (const action of ["create", "edit", "send", "delete"]) {
      expect(actions, action).toContain(`appointment.report_card.${action}`);
    }
  });

  it("keeps report cards inside their own tenant", async () => {
    const recreated = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/report-cards`,
      headers: { cookie: ownerCookie }, payload: { petId }
    });
    expect(recreated.statusCode).toBe(201);
    const foreign = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `foreign-cards-${crypto.randomUUID()}@example.test`,
      password: "correct horse foreign cards", businessName: "Foreign Report Salon"
    }});
    for (const [method, url] of [
      ["GET", `/api/report-cards/${recreated.json().id}/preview`],
      ["DELETE", `/api/report-cards/${recreated.json().id}`]
    ] as const) {
      const denied = await app.inject({ method, url, headers: { cookie: cookie(foreign) } });
      expect([403, 404], `${method} ${url}`).toContain(denied.statusCode);
    }
  });

  /**
   * The date preference, proved on a surface the server actually renders.
   *
   * This page is one of the four places the server used to hard-code `en-US`, so a workspace that
   * chose DD/MM/YYYY saw month-first anyway. Asserting it here rather than only against the
   * formatter is the difference between "the function can produce that string" and "the setting
   * reaches the page a client is shown". The appointment is 09:00 on 12 June 2034, a date whose
   * day and month cannot be confused for one another.
   */
  it("renders the preview date in the format the workspace chose", async () => {
    // Read the card that exists for this visit rather than assuming which of the tests above
    // created or removed one: there is at most one per pet per visit, by unique constraint.
    const card = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/report-cards`,
      headers: { cookie: ownerCookie }, payload: { petId }
    });
    expect([201, 409]).toContain(card.statusCode);
    const id = card.statusCode === 201 ? card.json().id : (await db<{ id: string }[]>`
      select id from appointment_report_cards
      where business_id=${businessId} and appointment_id=${appointmentId} and pet_id=${petId}
    `)[0]!.id;
    const preview = async () => (await app.inject({
      method: "GET", url: `/api/report-cards/${id}/preview`, headers: { cookie: ownerCookie }
    })).body;

    const saveSettings = async (payload: Record<string, unknown>) => {
      const current = (await app.inject({
        method: "GET", url: "/api/me", headers: { cookie: ownerCookie }
      })).json();
      const saved = await app.inject({
        method: "PUT", url: "/api/business/settings",
        headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
        payload: {
          name: current.business.name, timezone: current.business.timezone,
          taxRateBasisPoints: current.business.taxRateBasisPoints,
          reminderLeadMinutes: current.business.reminderLeadMinutes,
          locationVersion: current.business.locationVersion, ...payload
        }
      });
      expect(saved.statusCode, saved.body).toBe(200);
    };

    // The default, which is what every workspace behaved as before 0047 - unchanged output for a
    // salon that never opens the setting.
    expect(await preview()).toContain("06/12/2034 at 9:00 AM");

    await saveSettings({ dateFormat: "DD/MM/YYYY", hourFormat: "24" });
    const international = await preview();
    expect(international).toContain("12/06/2034 at 09:00");
    expect(international).not.toContain("06/12/2034");

    // The two are independent columns, so one may move without the other.
    await saveSettings({ hourFormat: "12" });
    expect(await preview()).toContain("12/06/2034 at 9:00 AM");

    await saveSettings({ dateFormat: "MM/DD/YYYY" });
    expect(await preview()).toContain("06/12/2034 at 9:00 AM");
  });
});
