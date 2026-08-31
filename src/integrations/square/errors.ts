/**
 * Square failures, as things this codebase can branch on.
 *
 * Square answers every failure with `{"errors":[{"category","code","detail","field"}]}` and an
 * HTTP status. Handing that shape to callers would spread string comparisons on Square's
 * vocabulary through the worker, the routes and the reconciler, and the day a code is renamed
 * every one of those comparisons quietly stops matching. So the shape is mapped once, here, and
 * the rest of the integration switches on a closed set.
 *
 * The five codes the integration must actually distinguish are the ones that change what we do
 * next rather than merely what we log:
 *
 *   ACCESS_TOKEN_EXPIRED    refresh and retry once; the scheduled refresh should have prevented
 *                           this, so reaching it is also a signal the schedule is not running.
 *   ACCESS_TOKEN_REVOKED    stop. The merchant withdrew the authorisation. Nothing is retryable
 *                           and the connection must be marked revoked rather than retried.
 *   INSUFFICIENT_SCOPES     stop, and do not retry: the token is valid and simply is not allowed
 *                           to do this. Retrying is guaranteed to fail and looks like abuse.
 *   RATE_LIMITED            back off and try again later.
 *   IDEMPOTENCY_KEY_REUSED  the same key was sent with different content. This is our bug, never
 *                           Square's, and it must surface rather than be retried into silence.
 */

export type SquareErrorCode =
  | "access_token_expired"
  | "access_token_revoked"
  | "insufficient_scopes"
  | "rate_limited"
  | "idempotency_key_reused"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "square_unavailable"
  | "timeout"
  | "network_failure"
  | "malformed_response"
  | "unknown";

export interface SquareApiErrorDetail {
  category: string;
  code: string;
  detail?: string | undefined;
  field?: string | undefined;
}

const codeMap: Record<string, SquareErrorCode> = {
  ACCESS_TOKEN_EXPIRED: "access_token_expired",
  ACCESS_TOKEN_REVOKED: "access_token_revoked",
  INSUFFICIENT_SCOPES: "insufficient_scopes",
  RATE_LIMITED: "rate_limited",
  IDEMPOTENCY_KEY_REUSED: "idempotency_key_reused",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  BAD_REQUEST: "invalid_request",
  INVALID_REQUEST_ERROR: "invalid_request",
  CONFLICT: "conflict",
  SERVICE_UNAVAILABLE: "square_unavailable",
  GATEWAY_TIMEOUT: "square_unavailable",
  INTERNAL_SERVER_ERROR: "square_unavailable"
};

const statusMap: Record<number, SquareErrorCode> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "invalid_request",
  429: "rate_limited"
};

/** Codes that describe a condition a later attempt could plausibly find changed. */
const retryableCodes = new Set<SquareErrorCode>([
  "rate_limited", "square_unavailable", "timeout", "network_failure"
]);

/** Codes that mean the stored credential can no longer be used as it stands. */
const credentialCodes = new Set<SquareErrorCode>([
  "access_token_expired", "access_token_revoked", "unauthorized"
]);

export class SquareApiError extends Error {
  constructor(
    readonly code: SquareErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly errors: readonly SquareApiErrorDetail[] = []
  ) {
    super(message);
    this.name = "SquareApiError";
  }

  get retryable(): boolean {
    return retryableCodes.has(this.code);
  }

  get credentialFailure(): boolean {
    return credentialCodes.has(this.code);
  }
}

/**
 * The typed code for a Square failure.
 *
 * The body's own `code` wins where there is one, because it is more specific than the status:
 * `ACCESS_TOKEN_REVOKED` and `ACCESS_TOKEN_EXPIRED` both arrive as 401, and the first must stop
 * the integration while the second must refresh and carry on.
 */
export function squareErrorCode(
  status: number,
  errors: readonly SquareApiErrorDetail[]
): SquareErrorCode {
  for (const error of errors) {
    const mapped = codeMap[error.code];
    if (mapped) return mapped;
  }
  if (statusMap[status]) return statusMap[status];
  if (status >= 500) return "square_unavailable";
  return "unknown";
}

export function squareErrorMessage(
  code: SquareErrorCode,
  errors: readonly SquareApiErrorDetail[]
): string {
  const detail = errors.find((error) => error.detail)?.detail;
  return detail ? `Square rejected the request (${code}): ${detail}` : `Square rejected the request (${code})`;
}
