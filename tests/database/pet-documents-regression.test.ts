import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { MemoryDocumentStorage } from "../../src/storage/documents.js";
import { roleFor } from "../support/roles.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "test-session-secret-at-least-thirty-two-characters",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");

function diagnosticPdf(size: number): Buffer {
  const bytes = Buffer.alloc(size, 32);
  bytes.write("%PDF-1.4\n", 0, "ascii");
  bytes.write("\n%%EOF\n", size - 7, "ascii");
  return bytes;
}

function cookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  if (typeof value !== "string") throw new Error("Session cookie missing");
  return value.split(";", 1)[0]!;
}

function multipart(
  metadata: unknown,
  file: Buffer<ArrayBufferLike> = pdf,
  filename = "rabies-certificate.pdf",
  mime = "application/pdf"
) {
  const boundary = `pawsh-${crypto.randomUUID()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`+
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
  );
  return {
    payload: Buffer.concat([prefix, file, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}

describeDatabase("D3.2 rabies vaccination documents", () => {
  let db: Database;
  let storage: MemoryDocumentStorage;
  let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string;
  let businessId: string;
  let petId: string;
  const suffix = crypto.randomUUID();

  beforeAll(async () => {
    db = createDatabase(config);
    storage = new MemoryDocumentStorage();
    app = await createApp(config, db, { runWorker: false, serveStatic: false, documentStorage: storage });
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `documents-${suffix}@example.test`, password: "correct horse document battery",
      businessName: `Documents ${suffix}`
    }});
    expect(signup.statusCode).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId } = signup.json());
    const customer = await app.inject({ method: "POST", url: "/api/customers", headers: { cookie: ownerCookie }, payload: {
      firstName: "Document", lastName: "Customer", email: `customer-${suffix}@example.test`
    }});
    const pet = await app.inject({ method: "POST", url: "/api/pets", headers: { cookie: ownerCookie }, payload: {
      customerId: customer.json().id, name: "Evidence", species: "dog"
    }});
    petId = pet.json().id;
  });

  afterAll(async () => { await app?.close(); await db?.end(); });

  const metadata = (overrides: Record<string, unknown> = {}) => ({
    uploadRequestId: crypto.randomUUID(), expectedCurrentDocumentId: null,
    expiration: { intent: "preserve" }, ...overrides
  });

  it("uploads, replays durably, downloads safely, and preserves superseded history", async () => {
    const firstMetadata = metadata({ documentDate: "2035-01-02" });
    const firstBody = multipart(firstMetadata);
    const first = await app.inject({ method: "POST", url: `/api/pets/${petId}/documents/rabies`,
      headers: { cookie: ownerCookie, ...firstBody.headers }, payload: firstBody.payload });
    expect(first.statusCode).toBe(201);
    const firstDocument = first.json();
    expect(firstDocument).not.toHaveProperty("storageKey");

    const replayBody = multipart(firstMetadata);
    const replay = await app.inject({ method: "POST", url: `/api/pets/${petId}/documents/rabies`,
      headers: { cookie: ownerCookie, ...replayBody.headers }, payload: replayBody.payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(firstDocument.id);
    expect(storage.objects.size).toBe(1);

    const replacementMetadata = metadata({
      expectedCurrentDocumentId: firstDocument.id, expectedCurrentDocumentVersion: 1
    });
    const replacementBody = multipart(replacementMetadata, pdf, "replacement;\".pdf");
    const replacement = await app.inject({ method: "POST", url: `/api/pets/${petId}/documents/rabies`,
      headers: { cookie: ownerCookie, ...replacementBody.headers }, payload: replacementBody.payload });
    expect(replacement.statusCode).toBe(200);
    expect(replacement.json().expiresOn).toBeNull();

    const list = await app.inject({ method: "GET", url: `/api/pets/${petId}/documents`, headers: { cookie: ownerCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().current.id).toBe(replacement.json().id);
    expect(list.json().previous.map((item: { id: string }) => item.id)).toContain(firstDocument.id);

    const download = await app.inject({ method: "GET", url: `/api/pet-documents/${firstDocument.id}/download`,
      headers: { cookie: ownerCookie, range: "bytes=0-2" } });
    expect(download.statusCode).toBe(200);
    expect(download.headers["accept-ranges"]).toBeUndefined();
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.headers["cache-control"]).toBe("private, no-store");
    expect(download.rawPayload).toEqual(pdf);

    const [pet] = await db<{ version: number; vaccinationExpiresOn: string | Date }[]>`
      select version,vaccination_expires_on from pets where id=${petId}
    `;
    expect(pet?.version).toBe(1);
    expect(pet?.vaccinationExpiresOn).toBeNull();
    const [events] = await db<{ documents: number; care: number }[]>`
      select count(*) filter (where action in ('pet.document.uploaded','pet.document.replaced'))::int as documents,
        count(*) filter (where action='pet.care.update')::int as care
      from audit_events where business_id=${businessId} and resource_id in (${firstDocument.id},${replacement.json().id},${petId})
    `;
    expect(events).toEqual({ documents: 2, care: 0 });
    await expect(db`update pet_documents set sha256=${"0".repeat(64)} where id=${firstDocument.id}`)
      .rejects.toThrow(/superseded pet documents are immutable/);
  });

  it("rolls promotion back when audit persistence fails", async () => {
    const [before] = await db<{ id: string; documentVersion: number }[]>`
      select id,document_version from pet_documents
      where business_id=${businessId} and pet_id=${petId} and state='current'
    `;
    const failingApp = await createApp(config, db, {
      runWorker: false, serveStatic: false, documentStorage: storage,
      documentHooks: { beforeDocumentAudit: async () => { throw new Error("injected audit failure"); } }
    });
    const replacementMetadata = metadata({
      expectedCurrentDocumentId: before!.id, expectedCurrentDocumentVersion: before!.documentVersion
    });
    const body = multipart(replacementMetadata);
    const response = await failingApp.inject({ method: "POST", url: `/api/pets/${petId}/documents/rabies`,
      headers: { cookie: ownerCookie, ...body.headers }, payload: body.payload });
    expect(response.statusCode).toBe(503);
    const [after] = await db<{ id: string }[]>`
      select id from pet_documents where business_id=${businessId} and pet_id=${petId} and state='current'
    `;
    expect(after?.id).toBe(before?.id);
    await failingApp.close();
  });

  it("serializes true first-upload races with one handled loser", async () => {
    const customer = await app.inject({ method: "POST", url: "/api/customers", headers: { cookie: ownerCookie }, payload: {
      firstName: "Race", lastName: "Customer"
    }});
    const pet = await app.inject({ method: "POST", url: "/api/pets", headers: { cookie: ownerCookie }, payload: {
      customerId: customer.json().id, name: "Concurrent", species: "dog"
    }});
    const make = () => {
      const value = multipart(metadata());
      return app.inject({ method: "POST", url: `/api/pets/${pet.json().id}/documents/rabies`,
        headers: { cookie: ownerCookie, ...value.headers }, payload: value.payload });
    };
    const responses = await Promise.all([make(), make()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201,409]);
    const [current] = await db<{ count: number }[]>`
      select count(*)::int as count from pet_documents
      where business_id=${businessId} and pet_id=${pet.json().id} and state='current'
    `;
    expect(current?.count).toBe(1);
  });

  it("does not disclose metadata or permit mutation without current care authority", async () => {
    const email = `documents-limited-${suffix}@example.test`;
    const password = "correct horse limited battery";
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash) values (${email},${email},${await hashPassword(password)}) returning id
    `;
    await db`insert into business_memberships(business_id,user_id,role_id)
      values (${businessId},${user!.id},${await roleFor(db, businessId, ["customers.view"])})`;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    const limitedCookie = cookie(login);
    const list = await app.inject({ method: "GET", url: `/api/pets/${petId}/documents`, headers: { cookie: limitedCookie } });
    expect(list.statusCode).toBe(403);
    const uploadBody = multipart(metadata());
    const upload = await app.inject({ method: "POST", url: `/api/pets/${petId}/documents/rabies`,
      headers: { cookie: limitedCookie, ...uploadBody.headers }, payload: uploadBody.payload });
    expect(upload.statusCode).toBe(403);
  });

  it("does not disclose known document or pet identifiers across tenants", async () => {
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `documents-foreign-${suffix}@example.test`, password: "correct horse foreign battery",
      businessName: `Foreign ${suffix}`
    }});
    const foreignCookie = cookie(signup);
    const foreign = signup.json();
    const [current] = await db<{ id: string }[]>`
      select id from pet_documents where business_id=${businessId} and pet_id=${petId} and state='current'
    `;
    const list = await app.inject({ method: "GET", url: `/api/pets/${petId}/documents`, headers: { cookie: foreignCookie } });
    expect(list.statusCode).toBe(404);
    const download = await app.inject({ method: "GET", url: `/api/pet-documents/${current!.id}/download`,
      headers: { cookie: foreignCookie } });
    expect(download.statusCode).toBe(404);
    const body = multipart(metadata());
    const upload = await app.inject({ method: "POST", url: `/api/pets/${petId}/documents/rabies`,
      headers: { cookie: foreignCookie, ...body.headers }, payload: body.payload });
    expect(upload.statusCode).toBe(404);
    await expect(db`
      insert into pet_documents
        (business_id,pet_id,document_type,state,original_filename,safe_download_filename,
         storage_key,content_type,uploaded_by)
      values (${foreign.businessId},${petId},'rabies_vaccination','pending','x.pdf','x.pdf',
        ${`foreign/${crypto.randomUUID()}`},'application/pdf',${foreign.userId})
    `).rejects.toThrow();
  });

  it("rechecks membership before promotion", async () => {
    class BlockingStorage extends MemoryDocumentStorage {
      entered!: () => void; release!: () => void;
      readonly started = new Promise<void>((resolve) => { this.entered = resolve; });
      readonly continue = new Promise<void>((resolve) => { this.release = resolve; });
      override async put(key: string, bytes: Uint8Array) {
        this.entered(); await this.continue; return super.put(key, bytes, "application/pdf");
      }
    }
    const blocking = new BlockingStorage();
    const isolatedApp = await createApp(config, db, { runWorker: false, serveStatic: false, documentStorage: blocking });
    const email = `documents-revoked-${suffix}@example.test`;
    const password = "correct horse revoked battery";
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash) values (${email},${email},${await hashPassword(password)}) returning id
    `;
    const [membership] = await db<{ id: string }[]>`
      insert into business_memberships(business_id,user_id,role_id)
      values (${businessId},${user!.id},${await roleFor(db, businessId, ["pets.edit","pets.care.edit"])}) returning id
    `;
    const login = await isolatedApp.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    const memberCookie = cookie(login);
    const [current] = await db<{ id: string; documentVersion: number }[]>`
      select id,document_version from pet_documents
      where business_id=${businessId} and pet_id=${petId} and state='current'
    `;
    const body = multipart(metadata({
      expectedCurrentDocumentId: current!.id, expectedCurrentDocumentVersion: current!.documentVersion
    }));
    const pending = isolatedApp.inject({ method: "POST", url: `/api/pets/${petId}/documents/rabies`,
      headers: { cookie: memberCookie, ...body.headers }, payload: body.payload });
    await blocking.started;
    await db`update business_memberships set role_id=${await roleFor(db, businessId, [])} where id=${membership!.id}`;
    blocking.release();
    const response = await pending;
    expect(response.statusCode).toBe(403);
    await isolatedApp.close();
  });

  it("records bounded 1/5/10 MiB ingestion and retrieval diagnostics", async () => {
    const [owner] = await db<{ userId: string }[]>`
      select user_id from business_memberships where business_id=${businessId} and is_owner
    `;
    const diagnostics: Array<{
      sizeMiB: number; uploadMs: number[]; metadataMs: number; downloadMs: number; responseBytes: number;
    }> = [];
    for (const sizeMiB of [1,5,10]) {
      const [customer] = await db<{ id: string }[]>`
        insert into customers(business_id,first_name,last_name,created_by,updated_by)
        values (${businessId},'Diagnostic',${`${sizeMiB} MiB`},${owner!.userId},${owner!.userId}) returning id
      `;
      const [pet] = await db<{ id: string }[]>`
        insert into pets(business_id,customer_id,name,created_by,updated_by)
        values (${businessId},${customer!.id},${`Diagnostic ${sizeMiB}`},${owner!.userId},${owner!.userId}) returning id
      `;
      const uploadMs: number[] = [];
      let currentId = "";
      for (let sample = 0; sample < 3; sample += 1) {
        const current = currentId ? await db<{ documentVersion: number }[]>`
          select document_version from pet_documents where id=${currentId}
        ` : [];
        const input = metadata(currentId ? {
          expectedCurrentDocumentId: currentId, expectedCurrentDocumentVersion: current[0]!.documentVersion
        } : {});
        const upload = multipart(input, diagnosticPdf(sizeMiB * 1024 * 1024));
        const started = performance.now();
        const response = await app.inject({ method: "POST", url: `/api/pets/${pet!.id}/documents/rabies`,
          headers: { cookie: ownerCookie, ...upload.headers }, payload: upload.payload });
        uploadMs.push(Number((performance.now()-started).toFixed(2)));
        expect([200,201]).toContain(response.statusCode);
        currentId = response.json().id;
      }
      const metadataStarted = performance.now();
      const history = await app.inject({ method: "GET", url: `/api/pets/${pet!.id}/documents`, headers: { cookie: ownerCookie } });
      const metadataMs = Number((performance.now()-metadataStarted).toFixed(2));
      const downloadStarted = performance.now();
      const download = await app.inject({ method: "GET", url: `/api/pet-documents/${currentId}/download`, headers: { cookie: ownerCookie } });
      const downloadMs = Number((performance.now()-downloadStarted).toFixed(2));
      expect(download.statusCode).toBe(200);
      diagnostics.push({ sizeMiB, uploadMs, metadataMs, downloadMs, responseBytes: Buffer.byteLength(history.body) });
    }
    console.log("D3_2_DOCUMENT_DIAGNOSTICS", JSON.stringify({
      environment: "CI PostgreSQL plus deterministic memory object adapter; app/browser startup excluded",
      samplesPerSize: 3, memoryModel: "one bounded PDF buffer per request", diagnostics
    }));
  }, 30_000);
});
