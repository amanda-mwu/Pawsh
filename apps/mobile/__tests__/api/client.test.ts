import { buildUrl, configureApiClient, request } from "../../src/api/client";
import { api } from "../../src/api/endpoints";
import { ApiError, messageFor } from "../../src/api/errors";
import { makeAppointment } from "../support/fixtures";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => "",
    json: async () => {
      throw new Error("no body");
    }
  } as unknown as Response;
}

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  configureApiClient({ readToken: () => null, onUnauthorized: () => undefined });
});

describe("buildUrl", () => {
  it("drops undefined, null and empty query values", () => {
    // Most query schemas on the server are `.strict()`, so an unexpected or empty key is a 400.
    expect(
      buildUrl("/api/appointments", { localDate: undefined, days: 1, mode: null, employeeIds: "" })
    ).toBe("https://api.test.pawsh/api/appointments?days=1");
  });

  it("never puts the token in the URL", () => {
    configureApiClient({ readToken: () => "secret-token", onUnauthorized: () => undefined });
    expect(buildUrl("/api/me")).not.toContain("secret-token");
  });
});

describe("request headers", () => {
  it("declares itself native and sends the bearer token", async () => {
    configureApiClient({ readToken: () => "secret-token", onUnauthorized: () => undefined });
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await request("/api/me");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["x-pawsh-client"]).toBe("native");
    expect(init.headers.authorization).toBe("Bearer secret-token");
  });

  it("omits the authorization header when there is no session", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await request("/api/auth/login", { method: "POST", body: { email: "a@b.c", password: "x" } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBeUndefined();
    expect(init.headers["content-type"]).toBe("application/json");
  });
});

describe("401 handling", () => {
  it("notifies the session and throws an unauthenticated error", async () => {
    const onUnauthorized = jest.fn();
    configureApiClient({ readToken: () => "expired", onUnauthorized });
    fetchMock.mockResolvedValue(jsonResponse({ error: "Session is invalid" }, 401));

    await expect(request("/api/me")).rejects.toMatchObject({ kind: "unauthenticated" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe("error normalization", () => {
  it("treats a 400 as a rejection rather than a server fault, keeping the server message", async () => {
    // The backend answers its own unexpected faults with 400, so status alone never says whose
    // fault a failure was. The message is the server's own words.
    fetchMock.mockResolvedValue(jsonResponse({ error: "Invalid appointment transition" }, 400));
    const error = (await request("/api/appointments/1/transition").catch(
      (cause: unknown) => cause
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe("rejected");
    expect(error.retryable).toBe(false);
    expect(messageFor(error)).toBe("Invalid appointment transition");
  });

  it("maps 409 to a conflict so a stale view can be refreshed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Appointment changed" }, 409));
    await expect(request("/api/x")).rejects.toMatchObject({ kind: "conflict" });
  });

  it("maps 403 and 404 to their own kinds", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Missing permission" }, 403));
    await expect(request("/api/x")).rejects.toMatchObject({ kind: "forbidden" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Not found" }, 404));
    await expect(request("/api/x")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("turns a rejected fetch into a retryable offline error, not a server answer", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    const error = (await request("/api/me").catch((cause: unknown) => cause)) as ApiError;
    expect(error.kind).toBe("offline");
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(messageFor(error)).toBe("No connection.");
  });

  it("survives a failure with an unparseable body", async () => {
    fetchMock.mockResolvedValue(emptyResponse(500));
    await expect(request("/api/x")).rejects.toMatchObject({
      kind: "rejected",
      message: "Request failed (500)."
    });
  });
});

describe("response shapes", () => {
  it("reads a bare array", async () => {
    fetchMock.mockResolvedValue(jsonResponse([makeAppointment()]));
    await expect(api.appointments({ days: 1 })).resolves.toHaveLength(1);
  });

  it("reads a bare row", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeAppointment({ id: "appointment-9" })));
    await expect(api.appointment("appointment-9")).resolves.toMatchObject({
      id: "appointment-9"
    });
  });

  it("unwraps the {items} envelope pet notes use", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [{ id: "note-1", body: "Matting behind the ears" }] })
    );
    const notes = await api.petNotes("pet-1");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe("Matting behind the ears");
  });

  it("reads the bespoke composite the customer profile returns", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        customer: { id: "customer-1", firstName: "Sarah" },
        pets: [],
        upcoming: { items: [], total: 0 },
        history: { items: [], total: 0 },
        appointmentTotal: 0,
        appointmentsTruncated: false,
        summary: null,
        invoices: []
      })
    );
    const history = await api.customerHistory("customer-1");
    // `summary` is withheld rather than zeroed without payments.view; null must survive the trip.
    expect(history.summary).toBeNull();
    expect(history.customer.firstName).toBe("Sarah");
  });

  it("returns undefined for a 204", async () => {
    fetchMock.mockResolvedValue(emptyResponse(204));
    await expect(api.logout()).resolves.toBeUndefined();
  });

  it("sends employeeIds as a comma-separated list", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api.appointments({ employeeIds: ["a", "b"] });
    expect(fetchMock.mock.calls[0][0]).toContain("employeeIds=a%2Cb");
  });
});
