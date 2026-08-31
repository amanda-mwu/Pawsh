import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createSquareClient, squareApiVersion, squareScopes, type SquareFetch
} from "../../src/integrations/square/client.js";
import type { SquareApiError } from "../../src/integrations/square/errors.js";

/**
 * The one place Square is called, exercised through an injected transport.
 *
 * No `nock`, no patched global `fetch`. The client takes its transport as a constructor option,
 * so a test hands it a function that answers from the recorded fixtures and the production code
 * path - headers, version pinning, error mapping, response parsing - is the code under test
 * rather than something a mock stood in for.
 */

async function fixture(name: string): Promise<string> {
  return readFile(`tests/fixtures/square/${name}`, "utf8");
}

interface RecordedCall { url: string; init: RequestInit }

function transport(responses: { body: string; status?: number }[]): {
  fetchImplementation: SquareFetch; calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  return {
    calls,
    fetchImplementation: async (url, init) => {
      calls.push({ url, init });
      const next = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return new Response(next.body, {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" }
      });
    }
  };
}

function client(responses: { body: string; status?: number }[], environment: "sandbox" | "production" = "sandbox") {
  const injected = transport(responses);
  return {
    calls: injected.calls,
    square: createSquareClient({
      environment,
      applicationId: "sandbox-sq0idb-TEST-APPLICATION",
      applicationSecret: "sandbox-sq0csb-TEST-SECRET",
      fetchImplementation: injected.fetchImplementation
    })
  };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe("Square client", () => {
  it("pins Square-Version in code rather than letting the dashboard choose it", async () => {
    const { square, calls } = client([{ body: await fixture("oauth-token.json") }]);
    await square.exchangeAuthorizationCode({ code: "code", redirectUri: "https://app.pawsh.example/cb" });
    expect(headerOf(calls[0]!.init, "Square-Version")).toBe(squareApiVersion);
    expect(headerOf(calls[0]!.init, "Content-Type")).toBe("application/json");
    expect(square.apiVersion).toBe("2026-08-19");
  });

  it("puts OAuth at the host root and everything else under /v2", async () => {
    const token = client([{ body: await fixture("oauth-token.json") }]);
    await token.square.exchangeAuthorizationCode({ code: "code", redirectUri: "https://app.pawsh.example/cb" });
    expect(token.calls[0]!.url).toBe("https://connect.squareupsandbox.com/oauth2/token");

    const merchant = client([{ body: await fixture("merchant.json") }]);
    await merchant.square.retrieveMerchant({ accessToken: "token", merchantId: "MLSAMPLE00000001" });
    expect(merchant.calls[0]!.url).toBe("https://connect.squareupsandbox.com/v2/merchants/MLSAMPLE00000001");
    expect(headerOf(merchant.calls[0]!.init, "Authorization")).toBe("Bearer token");

    const production = client([{ body: await fixture("merchant.json") }], "production");
    await production.square.retrieveMerchant({ accessToken: "token", merchantId: "MLSAMPLE00000001" });
    expect(production.calls[0]!.url).toBe("https://connect.squareup.com/v2/merchants/MLSAMPLE00000001");
  });

  it("asks for exactly the four scopes Terminal needs", () => {
    const { square } = client([{ body: "{}" }]);
    const url = new URL(square.authorizeUrl({
      state: "state-value", redirectUri: "https://app.pawsh.example/api/integrations/square/callback"
    }));
    expect(url.origin + url.pathname).toBe("https://connect.squareupsandbox.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("sandbox-sq0idb-TEST-APPLICATION");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("redirect_uri"))
      .toBe("https://app.pawsh.example/api/integrations/square/callback");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "PAYMENTS_READ", "PAYMENTS_WRITE", "DEVICE_CREDENTIAL_MANAGEMENT", "MERCHANT_PROFILE_READ"
    ]);
    // The Reader SDK scope and the split-payment scope are not ours to ask for.
    expect(url.search).not.toContain("PAYMENTS_WRITE_IN_PERSON");
    expect(url.search).not.toContain("PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS");
    expect([...squareScopes]).toHaveLength(4);
    // Nothing secret goes in a URL a browser follows.
    expect(url.search).not.toContain("sq0csb");
  });

  it("parses the authorization-code exchange", async () => {
    const { square, calls } = client([{ body: await fixture("oauth-token.json") }]);
    const grant = await square.exchangeAuthorizationCode({
      code: "authorization-code", redirectUri: "https://app.pawsh.example/cb"
    });
    expect(grant.merchantId).toBe("MLSAMPLE00000001");
    expect(grant.accessToken).toMatch(/^EAAAl0SAMPLE/);
    expect(grant.refreshToken).toMatch(/^EQAAl0SAMPLE/);
    expect(grant.expiresAt?.toISOString()).toBe("2026-09-29T18:22:41.000Z");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      grant_type: "authorization_code",
      code: "authorization-code",
      client_id: "sandbox-sq0idb-TEST-APPLICATION",
      client_secret: "sandbox-sq0csb-TEST-SECRET",
      redirect_uri: "https://app.pawsh.example/cb"
    });
  });

  it("refreshes with the non-rotating refresh token", async () => {
    const { square, calls } = client([{ body: await fixture("oauth-token-refreshed.json") }]);
    const grant = await square.refreshAccessToken({ refreshToken: "EQAAl0SAMPLEsandboxREFRESHtoken000000000000000000000" });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ grant_type: "refresh_token" });
    expect(grant.accessToken).toContain("1111111111");
    // Square returns the same refresh token: the code flow does not rotate it.
    expect(grant.refreshToken).toBe("EQAAl0SAMPLEsandboxREFRESHtoken000000000000000000000");
  });

  it("reads the scopes actually granted, which the token response does not report", async () => {
    const token = JSON.parse(await fixture("oauth-token.json"));
    expect(token.scope).toBeUndefined();
    expect(token.scopes).toBeUndefined();
    const { square, calls } = client([{ body: await fixture("oauth-token-status.json") }]);
    const status = await square.retrieveTokenStatus({ accessToken: "access" });
    expect(calls[0]!.url).toBe("https://connect.squareupsandbox.com/oauth2/token/status");
    expect(status.scopes).toEqual([...squareScopes]);
  });

  it("authenticates revocation as the application, not as the merchant", async () => {
    const { square, calls } = client([{ body: "{}" }]);
    await square.revokeAccessToken({ accessToken: "merchant-access-token" });
    expect(calls[0]!.url).toBe("https://connect.squareupsandbox.com/oauth2/revoke");
    expect(headerOf(calls[0]!.init, "Authorization")).toBe("Client sandbox-sq0csb-TEST-SECRET");
  });

  it("parses the merchant and location reads", async () => {
    const merchant = client([{ body: await fixture("merchant.json") }]);
    expect(await merchant.square.retrieveMerchant({ accessToken: "t", merchantId: "MLSAMPLE00000001" }))
      .toMatchObject({ id: "MLSAMPLE00000001", businessName: "Sample Grooming Salon", currency: "USD" });

    const locations = client([{ body: await fixture("locations.json") }]);
    const list = await locations.square.listLocations({ accessToken: "t" });
    expect(list.map((entry) => entry.id)).toEqual(["LSAMPLE000000001", "LSAMPLE000000002"]);
    expect(locations.calls[0]!.url).toBe("https://connect.squareupsandbox.com/v2/locations");
  });
});

