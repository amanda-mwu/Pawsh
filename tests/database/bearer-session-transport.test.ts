import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { tokenHash } from "../../src/http/context.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "bearer-transport-secret-at-least-thirty-two-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const setCookieHeader = (response: { headers: Record<string, unknown> }) => response.headers["set-cookie"];
const cookie = (response: { headers: Record<string, unknown> }) =>
  String(setCookieHeader(response)).split(";", 1)[0]!;

/**
 * The session token is the same opaque credential on both transports; only the carrier differs.
 * These tests hold the two apart, because the failure mode of getting them wrong is silent: a
 * bearer caller whose logout revokes nothing still receives 204.
 */
describeDatabase("bearer session transport", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  const email = `bearer-${suffix}@example.test`;
  const password = "correct horse bearer battery";
  let businessId: string;
  let secondBusinessId: string;

  const login = (headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { email, password } });
  const nativeToken = async () => {
    const response = await login({ "x-pawsh-client": "native" });
    expect(response.statusCode).toBe(200);
    return response.json().token as string;
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email, password, businessName: "Bearer Salon"
    }});
    expect(signup.statusCode).toBe(201);
    businessId = signup.json().businessId;
    const second = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `bearer-second-${suffix}@example.test`,
      password: "correct horse second battery", businessName: "Bearer Second Salon"
    }});
    secondBusinessId = second.json().businessId;
    await db`
      insert into business_memberships(business_id,user_id,is_owner,permissions)
      values (${secondBusinessId},(select id from users where normalized_email=${email}),false,
        ${["calendar.view", "appointments.view"] as unknown as string[]})
    `;
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it("issues the token to a declared native client and sets no cookie", async () => {
    const response = await login({ "x-pawsh-client": "native" });
    expect(response.statusCode).toBe(200);
    expect(setCookieHeader(response)).toBeUndefined();
    expect(typeof response.json().token).toBe("string");
    expect(response.json()).toEqual({ ok: true, token: response.json().token });
    const [session] = await db<{ id: string }[]>`
      select id from sessions where token_hash=${tokenHash(response.json().token)} and revoked_at is null
    `;
    expect(session).toBeDefined();
  });

  it("leaves the browser response byte-identical: cookie set, no token disclosed", async () => {
    const response = await login();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(String(setCookieHeader(response))).toContain("pawsh_session=");
    expect(String(setCookieHeader(response))).toContain("HttpOnly");
  });

  it("ignores a client declaration it does not recognise", async () => {
    const response = await login({ "x-pawsh-client": "web" });
    expect(response.json()).toEqual({ ok: true });
    expect(String(setCookieHeader(response))).toContain("pawsh_session=");
  });

  it("authenticates a request carrying the token as a bearer credential", async () => {
    const token = await nativeToken();
    const me = await app.inject({ method: "GET", url: "/api/me", headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().businessId).toBe(businessId);
    expect(me.json().account.email).toBe(email);
  });

  it("still authenticates the cookie transport unchanged", async () => {
    const sessionCookie = cookie(await login());
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().businessId).toBe(businessId);
  });

  it("prefers the bearer header when a cookie also rides along", async () => {
    const sessionCookie = cookie(await login());
    const rejected = await app.inject({
      method: "GET", url: "/api/me",
      headers: { cookie: sessionCookie, authorization: "Bearer not-a-real-session-token" }
    });
    expect(rejected.statusCode).toBe(401);
  });

  it("does not fall back to the cookie when the bearer scheme is used but empty", async () => {
    const sessionCookie = cookie(await login());
    const empty = await app.inject({
      method: "GET", url: "/api/me", headers: { cookie: sessionCookie, authorization: "Bearer   " }
    });
    // A caller that declared the bearer scheme is answered on the bearer scheme. Silently
    // authenticating it as whatever cookie happened to be attached is exactly the confusion the
    // single accessor exists to prevent.
    expect(empty.statusCode).toBe(401);
    // A scheme that is not Bearer is not a session token at all, so the cookie is read as usual.
    const otherScheme = await app.inject({
      method: "GET", url: "/api/me",
      headers: { cookie: sessionCookie, authorization: `Basic ${await nativeToken()}` }
    });
    expect(otherScheme.statusCode).toBe(200);
  });

  it("revokes the bearer session on logout so the token stops working", async () => {
    const token = await nativeToken();
    expect((await app.inject({ method: "GET", url: "/api/me", headers: bearer(token) })).statusCode).toBe(200);

    const loggedOut = await app.inject({ method: "POST", url: "/api/auth/logout", headers: bearer(token) });
    expect(loggedOut.statusCode).toBe(204);

    const [session] = await db<{ revokedAt: Date | null }[]>`
      select revoked_at from sessions where token_hash=${tokenHash(token)}
    `;
    expect(session?.revokedAt).not.toBeNull();
    const replayed = await app.inject({ method: "GET", url: "/api/me", headers: bearer(token) });
    expect(replayed.statusCode).toBe(401);
  });

  it("does not revoke unrelated sessions when a bearer client logs out", async () => {
    const survivor = await nativeToken();
    const departing = await nativeToken();
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: bearer(departing) });
    expect((await app.inject({ method: "GET", url: "/api/me", headers: bearer(survivor) })).statusCode).toBe(200);
  });

  it("switches workspace on the bearer session rather than on no session at all", async () => {
    const token = await nativeToken();
    const switched = await app.inject({
      method: "POST", url: "/api/workspaces/select",
      headers: { ...bearer(token), origin: config.APP_ORIGIN },
      payload: { businessId: secondBusinessId }
    });
    expect(switched.statusCode).toBe(200);
    const [session] = await db<{ businessId: string | null }[]>`
      select business_id from sessions where token_hash=${tokenHash(token)}
    `;
    expect(session?.businessId).toBe(secondBusinessId);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: bearer(token) })).json().businessId)
      .toBe(secondBusinessId);
    await app.inject({
      method: "POST", url: "/api/workspaces/select",
      headers: { ...bearer(token), origin: config.APP_ORIGIN }, payload: { businessId }
    });
  });

  it("selects a location on the bearer session", async () => {
    const token = await nativeToken();
    const locations = await app.inject({ method: "GET", url: "/api/locations", headers: bearer(token) });
    const locationId = (locations.json() as { id: string }[])[0]!.id;
    const selected = await app.inject({
      method: "POST", url: "/api/me/location",
      headers: { ...bearer(token), origin: config.APP_ORIGIN }, payload: { locationId }
    });
    expect(selected.statusCode).toBe(200);
    const [session] = await db<{ locationId: string | null }[]>`
      select location_id from sessions where token_hash=${tokenHash(token)}
    `;
    expect(session?.locationId).toBe(locationId);
  });

  it("keeps the caller's own bearer session alive through a password change", async () => {
    const changingEmail = `bearer-password-${suffix}@example.test`;
    const startingPassword = "correct horse password battery";
    const newPassword = "correct horse rotated battery";
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: changingEmail, password: startingPassword, businessName: "Bearer Rotation Salon"
    }});
    expect(signup.statusCode).toBe(201);
    const nativeLogin = await app.inject({
      method: "POST", url: "/api/auth/login", headers: { "x-pawsh-client": "native" },
      payload: { email: changingEmail, password: startingPassword }
    });
    const token = nativeLogin.json().token as string;
    const otherSession = await app.inject({
      method: "POST", url: "/api/auth/login", headers: { "x-pawsh-client": "native" },
      payload: { email: changingEmail, password: startingPassword }
    });
    const otherToken = otherSession.json().token as string;

    const changed = await app.inject({
      method: "POST", url: "/api/me/password",
      headers: { ...bearer(token), origin: config.APP_ORIGIN },
      payload: { currentPassword: startingPassword, newPassword }
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ changed: true });

    // The caller keeps working; every other session for that user is revoked.
    expect((await app.inject({ method: "GET", url: "/api/me", headers: bearer(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: bearer(otherToken) })).statusCode).toBe(401);
  });
});
