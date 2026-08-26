import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { MemoryDocumentStorage } from "../../src/storage/documents.js";
import { decodablePng } from "../support/images.js";
import { multipartFile, multipartUpload } from "../support/multipart.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "pet-profile-secret-at-least-thirty-two-characters",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

describeDatabase("pet profile", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>, storage: MemoryDocumentStorage;
  let ownerCookie: string, businessId: string, customerId: string, petId: string;

  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
  const send = (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie: ownerCookie }, ...(payload ? { payload } : {}) });

  async function uploadPhoto(useAsAvatar = false) {
    const body = multipartUpload({
      metadata: { uploadRequestId: crypto.randomUUID(), useAsAvatar },
      file: decodablePng(400, 400), filename: "pet.png", contentType: "image/png"
    });
    return app.inject({
      method: "POST", url: `/api/pets/${petId}/photos`,
      payload: body.payload, headers: { ...body.headers, cookie: ownerCookie }
    });
  }

  beforeAll(async () => {
    db = createDatabase(config);
    storage = new MemoryDocumentStorage();
    app = await createApp(config, db, { runWorker: false, serveStatic: false, documentStorage: storage });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `petprofile-${crypto.randomUUID()}@example.test`,
      password: "correct horse pet profile", businessName: "Profile Salon"
    }});
    ownerCookie = cookie(signup);
    ({ businessId } = signup.json());
    customerId = (await send("POST", "/api/customers", { firstName: "Pat", lastName: "Owner" })).json().id;
    petId = (await send("POST", "/api/pets", {
      customerId, name: "Tetsu", species: "dog", breed: "Yorkshire Terrier"
    })).json().id;
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it("stores the grooming identity fields with their own vocabularies", async () => {
    const pet = (await get(`/api/pets/${petId}`)).json();
    const updated = await send("PUT", `/api/pets/${petId}`, {
      customerId, name: "Tetsu", species: "dog", breed: "Yorkshire Terrier",
      mixedBreed: false, hairLength: "All Other Coats", coatColor: "Parti",
      fixedStatus: "neutered", preferredShampoo: "Oatmeal",
      approximateAgeYears: 3, approximateAgeMonths: 6,
      version: pet.version
    });
    expect(updated.statusCode, updated.body).toBe(200);
    // Spayed and neutered also carry the sex, which a plain "fixed: yes" would have lost.
    expect(updated.json()).toMatchObject({
      mixedBreed: false, fixedStatus: "neutered", hairLength: "All Other Coats",
      coatColor: "Parti", preferredShampoo: "Oatmeal",
      approximateAgeYears: 3, approximateAgeMonths: 6
    });
    const [stored] = await db<{ mixedBreed: boolean | null }[]>`
      select mixed_breed from pets where business_id=${businessId} and id=${petId}
    `;
    expect(stored!.mixedBreed).toBe(false);
  });

  it("keeps a note thread that records who wrote each entry", async () => {
    const created = await send("POST", `/api/pets/${petId}/notes`, {
      body: "1\" reverse, round head. Sweet boy.", pinned: false
    });
    expect(created.statusCode, created.body).toBe(201);
    const [note] = created.json().items;
    expect(note.body).toContain("reverse, round head");
    expect(note.authorName).toBeTruthy();
    expect(note.createdAt).toBeTruthy();

    const edited = await send("PATCH", `/api/pets/${petId}/notes/${note.id}`, { pinned: true });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().items[0].pinned).toBe(true);
    expect((await send("DELETE", `/api/pets/${petId}/notes/${note.id}`)).statusCode).toBe(204);
    expect((await get(`/api/pets/${petId}/notes`)).json().items).toHaveLength(0);
  });

  it("distinguishes health issues never asked from none reported", async () => {
    const care = () => get(`/api/pets/${petId}`);
    // Never asked.
    expect((await care()).json().healthIssues).toBeNull();

    const version = (await care()).json().version;
    const asked = await send("PUT", `/api/pets/${petId}/care`, { healthIssues: [], version });
    expect(asked.statusCode, asked.body).toBe(200);
    expect((await care()).json().healthIssues).toEqual([]);

    const recorded = await send("PUT", `/api/pets/${petId}/care`, {
      healthIssues: ["arthritis", "obesity"], version: (await care()).json().version
    });
    expect(recorded.statusCode).toBe(200);
    expect((await care()).json().healthIssues).toEqual(["arthritis", "obesity"]);
  });

  it("refuses rabies as a health issue and as a free vaccination record", async () => {
    // Rabies has one authoritative home; a second unverified answer is what compliance cannot afford.
    const asIssue = await send("PUT", `/api/pets/${petId}/care`, {
      healthIssues: ["rabies_shot"], version: (await get(`/api/pets/${petId}`)).json().version
    });
    expect(asIssue.statusCode).toBe(400);

    const asRecord = await send("POST", `/api/pets/${petId}/vaccinations`, {
      vaccine: "Rabies", expiresOn: "2029-02-13"
    });
    expect(asRecord.statusCode).toBe(409);
    expect(asRecord.json().code).toBe("RABIES_MANAGED_ELSEWHERE");
    // Case does not get around it either.
    expect((await send("POST", `/api/pets/${petId}/vaccinations`, { vaccine: " rabies " })).statusCode).toBe(409);
  });

  it("keeps other vaccination records with optimistic concurrency", async () => {
    const created = await send("POST", `/api/pets/${petId}/vaccinations`, {
      vaccine: "Bordetella", expiresOn: "2028-05-01"
    });
    expect(created.statusCode, created.body).toBe(201);
    const listed = await get(`/api/pets/${petId}/vaccinations`);
    expect(listed.statusCode).toBe(200);
    const record = listed.json().items.find((item: { vaccine: string }) => item.vaccine === "Bordetella");
    expect(record).toBeTruthy();
    // Rabies is reported beside them and flagged as owned elsewhere.
    expect(listed.json().rabies.managedElsewhere).toBe(true);

    const stale = await send("PATCH", `/api/pet-vaccinations/${record.id}`, {
      expiresOn: "2030-01-01", version: record.version + 3
    });
    expect(stale.statusCode).toBe(409);
    const edited = await send("PATCH", `/api/pet-vaccinations/${record.id}`, {
      expiresOn: "2030-01-01", version: record.version
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await send("DELETE", `/api/pet-vaccinations/${record.id}`)).statusCode).toBe(204);
  });

  it("attaches a rabies document and links it from the vaccination table", async () => {
    // The question this answers: can a certificate actually be attached, and does the link the
    // pet profile renders actually open it?
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
    const body = multipartUpload({
      metadata: {
        uploadRequestId: crypto.randomUUID(), expectedCurrentDocumentId: null,
        expiration: { intent: "preserve" }
      },
      file: pdf, filename: "rabies.pdf", contentType: "application/pdf"
    });
    const upload = await app.inject({
      method: "POST", url: `/api/pets/${petId}/documents/rabies`,
      payload: body.payload, headers: { ...body.headers, cookie: ownerCookie }
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const documentId = upload.json().id;

    // The vaccination table reads the document from the place that owns rabies.
    const listed = await get(`/api/pets/${petId}/vaccinations`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().rabies.documentId).toBe(documentId);

    // And the link the profile renders opens the certificate rather than downloading it.
    const viewed = await get(`/api/pet-documents/${documentId}/download?disposition=inline`);
    expect(viewed.statusCode, viewed.body.slice(0, 200)).toBe(200);
    expect(viewed.headers["content-type"]).toBe("application/pdf");
    expect(String(viewed.headers["content-disposition"])).toContain("inline");
    expect(viewed.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(viewed.headers["content-security-policy"])).toContain("default-src 'none'");
    // Without the flag it still downloads, so nothing that relied on that changed.
    const downloaded = await get(`/api/pet-documents/${documentId}/download`);
    expect(String(downloaded.headers["content-disposition"])).toContain("attachment");
  });

  it("attaches a PDF or an image to a vaccination record and serves it inline", async () => {
    const created = await send("POST", `/api/pets/${petId}/vaccinations`, {
      vaccine: "DHPP", expiresOn: "2031-01-01"
    });
    expect(created.statusCode, created.body).toBe(201);
    const vaccinationId = created.json().id;

    const attach = (file: Buffer, filename: string, contentType: string) => {
      const body = multipartFile({ file, filename, contentType });
      return app.inject({
        method: "POST", url: `/api/pet-vaccinations/${vaccinationId}/document`,
        payload: body.payload, headers: { ...body.headers, cookie: ownerCookie }
      });
    };

    const image = await attach(decodablePng(320, 240), "card.png", "image/png");
    expect(image.statusCode, image.body).toBe(201);
    expect(image.json()).toMatchObject({ contentType: "image/png" });

    const listed = await get(`/api/pets/${petId}/vaccinations`);
    const row = listed.json().items.find((item: { id: string }) => item.id === vaccinationId);
    expect(row.hasDocument).toBe(true);

    const served = await get(`/api/pet-vaccinations/${vaccinationId}/document`);
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(served.headers["content-disposition"])).toContain("inline");

    // A PDF is equally acceptable, and replacing the attachment keeps the record readable.
    const pdf = await attach(
      Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"), "card.pdf", "application/pdf"
    );
    expect(pdf.statusCode, pdf.body).toBe(201);
    expect((await get(`/api/pet-vaccinations/${vaccinationId}/document`)).headers["content-type"])
      .toBe("application/pdf");

    // What the bytes are, not what the upload claimed.
    const rejected = await attach(Buffer.from("just text, not a document"), "note.pdf", "application/pdf");
    expect(rejected.statusCode).toBe(400);

    expect((await send("DELETE", `/api/pet-vaccinations/${vaccinationId}`)).statusCode).toBe(204);
  });

  it("stores vet details as structured fields behind the care permission", async () => {
    const version = (await get(`/api/pets/${petId}`)).json().version;
    const saved = await send("PUT", `/api/pets/${petId}/care`, {
      vetName: "Bayview Animal Hospital", vetPhone: "(408) 555-0100",
      vetContactName: "Dr. Rivera", vetContactPhone: "(408) 555-0101",
      vetAddress: "1 Bay Street, San Jose, CA", version
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await get(`/api/pets/${petId}`)).json()).toMatchObject({
      vetName: "Bayview Animal Hospital", vetContactName: "Dr. Rivera"
    });
  });

  it("takes photographs, makes the first one the avatar, and lets another be chosen", async () => {
    const first = await uploadPhoto();
    expect(first.statusCode, first.body).toBe(201);
    let gallery = (await get(`/api/pets/${petId}/photos`)).json();
    // A gallery with a picture in it and a profile still showing an initial helps nobody.
    expect(gallery.avatarPhotoId).toBe(first.json().id);

    const second = await uploadPhoto();
    expect(second.statusCode).toBe(201);
    gallery = (await get(`/api/pets/${petId}/photos`)).json();
    // A later upload does not quietly change the face on the profile.
    expect(gallery.avatarPhotoId).toBe(first.json().id);
    expect(gallery.items).toHaveLength(2);

    const chosen = await send("PATCH", `/api/pets/${petId}/avatar`, { photoId: second.json().id });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect((await get(`/api/pets/${petId}/photos`)).json().avatarPhotoId).toBe(second.json().id);

    const content = await get(`/api/pet-photos/${second.json().id}/content`);
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/png");
    expect(content.headers["x-content-type-options"]).toBe("nosniff");

    // Deleting the portrait falls back to an initial rather than pointing at bytes that are gone.
    expect((await send("DELETE", `/api/pet-photos/${second.json().id}`)).statusCode).toBe(204);
    expect((await get(`/api/pets/${petId}/photos`)).json().avatarPhotoId).toBeNull();
  });

  it("marks a pet as having died without hiding its history", async () => {
    const marked = await send("POST", `/api/pets/${petId}/deceased`, { deceased: true });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json().deceasedAt).toBeTruthy();
    // The record stays readable: its invoices and report cards still have to be explainable.
    expect((await get(`/api/pets/${petId}`)).statusCode).toBe(200);
    const cleared = await send("POST", `/api/pets/${petId}/deceased`, { deceased: false });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().deceasedAt).toBeNull();
  });

  it("keeps pet profile data inside its own tenant", async () => {
    const foreign = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `foreign-profile-${crypto.randomUUID()}@example.test`,
      password: "correct horse foreign profile", businessName: "Foreign Profile Salon"
    }});
    const foreignCookie = cookie(foreign);
    for (const url of [
      `/api/pets/${petId}/notes`, `/api/pets/${petId}/photos`, `/api/pets/${petId}/vaccinations`
    ]) {
      const denied = await app.inject({ method: "GET", url, headers: { cookie: foreignCookie } });
      expect([403, 404], url).toContain(denied.statusCode);
    }
  });
});
