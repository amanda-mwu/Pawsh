import React from "react";
import { Pressable, Text } from "react-native";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClientProvider } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { AuthProvider, useAuth } from "../../src/auth/AuthProvider";
import { request } from "../../src/api/client";
import { createTestQueryClient } from "../support/harness";
import { makeMe } from "../support/fixtures";

/**
 * These mount the real provider over a mocked `fetch` rather than a mocked endpoint module, so
 * the provider and the API client are exercised together. The bug this guards against — a
 * sign-out that clears the token before the revoke can use it — is invisible when `api.logout`
 * itself is the mock.
 */
const fetchMock = jest.fn();
const secure = SecureStore as jest.Mocked<typeof SecureStore>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body
  } as unknown as Response;
}

function Probe(): React.ReactElement {
  const auth = useAuth();
  return (
    <>
      <Text testID="status">{auth.status}</Text>
      <Text testID="account">{auth.me?.account?.email ?? "none"}</Text>
      <Pressable
        testID="do-sign-in"
        onPress={() => void auth.signIn({ email: "maya@salon.test", password: "pw" }).catch(() => undefined)}
      >
        <Text>in</Text>
      </Pressable>
      <Pressable testID="do-sign-out" onPress={() => void auth.signOut()}>
        <Text>out</Text>
      </Pressable>
      <Pressable testID="do-request" onPress={() => void request("/api/me").catch(() => undefined)}>
        <Text>req</Text>
      </Pressable>
    </>
  );
}

async function mount() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  secure.getItemAsync.mockResolvedValue(null);
});

describe("session restore", () => {
  it("comes up signed out when the keychain holds nothing", async () => {
    const view = await mount();
    await waitFor(() => expect(view.getByTestId("status")).toHaveTextContent("signed-out"));
  });

  it("comes up signed in when a token was stored", async () => {
    secure.getItemAsync.mockResolvedValue("stored-token");
    const view = await mount();
    await waitFor(() => expect(view.getByTestId("status")).toHaveTextContent("signed-in"));
  });
});

describe("sign in", () => {
  it("stores the token and loads the identity", async () => {
    const view = await mount();
    await waitFor(() => expect(view.getByTestId("status")).toHaveTextContent("signed-out"));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, token: "fresh-token" }))
      .mockResolvedValueOnce(jsonResponse(makeMe()));

    await fireEvent.press(view.getByTestId("do-sign-in"));

    await waitFor(() => expect(view.getByTestId("account")).toHaveTextContent("maya@salon.test"));
    expect(secure.setItemAsync).toHaveBeenCalledWith(
      "pawsh.session.token",
      "fresh-token",
      expect.anything()
    );

    const [, loginInit] = fetchMock.mock.calls[0];
    expect(loginInit.headers["x-pawsh-client"]).toBe("native");
    const [, meInit] = fetchMock.mock.calls[1];
    expect(meInit.headers.authorization).toBe("Bearer fresh-token");
  });

  it("stays signed out when the response carries no token", async () => {
    const view = await mount();
    await waitFor(() => expect(view.getByTestId("status")).toHaveTextContent("signed-out"));

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await fireEvent.press(view.getByTestId("do-sign-in"));

    await waitFor(() => expect(secure.setItemAsync).not.toHaveBeenCalled());
    expect(view.getByTestId("status")).toHaveTextContent("signed-out");
  });
});

describe("sign out", () => {
  it("revokes with the credential still attached, then clears the device", async () => {
    secure.getItemAsync.mockResolvedValue("live-token");
    const view = await mount();
    await waitFor(() => expect(view.getByTestId("status")).toHaveTextContent("signed-in"));

    fetchMock.mockResolvedValueOnce(jsonResponse({}, 204));
    await fireEvent.press(view.getByTestId("do-sign-out"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/auth/logout");
    // Without the header the server would leave a live 14-day session behind a "signed out" app.
    expect(init.headers.authorization).toBe("Bearer live-token");

    await waitFor(() => expect(secure.deleteItemAsync).toHaveBeenCalled());
    await waitFor(() => expect(view.getByTestId("status")).toHaveTextContent("signed-out"));
  });

  it("still signs out locally when the revoke fails", async () => {
    secure.getItemAsync.mockResolvedValue("live-token");
    const view = await mount();
    await waitFor(() => expect(view.getByTestId("status")).toHaveTextContent("signed-in"));

    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    await fireEvent.press(view.getByTestId("do-sign-out"));

    await waitFor(() => expect(view.getByTestId("status")).toHaveTextContent("signed-out"));
    expect(secure.deleteItemAsync).toHaveBeenCalled();
  });
});

describe("expired session", () => {
  it("drops the session on any 401, because there is no refresh", async () => {
    secure.getItemAsync.mockResolvedValue("expired-token");
    const view = await mount();
    await waitFor(() => expect(view.getByTestId("status")).toHaveTextContent("signed-in"));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "Session is invalid" }, 401))
      .mockResolvedValueOnce(jsonResponse({}, 204));

    await fireEvent.press(view.getByTestId("do-request"));

    await waitFor(() => expect(view.getByTestId("status")).toHaveTextContent("signed-out"));
    expect(secure.deleteItemAsync).toHaveBeenCalled();
  });
});
