import { describe, expect, it } from "vitest";
import {
  generateOAuthState, hashOAuthState, oauthStateDecision, oauthStateTtlMs, refreshIntervalDays
} from "../../src/integrations/square/oauth.js";

/**
 * The `state` parameter, which Square does nothing with.
 *
 * Square echoes it back unchanged. It does not generate it, store it, or check it, so it is not
 * a defence Square provides - it is one we build and Square carries. Every property here has to
 * be ours: unguessable, tied to the business that started the flow, short-lived, and spendable
 * exactly once.
 *
 * The refusals are a pure function so all four are reachable without a database. That the
 * single-use claim is also atomic under concurrency is a property of the UPDATE and is proved in
 * the database tier; this file proves the decision it enforces.
 */

const business = "11111111-1111-4111-8111-111111111111";
const rival = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-08-31T12:00:00.000Z");

describe("Square OAuth state", () => {
  it("is 256 bits of URL-safe entropy", () => {
    const state = generateOAuthState();
    expect(Buffer.from(state, "base64url").byteLength).toBe(32);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    // No padding, nothing that needs escaping in a query string.
    expect(state).not.toContain("=");
    expect(encodeURIComponent(state)).toBe(state);
  });

  it("never repeats", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) seen.add(generateOAuthState());
    expect(seen.size).toBe(2_000);
  });

  it("is stored only as a hash, exactly as session tokens are", () => {
    const state = generateOAuthState();
    const hash = hashOAuthState(state);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(state);
    expect(hashOAuthState(state)).toBe(hash);
    expect(hashOAuthState(generateOAuthState())).not.toBe(hash);
  });

  it("accepts a live, unspent state that belongs to this business", () => {
    expect(oauthStateDecision(
      { businessId: business, expiresAt: new Date(now.getTime() + 60_000), consumedAt: null },
      { businessId: business, now }
    )).toEqual({ valid: true });
  });

  it("refuses a state it never issued", () => {
    expect(oauthStateDecision(null, { businessId: business, now }))
      .toEqual({ valid: false, reason: "unknown" });
  });

  it("refuses a replay of a state that was already spent", () => {
    expect(oauthStateDecision(
      {
        businessId: business,
        expiresAt: new Date(now.getTime() + 60_000),
        consumedAt: new Date(now.getTime() - 1_000)
      },
      { businessId: business, now }
    )).toEqual({ valid: false, reason: "expired_or_used" });
  });

  it("refuses an expired state, including one expiring on the boundary", () => {
    expect(oauthStateDecision(
      { businessId: business, expiresAt: new Date(now.getTime() - 1), consumedAt: null },
      { businessId: business, now }
    )).toEqual({ valid: false, reason: "expired_or_used" });
    expect(oauthStateDecision(
      { businessId: business, expiresAt: now, consumedAt: null },
      { businessId: business, now }
    )).toEqual({ valid: false, reason: "expired_or_used" });
  });

  it("refuses a state belonging to another business", () => {
    // The signed-in caller is the rival; the state was issued to `business`. Without this the
    // rival would attach somebody else's Square merchant to their own account.
    expect(oauthStateDecision(
      { businessId: business, expiresAt: new Date(now.getTime() + 60_000), consumedAt: null },
      { businessId: rival, now }
    )).toEqual({ valid: false, reason: "business_mismatch" });
  });

  it("expires soon enough to matter and refreshes often enough to satisfy Square", () => {
    // Long enough for a browser round trip through Square's consent screen, short enough that a
    // leaked state ages out before anybody could use it.
    expect(oauthStateTtlMs).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(oauthStateTtlMs).toBeGreaterThanOrEqual(2 * 60 * 1000);
    // Square instructs refreshing every seven days or fewer regardless of activity.
    expect(refreshIntervalDays).toBeLessThanOrEqual(7);
  });
});
