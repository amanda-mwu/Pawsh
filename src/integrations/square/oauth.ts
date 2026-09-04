import { createHash, randomBytes } from "node:crypto";
import type { Database, SqlExecutor } from "../../db/client.js";
import type { IntegrationKeyring } from "../../security/integration-encryption.js";
import { SquareApiError } from "./errors.js";
import type { SquareClient, SquareEnvironment } from "./client.js";

/**
 * Connecting, keeping connected, and stopping.
 *
 * THE STATE PARAMETER IS ENTIRELY OURS. Square echoes `state` back unchanged and binds nothing
 * to it: it does not generate it, does not remember it, and does not check it. So every property
 * that makes it a defence has to be built here - crypto-strength entropy, a row tying it to the
 * business that started the flow, a short expiry, and a single-use consumption that is one
 * atomic UPDATE rather than a read followed by a write. A callback presenting a state that was
 * already used, has expired, or belongs to another business is refused, and refused before any
 * code is exchanged, because exchanging first would have already burned a real authorisation
 * code against an unproven request.
 *
 * REFRESH IS SCHEDULED, NOT LAZY. Square access tokens last 30 days and the refresh token for
 * the code flow neither expires nor rotates, and Square's instruction is to refresh every seven
 * days or fewer REGARDLESS of activity. A salon that takes no card payments for a month is
 * exactly the case a refresh-on-401 scheme cannot serve: there is no request to fail, so there
 * is no 401, so nothing refreshes, and the token dies quietly. The worker tick claims due
 * connections the same way `processOutbox` claims events, and a 401 in the request path is a
 * fallback for the gap between two ticks rather than the mechanism.
 *
 * A REVOCATION ARRIVES WITH A MERCHANT AND NOTHING ELSE. `oauth.authorization.revoked` carries
 * `merchant_id`, so the tenant lookup keys on `square_merchant_id` and marks every matching
 * connection revoked - Square revokes the authorisation for the merchant and application pair,
 * not for one of our rows. Revoking clears the sealed tokens, because a token we have been told
 * is dead is not a credential, it is a liability sitting in a backup.
 */

/** Where the sealed columns live. Reproduced exactly when opening; see `sealedFieldAad`. */
export const squareConnectionTable = "square_connections";
export const accessTokenColumn = "access_token";
export const refreshTokenColumn = "refresh_token";

/** Long enough that the browser round trip is comfortable; short enough that a leak ages out. */
export const oauthStateTtlMs = 10 * 60 * 1000;
/** Square's own instruction, and the reason the refresh is on a schedule rather than a 401. */
export const refreshIntervalDays = 7;

