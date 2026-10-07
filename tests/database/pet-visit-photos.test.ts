import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissionPresets } from "@pawsh/domain";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { MemoryDocumentStorage } from "../../src/storage/documents.js";
import { hashPassword } from "../../src/security/passwords.js";
import { decodablePng } from "../support/images.js";
import { multipartUpload } from "../support/multipart.js";
import { roleFor } from "../support/roles.js";

/**
 * VISIT PHOTOGRAPHS BELONG ON THE PET'S PROFILE, AND THE PICTURE IS CHOSEN BY SOMEBODY.
 *
 * `GET /api/pets/:id/visit-photos` lists every photograph taken of the pet across its visits, and
 * `PATCH /api/pets/:id/avatar` with `appointmentPhotoId` copies one into the pet's own gallery,
 * attributed to the person who chose it, and makes it the picture.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "pet-visit-photo-secret-at-least-thirty-two-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("pet visit photos", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>, storage: MemoryDocumentStorage;
  let ownerCookie: string, managerCookie: string, groomerCookie: string, petsOnlyCookie: string;
  let managerUserId: string, ownerUserId: string;
  let businessId: string, locationId: string, serviceId: string, customerId: string, petId: string;
  let earlyGroomerId: string, lateGroomerId: string;
  let earlyVisitId: string, lateVisitId: string;
  const photos = { lateBefore: "", lateAfter: "", earlyBefore: "", earlyAfter: "" };
  const suffix = crypto.randomUUID();

  const request = (method: "GET" | "PATCH" | "DELETE", url: string, who: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie: who }, ...(payload ? { payload } : {}) });

  async function seat(label: string, permissions: readonly string[]) {
    const email = `visit-photos-${label}-${suffix}@example.test`;
    const password = `correct horse ${label} visit battery`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash,display_name)
      values (${email},${email},${await hashPassword(password)},${label}) returning id
    `;
    await db`
      insert into business_memberships(business_id,user_id,role_id)
      values (${businessId},${user!.id},${await roleFor(db, businessId, permissions)})
    `;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    return { cookie: cookie(login), userId: user!.id };
  }

  async function book(employeeId: string, localStart: string) {
    const booking = await app.inject({
      method: "POST", url: "/api/appointments",
      headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
      payload: {
        locationId, customerId, petId, employeeId, serviceIds: [serviceId],
        localStart, expectedLocationVersion: 1
      }
    });
    expect(booking.statusCode, booking.body).toBe(201);
    return booking.json().id as string;
  }

  async function shoot(appointmentId: string, phase: "before" | "after", width: number) {
    const body = multipartUpload({
      metadata: { petId, phase, uploadRequestId: crypto.randomUUID() },
      file: decodablePng(width, 300), filename: `${phase}.png`, contentType: "image/png"
    });
    const created = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/photos`,
      payload: body.payload, headers: { ...body.headers, cookie: ownerCookie }
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().id as string;
  }

  const petPhotoCount = async () => (await db<{ count: number }[]>`
    select count(*)::int count from pet_photos where business_id=${businessId} and pet_id=${petId}
  `)[0]!.count;

  beforeAll(async () => {
    db = createDatabase(config);
    storage = new MemoryDocumentStorage();
    app = await createApp(config, db, { runWorker: false, serveStatic: false, documentStorage: storage });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `visit-photos-owner-${suffix}@example.test`,
      password: "correct horse visit photo owner", businessName: "Visit Photo Salon"
    }});
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());
    ownerUserId = (await db<{ userId: string }[]>`
      select user_id from business_memberships where business_id=${businessId} and is_owner
    `)[0]!.userId;
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
    serviceId = (await post("/api/services", {
      name: "Visit Groom", baseDurationMinutes: 60, basePriceMinor: 5000
    })).json().id;
    earlyGroomerId = (await post("/api/employees", { displayName: "Early Groomer", serviceIds: [serviceId] })).json().id;
    lateGroomerId = (await post("/api/employees", { displayName: "Late Groomer", serviceIds: [serviceId] })).json().id;
    customerId = (await post("/api/customers", { firstName: "Visit", lastName: "Client" })).json().id;
    petId = (await post("/api/pets", { customerId, name: "Biscuit", species: "dog" })).json().id;

    earlyVisitId = await book(earlyGroomerId, "2034-05-15T09:00");
    lateVisitId = await book(lateGroomerId, "2034-06-20T10:00");
    // Taken out of display order on purpose: the listing orders them, not the upload sequence.
    photos.lateBefore = await shoot(lateVisitId, "before", 410);
    photos.earlyAfter = await shoot(earlyVisitId, "after", 420);
    photos.earlyBefore = await shoot(earlyVisitId, "before", 430);
    photos.lateAfter = await shoot(lateVisitId, "after", 440);

    const manager = await seat("manager", permissionPresets.manager!);
    managerCookie = manager.cookie; managerUserId = manager.userId;
    // The shipped Groomer: pets.view and appointments.view, no pets.edit, not assigned to either visit.
    groomerCookie = (await seat("groomer", permissionPresets.groomer!)).cookie;
    petsOnlyCookie = (await seat("petsonly", ["pets.view"])).cookie;
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it("lists the pet's photographs across visits, newest visit first and After before Before", async () => {
    const listed = await request("GET", `/api/pets/${petId}/visit-photos`, ownerCookie);
    expect(listed.statusCode, listed.body).toBe(200);
    const body = listed.json();
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      photos.lateAfter, photos.lateBefore, photos.earlyAfter, photos.earlyBefore
    ]);
    expect(body.items[0]).toMatchObject({
      id: photos.lateAfter, appointmentId: lateVisitId, visitDate: "2034-06-20", phase: "after",
      caption: null, contentUrl: `/api/appointment-photos/${photos.lateAfter}/content`,
      petPhotoId: null, isAvatar: false
    });
    expect(body.items[0].uploadedAt).toBeTruthy();
    expect(body.items[2]).toMatchObject({ appointmentId: earlyVisitId, visitDate: "2034-05-15" });
    expect(body).toMatchObject({ avatarPhotoId: null, hasMore: false, canSetAvatar: true });
    expect(JSON.stringify(body)).not.toContain("storage");

    const content = await request("GET", body.items[0].contentUrl, ownerCookie);
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/png");
  });

  it("shows a groomer every visit, as the appointment photo read does, and refuses them the picture", async () => {
    const listed = await request("GET", `/api/pets/${petId}/visit-photos`, groomerCookie);
    expect(listed.statusCode, listed.body).toBe(200);
    // Neither visit is assigned to this groomer; the appointment photo read has no assignment filter either.
    expect(listed.json().items).toHaveLength(4);
    expect(listed.json().canSetAvatar).toBe(false);
    const direct = await request("GET", `/api/appointments/${earlyVisitId}/photos`, groomerCookie);
    expect(direct.statusCode).toBe(200);

    const refused = await request("PATCH", `/api/pets/${petId}/avatar`, groomerCookie, {
      appointmentPhotoId: photos.lateAfter
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("Missing permission: pets.edit");
    expect(await petPhotoCount()).toBe(0);
  });

  it("refuses the listing to a caller who could not open the photographs it names", async () => {
    const refused = await request("GET", `/api/pets/${petId}/visit-photos`, petsOnlyCookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("Missing permission: appointments.view");
  });

  it("copies a visit photograph into the pet's gallery as the chooser's, and makes it the picture", async () => {
    const before = storage.objects.size;
    const chosen = await request("PATCH", `/api/pets/${petId}/avatar`, managerCookie, {
      appointmentPhotoId: photos.lateAfter
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    const result = chosen.json();
    expect(result.copied).toBe(true);
    expect(result.photo).toMatchObject({ id: result.avatarPhotoId, width: 440, height: 300, contentType: "image/png" });
    expect(storage.objects.size).toBe(before + 1);

    const [row] = await db<{ uploadedBy: string; uploadRequestId: string; sha256: string; state: string }[]>`
      select uploaded_by,upload_request_id,sha256,state from pet_photos
      where business_id=${businessId} and id=${result.avatarPhotoId}
    `;
    // Attributed to the person who chose it, not to the owner who took the photograph.
    expect(row).toMatchObject({ uploadedBy: managerUserId, uploadRequestId: photos.lateAfter, state: "stored" });
    expect(managerUserId).not.toBe(ownerUserId);
    const [source] = await db<{ sha256: string }[]>`
      select sha256 from appointment_photos where business_id=${businessId} and id=${photos.lateAfter}
    `;
    expect(row!.sha256).toBe(source!.sha256);

    const gallery = (await request("GET", `/api/pets/${petId}/photos`, ownerCookie)).json();
    expect(gallery.avatarPhotoId).toBe(result.avatarPhotoId);
    expect(gallery.items.map((item: { id: string }) => item.id)).toContain(result.avatarPhotoId);

    const audits = await db<{ action: string; actorId: string; afterData: Record<string, unknown> }[]>`
      select action,actor_id,after_data from audit_events
      where business_id=${businessId} and resource_type='pet' and resource_id=${petId}
        and action in ('pet.photo.add','pet.avatar.set')
    `;
    const avatarSet = audits.find((audit) => audit.action === "pet.avatar.set");
    expect(avatarSet).toMatchObject({
      actorId: managerUserId,
      afterData: {
        photoId: result.avatarPhotoId, source: "appointment_photo",
        appointmentPhotoId: photos.lateAfter, appointmentId: lateVisitId
      }
    });
    expect(audits.find((audit) => audit.action === "pet.photo.add")?.actorId).toBe(managerUserId);

    const listed = (await request("GET", `/api/pets/${petId}/visit-photos`, ownerCookie)).json();
    expect(listed.items[0]).toMatchObject({ id: photos.lateAfter, petPhotoId: result.avatarPhotoId, isAvatar: true });
  });

  it("reuses the earlier copy when the same visit photograph is chosen again", async () => {
    const count = await petPhotoCount();
    // Something else becomes the picture in between, so the re-pick is a real change.
    const other = await request("PATCH", `/api/pets/${petId}/avatar`, ownerCookie, { appointmentPhotoId: photos.earlyAfter });
    expect(other.statusCode, other.body).toBe(200);
    expect(await petPhotoCount()).toBe(count + 1);

    const again = await request("PATCH", `/api/pets/${petId}/avatar`, ownerCookie, { appointmentPhotoId: photos.lateAfter });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().copied).toBe(false);
    expect(await petPhotoCount()).toBe(count + 1);
    const [copy] = await db<{ id: string; uploadedBy: string }[]>`
      select id,uploaded_by from pet_photos where business_id=${businessId} and upload_request_id=${photos.lateAfter}
    `;
    expect(again.json().avatarPhotoId).toBe(copy!.id);
    // The copy keeps its original chooser; the re-pick is audited against whoever made it.
    expect(copy!.uploadedBy).toBe(managerUserId);
    const [audit] = await db<{ actorId: string }[]>`
      select actor_id from audit_events
      where business_id=${businessId} and action='pet.avatar.set' and resource_id=${petId}
        and after_data->>'photoId'=${copy!.id} and actor_id=${ownerUserId}
    `;
    expect(audit?.actorId).toBe(ownerUserId);
  });

  it("keeps the copy when the visit photograph is deleted", async () => {
    const [copy] = await db<{ id: string }[]>`
      select id from pet_photos where business_id=${businessId} and upload_request_id=${photos.lateAfter}
    `;
    const removed = await request("DELETE", `/api/appointment-photos/${photos.lateAfter}`, ownerCookie);
    expect(removed.statusCode).toBe(204);
    const content = await request("GET", `/api/pet-photos/${copy!.id}/content`, ownerCookie);
    expect(content.statusCode).toBe(200);
    expect((await request("GET", `/api/pets/${petId}/photos`, ownerCookie)).json().avatarPhotoId).toBe(copy!.id);
  });

  it("refuses a visit photograph of another pet, a malformed body, and an unknown id", async () => {
    const otherPet = (await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Other", species: "dog" }
    })).json().id;
    const wrongPet = await request("PATCH", `/api/pets/${otherPet}/avatar`, ownerCookie, { appointmentPhotoId: photos.earlyBefore });
    expect(wrongPet.statusCode).toBe(404);
    const both = await request("PATCH", `/api/pets/${petId}/avatar`, ownerCookie, {
      photoId: null, appointmentPhotoId: photos.earlyBefore
    });
    expect(both.statusCode).toBe(400);
    const unknown = await request("PATCH", `/api/pets/${petId}/avatar`, ownerCookie, { appointmentPhotoId: crypto.randomUUID() });
    expect(unknown.statusCode).toBe(404);
  });

  it("keeps visit photographs inside their own tenant", async () => {
    const foreign = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `visit-photos-foreign-${suffix}@example.test`,
      password: "correct horse foreign visit photo", businessName: "Foreign Visit Salon"
    }});
    const foreignCookie = cookie(foreign);
    expect((await request("GET", `/api/pets/${petId}/visit-photos`, foreignCookie)).statusCode).toBe(404);
    expect((await request("PATCH", `/api/pets/${petId}/avatar`, foreignCookie, {
      appointmentPhotoId: photos.earlyBefore
    })).statusCode).toBe(404);
    const foreignCustomer = (await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: foreignCookie },
      payload: { firstName: "Foreign", lastName: "Client" }
    })).json().id;
    const foreignPet = (await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: foreignCookie },
      payload: { customerId: foreignCustomer, name: "Stranger", species: "dog" }
    })).json().id;
    // Another salon's pet cannot adopt this salon's photograph either.
    const borrowed = await request("PATCH", `/api/pets/${foreignPet}/avatar`, foreignCookie, {
      appointmentPhotoId: photos.earlyBefore
    });
    expect(borrowed.statusCode).toBe(404);
  });

  it("refuses a copy past the per-pet limit with 409 and stores nothing", async () => {
    const existing = await petPhotoCount();
    for (let index = existing; index < 24; index += 1) {
      const id = crypto.randomUUID();
      await db`
        insert into pet_photos
          (id,business_id,pet_id,state,storage_key,content_type,width,height,size_bytes,sha256,
           original_filename,upload_request_id,uploaded_by)
        values (${id},${businessId},${petId},'stored',${`test/limit/${id}`},'image/png',10,10,1,
          ${"0".repeat(64)},'filler.png',${crypto.randomUUID()},${ownerUserId})
      `;
    }
    const objects = storage.objects.size;
    const refused = await request("PATCH", `/api/pets/${petId}/avatar`, ownerCookie, { appointmentPhotoId: photos.earlyBefore });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe("PHOTO_LIMIT_REACHED");
    expect(await petPhotoCount()).toBe(24);
    expect(storage.objects.size).toBe(objects);
    // A re-pick of a photograph already in the gallery still works at the limit: it adds nothing.
    const reused = await request("PATCH", `/api/pets/${petId}/avatar`, ownerCookie, { appointmentPhotoId: photos.earlyAfter });
    expect(reused.statusCode, reused.body).toBe(200);
    expect(reused.json().copied).toBe(false);
  });
});
