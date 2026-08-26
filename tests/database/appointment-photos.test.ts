import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { MemoryDocumentStorage } from "../../src/storage/documents.js";
import { decodablePng, jpegHeader } from "../support/images.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "appointment-photo-secret-at-least-thirty-two-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

function multipart(metadata: unknown, file: Buffer = decodablePng(), filename = "buster.png", mime = "image/png") {
  const boundary = `pawsh-${crypto.randomUUID()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
  );
  return {
    payload: Buffer.concat([prefix, file, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}

describeDatabase("appointment photos", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>, storage: MemoryDocumentStorage;
  let ownerCookie: string, businessId: string, locationId: string;
  let customerId: string, petId: string, otherPetId: string, employeeId: string;
  let serviceId: string, appointmentId: string;

  beforeAll(async () => {
    db = createDatabase(config);
    storage = new MemoryDocumentStorage();
    app = await createApp(config, db, { runWorker: false, serveStatic: false, documentStorage: storage });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `photos-${crypto.randomUUID()}@example.test`,
      password: "correct horse photo battery", businessName: "Photo Salon"
    }});
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
    serviceId = (await post("/api/services", {
      name: "Photo Groom", baseDurationMinutes: 60, basePriceMinor: 5000
    })).json().id;
    employeeId = (await post("/api/employees", {
      displayName: "Photo Groomer", serviceIds: [serviceId]
    })).json().id;
    customerId = (await post("/api/customers", { firstName: "Photo", lastName: "Client" })).json().id;
    petId = (await post("/api/pets", { customerId, name: "Buster", species: "dog" })).json().id;
    otherPetId = (await post("/api/pets", { customerId, name: "Mochi", species: "dog" })).json().id;
    const booking = await app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId, serviceIds: [serviceId],
        localStart: "2034-05-15T09:00", expectedLocationVersion: 1
      }
    });
    expect(booking.statusCode).toBe(201);
    appointmentId = booking.json().id;
  });
  afterAll(async () => { await app.close(); await db.end(); });

  const upload = (metadata: Record<string, unknown>, file?: Buffer, filename?: string, mime?: string) => {
    const body = multipart(metadata, file, filename, mime);
    return app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/photos`,
      payload: body.payload,
      headers: { ...body.headers, cookie: ownerCookie }
    });
  };

  it("stores a before photo, reads its dimensions, and serves it inline", async () => {
    const created = await upload({
      petId, phase: "before", uploadRequestId: crypto.randomUUID()
    }, decodablePng(1600, 1200));
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      phase: "before", contentType: "image/png", width: 1600, height: 1200, petId
    });

    const listed = await app.inject({
      method: "GET", url: `/api/appointments/${appointmentId}/photos`, headers: { cookie: ownerCookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().pets[0].before).toHaveLength(1);
    expect(listed.json().pets[0].after).toHaveLength(0);
    expect(listed.json().pets[0].petName).toBe("Buster");
    // The storage key never leaves the server; it is the one field that describes the bucket.
    expect(JSON.stringify(listed.json())).not.toContain("storageKey");

    const content = await app.inject({
      method: "GET", url: `/api/appointment-photos/${created.json().id}/content`,
      headers: { cookie: ownerCookie }
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/png");
    // Served inline so it can render in an <img>, which makes these headers load-bearing.
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
    expect(content.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(String(content.headers["content-disposition"])).toContain("inline");
  });

  it("stores what the bytes are, not what the upload claimed", async () => {
    // A JPEG uploaded as image/png with a .png name: both claims are the client's and both are
    // ignored in favour of the header that was actually parsed.
    const jpegBytes = jpegHeader(800, 600);
    const created = await upload({
      petId, phase: "after", uploadRequestId: crypto.randomUUID()
    }, jpegBytes, "mislabelled.png", "image/png");
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().contentType).toBe("image/jpeg");
    expect(created.json().originalFilename).toBe("mislabelled.jpg");
    expect(created.json()).toMatchObject({ width: 800, height: 600 });
  });

  it("refuses anything that is not a readable image", async () => {
    for (const bytes of [
      Buffer.from("%PDF-1.4\n%%EOF\n"),
      Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"),
      Buffer.from("")
    ]) {
      const rejected = await upload({
        petId, phase: "before", uploadRequestId: crypto.randomUUID()
      }, bytes, "payload.png", "image/png");
      expect(rejected.statusCode, rejected.body).toBe(400);
    }
    const stored = await db<{ count: number }[]>`
      select count(*)::int count from appointment_photos where business_id=${businessId}
    `;
    // Nothing reserved a row on the way to being refused.
    expect(stored[0]!.count).toBe(2);
  });

  it("refuses an upload that was cut off part-way through", async () => {
    // The header parses and the dimensions are right; only the missing IEND says the connection
    // dropped. Storing it would put a permanently broken thumbnail on the appointment.
    const complete = decodablePng(640, 480);
    const rejected = await upload({
      petId, phase: "before", uploadRequestId: crypto.randomUUID()
    }, complete.subarray(0, complete.byteLength - 12));
    expect(rejected.statusCode, rejected.body).toBe(400);
  });

  it("reconciles a retried upload to the row it already created", async () => {
    const uploadRequestId = crypto.randomUUID();
    const first = await upload({ petId, phase: "before", uploadRequestId });
    expect(first.statusCode).toBe(201);
    const replay = await upload({ petId, phase: "before", uploadRequestId });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    const [count] = await db<{ count: number }[]>`
      select count(*)::int count from appointment_photos
      where business_id=${businessId} and upload_request_id=${uploadRequestId}
    `;
    expect(count!.count).toBe(1);
  });

  it("refuses a pet that is not on the appointment", async () => {
    const rejected = await upload({
      petId: otherPetId, phase: "before", uploadRequestId: crypto.randomUUID()
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("not on this appointment");
  });

  it("deletes a photo and its stored object together", async () => {
    const created = await upload({ petId, phase: "after", uploadRequestId: crypto.randomUUID() });
    expect(created.statusCode).toBe(201);
    const before = storage.objects.size;
    const removed = await app.inject({
      method: "DELETE", url: `/api/appointment-photos/${created.json().id}`,
      headers: { cookie: ownerCookie }
    });
    expect(removed.statusCode).toBe(204);
    expect(storage.objects.size).toBe(before - 1);
    const gone = await app.inject({
      method: "GET", url: `/api/appointment-photos/${created.json().id}/content`,
      headers: { cookie: ownerCookie }
    });
    expect(gone.statusCode).toBe(404);
  });

  it("records adding and removing a photo on the appointment's activity", async () => {
    const activity = await app.inject({
      method: "GET", url: `/api/appointments/${appointmentId}/activity`, headers: { cookie: ownerCookie }
    });
    expect(activity.statusCode).toBe(200);
    const actions = activity.json().items.map((item: { action: string }) => item.action);
    expect(actions).toContain("appointment.photo.add");
    expect(actions).toContain("appointment.photo.remove");
  });

  it("keeps photos inside their own tenant", async () => {
    const [photo] = await db<{ id: string }[]>`
      select id from appointment_photos where business_id=${businessId} and state='stored' limit 1
    `;
    const foreign = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `foreign-photos-${crypto.randomUUID()}@example.test`,
      password: "correct horse foreign photo", businessName: "Foreign Photo Salon"
    }});
    const denied = await app.inject({
      method: "GET", url: `/api/appointment-photos/${photo!.id}/content`,
      headers: { cookie: cookie(foreign) }
    });
    expect(denied.statusCode).toBe(404);
    const deniedDelete = await app.inject({
      method: "DELETE", url: `/api/appointment-photos/${photo!.id}`,
      headers: { cookie: cookie(foreign) }
    });
    expect([403, 404]).toContain(deniedDelete.statusCode);
  });
});
