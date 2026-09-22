import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * What a caller is told when the server refuses or fails, as opposed to when the request itself
 * was wrong.
 *
 * The client reads the status before the body. A 401 means "no longer signed in" and sends the
 * operator to the sign-in screen; every other non-2xx is a message to show and keep working. So
 * the limiter's refusal must be a 429 the client can wait out - a front desk with several tabs
 * open on the live calendar reaches it - and a failure on this side must be a 500 that says no
 * more than that, never a 400 wearing a driver's message.
 */

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

describeDatabase("rate-limited requests", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const allowed = 3;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false, requestsPerMinute: allowed });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("answers the request over the limit with 429, a Retry-After, and a body the client can read", async () => {
    for (let attempt = 0; attempt < allowed; attempt += 1) {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
    }
    const refused = await app.inject({ method: "GET", url: "/health" });
    expect(refused.statusCode).toBe(429);
    const retryAfter = Number(refused.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(refused.headers["x-ratelimit-limit"]).toBe(String(allowed));
    expect(refused.headers["x-ratelimit-remaining"]).toBe("0");
    expect(refused.json()).toEqual({ code: "RATE_LIMITED", error: expect.stringMatching(/^Too many requests\. Try again in /) });

    // The refusal is decided before authentication, so a signed-out probe of `/api/me` - the
    // request the client treats as the session check - is told to wait, not that it is signed out.
    const me = await app.inject({ method: "GET", url: "/api/me" });
    expect(me.statusCode).toBe(429);
    expect(me.json().code).toBe("RATE_LIMITED");
  });
});

describeDatabase("failures on the server's side", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    // Registered by the test, not the product: a route has to fail in each of the ways a real one
    // can for the handler's answer to be observable.
    app.get("/test-only/refusal", async () => { throw new Error("Transfer ownership before removing an Owner"); });
    app.get("/test-only/defect", async () => { throw new TypeError("Cannot read properties of undefined (reading 'id')"); });
    app.get("/test-only/driver", async () => { await db`select * from no_such_table_for_this_test`; });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("keeps a route's sentence refusal at 400 with the sentence", async () => {
    const response = await app.inject({ method: "GET", url: "/test-only/refusal" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Transfer ownership before removing an Owner" });
  });

  it("answers a defect with 500 and nothing of the defect", async () => {
    const response = await app.inject({ method: "GET", url: "/test-only/defect" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR", error: expect.any(String) });
    expect(response.body).not.toMatch(/undefined|reading 'id'/);
  });

  it("answers a database failure with 500 and nothing of the schema", async () => {
    const response = await app.inject({ method: "GET", url: "/test-only/driver" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR", error: expect.any(String) });
    expect(response.body).not.toMatch(/no_such_table|relation|does not exist/);
  });

  it("keeps the status a request-parsing error already carries", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/auth/login", headers: { "content-type": "text/csv" }, payload: "email,password"
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: expect.stringMatching(/Unsupported Media Type/) });
  });

  it("keeps a malformed request at 400", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: "{not json"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: expect.any(String) });
  });
});