export interface SquareConnectionRecord {
  id: string;
  businessId: string;
  environment: SquareEnvironment;
  squareMerchantId: string;
  status: "connected" | "revoked" | "disconnected";
  scopes: string[];
  keyVersion: number;
  accessTokenExpiresAt: Date | null;
  connectedAt: Date;
  refreshedAt: Date | null;
  revokedAt: Date | null;
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/**
 * The state value itself: 32 bytes from the CSPRNG, URL-safe.
 *
 * Separate from the row that records it so the entropy is testable without a database. 256 bits
 * is far beyond guessing, which matters because Square will faithfully echo back whatever an
 * attacker puts in the parameter and the only thing standing between that and an accepted
 * callback is that we do not recognise it.
 */
export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export interface OAuthStateRecord {
  businessId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export type OAuthStateRejection = "unknown" | "expired_or_used" | "business_mismatch";

/**
 * Whether a presented state may be spent, and if not, why.
 *
 * Pure, so every refusal is reachable in the unit suite without a database: an unknown state, one
 * already spent, one past its expiry, and one belonging to another business. The atomic claim in
 * `consumeOAuthState` repeats the first three as SQL predicates - this function explains, the
 * UPDATE enforces - because two callbacks racing on one state must not both pass a check that
 * happened before either wrote.
 */
export function oauthStateDecision(
  record: OAuthStateRecord | null,
  input: { businessId: string; now: Date }
): { valid: true } | { valid: false; reason: OAuthStateRejection } {
  if (!record) return { valid: false, reason: "unknown" };
  if (record.consumedAt !== null) return { valid: false, reason: "expired_or_used" };
  if (record.expiresAt.getTime() <= input.now.getTime()) return { valid: false, reason: "expired_or_used" };
  // Bound to the business that started the flow. A signed-in owner of another salon completing
  // somebody else's callback would otherwise attach that merchant to their own account.
  if (record.businessId !== input.businessId) return { valid: false, reason: "business_mismatch" };
  return { valid: true };
}

/**
 * Mints a state value and records it against the business that started the flow.
 *
 * 32 bytes from the CSPRNG. Only the hash is stored, exactly as session tokens are stored, so a
 * database read does not hand anybody a usable state.
 */
export async function createOAuthState(
  sql: SqlExecutor,
  input: {
    businessId: string;
    userId: string;
    environment: SquareEnvironment;
    redirectUri: string;
    ttlMs?: number;
  }
): Promise<string> {
  const state = generateOAuthState();
  const ttl = Math.max(1, Math.round((input.ttlMs ?? oauthStateTtlMs) / 1000));
  await sql`
    insert into square_oauth_states
      (business_id, state_hash, environment, redirect_uri, created_by, expires_at)
    values (${input.businessId}, ${hashOAuthState(state)}, ${input.environment},
      ${input.redirectUri}, ${input.userId}, now() + make_interval(secs => ${ttl}))
  `;
  return state;
}

export type OAuthStateOutcome =
  | { valid: true; businessId: string; environment: SquareEnvironment; redirectUri: string }
  | { valid: false; reason: OAuthStateRejection };

/**
 * Spends a state exactly once.
 *
 * Two steps on purpose. The read produces an explainable refusal - unknown, spent, expired,
 * another business's - through `oauthStateDecision`. The UPDATE then repeats the same predicates
 * as SQL, so if two callbacks present the same state at the same moment they race in the
 * database and exactly one wins; a read-then-write with the check only in the read would let
 * both through.
 */
export async function consumeOAuthState(
  sql: SqlExecutor,
  input: { state: string; businessId: string }
): Promise<OAuthStateOutcome> {
  const stateHash = hashOAuthState(input.state);
  const [existing] = await sql<{ businessId: string; expiresAt: Date; consumedAt: Date | null }[]>`
    select business_id, expires_at, consumed_at from square_oauth_states where state_hash=${stateHash}
  `;
  const decision = oauthStateDecision(existing ?? null, {
    businessId: input.businessId, now: new Date()
  });
  if (!decision.valid) return decision;

  const [claimed] = await sql<{ environment: SquareEnvironment; redirectUri: string }[]>`
    update square_oauth_states set consumed_at=now()
    where state_hash=${stateHash} and consumed_at is null and expires_at > now()
    returning environment, redirect_uri
  `;
  if (!claimed) return { valid: false, reason: "expired_or_used" };
  return {
    valid: true,
    businessId: input.businessId,
    environment: claimed.environment,
    redirectUri: claimed.redirectUri
  };
}

/** Housekeeping for states nobody came back for. Nothing depends on them after they expire. */
export async function purgeExpiredOAuthStates(sql: SqlExecutor): Promise<number> {
  const removed = await sql<{ id: string }[]>`
    delete from square_oauth_states where expires_at < now() - interval '1 day' returning id
  `;
  return removed.length;
}

export interface StoreConnectionInput {
  businessId: string;
  environment: SquareEnvironment;
  merchantId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date | null;
  scopes: readonly string[];
  keyring: IntegrationKeyring;
}

/**
 * Writes the connection, sealed.
 *
 * One row per business, so reconnecting replaces rather than accumulates. `key_version` records
 * which integration key sealed these particular values; a rotation reads it to find the rows
 * still resting on a retiring key without opening any of them.
 */
export async function storeConnection(
  sql: SqlExecutor,
  input: StoreConnectionInput
): Promise<SquareConnectionRecord> {
  const sealedAccess = input.keyring.seal(input.accessToken, {
    businessId: input.businessId, table: squareConnectionTable, column: accessTokenColumn
  });
  const sealedRefresh = input.keyring.seal(input.refreshToken, {
    businessId: input.businessId, table: squareConnectionTable, column: refreshTokenColumn
  });
  const [row] = await sql<SquareConnectionRecord[]>`
    insert into square_connections
      (business_id, environment, square_merchant_id, access_token, refresh_token,
       access_token_expires_at, scopes, status, key_version, connected_at, refreshed_at,
       next_refresh_at, refresh_attempts, last_refresh_error, revoked_at)
    values (${input.businessId}, ${input.environment}, ${input.merchantId},
      ${sealedAccess.value}, ${sealedRefresh.value}, ${input.accessTokenExpiresAt},
      ${input.scopes as string[]}, 'connected', ${sealedAccess.keyVersion}, now(), now(),
      now() + make_interval(days => ${refreshIntervalDays}), 0, null, null)
    on conflict (business_id) do update set
      environment=excluded.environment,
      square_merchant_id=excluded.square_merchant_id,
      access_token=excluded.access_token,
      refresh_token=excluded.refresh_token,
      access_token_expires_at=excluded.access_token_expires_at,
      scopes=excluded.scopes,
      status='connected',
      key_version=excluded.key_version,
      connected_at=now(),
      refreshed_at=now(),
      next_refresh_at=excluded.next_refresh_at,
      refresh_attempts=0,
      last_refresh_error=null,
      revoked_at=null,
      updated_at=now()
    returning id, business_id, environment, square_merchant_id, status, scopes, key_version,
      access_token_expires_at, connected_at, refreshed_at, revoked_at
  `;
  if (!row) throw new Error("Square connection could not be stored");
  return row;
}

/** The connection as a screen may see it. Never returns a token, sealed or otherwise. */
export async function readConnection(
  sql: SqlExecutor,
  businessId: string
): Promise<SquareConnectionRecord | null> {
  const [row] = await sql<SquareConnectionRecord[]>`
    select id, business_id, environment, square_merchant_id, status, scopes, key_version,
      access_token_expires_at, connected_at, refreshed_at, revoked_at
    from square_connections where business_id=${businessId}
  `;
  return row ?? null;
}

export type ConnectionAccess =
  | { usable: true; accessToken: string; connection: SquareConnectionRecord }
  | { usable: false; reason: "absent" | "revoked" | "disconnected" };

/**
 * The access token for a business, opened, or the reason there isn't one.
 *
 * Everything that talks to Square on a salon's behalf comes through here, so "this connection
 * was revoked" is answered once rather than by each caller remembering to check a status column
 * before reaching for a token that a database constraint has already set to null.
 */
export async function openAccessToken(
  sql: SqlExecutor,
  input: { businessId: string; keyring: IntegrationKeyring }
): Promise<ConnectionAccess> {
  const [row] = await sql<(SquareConnectionRecord & { accessToken: string | null })[]>`
    select id, business_id, environment, square_merchant_id, status, scopes, key_version,
      access_token, access_token_expires_at, connected_at, refreshed_at, revoked_at
    from square_connections where business_id=${input.businessId}
  `;
  if (!row) return { usable: false, reason: "absent" };
  if (row.status !== "connected" || !row.accessToken) {
    return { usable: false, reason: row.status === "revoked" ? "revoked" : "disconnected" };
  }
  const { accessToken, ...connection } = row;
  return {
    usable: true,
    accessToken: input.keyring.open(accessToken, {
      businessId: input.businessId, table: squareConnectionTable, column: accessTokenColumn
    }),
    connection
  };
}

export interface SquareWorkerDependencies {
  client: SquareClient;
  keyring: IntegrationKeyring;
  environment: SquareEnvironment;
}

/**
 * One tick's total refresh budget, and the share of it a connection that is not already failing
 * can always take.
 *
 * THIS TABLE HAS NO RESTING STATE, WHICH IS WHY THE RESERVE MATTERS MORE HERE THAN ANYWHERE ELSE.
 * A webhook event dead-letters after `maxWebhookAttempts` and a swept checkout becomes
 * `needs_review`; both stop being claimed. A connection Square keeps refusing to refresh for a
 * reason that is not revocation has nowhere to come to rest: `status` is `connected`,
 * `next_refresh_at` is pushed out by at most six hours, and the row is claimed again forever.
 * The set of such rows only grows, so a budget handed out purely in schedule order is a budget an
 * unbounded backlog can occupy - and the row it delays is a connection whose access token dies in
 * thirty days if nothing refreshes it.
 *
 * `refresh_attempts = 0` is exactly "this connection is not in a failure cycle": every successful
 * refresh resets it to zero and every failure leaves it above zero. Reserving half the budget for
 * those rows gives a healthy due connection a claim on the first tick after it comes due,
 * independently of how many broken connections exist. The remaining budget is claimed in schedule
 * order, `next_refresh_at`, which is the column `square_connection_refresh_due` is built on and
 * which every claim pushes forward - so the broken rows drain among themselves in a bounded,
 * fair order rather than one subset monopolising the lane.
 *
 * THE LANES CANNOT CLAIM THE SAME ROW. The healthy lane runs first and its own UPDATE moves the
 * rows it took to `now() + 15 minutes`, which puts them outside `next_refresh_at <= now()`. That
 * is the same fence that already stops two consecutive ticks claiming one row.
 */
export const connectionRefreshBatch = 10;
export const connectionRefreshHealthyReserve = 5;

interface ClaimedConnection {
  id: string;
  businessId: string;
  refreshToken: string;
  squareMerchantId: string;
  refreshAttempts: number;
}

/**
 * Takes one lane's worth of due connections.
 *
 * Claimed with `for update skip locked` so two application instances running the same tick take
 * different rows rather than the same one twice. The claim itself moves `next_refresh_at`
 * forward and increments `refresh_attempts`, so a crash between claiming and finishing costs a
 * short delay rather than a hot loop against Square.
 */
async function claimDueConnections(
  db: Database,
  input: { environment: SquareEnvironment; lane: "healthy" | "due"; limit: number }
): Promise<ClaimedConnection[]> {
  if (input.limit <= 0) return [];
  const restriction = input.lane === "healthy" ? db`and due.refresh_attempts = 0` : db`and true`;
  return db<ClaimedConnection[]>`
    with claim as (
      select due.id from square_connections due
      where due.status='connected' and due.environment=${input.environment}
        and due.next_refresh_at <= now()
        ${restriction}
      order by due.next_refresh_at, due.id
      for update skip locked limit ${input.limit}
    )
    update square_connections connection set
      refresh_attempts=connection.refresh_attempts+1,
      next_refresh_at=now() + interval '15 minutes'
    from claim where connection.id=claim.id
    returning connection.id, connection.business_id, connection.refresh_token,
      connection.square_merchant_id, connection.refresh_attempts
  `;
}

/**
 * Refreshes every connection that is due, and is safe to run on every worker tick.
 *
 * The budget is claimed in two passes - see `connectionRefreshBatch` - so that connections stuck
 * in a failure cycle cannot occupy the whole tick and let a healthy connection's token expire.
 * Nothing below the claim knows which lane a row came from, and the return value is still the
 * number of connections this tick actually refreshed.
 */
export async function refreshDueConnections(
  db: Database,
  dependencies: SquareWorkerDependencies
): Promise<number> {
  const healthy = await claimDueConnections(db, {
    environment: dependencies.environment,
    lane: "healthy",
    limit: connectionRefreshHealthyReserve
  });
  const due = healthy.concat(await claimDueConnections(db, {
    environment: dependencies.environment,
    lane: "due",
    limit: connectionRefreshBatch - healthy.length
  }));
  let refreshed = 0;
  for (const connection of due) {
    try {
      const refreshToken = dependencies.keyring.open(connection.refreshToken, {
        businessId: connection.businessId, table: squareConnectionTable, column: refreshTokenColumn
      });
      const grant = await dependencies.client.refreshAccessToken({ refreshToken });
      // Square's code-flow refresh token does not rotate, so a response without one is normal
      // and means "keep the one you have". Re-sealing it under the active key on every refresh
      // is also how a rotated keyring drains: the row moves forward without a migration.
      const nextRefreshToken = grant.refreshToken ?? refreshToken;
      const sealedAccess = dependencies.keyring.seal(grant.accessToken, {
        businessId: connection.businessId, table: squareConnectionTable, column: accessTokenColumn
      });
      const sealedRefresh = dependencies.keyring.seal(nextRefreshToken, {
        businessId: connection.businessId, table: squareConnectionTable, column: refreshTokenColumn
      });
      await db`
        update square_connections set
          access_token=${sealedAccess.value},
          refresh_token=${sealedRefresh.value},
          access_token_expires_at=${grant.expiresAt},
          key_version=${sealedAccess.keyVersion},
          refreshed_at=now(),
          next_refresh_at=now() + make_interval(days => ${refreshIntervalDays}),
          refresh_attempts=0,
          last_refresh_error=null,
          updated_at=now()
        where id=${connection.id} and status='connected'
      `;
      refreshed += 1;
    } catch (error) {
      const revoked = error instanceof SquareApiError
        && (error.code === "access_token_revoked" || error.code === "unauthorized");
      if (revoked) {
        // The merchant withdrew the authorisation, or Square no longer honours this refresh
        // token. Retrying is guaranteed to fail; the honest state is revoked and empty.
        await markRevoked(db, {
          merchantId: connection.squareMerchantId,
          environment: dependencies.environment,
          revokedAt: null
        });
        continue;
      }
      // The exponent is clamped, and the clamp changes no schedule this backoff has ever
      // produced: `least(interval '6 hours', ...)` already wins from the eighth attempt onward,
      // and 2^12 is far past that. It exists because `refresh_attempts` on this table has no
      // ceiling - nothing dead-letters a connection - so it really does keep counting. Around
      // three hundred attempts, which a six-hourly retry reaches in a matter of months,
      // `power(2, n)` exceeds what an interval can hold and PostgreSQL raises rather than
      // multiplying, which would abort the whole worker tick from inside its error handler.
      await db`
        update square_connections set
          last_refresh_error=${String(error)},
          next_refresh_at=now() + least(interval '6 hours',
            interval '5 minutes' * power(2, least(${connection.refreshAttempts}, 12))),
          updated_at=now()
        where id=${connection.id}
      `;
    }
  }
  return refreshed;
}

/**
 * Refreshes one named connection immediately, outside the schedule.
 *
 * The scheduled sweep is the mechanism and this is the gap-filler: a request that reached Square
 * between two ticks and was told the token had expired. It returns whether the connection is
 * usable afterwards rather than throwing, because every caller's next move is the same either way
 * - try once more, or stop - and a thrown error here would be indistinguishable from the original
 * failure it was trying to recover from.
 */
export async function refreshConnectionNow(
  sql: SqlExecutor,
  dependencies: SquareWorkerDependencies,
  businessId: string
): Promise<boolean> {
  const [row] = await sql<{
    id: string; refreshToken: string | null; squareMerchantId: string; status: string;
  }[]>`
    select id, refresh_token, square_merchant_id, status
    from square_connections where business_id=${businessId}
  `;
  if (!row || row.status !== "connected" || !row.refreshToken) return false;
  let grant;
  try {
    const refreshToken = dependencies.keyring.open(row.refreshToken, {
      businessId, table: squareConnectionTable, column: refreshTokenColumn
    });
    grant = await dependencies.client.refreshAccessToken({ refreshToken });
    const nextRefreshToken = grant.refreshToken ?? refreshToken;
    const sealedAccess = dependencies.keyring.seal(grant.accessToken, {
      businessId, table: squareConnectionTable, column: accessTokenColumn
    });
    const sealedRefresh = dependencies.keyring.seal(nextRefreshToken, {
      businessId, table: squareConnectionTable, column: refreshTokenColumn
    });
    await sql`
      update square_connections set
        access_token=${sealedAccess.value},
        refresh_token=${sealedRefresh.value},
        access_token_expires_at=${grant.expiresAt},
        key_version=${sealedAccess.keyVersion},
        refreshed_at=now(),
        next_refresh_at=now() + make_interval(days => ${refreshIntervalDays}),
        refresh_attempts=0,
        last_refresh_error=null,
        updated_at=now()
      where id=${row.id} and status='connected'
    `;
    return true;
  } catch (error) {
    const revoked = error instanceof SquareApiError
      && (error.code === "access_token_revoked" || error.code === "unauthorized");
    if (revoked) {
      await markRevoked(sql, {
        merchantId: row.squareMerchantId, environment: dependencies.environment, revokedAt: null
      });
    }
    return false;
  }
}

export type SquareAccessOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "absent" | "revoked" | "disconnected" };

/**
 * Runs one Square call on a business's behalf, refreshing and retrying exactly once.
 *
 * THE WORK IS A FUNCTION OF THE TOKEN AND NOTHING ELSE, WHICH IS THE WHOLE POINT. A Terminal
 * checkout carries a deterministic idempotency key derived before this is called, so the second
 * attempt sends byte-for-byte the request the first one did and Square answers it with the
 * checkout it already created rather than a second one. If this helper minted anything per
 * attempt - a key, a reference, a timestamp - the retry would become a new request and the
 * recovery path would be the charge-twice path.
 *
 * Exactly once, not until it works. `ACCESS_TOKEN_EXPIRED` twice in a row means the refresh did
 * not do what it said, and looping on that is how an integration turns one stale credential into
 * a rate-limit ban.
 */
export async function withSquareAccess<T>(
  sql: SqlExecutor,
  dependencies: SquareWorkerDependencies,
  businessId: string,
  work: (accessToken: string) => Promise<T>
): Promise<SquareAccessOutcome<T>> {
  const access = await openAccessToken(sql, { businessId, keyring: dependencies.keyring });
  if (!access.usable) return { ok: false, reason: access.reason };
  try {
    return { ok: true, value: await work(access.accessToken) };
  } catch (error) {
    if (error instanceof SquareApiError && error.code === "access_token_expired") {
      if (await refreshConnectionNow(sql, dependencies, businessId)) {
        const refreshed = await openAccessToken(sql, {
          businessId, keyring: dependencies.keyring
        });
        if (refreshed.usable) return { ok: true, value: await work(refreshed.accessToken) };
      }
      return { ok: false, reason: "revoked" };
    }
    if (error instanceof SquareApiError
      && (error.code === "access_token_revoked" || error.code === "unauthorized")) {
      // The merchant withdrew the authorisation while we were mid-flight. Recording that here
      // rather than at the call site means every path through this helper leaves the connection
      // honest, including the ones that go on to fail for their own reasons.
      await markRevoked(sql, {
        merchantId: access.connection.squareMerchantId,
        environment: dependencies.environment,
        revokedAt: null
      });
      return { ok: false, reason: "revoked" };
    }
    throw error;
  }
}

/**
 * Marks every connection for a merchant revoked and empties it of credentials.
 *
 * Keyed on merchant because that is all a revocation event carries, and applied to every match
 * because Square revokes the merchant's authorisation of this application rather than one row of
 * ours. Returns the businesses affected so the caller can record what it did.
 */
export async function markRevoked(
  sql: SqlExecutor,
  input: { merchantId: string; environment: SquareEnvironment; revokedAt: Date | null }
): Promise<string[]> {
  const rows = await sql<{ businessId: string }[]>`
    update square_connections set
      status='revoked',
      access_token=null,
      refresh_token=null,
      access_token_expires_at=null,
      revoked_at=coalesce(${input.revokedAt}, now()),
      refresh_attempts=0,
      next_refresh_at=now(),
      last_refresh_error=null,
      updated_at=now()
    where environment=${input.environment} and square_merchant_id=${input.merchantId}
      and status <> 'revoked'
    returning business_id
  `;
  return rows.map((row) => row.businessId);
}

/** The salon's own decision to stop, as distinct from the merchant revoking us at Square. */
export async function markDisconnected(
  sql: SqlExecutor,
  businessId: string
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update square_connections set
      status='disconnected',
      access_token=null,
      refresh_token=null,
      access_token_expires_at=null,
      revoked_at=null,
      refresh_attempts=0,
      next_refresh_at=now(),
      last_refresh_error=null,
      updated_at=now()
    where business_id=${businessId} and status <> 'disconnected'
    returning id
  `;
  return rows.length > 0;
}
