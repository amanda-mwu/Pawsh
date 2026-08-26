import type { ApiErrorBody } from "@pawsh/domain";

export type ApiFailureKind =
  /** The request never reached the server: no connectivity, DNS, TLS, or a timeout. */
  | "offline"
  /** The session is gone. The caller must clear its token and return to login. */
  | "unauthenticated"
  /** Authenticated, but not permitted. */
  | "forbidden"
  | "not_found"
  /** Optimistic-concurrency conflict. The view is stale; refresh before retrying. */
  | "conflict"
  | "rate_limited"
  /** Anything else the server rejected, including its own unexpected faults. */
  | "rejected";

/**
 * One error type for every failure the app can see.
 *
 * The API has no error envelope and, notably, answers an unexpected server fault with **400**
 * rather than 500, so status alone never tells you whose fault a failure was. `kind` is what the
 * UI branches on; `status` is kept for diagnostics.
 */
export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  readonly status: number;
  readonly code: string | undefined;
  readonly body: ApiErrorBody | undefined;

  constructor(options: {
    kind: ApiFailureKind;
    status: number;
    message: string;
    code?: string | undefined;
    body?: ApiErrorBody | undefined;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
  }

  /** Whether trying the same request again could plausibly succeed without a change. */
  get retryable(): boolean {
    return this.kind === "offline" || this.kind === "rate_limited";
  }
}

const kindByStatus: Record<number, ApiFailureKind> = {
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited"
};

export function failureKindForStatus(status: number): ApiFailureKind {
  return kindByStatus[status] ?? "rejected";
}

export function offlineError(message = "No connection."): ApiError {
  return new ApiError({ kind: "offline", status: 0, message });
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * A sentence to put in front of a groomer.
 *
 * The server's own message is preferred wherever it has one — it is written for this product and
 * says more than a generic string can — and only the failures with no useful body get replaced.
 */
export function messageFor(error: unknown): string {
  if (!isApiError(error)) {
    return error instanceof Error && error.message ? error.message : "Something went wrong.";
  }
  if (error.kind === "offline") return "No connection.";
  if (error.kind === "rate_limited") return "Too many requests. Try again in a moment.";
  return error.message;
}
