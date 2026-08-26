import type { ApiErrorBody } from "@pawsh/domain";
import { apiBaseUrl, nativeClientHeader, requestTimeoutMs } from "./config";
import { ApiError, failureKindForStatus, offlineError } from "./errors";

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /**
   * Query parameters. Undefined and null entries are dropped rather than sent empty: most query
   * schemas on the server are `.strict()`, so an unexpected key — a cache-buster, say — is a 400.
   */
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
}

type TokenReader = () => string | null;
type UnauthorizedHandler = () => void;

let readToken: TokenReader = () => null;
let onUnauthorized: UnauthorizedHandler = () => {};

/**
 * Wires the client to the session.
 *
 * Injected rather than imported so the API layer holds no reference to React state and can be
 * driven directly from a test.
 */
export function configureApiClient(options: {
  readToken: TokenReader;
  onUnauthorized: UnauthorizedHandler;
}): void {
  readToken = options.readToken;
  onUnauthorized = options.onUnauthorized;
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    search.append(key, String(value));
  }
  const suffix = search.toString();
  return `${apiBaseUrl}${path}${suffix ? `?${suffix}` : ""}`;
}

async function readErrorBody(response: Response): Promise<ApiErrorBody | undefined> {
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object") return parsed as ApiErrorBody;
  } catch {
    // A failure with an unparseable body is still a failure; the status carries the meaning.
  }
  return undefined;
}

/**
 * One request against the Pawsh API.
 *
 * The token never appears in a URL or a query parameter — only in the `Authorization` header,
 * which is not written to server access logs or shared through a deep link.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = readToken();
  const headers: Record<string, string> = {
    accept: "application/json",
    ...nativeClientHeader
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const abortFromCaller = (): void => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller);

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? "GET",
      headers,
      signal: controller.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
  } catch {
    // fetch rejects for connectivity, DNS, TLS and abort alike. None of them are a server
    // answer, so none of them should be presented to a groomer as one.
    if (options.signal?.aborted) throw offlineError("Request cancelled.");
    throw offlineError();
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }

  if (response.status === 401) {
    // Sessions last 14 days with no refresh and no sliding expiry, so a 401 is terminal.
    onUnauthorized();
    throw new ApiError({
      kind: "unauthenticated",
      status: 401,
      message: "Your session has expired. Sign in again."
    });
  }

  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new ApiError({
      kind: failureKindForStatus(response.status),
      status: response.status,
      message:
        typeof body?.error === "string" && body.error
          ? body.error
          : `Request failed (${response.status}).`,
      code: typeof body?.code === "string" ? body.code : undefined,
      body
    });
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
