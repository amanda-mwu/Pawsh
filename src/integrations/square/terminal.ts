import { createHash } from "node:crypto";
import type { SqlExecutor } from "../../db/client.js";
import type { SquareDeviceCode } from "./schemas.js";

/**
 * Pairing a terminal, and starting a checkout on it.
 *
 * THE IDEMPOTENCY KEY IS DERIVED, NEVER GENERATED. This is the one property in the whole phase
 * that a customer feels when it is wrong, and the failure it defends against is ordinary: the
 * request reaches Square, Square creates the checkout and charges nothing yet, and the response is
 * lost on the way back. A client that retries with a fresh key asks Square for a second checkout,
 * and a second checkout on a terminal is a second prompt to tap a card. So the key is a hash of
 * the facts - business, invoice, device, amount, currency, attempt - and every retry of the same
 * logical attempt reproduces it exactly. There is no clock in the derivation and no randomness;
 * feed it the same row twice and it cannot give a different answer.
 *
 * WHAT MAKES AN ATTEMPT "THE SAME ATTEMPT" IS A ROW, NOT A HEADER. The live checkout for an
 * invoice is the attempt. A retry finds that row and reuses its stored key. Only when the previous
 * attempt has come to rest - cancelled, failed, or settled - does the counter move and a new key
 * become derivable, which is why `attempt` is a column and `unique (business_id, invoice_id,
 * attempt)` exists: two concurrent starts must not both believe they are attempt two.
 *
 * A SQUARE IDENTIFIER IN A REQUEST BODY IS REFUSED. Every mutation here takes Pawsh uuids. The
 * Square location id, the device id and the checkout id are read back out of the row that already
 * holds them, server side. A route that accepted `square_device_id` from a client would let one
 * salon's browser name another salon's terminal, and no amount of checking afterwards is as good
 * as never having taken the value.
 *
 * DEVICE CODES EXPIRE, AND AN EXPIRED CODE IS A STATE RATHER THAN A SILENCE. A code that has
 * passed its `pair_by` presents as expired and offers to be re-issued. The alternative - a row
 * that still says "unpaired" while the code on the screen has stopped working - sends a salon to
 * type a dead code into a terminal repeatedly and gives them no way to find out why.
 */

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export type DevicePairingStatus = "unpaired" | "paired" | "expired";

