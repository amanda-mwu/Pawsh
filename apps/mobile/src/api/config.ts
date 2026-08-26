import Constants from "expo-constants";

/**
 * The API base URL, from `app.config.ts` `extra.apiUrl`, which reads
 * `EXPO_PUBLIC_PAWSH_API_URL`.
 *
 * It is never hardcoded to loopback at the call site: a physical device cannot reach the
 * development machine's `localhost`, and the failure looks like a dead server rather than a
 * misconfiguration. See README.md for LAN testing.
 */
function readApiUrl(): string {
  const extra = Constants.expoConfig?.extra as { apiUrl?: unknown } | undefined;
  const value = typeof extra?.apiUrl === "string" ? extra.apiUrl.trim() : "";
  if (!value) {
    throw new Error(
      "Pawsh API URL is not configured. Set EXPO_PUBLIC_PAWSH_API_URL before starting the app."
    );
  }
  return value.replace(/\/+$/, "");
}

export const apiBaseUrl = readApiUrl();

/**
 * Declares this client as one that holds its own session token.
 *
 * The server returns a bearer token instead of setting a cookie only to a caller that sends
 * this at the moment it authenticates, so there is no way to trade a cookie for a token later.
 */
export const nativeClientHeader = { "x-pawsh-client": "native" } as const;

/** A salon has thick walls. A request that has not answered by now will not answer usefully. */
export const requestTimeoutMs = 15_000;