describe("Square error mapping", () => {
  async function failure(name: string, status: number): Promise<SquareApiError> {
    const { square } = client([{ body: await fixture(name), status }]);
    try {
      await square.listLocations({ accessToken: "token" });
    } catch (error) {
      return error as SquareApiError;
    }
    throw new Error(`${name} did not fail`);
  }

  it("maps the codes the integration has to branch on", async () => {
    expect((await failure("error-access-token-expired.json", 401)).code).toBe("access_token_expired");
    expect((await failure("error-access-token-revoked.json", 401)).code).toBe("access_token_revoked");
    expect((await failure("error-insufficient-scopes.json", 403)).code).toBe("insufficient_scopes");
    expect((await failure("error-rate-limited.json", 429)).code).toBe("rate_limited");
    expect((await failure("error-idempotency-key-reused.json", 409)).code).toBe("idempotency_key_reused");
  });

  it("lets the body's code beat the status, because 401 means two different things", async () => {
    const expired = await failure("error-access-token-expired.json", 401);
    const revoked = await failure("error-access-token-revoked.json", 401);
    expect(expired.status).toBe(401);
    expect(revoked.status).toBe(401);
    // Same status, opposite handling: one refreshes and carries on, the other stops.
    expect(expired.code).not.toBe(revoked.code);
    expect(expired.credentialFailure).toBe(true);
    expect(revoked.credentialFailure).toBe(true);
    expect(revoked.retryable).toBe(false);
  });

  it("marks only the conditions a later attempt could find changed as retryable", async () => {
    expect((await failure("error-rate-limited.json", 429)).retryable).toBe(true);
    expect((await failure("error-insufficient-scopes.json", 403)).retryable).toBe(false);
    expect((await failure("error-idempotency-key-reused.json", 409)).retryable).toBe(false);
  });

  it("falls back to the status when the body carries no usable code", async () => {
    for (const [status, code] of [[429, "rate_limited"], [503, "square_unavailable"], [404, "not_found"]] as const) {
      const { square } = client([{ body: "", status }]);
      await expect(square.listLocations({ accessToken: "t" })).rejects.toMatchObject({ code });
    }
  });

  it("refuses a body that is not JSON, and a 200 whose shape is not the one we parse", async () => {
    const notJson = client([{ body: "<html>maintenance</html>" }]);
    await expect(notJson.square.listLocations({ accessToken: "t" }))
      .rejects.toMatchObject({ code: "malformed_response" });

    const wrongShape = client([{ body: JSON.stringify({ merchant: { business_name: "no id" } }) }]);
    await expect(wrongShape.square.retrieveMerchant({ accessToken: "t", merchantId: "M" }))
      .rejects.toMatchObject({ code: "malformed_response" });
  });

  it("reports a timeout and a transport failure as distinct, retryable conditions", async () => {
    const timedOut = createSquareClient({
      environment: "sandbox", applicationId: "id", applicationSecret: "secret",
      fetchImplementation: async () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }
    });
    await expect(timedOut.listLocations({ accessToken: "t" }))
      .rejects.toMatchObject({ code: "timeout", retryable: true });

    const unreachable = createSquareClient({
      environment: "sandbox", applicationId: "id", applicationSecret: "secret",
      fetchImplementation: async () => { throw new TypeError("fetch failed"); }
    });
    await expect(unreachable.listLocations({ accessToken: "t" }))
      .rejects.toMatchObject({ code: "network_failure", retryable: true });
  });
});