export interface SquareDeviceRow {
  id: string;
  businessId: string;
  locationId: string;
  squareLocationId: string;
  label: string;
  deviceCodeId: string | null;
  deviceCode: string | null;
  pairBy: Date | null;
  pairingStatus: DevicePairingStatus;
  squareDeviceId: string | null;
  pairedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The pairing state a screen should show, which is not always the column.
 *
 * The column is what the database was last told; this is what is true now. A code whose `pair_by`
 * has passed is expired the moment it passes, and the sweep that writes that down runs on a worker
 * tick - so a salon looking at the screen in between would otherwise be shown a code that cannot
 * work, labelled as though it could.
 */
export function devicePairingView(
  row: Pick<SquareDeviceRow, "pairingStatus" | "pairBy" | "deviceCode" | "deviceCodeId">,
  now: Date
): { status: DevicePairingStatus; code: string | null; pairBy: Date | null } {
  if (row.pairingStatus === "paired") return { status: "paired", code: null, pairBy: null };
  const expired = row.pairingStatus === "expired"
    || !row.deviceCodeId
    || (row.pairBy !== null && row.pairBy.getTime() <= now.getTime());
  if (expired) return { status: "expired", code: null, pairBy: row.pairBy };
  return { status: "unpaired", code: row.deviceCode, pairBy: row.pairBy };
}

export async function listSquareDevices(
  sql: SqlExecutor, businessId: string
): Promise<SquareDeviceRow[]> {
  return sql<SquareDeviceRow[]>`
    select id, business_id, location_id, square_location_id, label, device_code_id,
      device_code, pair_by, pairing_status, square_device_id, paired_at, created_at, updated_at from square_devices
    where business_id=${businessId} order by lower(label), id
  `;
}

export async function readSquareDevice(
  sql: SqlExecutor, input: { businessId: string; deviceId: string }
): Promise<SquareDeviceRow | null> {
  const [row] = await sql<SquareDeviceRow[]>`
    select id, business_id, location_id, square_location_id, label, device_code_id,
      device_code, pair_by, pairing_status, square_device_id, paired_at, created_at, updated_at from square_devices
    where business_id=${input.businessId} and id=${input.deviceId}
  `;
  return row ?? null;
}

/**
 * Writes the issued code onto a device row.
 *
 * `pair_by` is whatever Square said and nothing else. Parsing it out of the response is the reason
 * no expiry constant appears anywhere in this integration: Square's published answers about how
 * long a code lives do not agree with each other, and a number written down here would be believed
 * long after it stopped being true.
 *
 * Issuing a code clears any existing pairing, because that is what issuing a code means: the
 * device this row describes is the one that types the new code in, and claiming it is still paired
 * to the previous device id would be a claim about hardware we can no longer see.
 */
export async function recordIssuedDeviceCode(
  sql: SqlExecutor,
  input: { businessId: string; deviceId: string; deviceCode: SquareDeviceCode }
): Promise<SquareDeviceRow | null> {
  const pairBy = parseSquareTimestamp(input.deviceCode.pair_by);
  const [row] = await sql<SquareDeviceRow[]>`
    update square_devices set
      device_code_id=${input.deviceCode.id},
      device_code=${input.deviceCode.code ?? null},
      pair_by=${pairBy},
      pairing_status='unpaired',
      square_device_id=null,
      paired_at=null,
      updated_at=now()
    where business_id=${input.businessId} and id=${input.deviceId}
    returning id, business_id, location_id, square_location_id, label, device_code_id,
      device_code, pair_by, pairing_status, square_device_id, paired_at, created_at, updated_at
  `;
  return row ?? null;
}

/**
 * Applies what Square says about a device code, from either the webhook or a manual re-read.
 *
 * One function for both so the two paths cannot disagree about what "paired" means. It is written
 * to converge rather than to transition: a device already paired to this device id is left alone
 * and reported as paired, because a redelivered `device.code.paired` and an operator pressing
 * refresh at the same moment are both ordinary.
 */
export async function applyDeviceCodeState(
  sql: SqlExecutor,
  input: { deviceCode: SquareDeviceCode; deviceCodeId?: string }
): Promise<{ businessId: string; status: DevicePairingStatus } | null> {
  const codeId = input.deviceCode.id || input.deviceCodeId;
  if (!codeId) return null;
  const status = (input.deviceCode.status ?? "").toUpperCase();
  if (input.deviceCode.device_id && status !== "EXPIRED") {
    const [paired] = await sql<{ businessId: string }[]>`
      update square_devices set
        pairing_status='paired',
        square_device_id=${input.deviceCode.device_id},
        paired_at=coalesce(paired_at, now()),
        updated_at=now()
      where device_code_id=${codeId}
        and (pairing_status <> 'paired' or square_device_id is distinct from ${input.deviceCode.device_id})
      returning business_id
    `;
    if (paired) return { businessId: paired.businessId, status: "paired" };
    const [already] = await sql<{ businessId: string }[]>`
      select business_id from square_devices where device_code_id=${codeId}
    `;
    return already ? { businessId: already.businessId, status: "paired" } : null;
  }
  if (status === "EXPIRED") {
    const [expired] = await sql<{ businessId: string }[]>`
      update square_devices set pairing_status='expired', updated_at=now()
      where device_code_id=${codeId} and pairing_status='unpaired'
      returning business_id
    `;
    if (expired) return { businessId: expired.businessId, status: "expired" };
  }
  const [row] = await sql<{ businessId: string; pairingStatus: DevicePairingStatus }[]>`
    select business_id, pairing_status from square_devices where device_code_id=${codeId}
  `;
  return row ? { businessId: row.businessId, status: row.pairingStatus } : null;
}

/**
 * Makes the column agree with the clock for codes nobody came back to.
 *
 * Runs on the worker tick beside the other Square housekeeping. `devicePairingView` already tells
 * a screen the truth without this, so the sweep is not what makes the product honest; it is what
 * stops a listing query having to reason about time to answer "how many terminals are waiting".
 */
export async function expireStaleDeviceCodes(sql: SqlExecutor): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update square_devices set pairing_status='expired', updated_at=now()
    where pairing_status='unpaired' and pair_by is not null and pair_by <= now()
    returning id
  `;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Terminal checkouts
// ---------------------------------------------------------------------------

export type TerminalCheckoutStatus =
  | "pending" | "in_progress" | "canceled" | "failed" | "completed" | "needs_review";

export interface TerminalCheckoutRow {
  id: string;
  businessId: string;
  invoiceId: string;
  deviceId: string;
  squareCheckoutId: string | null;
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  status: TerminalCheckoutStatus;
  cancelReason: string | null;
  lastError: string | null;
  mismatch: unknown;
  paymentId: string | null;
  attempt: number;
  createdBy: string;
  reconciledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `mismatch::text`, never `mismatch`.
 *
 * The database client is configured with `postgres.camel`, which camel-cases the keys of a jsonb
 * value on the way out as well as column names. A stored `amount_money` comes back as
 * `amountMoney` and a document written for a person to read stops matching the vocabulary it was
 * written in. Reading it as text and parsing here returns exactly the bytes that were stored,
 * which is the same discipline the webhook drain applies to `payload`.
 */
type CheckoutRowShape = Omit<TerminalCheckoutRow, "mismatch"> & { mismatchText: string | null };

function hydrate(row: CheckoutRowShape): TerminalCheckoutRow {
  const { mismatchText, ...rest } = row;
  return { ...rest, mismatch: mismatchText ? JSON.parse(mismatchText) : null };
}

export const terminalCheckoutIdempotencyVersion = "pawsh.square.terminal-checkout.v1";

/**
 * The idempotency key for one logical checkout attempt.
 *
 * SHA-256 over a canonical array, base64url encoded: 43 characters, inside Square's 45-character
 * limit with room that is deliberately not spent on a prefix. Every input is a fact already stored
 * on the row, so the key can be re-derived from the row afterwards and checked - which is what
 * makes "deterministic" an assertion a test can make rather than a claim in a comment.
 *
 * The version string is the first element so that changing what goes into the key can never make
 * two different derivations collide: a future v2 hashes a different array and yields a different
 * key for the same attempt, which is a new request to Square rather than a silently reinterpreted
 * old one.
 */
export function terminalCheckoutIdempotencyKey(input: {
  businessId: string;
  invoiceId: string;
  deviceId: string;
  amountMinor: number;
  currency: string;
  attempt: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    terminalCheckoutIdempotencyVersion,
    input.businessId,
    input.invoiceId,
    input.deviceId,
    input.amountMinor,
    input.currency,
    input.attempt
  ]), "utf8").digest("base64url");
}

/** The statuses from which a further Square event can still change the outcome. */
export const liveCheckoutStatuses = ["pending", "in_progress"] as const;

/**
 * Square's checkout vocabulary, mapped onto ours - and deliberately not all the way to `completed`.
 *
 * Square's COMPLETED means the terminal finished. Ours means a retrieved Payment has been posted
 * to the ledger inside the reconciling transaction. Those are different facts and the gap between
 * them is where a "paid" screen would be a lie, so this mapping stops at `in_progress` and only
 * the reconciler is allowed to write `completed`.
 */
export function mapSquareCheckoutStatus(status: string | undefined): {
  status: "pending" | "in_progress" | "canceled";
  settledAtSquare: boolean;
} {
  switch ((status ?? "").toUpperCase()) {
    case "PENDING":
      return { status: "pending", settledAtSquare: false };
    case "COMPLETED":
      return { status: "in_progress", settledAtSquare: true };
    case "CANCELED":
    case "CANCELLED":
      return { status: "canceled", settledAtSquare: false };
    case "IN_PROGRESS":
    case "CANCEL_REQUESTED":
      return { status: "in_progress", settledAtSquare: false };
    default:
      // An unrecognised status is in flight, not finished. Guessing "canceled" would tell a salon
      // to take the money another way while a terminal is still holding the card.
      return { status: "in_progress", settledAtSquare: false };
  }
}

export async function readTerminalCheckout(
  sql: SqlExecutor, input: { businessId: string; checkoutId: string }
): Promise<TerminalCheckoutRow | null> {
  const [row] = await sql<CheckoutRowShape[]>`
    select id, business_id, invoice_id, device_id, square_checkout_id, idempotency_key,
      amount_minor, currency, status, cancel_reason, last_error, mismatch::text as mismatch_text,
      payment_id, attempt, created_by, reconciled_at, created_at, updated_at from square_terminal_checkouts
    where business_id=${input.businessId} and id=${input.checkoutId}
  `;
  return row ? hydrate(row) : null;
}

/**
 * Our own row for a Square checkout id, which is the only anchor reconciliation is allowed to use.
 *
 * Not keyed on merchant. `square_merchant_id` is deliberately not unique, so one merchant id can
 * name two Pawsh businesses and a payment resolved through it could be posted into the wrong
 * ledger. We created this row, so it already knows the business, the invoice and the amount that
 * was asked for; nothing about the incoming event is trusted to supply any of those.
 */
export async function findCheckoutBySquareId(
  sql: SqlExecutor, squareCheckoutId: string
): Promise<TerminalCheckoutRow | null> {
  const [row] = await sql<CheckoutRowShape[]>`
    select id, business_id, invoice_id, device_id, square_checkout_id, idempotency_key,
      amount_minor, currency, status, cancel_reason, last_error, mismatch::text as mismatch_text,
      payment_id, attempt, created_by, reconciled_at, created_at, updated_at from square_terminal_checkouts
    where square_checkout_id=${squareCheckoutId}
  `;
  return row ? hydrate(row) : null;
}

export async function listInvoiceCheckouts(
  sql: SqlExecutor, input: { businessId: string; invoiceId: string }
): Promise<TerminalCheckoutRow[]> {
  const rows = await sql<CheckoutRowShape[]>`
    select id, business_id, invoice_id, device_id, square_checkout_id, idempotency_key,
      amount_minor, currency, status, cancel_reason, last_error, mismatch::text as mismatch_text,
      payment_id, attempt, created_by, reconciled_at, created_at, updated_at from square_terminal_checkouts
    where business_id=${input.businessId} and invoice_id=${input.invoiceId}
    order by attempt desc
  `;
  return rows.map(hydrate);
}

export type StartCheckoutRefusal =
  | "invoice_not_found"
  | "invoice_not_payable"
  | "invoice_has_tip"
  | "device_not_paired"
  | "currency_unknown";

export type StartCheckoutClaim =
  | { claimed: true; checkout: TerminalCheckoutRow; reused: boolean; squareDeviceId: string }
  | { claimed: false; reason: StartCheckoutRefusal };

/**
 * Claims the checkout row before Square is called, which is the order that makes a retry safe.
 *
 * Local row first, Square second. The other order has a window in which Square holds a checkout
 * nothing here knows about, and the only way out of that window is a key we can re-derive - which
 * we could not, because the row that would have told us the attempt number was never written.
 *
 * `invoice_has_tip` is a fence, not a validation. Reconciliation raises `tip_minor` from zero to
 * whatever the customer left on the device, and that operation is only sound on an invoice whose
 * tip was created as zero. An invoice that already carries a tip was captured some other way, and
 * a Terminal checkout must not be startable against it.
 */
export async function claimTerminalCheckout(
  sql: SqlExecutor,
  input: { businessId: string; invoiceId: string; deviceId: string; userId: string }
): Promise<StartCheckoutClaim> {
  const [invoice] = await sql<{
    balanceMinor: number; status: string; tipMinor: number; currency: string | null;
  }[]>`
    select i.balance_minor, i.status, i.tip_minor, b.currency
    from invoices i join businesses b on b.id=i.business_id
    where i.business_id=${input.businessId} and i.id=${input.invoiceId}
    for update of i
  `;
  if (!invoice) return { claimed: false, reason: "invoice_not_found" };
  if (!["open", "partially_paid"].includes(invoice.status) || invoice.balanceMinor <= 0) {
    return { claimed: false, reason: "invoice_not_payable" };
  }
  if (invoice.tipMinor !== 0) return { claimed: false, reason: "invoice_has_tip" };
  const currency = (invoice.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { claimed: false, reason: "currency_unknown" };

  const device = await readSquareDevice(sql, {
    businessId: input.businessId, deviceId: input.deviceId
  });
  if (!device || device.pairingStatus !== "paired" || !device.squareDeviceId) {
    return { claimed: false, reason: "device_not_paired" };
  }

  // The live attempt, if there is one. This is what makes a retry a retry: the same row, and
  // therefore the same stored key, rather than a second request that happens to look similar.
  const [live] = await sql<CheckoutRowShape[]>`
    select id, business_id, invoice_id, device_id, square_checkout_id, idempotency_key,
      amount_minor, currency, status, cancel_reason, last_error, mismatch::text as mismatch_text,
      payment_id, attempt, created_by, reconciled_at, created_at, updated_at from square_terminal_checkouts
    where business_id=${input.businessId} and invoice_id=${input.invoiceId}
      and status in ('pending','in_progress')
    order by attempt desc limit 1
  `;
  if (live) {
    return {
      claimed: true, checkout: hydrate(live), reused: true, squareDeviceId: device.squareDeviceId
    };
  }

  const [counted] = await sql<{ attempts: number }[]>`
    select coalesce(max(attempt),0)::int as attempts from square_terminal_checkouts
    where business_id=${input.businessId} and invoice_id=${input.invoiceId}
  `;
  const attempt = (counted?.attempts ?? 0) + 1;
  const idempotencyKey = terminalCheckoutIdempotencyKey({
    businessId: input.businessId,
    invoiceId: input.invoiceId,
    deviceId: input.deviceId,
    amountMinor: invoice.balanceMinor,
    currency,
    attempt
  });
  const [created] = await sql<CheckoutRowShape[]>`
    insert into square_terminal_checkouts
      (business_id, invoice_id, device_id, idempotency_key, amount_minor, currency, status,
       attempt, created_by)
    values (${input.businessId}, ${input.invoiceId}, ${input.deviceId}, ${idempotencyKey},
      ${invoice.balanceMinor}, ${currency}, 'pending', ${attempt}, ${input.userId})
    returning id, business_id, invoice_id, device_id, square_checkout_id, idempotency_key,
      amount_minor, currency, status, cancel_reason, last_error, mismatch::text as mismatch_text,
      payment_id, attempt, created_by, reconciled_at, created_at, updated_at
  `;
  if (!created) throw new Error("Terminal checkout could not be claimed");
  return {
    claimed: true, checkout: hydrate(created), reused: false, squareDeviceId: device.squareDeviceId
  };
}

/** Binds our row to the checkout Square created, and records what Square said it was doing. */
export async function bindSquareCheckout(
  sql: SqlExecutor,
  input: {
    businessId: string; checkoutId: string; squareCheckoutId: string;
    status: TerminalCheckoutStatus; cancelReason: string | null;
  }
): Promise<void> {
  await sql`
    update square_terminal_checkouts set
      square_checkout_id=${input.squareCheckoutId},
      status=${input.status},
      cancel_reason=${input.cancelReason},
      last_error=null,
      updated_at=now()
    where business_id=${input.businessId} and id=${input.checkoutId}
      and status in ('pending','in_progress')
  `;
}

/**
 * Records that an attempt did not become money, with a sentence rather than a stack trace.
 *
 * Never touches the invoice. A failed checkout leaves the balance exactly where it was, which is
 * the difference between "we could not take this payment" and "we took it and lost the record".
 */
export async function markCheckoutFailed(
  sql: SqlExecutor,
  input: { businessId: string; checkoutId: string; reason: string }
): Promise<void> {
  await sql`
    update square_terminal_checkouts set
      status='failed', last_error=${input.reason.slice(0, 500)}, updated_at=now()
    where business_id=${input.businessId} and id=${input.checkoutId}
      and status in ('pending','in_progress')
  `;
}

/** A transient refusal that leaves the attempt live, so a retry reuses the same key. */
export async function noteCheckoutError(
  sql: SqlExecutor,
  input: { businessId: string; checkoutId: string; reason: string }
): Promise<void> {
  await sql`
    update square_terminal_checkouts set last_error=${input.reason.slice(0, 500)}, updated_at=now()
    where business_id=${input.businessId} and id=${input.checkoutId}
      and status in ('pending','in_progress')
  `;
}

export function parseSquareTimestamp(value: string | undefined | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Presentation
//
// Salon staff do not read Square's vocabulary, and they must never be shown a success that has
// not happened. Both of those are one function, because a label computed in two places drifts and
// the half that drifts is the half nobody is looking at.
// ---------------------------------------------------------------------------

export interface CheckoutPresentation {
  /** What the operator is told, in their words rather than Square's. */
  label: string;
  /** True while the terminal may still change the outcome. */
  inFlight: boolean;
  /** True only when a Square Payment has been posted to the ledger. Nothing else may say "paid". */
  settled: boolean;
  /** True when a person has to look at this before any money moves. */
  needsReview: boolean;
}

export function checkoutPresentation(
  row: Pick<TerminalCheckoutRow, "status" | "cancelReason" | "squareCheckoutId">
): CheckoutPresentation {
  const reason = (row.cancelReason ?? "").toUpperCase();
  switch (row.status) {
    case "pending":
      return {
        label: row.squareCheckoutId ? "Waiting for the customer" : "Sending to the terminal",
        inFlight: true, settled: false, needsReview: false
      };
    case "in_progress":
      return { label: "In progress", inFlight: true, settled: false, needsReview: false };
    case "completed":
      return { label: "Completed", inFlight: false, settled: true, needsReview: false };
    case "canceled":
      if (reason === "TIMED_OUT" || reason === "TIMED_OUT_BEFORE_PAIRED") {
        return { label: "Timed out", inFlight: false, settled: false, needsReview: false };
      }
      if (reason === "DEVICE_OFFLINE") {
        return { label: "Terminal offline", inFlight: false, settled: false, needsReview: false };
      }
      return { label: "Cancelled", inFlight: false, settled: false, needsReview: false };
    case "failed":
      return { label: "Failed", inFlight: false, settled: false, needsReview: false };
    case "needs_review":
      return { label: "Needs review", inFlight: false, settled: false, needsReview: true };
    default:
      return { label: "Unknown", inFlight: false, settled: false, needsReview: true };
  }
}
